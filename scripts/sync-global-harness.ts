#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";

interface McpServerSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const DEFAULT_MCP_SERVERS: Readonly<Record<string, McpServerSpec>> = {
  shadcn: {
    command: "npx",
    args: ["-y", "shadcn@latest", "mcp"],
  },
  magicui: {
    command: "npx",
    args: ["-y", "@magicuidesign/mcp@latest"],
  },
};

const decodeJsonUnknown = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonPretty = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

const dryRun = process.argv.includes("--dry-run");
const initMissing = process.argv.includes("--init-missing");
const homeDir = NodeOS.homedir();

function logAction(kind: string, targetPath: string, detail: string) {
  const mode = dryRun ? "[dry-run]" : "[applied]";
  return Console.log(`${mode} ${kind} -> ${targetPath}: ${detail}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const syncJsonMcpFile = Effect.fn("syncJsonMcpFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(filePath);
  if (!exists && !initMissing) {
    yield* logAction("skip-missing", filePath, "not present (pass --init-missing to create)");
    return;
  }

  let parsed: Record<string, unknown> = {};
  if (exists) {
    const raw = (yield* fs.readFileString(filePath)).trim();
    const loaded = yield* (raw === "" ? Effect.succeed<unknown>({}) : decodeJsonUnknown(raw)).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(`Skipped invalid JSON at ${filePath}: ${String(error)}`);
          return null;
        }),
      ),
    );
    if (loaded === null) {
      return;
    }
    if (isPlainRecord(loaded)) {
      parsed = loaded;
    }
  }

  const existingServers: Record<string, unknown> = isPlainRecord(parsed.mcpServers)
    ? { ...parsed.mcpServers }
    : {};

  const added: Array<string> = [];
  for (const [name, spec] of Object.entries(DEFAULT_MCP_SERVERS)) {
    if (!(name in existingServers)) {
      existingServers[name] = {
        command: spec.command,
        args: [...spec.args],
      };
      added.push(name);
    }
  }

  if (added.length === 0) {
    yield* logAction("mcp-json", filePath, "already in sync");
    return;
  }

  const next = { ...parsed, mcpServers: existingServers };
  if (!dryRun) {
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const serialized = yield* encodeJsonPretty(next);
    yield* fs.writeFileString(filePath, `${serialized}\n`);
  }
  yield* logAction("mcp-json", filePath, `added ${added.join(", ")}`);
});

const syncCodexToml = Effect.fn("syncCodexToml")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(filePath);
  if (!exists && !initMissing) {
    yield* logAction("skip-missing", filePath, "not present (pass --init-missing to create)");
    return;
  }

  const raw = exists ? yield* fs.readFileString(filePath) : "";
  const sectionsToAppend: Array<string> = [];
  const added: Array<string> = [];

  for (const [name, spec] of Object.entries(DEFAULT_MCP_SERVERS)) {
    const headerPattern = new RegExp(`^\\[mcp_servers\\.${name}\\]`, "m");
    if (!headerPattern.test(raw)) {
      const encodedCommand = yield* encodeJsonUnknown(spec.command);
      const encodedArgs = yield* encodeJsonUnknown(spec.args);
      sectionsToAppend.push(
        `[mcp_servers.${name}]`,
        `command = ${encodedCommand}`,
        `args = ${encodedArgs}`,
        "",
      );
      added.push(name);
    }
  }

  if (added.length === 0) {
    yield* logAction("mcp-toml", filePath, "already in sync");
    return;
  }

  if (!dryRun) {
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const separator = raw.length > 0 && !raw.endsWith("\n") ? "\n\n" : raw.length > 0 ? "\n" : "";
    yield* fs.writeFileString(filePath, `${raw}${separator}${sectionsToAppend.join("\n")}`);
  }
  yield* logAction("mcp-toml", filePath, `added ${added.join(", ")}`);
});

const syncSkillDirs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const sourceDir = path.join(repoRoot, ".agents", "skills");
  if (!(yield* fs.exists(sourceDir))) {
    yield* logAction("skills", sourceDir, "source directory missing");
    return;
  }

  const entries = yield* fs.readDirectory(sourceDir);
  const skillNames: Array<string> = [];
  for (const entry of entries) {
    const info = yield* fs.stat(path.join(sourceDir, entry));
    if (info.type === "Directory") {
      skillNames.push(entry);
    }
  }

  const targets = [
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".claude", "skills"),
  ];

  for (const targetRoot of targets) {
    if (!(yield* fs.exists(targetRoot)) && !initMissing) {
      yield* logAction("skip-missing", targetRoot, "skills dir not present");
      continue;
    }
    let copied = 0;
    for (const skill of skillNames) {
      const skillSourceDir = path.join(sourceDir, skill);
      const skillMarker = path.join(skillSourceDir, "SKILL.md");
      if (!(yield* fs.exists(skillMarker))) continue;

      const skillEntries = yield* fs.readDirectory(skillSourceDir);
      for (const fileName of skillEntries) {
        if (fileName.startsWith(".")) continue;
        const srcFile = path.join(skillSourceDir, fileName);
        const fileInfo = yield* fs.stat(srcFile);
        if (fileInfo.type !== "File") continue;

        const destFile = path.join(targetRoot, skill, fileName);
        const destExists = yield* fs.exists(destFile);
        if (fileName === "council.json" && destExists) continue;

        const srcText = yield* fs.readFileString(srcFile);
        const destText = destExists ? yield* fs.readFileString(destFile) : null;
        if (srcText !== destText) {
          if (!dryRun) {
            yield* fs.makeDirectory(path.dirname(destFile), { recursive: true });
            yield* fs.writeFileString(destFile, srcText);
          }
          copied += 1;
        }
      }
    }
    yield* logAction(
      "skills",
      targetRoot,
      copied > 0 ? `synced ${copied} skill file(s)` : "already in sync",
    );
  }
});

const TAILSCALE_MARKER_START = "<!-- t3code:tailscale-preview:start -->";
const TAILSCALE_MARKER_END = "<!-- t3code:tailscale-preview:end -->";
const TAILSCALE_PREVIEW_BLOCK = [
  TAILSCALE_MARKER_START,
  "## Tailscale Serve Previews",
  "",
  "- Whenever sharing a link to a local server, preview, review page, or dashboard running on this PC, check `tailscale status` first.",
  "- If Tailscale is active, publish privately with `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` (never overwrite port 443 used by T3 Code and never use `tailscale funnel`), verify the `https://<host>.<tailnet>.ts.net:<port>` URL responds, and send that Tailscale link.",
  "- Fall back to `localhost` only when Tailscale is inactive or unavailable.",
  TAILSCALE_MARKER_END,
].join("\n");

const syncGlobalClaudeMd = Effect.fn("syncGlobalClaudeMd")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parentDir = path.dirname(filePath);
  if (!(yield* fs.exists(parentDir)) && !initMissing) {
    yield* logAction(
      "skip-missing",
      filePath,
      "parent dir not present (pass --init-missing to create)",
    );
    return;
  }

  const existing = (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : "";
  const startIdx = existing.indexOf(TAILSCALE_MARKER_START);
  const endIdx = existing.indexOf(TAILSCALE_MARKER_END);

  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + TAILSCALE_MARKER_END.length);
    next = `${before}${TAILSCALE_PREVIEW_BLOCK}${after}`;
  } else if (existing.trim().length === 0) {
    next = `${TAILSCALE_PREVIEW_BLOCK}\n`;
  } else {
    const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    next = `${existing}${separator}${TAILSCALE_PREVIEW_BLOCK}\n`;
  }

  if (next === existing) {
    yield* logAction("claude-md", filePath, "already in sync");
    return;
  }

  if (!dryRun) {
    yield* fs.makeDirectory(parentDir, { recursive: true });
    yield* fs.writeFileString(filePath, next);
  }
  yield* logAction(
    "claude-md",
    filePath,
    startIdx !== -1 && endIdx !== -1
      ? "updated tailscale preview rule"
      : "added tailscale preview rule",
  );
});

const main = Effect.gen(function* () {
  const path = yield* Path.Path;
  yield* syncJsonMcpFile(path.join(homeDir, ".claude.json"));
  yield* syncJsonMcpFile(path.join(homeDir, ".claude", ".claude.json"));
  yield* syncJsonMcpFile(path.join(homeDir, ".gemini", "antigravity", "mcp_config.json"));
  yield* syncCodexToml(path.join(homeDir, ".codex", "config.toml"));
  yield* syncGlobalClaudeMd(path.join(homeDir, ".claude", "CLAUDE.md"));
  yield* syncSkillDirs;
});

if (import.meta.main) {
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
