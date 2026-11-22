import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  collectGlobalSkillNames,
  shouldSyncSkillGlobally,
  syncSkillTree,
} from "./sync-global-harness.ts";

it.layer(NodeServices.layer)("sync-global-harness", (it) => {
  it("parses frontmatter scope and sync-global flags with fallback to REPO_LOCAL_SKILLS", () => {
    assert.isFalse(
      shouldSyncSkillGlobally(
        "custom-skill",
        "---\nname: custom-skill\nsync-global: false\ndescription: local\n---\n",
      ),
    );
    assert.isFalse(
      shouldSyncSkillGlobally(
        "custom-skill",
        "---\nname: custom-skill\nscope: repo\ndescription: local\n---\n",
      ),
    );
    assert.isFalse(
      shouldSyncSkillGlobally("custom-skill", "---\nname: custom-skill\nscope: repo-local\n---\n"),
    );
    assert.isTrue(
      shouldSyncSkillGlobally("test-t3-app", "---\nname: test-t3-app\nsync-global: true\n---\n"),
    );
    assert.isTrue(shouldSyncSkillGlobally("custom-global", "# No frontmatter\n"));
    assert.isFalse(shouldSyncSkillGlobally("verify-t3", "# No frontmatter\n"));
  });

  it.effect("classifies real .agents/skills/*/SKILL.md files accurately", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.resolve(import.meta.dirname, "..");
      const skillsDir = path.join(repoRoot, ".agents", "skills");

      for (const localSkill of [
        "test-t3-app",
        "test-t3-mobile",
        "verify-t3",
        "contribution-triage",
      ]) {
        const content = yield* fs.readFileString(path.join(skillsDir, localSkill, "SKILL.md"));
        assert.isFalse(shouldSyncSkillGlobally(localSkill, content), localSkill);
      }

      for (const globalSkill of [
        "conselho",
        "sdd",
        "egm-review",
        "frontend-stack",
        "obsidian-brain",
      ]) {
        const content = yield* fs.readFileString(path.join(skillsDir, globalSkill, "SKILL.md"));
        assert.isTrue(shouldSyncSkillGlobally(globalSkill, content), globalSkill);
      }
    }),
  );

  it.effect("collectGlobalSkillNames skips subdirectories missing SKILL.md and local skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-skills-" });

      yield* fs.makeDirectory(path.join(tempDir, "empty-dir"), { recursive: true });
      yield* fs.makeDirectory(path.join(tempDir, "local-only"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tempDir, "local-only", "SKILL.md"),
        "---\nname: local-only\nsync-global: false\n---\n",
      );
      yield* fs.makeDirectory(path.join(tempDir, "shared-skill"), { recursive: true });
      yield* fs.writeFileString(
        path.join(tempDir, "shared-skill", "SKILL.md"),
        "---\nname: shared-skill\n---\n",
      );

      const selected = yield* collectGlobalSkillNames(tempDir);
      assert.deepEqual(selected, ["shared-skill"]);
    }),
  );

  it.effect("syncSkillTree copies nested scripts, preserves council.json, and is idempotent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-tree-" });
      const srcDir = path.join(tempDir, "src-skill");
      const dstDir = path.join(tempDir, "dst-skill");

      yield* fs.makeDirectory(path.join(srcDir, "scripts"), { recursive: true });
      yield* fs.writeFileString(path.join(srcDir, "SKILL.md"), "---\nname: demo\n---\n");
      yield* fs.writeFileString(path.join(srcDir, "council.json"), '{"default":true}\n');
      yield* fs.writeFileString(path.join(srcDir, "scripts", "helper.py"), "print('ok')\n");

      yield* fs.makeDirectory(dstDir, { recursive: true });
      yield* fs.writeFileString(path.join(dstDir, "council.json"), '{"custom":true}\n');

      const firstCopied = yield* syncSkillTree(srcDir, dstDir, false);
      assert.equal(firstCopied, 2);
      assert.equal(
        yield* fs.readFileString(path.join(dstDir, "scripts", "helper.py")),
        "print('ok')\n",
      );
      assert.equal(
        yield* fs.readFileString(path.join(dstDir, "council.json")),
        '{"custom":true}\n',
      );

      const secondCopied = yield* syncSkillTree(srcDir, dstDir, false);
      assert.equal(secondCopied, 0);
    }),
  );
});
