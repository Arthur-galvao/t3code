#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as HostProcess from "@t3tools/shared/HostProcess";

export type McpTransportSpec =
  | {
      readonly transport?: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }
  | {
      readonly transport: "http";
      readonly url: string;
    };

export type McpServerSpec = McpTransportSpec & {
  readonly antigravity?: McpTransportSpec;
};

export type McpTargetFormat = "claude" | "antigravity";

export const DEFAULT_MCP_SERVERS: Readonly<Record<string, McpServerSpec>> = {
  context7: {
    transport: "http",
    url: "https://mcp.context7.com/mcp",
    antigravity: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp@4.7.3"],
    },
  },
  shadcn: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "shadcn@4.23.0", "mcp"],
  },
  magicui: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@magicuidesign/mcp@2.1.1"],
  },
};

// Exact unpinned Round 1 defaults safe to auto-upgrade without disturbing user edits.
export const LEGACY_DEFAULT_MCP_ENTRIES: Readonly<
  Record<McpTargetFormat, Readonly<Record<string, ReadonlyArray<unknown>>>>
> = {
  claude: {
    shadcn: [{ command: "npx", args: ["-y", "shadcn@latest", "mcp"] }],
    magicui: [{ command: "npx", args: ["-y", "@magicuidesign/mcp@latest"] }],
  },
  antigravity: {
    context7: [{ serverUrl: "https://mcp.context7.com/mcp" }],
    shadcn: [{ command: "npx", args: ["-y", "shadcn@latest", "mcp"] }],
    magicui: [{ command: "npx", args: ["-y", "@magicuidesign/mcp@latest"] }],
  },
};

export function formatMcpServerForTarget(
  spec: McpServerSpec,
  format: McpTargetFormat,
): Record<string, unknown> {
  const effective = format === "antigravity" && spec.antigravity ? spec.antigravity : spec;
  if (effective.transport === "http") {
    return format === "antigravity"
      ? { serverUrl: effective.url }
      : { type: "http", url: effective.url };
  }
  return {
    command: effective.command,
    args: [...effective.args],
  };
}

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

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableJsonValue(value[key]);
    }
    return out;
  }
  return value;
}

export function shouldApplyMcpSpec(
  existing: unknown,
  desired: unknown,
  name: string,
  format: McpTargetFormat,
): boolean {
  if (existing === undefined) {
    return true;
  }
  const existingKey = JSON.stringify(stableJsonValue(existing));
  const desiredKey = JSON.stringify(stableJsonValue(desired));
  if (existingKey === desiredKey) {
    return false;
  }
  const legacyEntries = LEGACY_DEFAULT_MCP_ENTRIES[format][name] ?? [];
  return legacyEntries.some((legacy) => JSON.stringify(stableJsonValue(legacy)) === existingKey);
}

function parseMcpTransportSpec(raw: unknown): McpTransportSpec | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  if (raw.transport === "http") {
    return typeof raw.url === "string" && raw.url.trim().length > 0
      ? { transport: "http", url: raw.url.trim() }
      : undefined;
  }
  if (raw.transport === undefined || raw.transport === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
      return undefined;
    }
    const args =
      raw.args === undefined
        ? []
        : Array.isArray(raw.args) && raw.args.every((item) => typeof item === "string")
          ? [...raw.args]
          : undefined;
    if (args === undefined) {
      return undefined;
    }
    return { transport: "stdio", command: raw.command.trim(), args };
  }
  return undefined;
}

