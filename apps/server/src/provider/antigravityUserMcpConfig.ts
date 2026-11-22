import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  npmShimExecutable,
  SpawnExecutableResolution,
  type SpawnExecutableResolver,
} from "@t3tools/shared/shell";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const ANTIGRAVITY_USER_MCP_CONFIG_MAX_BYTES = 256_000;

const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface AntigravityUserMcpParseResult {
  readonly servers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly warnings: ReadonlyArray<string>;
}

export function resolveAntigravityUserMcpConfigPath(path: Path.Path, userHome: string): string {
  return path.join(userHome, ".gemini", "config", "mcp_config.json");
}

function isHttpOrHttpsUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function parseStringPairs(
  value: unknown,
): ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const pairs: Array<{ readonly name: string; readonly value: string }> = [];
  for (const [rawKey, v] of Object.entries(value)) {
    const k = rawKey.trim();
    if (k.length === 0 || typeof v !== "string") {
      return undefined;
    }
    pairs.push({ name: k, value: v });
  }
  return pairs;
}

type ParsedEntryOutcome =
  | { readonly _tag: "server"; readonly server: EffectAcpSchema.McpServer }
  | { readonly _tag: "disabled" }
  | { readonly _tag: "invalid"; readonly warning: string };

function parseEntry(rawName: string, entry: unknown): ParsedEntryOutcome {
  const name = rawName.trim();
  if (name.length === 0) {
    return { _tag: "invalid", warning: "Skipped MCP server entry with empty name." };
  }
  if (name.toLowerCase() === "t3-code") {
    return { _tag: "invalid", warning: `Skipped reserved MCP server "${name}".` };
  }
  if (!isPlainRecord(entry)) {
    return {
      _tag: "invalid",
      warning: `Skipped MCP server "${name}": entry must be a JSON object.`,
    };
  }
  if (entry.disabled === true) {
    return { _tag: "disabled" };
  }

  const rawUrl =
    typeof entry.serverUrl === "string"
      ? entry.serverUrl.trim()
      : typeof entry.url === "string"
        ? entry.url.trim()
        : undefined;
  if (rawUrl !== undefined) {
    if (entry.type !== undefined && entry.type !== "http" && entry.type !== "sse") {
      return {
        _tag: "invalid",
        warning: `Skipped MCP server "${name}": invalid URL transport type.`,
      };
    }
    if (!isHttpOrHttpsUrl(rawUrl)) {
      return {
        _tag: "invalid",
        warning: `Skipped MCP server "${name}": URL must use http or https.`,
      };
    }
    const headers = entry.headers === undefined ? [] : parseStringPairs(entry.headers);
    if (headers === undefined) {
      return {
        _tag: "invalid",
        warning: `Skipped MCP server "${name}": headers must be a string map with non-empty keys.`,
      };
    }
    const serverType = entry.type === "sse" ? "sse" : "http";
    return {
      _tag: "server",
      server: {
        type: serverType,
        name,
        url: rawUrl,
        headers: [...headers],
      },
    };
  }

  if (entry.type !== undefined && entry.type !== "stdio") {
    return {
      _tag: "invalid",
      warning: `Skipped MCP server "${name}": invalid stdio transport type.`,
    };
  }
  if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
    return {
      _tag: "invalid",
      warning: `Skipped MCP server "${name}": missing stdio command.`,
    };
  }
  const command = entry.command.trim();
  let args: ReadonlyArray<string> = [];
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || !entry.args.every((item) => typeof item === "string")) {
      return {
        _tag: "invalid",
        warning: `Skipped MCP server "${name}": args must be an array of strings.`,
      };
    }
    args = [...entry.args];
  }
  const env = entry.env === undefined ? [] : parseStringPairs(entry.env);
  if (env === undefined) {
    return {
      _tag: "invalid",
      warning: `Skipped MCP server "${name}": env must be a string map with non-empty keys.`,
    };
  }
  return {
    _tag: "server",
    server: {
      name,
      command,
      args,
      env: [...env],
    },
  };
}

