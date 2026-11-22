import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DEFAULT_MCP_SERVERS,
  LEGACY_DEFAULT_MCP_ENTRIES,
  collectGlobalSkillNames,
  formatMcpServerForTarget,
  loadCanonicalMcpServers,
  shouldApplyMcpSpec,
  shouldSyncSkillGlobally,
  syncJsonMcpFile,
  syncSkillTree,
  validateJsonMcpTargets,
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

  it.effect("syncSkillTree copies binary assets losslessly and stays idempotent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-bin-" });
      const srcDir = path.join(tempDir, "src-skill");
      const dstDir = path.join(tempDir, "dst-skill");
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

      yield* fs.makeDirectory(path.join(srcDir, "assets"), { recursive: true });
      yield* fs.writeFile(path.join(srcDir, "assets", "icon.png"), pngBytes);

      assert.equal(yield* syncSkillTree(srcDir, dstDir, false), 1);
      const copied = yield* fs.readFile(path.join(dstDir, "assets", "icon.png"));
      assert.deepEqual(Array.from(copied), Array.from(pngBytes));
      assert.equal(yield* syncSkillTree(srcDir, dstDir, false), 0);
    }),
  );

  it.effect(
    "syncJsonMcpFile formats HTTP/stdio per target, preserves user edits, upgrades legacy defaults, and writes atomically with backup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-mcp-" });

        assert.deepEqual(formatMcpServerForTarget(DEFAULT_MCP_SERVERS.context7!, "claude"), {
          type: "http",
          url: "https://mcp.context7.com/mcp",
        });
        assert.deepEqual(formatMcpServerForTarget(DEFAULT_MCP_SERVERS.context7!, "antigravity"), {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp@4.7.3"],
        });

        const claudeJson = path.join(tempDir, ".claude.json");
        yield* fs.writeFileString(
          claudeJson,
          JSON.stringify({
            mcpServers: {
              notion: { type: "http", url: "https://mcp.notion.com/mcp" },
              context7: {
                type: "http",
                url: "https://mcp.context7.com/mcp",
                headers: { Authorization: "Bearer custom-key" },
              },
              shadcn: { command: "npx", args: ["-y", "shadcn@latest", "mcp"] },
            },
          }),
        );
        yield* syncJsonMcpFile(claudeJson, "claude", false, true);
        const claudeParsed = JSON.parse(yield* fs.readFileString(claudeJson)) as {
          mcpServers: Record<string, unknown>;
        };
        assert.deepEqual(claudeParsed.mcpServers.notion, {
          type: "http",
          url: "https://mcp.notion.com/mcp",
        });
        assert.deepEqual(claudeParsed.mcpServers.context7, {
          type: "http",
          url: "https://mcp.context7.com/mcp",
          headers: { Authorization: "Bearer custom-key" },
        });
        assert.deepEqual(claudeParsed.mcpServers.shadcn, {
          command: "npx",
          args: ["-y", "shadcn@4.23.0", "mcp"],
        });
        assert.deepEqual(claudeParsed.mcpServers.magicui, {
          command: "npx",
          args: ["-y", "@magicuidesign/mcp@2.1.1"],
        });
        assert.isTrue(yield* fs.exists(`${claudeJson}.bak`));
        const entries = yield* fs.readDirectory(tempDir);
        assert.isFalse(entries.some((name) => name.includes(".tmp.")));

        const agMcpJson = path.join(tempDir, "mcp_config.json");
        yield* fs.writeFileString(
          agMcpJson,
          JSON.stringify({
            mcpServers: {
              context7: { serverUrl: "https://mcp.context7.com/mcp" },
            },
          }),
        );
        yield* syncJsonMcpFile(agMcpJson, "antigravity", false, true);
        const agParsed = JSON.parse(yield* fs.readFileString(agMcpJson)) as {
          mcpServers: Record<string, unknown>;
        };
        assert.deepEqual(agParsed.mcpServers.context7, {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp@4.7.3"],
        });
        assert.deepEqual(agParsed.mcpServers.shadcn, {
          command: "npx",
          args: ["-y", "shadcn@4.23.0", "mcp"],
        });
        assert.deepEqual(agParsed.mcpServers.magicui, {
          command: "npx",
          args: ["-y", "@magicuidesign/mcp@2.1.1"],
        });
      }),
  );

  it.effect("loadCanonicalMcpServers loads ~/.agents/mcp-servers.json overrides cleanly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-spec-" });
      const specPath = path.join(tempDir, "mcp-servers.json");

      assert.deepEqual(yield* loadCanonicalMcpServers(specPath), DEFAULT_MCP_SERVERS);

      yield* fs.writeFileString(
        specPath,
        JSON.stringify({
          mcpServers: {
            context7: {
              transport: "http",
              url: "https://mcp.context7.com/mcp",
              antigravity: {
                transport: "stdio",
                command: "npx",
                args: ["-y", "@upstash/context7-mcp@4.7.3"],
              },
            },
          },
        }),
      );
      const loaded = yield* loadCanonicalMcpServers(specPath);
      assert.deepEqual(formatMcpServerForTarget(loaded.context7!, "claude"), {
        type: "http",
        url: "https://mcp.context7.com/mcp",
      });
      assert.deepEqual(formatMcpServerForTarget(loaded.context7!, "antigravity"), {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp@4.7.3"],
      });
      assert.isFalse(
        shouldApplyMcpSpec(
          { command: "custom-shadcn", args: [] },
          { command: "npx", args: ["-y", "shadcn@4.23.0", "mcp"] },
          "shadcn",
          "claude",
        ),
      );
    }),
  );

  it.effect(
    "fails loudly on non-object JSON roots, invalid canonical overrides, and validateJsonMcpTargets before any write",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-failfast-" });

        const arrayTarget = path.join(tempDir, "array.json");
        yield* fs.writeFileString(arrayTarget, "[]");
        const syncExit = yield* Effect.exit(syncJsonMcpFile(arrayTarget, "claude", false, true));
        assert.equal(syncExit._tag, "Failure");
        assert.equal(yield* fs.readFileString(arrayTarget), "[]");

        const corruptSpec = path.join(tempDir, "corrupt-spec.json");
        yield* fs.writeFileString(corruptSpec, "{ invalid json");
        const corruptExit = yield* Effect.exit(loadCanonicalMcpServers(corruptSpec));
        assert.equal(corruptExit._tag, "Failure");

        const badOverrideSpec = path.join(tempDir, "bad-override.json");
        yield* fs.writeFileString(
          badOverrideSpec,
          JSON.stringify({
            mcpServers: {
              context7: {
                transport: "http",
                url: "https://mcp.context7.com/mcp",
                antigravity: { transport: "websocket", url: "wss://bad.example.com" },
              },
            },
          }),
        );
        const overrideExit = yield* Effect.exit(loadCanonicalMcpServers(badOverrideSpec));
        assert.equal(overrideExit._tag, "Failure");

        const validTarget = path.join(tempDir, "valid.json");
        yield* fs.writeFileString(validTarget, JSON.stringify({ mcpServers: {} }));
        const preValidateExit = yield* Effect.exit(
          validateJsonMcpTargets([validTarget, arrayTarget]),
        );
        assert.equal(preValidateExit._tag, "Failure");

        const emptyServersSpec = path.join(tempDir, "empty-servers.json");
        yield* fs.writeFileString(emptyServersSpec, JSON.stringify({ mcpServers: {} }));
        assert.deepEqual(yield* loadCanonicalMcpServers(emptyServersSpec), {});

        assert.deepEqual(formatMcpServerForTarget(DEFAULT_MCP_SERVERS.shadcn!, "claude"), {
          command: "npx",
          args: ["-y", "shadcn@4.23.0", "mcp"],
        });
        assert.deepEqual(LEGACY_DEFAULT_MCP_ENTRIES.antigravity.context7, [
          { serverUrl: "https://mcp.context7.com/mcp" },
        ]);
      }),
  );
});