export class SyncGlobalHarnessConfigError extends Schema.TaggedError<SyncGlobalHarnessConfigError>()(
  "SyncGlobalHarnessConfigError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const loadCanonicalMcpServers = Effect.fn("loadCanonicalMcpServers")(function* (
  specPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(specPath))) {
    return DEFAULT_MCP_SERVERS;
  }
  const raw = (yield* fs.readFileString(specPath)).trim();
  if (raw === "") {
    return yield* new SyncGlobalHarnessConfigError({
      detail: `Canonical MCP spec is empty: ${specPath}`,
    });
  }
  const decoded = yield* decodeJsonUnknown(raw).pipe(
    Effect.mapError(
      (cause) =>
        new SyncGlobalHarnessConfigError({
          detail: `Invalid canonical MCP spec at ${specPath}: ${String(cause)}`,
          cause,
        }),
    ),
  );
  if (!isPlainRecord(decoded) || !isPlainRecord(decoded.mcpServers)) {
    return yield* new SyncGlobalHarnessConfigError({
      detail: `Canonical MCP spec must be a JSON object with mcpServers: ${specPath}`,
    });
  }
  const parsed: Record<string, McpServerSpec> = {};
  for (const [name, entry] of Object.entries(decoded.mcpServers)) {
    const base = parseMcpTransportSpec(entry);
    if (base === undefined) {
      return yield* new SyncGlobalHarnessConfigError({
        detail: `Invalid canonical MCP server entry "${name}" in ${specPath}.`,
      });
    }
    let antigravity: McpTransportSpec | undefined;
    if (isPlainRecord(entry) && entry.antigravity !== undefined) {
      antigravity = parseMcpTransportSpec(entry.antigravity);
      if (antigravity === undefined) {
        return yield* new SyncGlobalHarnessConfigError({
          detail: `Invalid antigravity override for MCP server "${name}" in ${specPath}.`,
        });
      }
    }
    parsed[name] = antigravity === undefined ? base : { ...base, antigravity };
  }
  return parsed;
});

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function extractErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth >= 4 || !isPlainRecord(error)) {
    return undefined;
  }
  if (typeof error.code === "string") {
    return error.code;
  }
  return extractErrorCode(error.cause, depth + 1) ?? extractErrorCode(error.reason, depth + 1);
}

function isRetryableRenameError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code !== undefined && RETRYABLE_RENAME_CODES.has(code);
}

let atomicWriteCounter = 0;

function posixFileMode(
  platform: NodeJS.Platform,
  filePath: string,
  existingMode: number | undefined,
): number | undefined {
  if (platform === "win32") {
    return undefined;
  }
  if (existingMode !== undefined) {
    return existingMode & 0o777;
  }
  return filePath.endsWith(".claude.json") ? 0o600 : undefined;
}

const writeFileAtomic = Effect.fn("writeFileAtomic")(function* (
  filePath: string,
  content: string,
  createBackup: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const exists = yield* fs.exists(filePath);
  const existingInfo = exists ? yield* fs.stat(filePath) : undefined;
  const mode = posixFileMode(platform, filePath, existingInfo?.mode);
  const nowMillis = yield* Clock.currentTimeMillis;
  atomicWriteCounter += 1;
  const suffix = `${process.pid}.${nowMillis}.${atomicWriteCounter}`;
  const tmpPath = `${filePath}.tmp.${suffix}`;

  yield* Effect.gen(function* () {
    // Write tmp first (with final POSIX mode from creation when supported) so out-of-space errors preserve original/.bak.
    yield* fs.writeFileString(tmpPath, content, mode === undefined ? {} : { mode });
    if (mode !== undefined) {
      yield* fs.chmod(tmpPath, mode);
    }
    if (createBackup && exists) {
      const bakPath = `${filePath}.bak`;
      yield* fs.copyFile(filePath, bakPath);
      if (mode !== undefined) {
        yield* fs.chmod(bakPath, mode);
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const renamed = yield* Effect.result(fs.rename(tmpPath, filePath));
      if (Result.isSuccess(renamed)) {
        return;
      }
      if (attempt === 2 || !isRetryableRenameError(renamed.failure)) {
        return yield* renamed.failure;
      }
      yield* Effect.sleep("50 millis");
    }
  }).pipe(Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)));
});

