import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { BUNDLED_SKILLS } from "./bundledSkills.generated.ts";

/**
 * Seeds skills shipped with T3 Code into the user's Claude skills folder. An existing
 * skill folder is never touched, so the user's edits (e.g. council.json) survive updates.
 */
// shortcut: ignores a Claude instance's custom homePath; read it from settings if someone uses one.
export const installBundledSkills = Effect.fn("installBundledSkills")(
  function* (environment: NodeJS.ProcessEnv) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir =
      environment.CLAUDE_CONFIG_DIR?.trim() ||
      path.join(yield* HostProcess.HomeDirectory, ".claude");

    for (const skill of BUNDLED_SKILLS) {
      const directory = path.join(configDir, "skills", skill.name);
      if (yield* fs.exists(directory)) continue;
      // Write to a sibling and rename, so a failed write never leaves a half skill that blocks reinstall.
      const staging = `${directory}.installing`;
      yield* fs.remove(staging, { recursive: true, force: true });
      yield* fs.makeDirectory(staging, { recursive: true });
      for (const [file, contents] of Object.entries(skill.files)) {
        yield* fs.writeFileString(path.join(staging, file), contents);
      }
      yield* fs.rename(staging, directory);
    }
  },
  Effect.catchCause((cause) => Effect.logWarning("Failed to install bundled skills.", cause)),
);