export function parseAntigravityUserMcpConfigWithDiagnostics(
  raw: string,
): AntigravityUserMcpParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { servers: [], warnings: [] };
  }
  const decoded = decodeJsonUnknown(trimmed);
  if (Option.isNone(decoded)) {
    return { servers: [], warnings: ["Invalid JSON in Antigravity user MCP config."] };
  }
  if (!isPlainRecord(decoded.value)) {
    return {
      servers: [],
      warnings: ["Antigravity user MCP config root must be a JSON object."],
    };
  }
  const rawServers = decoded.value.mcpServers;
  if (rawServers === undefined) {
    return { servers: [], warnings: [] };
  }
  if (!isPlainRecord(rawServers)) {
    return {
      servers: [],
      warnings: ["Antigravity user MCP config 'mcpServers' must be a JSON object."],
    };
  }

  const seenNames = new Set<string>();
  const servers: Array<EffectAcpSchema.McpServer> = [];
  const warnings: Array<string> = [];
  for (const [rawName, entry] of Object.entries(rawServers)) {
    const outcome = parseEntry(rawName, entry);
    if (outcome._tag === "disabled") {
      continue;
    }
    if (outcome._tag === "invalid") {
      warnings.push(outcome.warning);
      continue;
    }
    const trimmedName = rawName.trim();
    const key = trimmedName.toLowerCase();
    if (seenNames.has(key)) {
      warnings.push(`Skipped duplicate MCP server "${trimmedName}".`);
      continue;
    }
    seenNames.add(key);
    servers.push(outcome.server);
  }
  return { servers, warnings };
}

export function parseAntigravityUserMcpConfig(
  raw: string,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  return parseAntigravityUserMcpConfigWithDiagnostics(raw).servers;
}

type StdioMcpServer = Extract<EffectAcpSchema.McpServer, { readonly command: string }>;

function isStdioMcpServer(server: EffectAcpSchema.McpServer): server is StdioMcpServer {
  return (!("type" in server) || server.type === "stdio") && "command" in server;
}

function windowsBasename(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return lastSep === -1 ? filePath : filePath.slice(lastSep + 1);
}

function windowsDirname(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return lastSep <= 0 ? "" : filePath.slice(0, lastSep);
}

function windowsExtension(filePath: string): string {
  const base = windowsBasename(filePath);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export interface DirectNodeScriptInvocation {
  readonly nodeExecutable: string;
  readonly scriptPath: string;
}

export function normalizeStdioMcpServerForPlatform(
  server: EffectAcpSchema.McpServer,
  options: {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly resolveExecutable: SpawnExecutableResolver;
    readonly resolveNpmShim?: (shimPath: string) => string | undefined;
    readonly resolveNodeScript?: (shimPath: string) => DirectNodeScriptInvocation | undefined;
  },
): EffectAcpSchema.McpServer {
  if (options.platform !== "win32" || !isStdioMcpServer(server)) {
    return server;
  }

  const resolved =
    options.resolveExecutable(server.command, "win32", options.env) ?? server.command;
  const extension = windowsExtension(resolved);
  if (extension !== ".cmd" && extension !== ".bat") {
    return server;
  }

  const directExe = (options.resolveNpmShim ?? npmShimExecutable)(resolved);
  if (directExe !== undefined) {
    return {
      ...server,
      command: directExe,
    };
  }

  const directNode = options.resolveNodeScript?.(resolved);
  if (directNode !== undefined) {
    return {
      ...server,
      command: directNode.nodeExecutable,
      args: [directNode.scriptPath, ...(server.args ?? [])],
    };
  }

  const comSpec = readWindowsComSpec(options.env);
  const targetCommand =
    !server.command.includes("/") && !server.command.includes("\\") && !/\s/.test(server.command)
      ? server.command
      : resolved;
  return {
    ...server,
    command: comSpec,
    // npx.cmd unwraps directly to node.exe + npx-cli.js; fallback avoids `/s` so single quoted paths keep quotes.
    args: ["/d", "/c", targetCommand, ...(server.args ?? [])],
  };
}

function readWindowsComSpec(env: NodeJS.ProcessEnv): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "comspec" && typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "cmd.exe";
}

