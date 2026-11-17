import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { BUNDLED_SKILLS } from "./bundledSkills.generated.ts";
import { installBundledSkills } from "./installBundledSkills.ts";

it.layer(NodeServices.layer)("installBundledSkills", (it) => {
  it.effect("matches the skill sources in .agents/skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(import.meta.dirname, "../../../..");
      for (const skill of BUNDLED_SKILLS) {
        for (const [file, contents] of Object.entries(skill.files)) {
          const source = yield* fs.readFileString(
            path.join(root, ".agents", "skills", skill.name, file),
          );
          assert.strictEqual(contents, source, `run scripts/sync-bundled-skills.py (${file})`);
        }
      }
    }),
  );

  it.effect("installs missing skills and keeps an existing one untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bundled-skills-" });
      const environment = { CLAUDE_CONFIG_DIR: configDir };
      const skillMd = path.join(configDir, "skills", "conselho", "SKILL.md");

      yield* installBundledSkills(environment);
      assert.strictEqual(
        yield* fs.readFileString(skillMd),
        BUNDLED_SKILLS.find((skill) => skill.name === "conselho")?.files["SKILL.md"],
      );

      yield* fs.writeFileString(skillMd, "edited");
      yield* installBundledSkills(environment);
      assert.strictEqual(yield* fs.readFileString(skillMd), "edited");
      assert.isFalse(yield* fs.exists(path.join(configDir, "skills", "conselho.installing")));
    }),
  );
});
