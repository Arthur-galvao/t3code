import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { collectMemoryDocs, searchMemoryDocs, toFtsQuery, writeMemoryNote } from "./MemoryNotes.ts";

describe("MemoryNotes", () => {
  it("builds safe FTS queries", () => {
    expect(toFtsQuery("obsidian-sync C:\\x")).toBe('"obsidian"* OR "sync"* OR "C"* OR "x"*');
    expect(toFtsQuery(":: --")).toBeUndefined();
  });

  it.effect(
    "writes Claude-format memories, indexes them, and finds them across accents per project",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-" });
        const written = yield* writeMemoryNote({
          fs,
          path,
          memoryDir,
          title: "Validação do T4",
          content:
            "Próximo passo: validar no lab 2060S. token sk-ant-abcdefghijklmnopqrstuvwxyz123",
          projectRoot: "C:\\repo\\dory",
          nowIso: "2026-11-20T00:00:00.000Z",
        });
        expect(path.basename(written.path)).toBe("validacao-do-t4.md");
        const note = yield* fs.readFileString(written.path);
        expect(note).toContain("name: validacao-do-t4");
        expect(note).toContain("  type: project");
        expect(note).not.toContain("sk-ant-abcdefghij");
        yield* writeMemoryNote({
          fs,
          path,
          memoryDir,
          title: "Global preference",
          content: "Reply in Portuguese.",
          nowIso: "2026-11-20T00:00:00.000Z",
        });
        // An existing Claude memory (nested metadata, no projectRoot) is global.
        yield* fs.writeFileString(
          path.join(memoryDir, "vp.md"),
          '---\nname: workspace-vp\ndescription: "use vp.cmd for tests"\nmetadata:\n  type: reference\n---\n\nGlobal vp breaks vitest.\n',
        );
        const index = yield* fs.readFileString(path.join(memoryDir, "MEMORY.md"));
        expect(index.trim().split("\n")).toEqual([
          "- [Validação do T4](validacao-do-t4.md) - Próximo passo: validar no lab 2060S. token [REDACTED_TOKEN]",
          "- [Global preference](global-preference.md) - Reply in Portuguese.",
        ]);

        const dory = yield* collectMemoryDocs({
          fs,
          path,
          memoryDir,
          projectRoot: "c:/repo/dory/",
        });
        expect(searchMemoryDocs(dory, "validacao lab").map((hit) => hit.title)).toEqual([
          "validacao-do-t4",
        ]);
        expect(searchMemoryDocs(dory, "vitest")[0]?.snippet).toContain("[vitest]");
        const other = yield* collectMemoryDocs({
          fs,
          path,
          memoryDir,
          projectRoot: "C:\\repo\\t3",
        });
        expect(other.map((doc) => doc.title).toSorted()).toEqual([
          "global-preference",
          "workspace-vp",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never overwrites a memory T3 did not write, and updates its own in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const memoryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-own-" });
      const userNote = path.join(memoryDir, "deploy.md");
      yield* fs.writeFileString(userNote, "# Deploy\n\nmine\n");
      const base = { fs, path, memoryDir, title: "Deploy", nowIso: "2026-11-20T00:00:00.000Z" };

      const first = yield* writeMemoryNote({ ...base, content: "v1" });
      expect(path.basename(first.path)).toBe("deploy-2.md");
      expect(yield* fs.readFileString(userNote)).toBe("# Deploy\n\nmine\n");
      const second = yield* writeMemoryNote({ ...base, content: "v2" });
      expect(second.path).toBe(first.path);
      expect(yield* fs.readFileString(second.path)).toContain("v2");
      const index = yield* fs.readFileString(path.join(memoryDir, "MEMORY.md"));
      expect(index).toBe("- [Deploy](deploy-2.md) - v2\n");

      const tooBig = yield* Effect.flip(writeMemoryNote({ ...base, content: "x".repeat(9_000) }));
      expect(tooBig.message).toContain("exceeds");
      const noTitle = yield* Effect.flip(
        writeMemoryNote({ ...base, title: "../..", content: "x" }),
      );
      expect(noTitle.message).toContain("empty");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves MEMORY.md headings/blank lines, uses reference type for global notes, and parses single-quoted frontmatter",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-fmt-" });
        yield* fs.writeFileString(
          path.join(memoryDir, "MEMORY.md"),
          "# Shared memory\n\n- [Existing](existing.md) - keep blank line above\n",
        );
        yield* fs.writeFileString(
          path.join(memoryDir, "quoted.md"),
          "---\nname: 'quoted-note'\ndescription: 'Single quoted'\nmetadata:\n  projectRoot: 'C:/repo/alpha'\n---\n\nAlpha only fact.\n",
        );
        const written = yield* writeMemoryNote({
          fs,
          path,
          memoryDir,
          title: "Global rule",
          content: "Applies everywhere.",
          nowIso: "2026-11-20T00:00:00.000Z",
        });
        expect(yield* fs.readFileString(written.path)).toContain("  type: reference");
        const index = yield* fs.readFileString(path.join(memoryDir, "MEMORY.md"));
        expect(index).toBe(
          "# Shared memory\n\n- [Existing](existing.md) - keep blank line above\n- [Global rule](global-rule.md) - Applies everywhere.\n",
        );
        const alpha = yield* collectMemoryDocs({
          fs,
          path,
          memoryDir,
          projectRoot: "C:\\repo\\alpha",
        });
        expect(alpha.map((d) => d.title).toSorted()).toEqual(["global-rule", "quoted-note"]);
        const beta = yield* collectMemoryDocs({
          fs,
          path,
          memoryDir,
          projectRoot: "C:\\repo\\beta",
        });
        expect(beta.map((d) => d.title)).toEqual(["global-rule"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