export const readAntigravityUserMcpServers = Effect.fn("readAntigravityUserMcpServers")(
  function* (input: {
    readonly userHome: string;
    readonly env?: NodeJS.ProcessEnv | undefined;
  }): Effect.fn.Return<
    ReadonlyArray<EffectAcpSchema.McpServer>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const env = input.env ?? (yield* HostProcess.Environment);
    const resolveExecutable = yield* SpawnExecutableResolution;
    const configPath = resolveAntigravityUserMcpConfigPath(path, input.userHome);

    return yield* Effect.gen(function* () {
      if (!(yield* fs.exists(configPath))) {
        return [];
      }
      const info = yield* fs.stat(configPath);
      if (info.type !== "File" || info.size > BigInt(ANTIGRAVITY_USER_MCP_CONFIG_MAX_BYTES)) {
        yield* Effect.logWarning("Skipped oversized or non-file Antigravity MCP config.", {
          configPath,
          size: info.size.toString(),
        });
        return [];
      }
      const raw = yield* fs.readFileString(configPath);
      const parsed = parseAntigravityUserMcpConfigWithDiagnostics(raw);
      if (parsed.warnings.length > 0) {
        yield* Effect.logWarning("Skipped invalid Antigravity user MCP config entries.", {
          configPath,
          warningCount: parsed.warnings.length,
          warnings: parsed.warnings,
        });
      }

      const resolvedByCommand = new Map<string, string | undefined>();
      const cachedResolveExecutable: SpawnExecutableResolver = (
        command,
        targetPlatform,
        targetEnv,
      ) => {
        if (targetPlatform === platform && targetEnv === env) {
          if (resolvedByCommand.has(command)) {
            return resolvedByCommand.get(command);
          }
          const found = resolveExecutable(command, targetPlatform, targetEnv);
          resolvedByCommand.set(command, found);
          return found;
        }
        return resolveExecutable(command, targetPlatform, targetEnv);
      };

      const directNodeScripts = new Map<string, DirectNodeScriptInvocation>();
      if (platform === "win32") {
        for (const server of parsed.servers) {
          if (!isStdioMcpServer(server)) {
            continue;
          }
          const resolved = cachedResolveExecutable(server.command, "win32", env) ?? server.command;
          if (
            windowsBasename(resolved).toLowerCase() !== "npx.cmd" ||
            directNodeScripts.has(resolved)
          ) {
            continue;
          }
          const shimDir = windowsDirname(resolved);
          if (shimDir.length === 0) {
            continue;
          }
          const sep = resolved.includes("\\") ? "\\" : "/";
          const npxCliPath = `${shimDir}${sep}node_modules${sep}npm${sep}bin${sep}npx-cli.js`;
          if (yield* fs.exists(npxCliPath)) {
            const siblingNode = `${shimDir}${sep}node.exe`;
            const nodeExecutable = (yield* fs.exists(siblingNode))
              ? siblingNode
              : (cachedResolveExecutable("node", "win32", env) ?? "node.exe");
            directNodeScripts.set(resolved, { nodeExecutable, scriptPath: npxCliPath });
          }
        }
      }

      return parsed.servers.map((server) =>
        normalizeStdioMcpServerForPlatform(server, {
          platform,
          env,
          resolveExecutable: cachedResolveExecutable,
          resolveNodeScript: (shimPath) => directNodeScripts.get(shimPath),
        }),
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to read Antigravity user MCP config.", {
          configPath,
          error,
        }).pipe(Effect.as<ReadonlyArray<EffectAcpSchema.McpServer>>([])),
      ),
    );
  },
);