const readValidatedJsonObjectFile = Effect.fn("readValidatedJsonObjectFile")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = (yield* fs.readFileString(filePath)).trim();
  if (raw === "") {
    return {} as Record<string, unknown>;
  }
  const loaded = yield* decodeJsonUnknown(raw).pipe(
    Effect.mapError(
      (cause) =>
        new SyncGlobalHarnessConfigError({
          detail: `Invalid JSON at ${filePath}: ${String(cause)}`,
          cause,
        }),
    ),
  );
  if (!isPlainRecord(loaded)) {
    return yield* new SyncGlobalHarnessConfigError({
      detail: `JSON root must be an object at ${filePath}.`,
    });
  }
  return loaded;
});

export const validateJsonMcpTargets = Effect.fn("validateJsonMcpTargets")(function* (
  filePaths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const filePath of filePaths) {
    if (yield* fs.exists(filePath)) {
      yield* readValidatedJsonObjectFile(filePath);
    }
  }
});

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export const syncJsonMcpFile = Effect.fn("syncJsonMcpFile")(function* (
  filePath: string,
  targetFormat: McpTargetFormat,
  isDryRun = dryRun,
  shouldInitMissing = initMissing,
  servers: Readonly<Record<string, McpServerSpec>> = DEFAULT_MCP_SERVERS,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(filePath);
  if (!exists && !shouldInitMissing) {
    yield* logAction("skip-missing", filePath, "not present (pass --init-missing to create)");
    return;
  }

  const parsed: Record<string, unknown> = exists
    ? yield* readValidatedJsonObjectFile(filePath)
    : {};

  const existingServers: Record<string, unknown> = isPlainRecord(parsed.mcpServers)
    ? { ...parsed.mcpServers }
    : {};

  const changed: Array<string> = [];
  for (const [name, spec] of Object.entries(servers)) {
    const desired = formatMcpServerForTarget(spec, targetFormat);
    if (shouldApplyMcpSpec(existingServers[name], desired, name, targetFormat)) {
      existingServers[name] = desired;
      changed.push(name);
    }
  }

  if (exists && changed.length === 0) {
    yield* logAction("mcp-json", filePath, "already in sync");
    return;
  }

  const next = { ...parsed, mcpServers: existingServers };
  if (!isDryRun) {
    const serialized = yield* encodeJsonPretty(next);
    yield* writeFileAtomic(filePath, `${serialized}\n`, exists);
  }
  yield* logAction(
    "mcp-json",
    filePath,
    changed.length > 0 ? `synced ${changed.join(", ")}` : "initialized",
  );
});

const syncCodexToml = Effect.fn("syncCodexToml")(function* (
  filePath: string,
  servers: Readonly<Record<string, McpServerSpec>> = DEFAULT_MCP_SERVERS,
) {
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

  for (const [name, spec] of Object.entries(servers)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headerPattern = new RegExp(`^\\[mcp_servers\\.${escapedName}\\]`, "m");
    if (!headerPattern.test(raw)) {
      if (spec.transport === "http") {
        const encodedUrl = yield* encodeJsonUnknown(spec.url);
        sectionsToAppend.push(`[mcp_servers.${name}]`, `url = ${encodedUrl}`, "");
      } else {
        const encodedCommand = yield* encodeJsonUnknown(spec.command);
        const encodedArgs = yield* encodeJsonUnknown(spec.args);
        sectionsToAppend.push(
          `[mcp_servers.${name}]`,
          `command = ${encodedCommand}`,
          `args = ${encodedArgs}`,
          "",
        );
      }
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
    yield* writeFileAtomic(filePath, `${raw}${separator}${sectionsToAppend.join("\n")}`, exists);
  }
  yield* logAction("mcp-toml", filePath, `added ${added.join(", ")}`);
});

const REPO_LOCAL_SKILLS = new Set([
  "test-t3-app",
  "test-t3-mobile",
  "verify-t3",
  "contribution-triage",
]);

export function shouldSyncSkillGlobally(skillName: string, skillMdContent: string): boolean {
  const match = skillMdContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (match !== null) {
    const frontmatter = match[1] ?? "";
    if (
      /^\s*sync-global\s*:\s*false\b/im.test(frontmatter) ||
      /^\s*scope\s*:\s*(?:repo|local|repo-local)\b/im.test(frontmatter)
    ) {
      return false;
    }
    if (/^\s*sync-global\s*:\s*true\b/im.test(frontmatter)) {
      return true;
    }
  }
  return !REPO_LOCAL_SKILLS.has(skillName);
}

export const collectGlobalSkillNames = Effect.fn("collectGlobalSkillNames")(function* (
  sourceDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(sourceDir))) {
    return [] as Array<string>;
  }
  const entries = yield* fs.readDirectory(sourceDir);
  const skillNames: Array<string> = [];
  for (const entry of entries) {
    const entryDir = path.join(sourceDir, entry);
    const info = yield* fs.stat(entryDir);
    if (info.type !== "Directory") continue;
    const skillMdPath = path.join(entryDir, "SKILL.md");
    if (!(yield* fs.exists(skillMdPath))) continue;
    const skillMdContent = yield* fs.readFileString(skillMdPath);
    if (!shouldSyncSkillGlobally(entry, skillMdContent)) continue;
    skillNames.push(entry);
  }
  return skillNames;
});

