import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeProjectDirName,
  collectMemoryDocs,
  searchMemoryDocs,
  toFtsQuery,
  writeMemoryNote,
} from "./MemoryNotes.ts";

describe("MemoryNotes", () => {
  it("builds safe FTS queries and Claude project folder names", () => {
    expect(toFtsQuery("obsidian-sync C:\\x")).toBe('"obsidian"* OR "sync"* OR "C"* OR "x"*');
    expect(toFtsQuery(":: --")).toBeUndefined();
    expect(claudeProjectDirName("C:\\Users\\Arthur\\Documents\\t3code")).toBe(
      "C--Users-Arthur-Documents-t3code",
    );
  });

  it.effect("writes a note and finds it across accents, scoped to its project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-" });
      const notesDir = path.join(root, "Memory");
      const written = yield* writeMemoryNote({
        fs,
        path,
        notesDir,
        title: "Validação do T4",
        content: "Próximo passo: validar no lab 2060S. token sk-ant-abcdefghijklmnopqrstuvwxyz123",
        projectRoot: "C:\\repo\\dory",
        nowIso: "2026-11-20T00:00:00.000Z",
      });
      expect(path.basename(written.path)).toBe("validacao-do-t4.md");
      expect(yield* fs.readFileString(written.path)).not.toContain("sk-ant-abcdefghij");

      yield* writeMemoryNote({
        fs,
        path,
        notesDir,
        title: "Global preference",
        content: "Reply in Portuguese.",
        nowIso: "2026-11-20T00:00:00.000Z",
      });

      const dory = yield* collectMemoryDocs({ fs, path, notesDir, projectRoot: "c:/repo/dory/" });
      expect(searchMemoryDocs(dory, "validacao lab").map((hit) => hit.title)).toEqual([
        "Validação do T4",
      ]);
      const other = yield* collectMemoryDocs({ fs, path, notesDir, projectRoot: "C:\\repo\\t3" });
      expect(other.map((doc) => doc.title)).toEqual(["Global preference"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Claude memory files but not their MEMORY.md index", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-claude-" });
      const claudeMemoryDir = path.join(root, "memory");
      yield* fs.makeDirectory(claudeMemoryDir, { recursive: true });
      yield* fs.writeFileString(path.join(claudeMemoryDir, "MEMORY.md"), "- [vp](vp.md) index");
      yield* fs.writeFileString(
        path.join(claudeMemoryDir, "vp.md"),
        '---\nname: workspace-vp\ndescription: "use vp.cmd for tests"\n---\n\nGlobal vp breaks vitest.\n',
      );
      const docs = yield* collectMemoryDocs({
        fs,
        path,
        notesDir: path.join(root, "none"),
        claudeMemoryDir,
      });
      expect(docs.map((doc) => [doc.source, doc.title])).toEqual([
        ["claude-memory", "workspace-vp"],
      ]);
      expect(searchMemoryDocs(docs, "vitest")[0]?.snippet).toContain("[vitest]");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never overwrites a note T3 did not write, and updates its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-own-" });
      const notesDir = path.join(root, "Memory");
      yield* fs.makeDirectory(notesDir, { recursive: true });
      const userNote = path.join(notesDir, "deploy.md");
      yield* fs.writeFileString(userNote, "# Deploy\n\nmine\n");
      const base = { fs, path, notesDir, title: "Deploy", nowIso: "2026-11-20T00:00:00.000Z" };

      const first = yield* writeMemoryNote({ ...base, content: "v1" });
      expect(path.basename(first.path)).toBe("deploy-2.md");
      expect(yield* fs.readFileString(userNote)).toBe("# Deploy\n\nmine\n");
      const second = yield* writeMemoryNote({ ...base, content: "v2" });
      expect(second.path).toBe(first.path);
      expect(yield* fs.readFileString(second.path)).toContain("v2");

      const tooBig = yield* Effect.flip(writeMemoryNote({ ...base, content: "x".repeat(9_000) }));
      expect(tooBig.message).toContain("exceeds");
      const noTitle = yield* Effect.flip(
        writeMemoryNote({ ...base, title: "../..", content: "x" }),
      );
      expect(noTitle.message).toContain("empty");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