export const syncSkillTree = Effect.fn("syncSkillTree")(function* (
  srcDir: string,
  dstDir: string,
  isDryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let copied = 0;
  const stack: Array<{ readonly src: string; readonly dst: string; readonly depth: number }> = [
    { src: srcDir, dst: dstDir, depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = yield* fs.readDirectory(current.src);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "__pycache__") continue;
      const srcPath = path.join(current.src, entry);
      const dstPath = path.join(current.dst, entry);
      const info = yield* fs.stat(srcPath);
      if (info.type === "Directory") {
        stack.push({ src: srcPath, dst: dstPath, depth: current.depth + 1 });
        continue;
      }
      if (info.type !== "File") continue;

      const destExists = yield* fs.exists(dstPath);
      if (current.depth === 0 && entry === "council.json" && destExists) continue;

      const srcBytes = yield* fs.readFile(srcPath);
      const destBytes = destExists ? yield* fs.readFile(dstPath) : null;
      if (destBytes === null || !bytesEqual(srcBytes, destBytes)) {
        if (!isDryRun) {
          yield* fs.makeDirectory(path.dirname(dstPath), { recursive: true });
          yield* fs.writeFile(dstPath, srcBytes);
        }
        copied += 1;
      }
    }
  }
  return copied;
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

  const skillNames = yield* collectGlobalSkillNames(sourceDir);

  const targets = [
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".claude", "skills"),
    path.join(homeDir, ".gemini", "config", "skills"),
  ];
  // Sync standalone Gemini CLI skills dir only when already present; never create it on --init-missing.
  const geminiLegacySkills = path.join(homeDir, ".gemini", "skills");
  if (yield* fs.exists(geminiLegacySkills)) {
    targets.push(geminiLegacySkills);
  }

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
      copied += yield* syncSkillTree(skillSourceDir, path.join(targetRoot, skill), dryRun);
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
    yield* writeFileAtomic(filePath, next, existing.length > 0);
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
  const claudeRootPath = path.join(homeDir, ".claude.json");
  const claudeSubPath = path.join(homeDir, ".claude", ".claude.json");
  const agMcpPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
  const servers = yield* loadCanonicalMcpServers(path.join(homeDir, ".agents", "mcp-servers.json"));
  yield* validateJsonMcpTargets([claudeRootPath, claudeSubPath, agMcpPath]);
  yield* syncJsonMcpFile(claudeRootPath, "claude", dryRun, initMissing, servers);
  yield* syncJsonMcpFile(claudeSubPath, "claude", dryRun, initMissing, servers);
  yield* syncJsonMcpFile(agMcpPath, "antigravity", dryRun, initMissing, servers);
  yield* syncCodexToml(path.join(homeDir, ".codex", "config.toml"), servers);
  yield* syncGlobalClaudeMd(path.join(homeDir, ".claude", "CLAUDE.md"));
  yield* syncSkillDirs;
});

if (import.meta.main) {
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
