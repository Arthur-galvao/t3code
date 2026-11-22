import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ANTIGRAVITY_USER_MCP_CONFIG_MAX_BYTES,
  normalizeStdioMcpServerForPlatform,
  parseAntigravityUserMcpConfig,
  parseAntigravityUserMcpConfigWithDiagnostics,
  readAntigravityUserMcpServers,
  resolveAntigravityUserMcpConfigPath,
} from "./antigravityUserMcpConfig.ts";

it.layer(NodeServices.layer)("antigravityUserMcpConfig", (it) => {
  it("parses serverUrl http, url sse, stdio, headers, and env while skipping disabled/reserved/duplicates", () => {
    const parsed = parseAntigravityUserMcpConfig(
      JSON.stringify({
        mcpServers: {
          "t3-code": { command: "evil", args: [] },
          "T3-CODE": { serverUrl: "https://example.com/override" },
          context7: {
            serverUrl: "https://mcp.context7.com/mcp",
            headers: { Authorization: "Bearer secret" },
          },
          Context7: {
            serverUrl: "https://duplicate.example.com/mcp",
          },
          stream: {
            type: "sse",
            url: "http://127.0.0.1:8080/sse",
          },
          shadcn: {
            command: "npx",
            args: ["-y", "shadcn@4.23.0", "mcp"],
            env: { NODE_ENV: "production" },
          },
          off: {
            disabled: true,
            command: "npx",
            args: ["disabled"],
          },
        },
      }),
    );

    assert.deepEqual(parsed, [
      {
        type: "http",
        name: "context7",
        url: "https://mcp.context7.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      },
      {
        type: "sse",
        name: "stream",
        url: "http://127.0.0.1:8080/sse",
        headers: [],
      },
      {
        name: "shadcn",
        command: "npx",
        args: ["-y", "shadcn@4.23.0", "mcp"],
        env: [{ name: "NODE_ENV", value: "production" }],
      },
    ]);
  });

  it("emits sanitized diagnostics for malformed JSON and invalid entries without leaking secrets", () => {
    const malformed = parseAntigravityUserMcpConfigWithDiagnostics("not json {");
    assert.deepEqual(malformed.servers, []);
    assert.deepEqual(malformed.warnings, ["Invalid JSON in Antigravity user MCP config."]);

    const nonObjectRoot = parseAntigravityUserMcpConfigWithDiagnostics("[]");
    assert.deepEqual(nonObjectRoot.servers, []);
    assert.deepEqual(nonObjectRoot.warnings, [
      "Antigravity user MCP config root must be a JSON object.",
    ]);

    const arrayServers = parseAntigravityUserMcpConfigWithDiagnostics(
      JSON.stringify({ mcpServers: [] }),
    );
    assert.deepEqual(arrayServers.servers, []);
    assert.deepEqual(arrayServers.warnings, [
      "Antigravity user MCP config 'mcpServers' must be a JSON object.",
    ]);

    const mixed = parseAntigravityUserMcpConfigWithDiagnostics(
      JSON.stringify({
        mcpServers: {
          "   ": { command: "npx" },
          "t3-code": { command: "evil" },
          disabledOk: { disabled: true, command: "npx" },
          fileUrl: {
            serverUrl: "file:///etc/passwd",
            headers: { Authorization: "Bearer SUPER_SECRET_TOKEN" },
          },
          badHeaders: {
            url: "https://mcp.example.com",
            headers: { Authorization: 123, SecretKey: "SUPER_SECRET_TOKEN" },
          },
          badEnv: {
            command: "npx",
            env: { API_KEY: 999, REAL_SECRET: "SECRET_ENV_VALUE" },
          },
          badArgs: { command: "npx", args: ["-y", 123] },
          emptyCmd: { command: "   " },
          validOne: { command: "npx", args: ["-y", "@upstash/context7-mcp@4.7.3"] },
          VALIDONE: { command: "npx", args: ["-y", "duplicate"] },
        },
      }),
    );

    assert.deepEqual(mixed.servers, [
      {
        name: "validOne",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp@4.7.3"],
        env: [],
      },
    ]);
    assert.deepEqual(mixed.warnings, [
      "Skipped MCP server entry with empty name.",
      'Skipped reserved MCP server "t3-code".',
      'Skipped MCP server "fileUrl": URL must use http or https.',
      'Skipped MCP server "badHeaders": headers must be a string map with non-empty keys.',
      'Skipped MCP server "badEnv": env must be a string map with non-empty keys.',
      'Skipped MCP server "badArgs": args must be an array of strings.',
      'Skipped MCP server "emptyCmd": missing stdio command.',
      'Skipped duplicate MCP server "VALIDONE".',
    ]);
    const joinedWarnings = mixed.warnings.join("\n");
    assert.isFalse(joinedWarnings.includes("SUPER_SECRET_TOKEN"));
    assert.isFalse(joinedWarnings.includes("SECRET_ENV_VALUE"));
  });

  it("rejects invalid protocols, malformed JSON, array shapes, invalid explicit types, whitespace keys, and non-string args/env/headers", () => {
    assert.deepEqual(parseAntigravityUserMcpConfig("not json {"), []);
    assert.deepEqual(parseAntigravityUserMcpConfig("[]"), []);
    assert.deepEqual(parseAntigravityUserMcpConfig(JSON.stringify({ mcpServers: [] })), []);
    assert.deepEqual(
      parseAntigravityUserMcpConfig(
        JSON.stringify({
          mcpServers: {
            fileUrl: { serverUrl: "file:///etc/passwd" },
            jsUrl: { url: "javascript:alert(1)" },
            badUrlType: { type: "websocket", url: "https://mcp.example.com" },
            badStdioType: { type: "http", command: "npx", args: [] },
            arrayEntry: ["npx"],
            arrayHeaders: { url: "https://mcp.example.com", headers: ["X-Test"] },
            arrayEnv: { command: "npx", env: ["FOO=bar"] },
            blankHeaderKey: { url: "https://mcp.example.com", headers: { "   ": "val" } },
            blankEnvKey: { command: "npx", env: { "": "val" } },
            badArgs: { command: "npx", args: ["-y", 123] },
            badEnv: { command: "npx", env: { PORT: 8080 } },
            badHeaders: { url: "https://mcp.example.com", headers: { X: 1 } },
            emptyCmd: { command: "   " },
          },
        }),
      ),
      [],
    );
  });

  it("normalizes Windows .cmd/.bat stdio executables cleanly without affecting POSIX or .exe", () => {
    const npxServer = {
      name: "shadcn",
      command: "npx",
      args: ["-y", "shadcn@4.23.0", "mcp"],
      env: [],
    } as const;

    assert.deepEqual(
      normalizeStdioMcpServerForPlatform(npxServer, {
        platform: "linux",
        env: {},
        resolveExecutable: () => "C:\\Program Files\\nodejs\\npx.CMD",
      }),
      npxServer,
    );

    assert.deepEqual(
      normalizeStdioMcpServerForPlatform(npxServer, {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        resolveExecutable: () => "C:\\Program Files\\nodejs\\npx.CMD",
        resolveNpmShim: () => undefined,
        resolveNodeScript: () => ({
          nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
          scriptPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
        }),
      }),
      {
        name: "shadcn",
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [
          "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
          "-y",
          "shadcn@4.23.0",
          "mcp",
        ],
        env: [],
      },
    );

    assert.deepEqual(
      normalizeStdioMcpServerForPlatform(
        {
          name: "customFallback",
          command: "C:\\Program Files\\My Tool\\tool.cmd",
          args: ["--flag"],
          env: [],
        },
        {
          platform: "win32",
          env: { comspec: "D:\\Custom\\cmd.exe" },
          resolveExecutable: (cmd) => cmd,
          resolveNpmShim: () => undefined,
          resolveNodeScript: () => undefined,
        },
      ),
      {
        name: "customFallback",
        command: "D:\\Custom\\cmd.exe",
        args: ["/d", "/c", "C:\\Program Files\\My Tool\\tool.cmd", "--flag"],
        env: [],
      },
    );

    assert.deepEqual(
      normalizeStdioMcpServerForPlatform(npxServer, {
        platform: "win32",
        env: {},
        resolveExecutable: () => "C:\\Users\\demo\\AppData\\Roaming\\npm\\tool.cmd",
        resolveNpmShim: () => "C:\\Users\\demo\\AppData\\Roaming\\npm\\tool.exe",
      }),
      {
        name: "shadcn",
        command: "C:\\Users\\demo\\AppData\\Roaming\\npm\\tool.exe",
        args: ["-y", "shadcn@4.23.0", "mcp"],
        env: [],
      },
    );

    const exeServer = {
      name: "nodeTool",
      command: "node",
      args: ["server.js"],
      env: [],
    } as const;
    assert.deepEqual(
      normalizeStdioMcpServerForPlatform(exeServer, {
        platform: "win32",
        env: {},
        resolveExecutable: () => "C:\\Program Files\\nodejs\\node.exe",
      }),
      exeServer,
    );

    const httpServer = {
      type: "http",
      name: "context7",
      url: "https://mcp.context7.com/mcp",
      headers: [],
    } as const;
    assert.deepEqual(
      normalizeStdioMcpServerForPlatform(httpServer, {
        platform: "win32",
        env: {},
        resolveExecutable: () => undefined,
      }),
      httpServer,
    );
  });

  it.effect(
    "reads ~/.gemini/config/mcp_config.json safely and handles missing or oversized files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ag-mcp-" });

        assert.deepEqual(yield* readAntigravityUserMcpServers({ userHome: tempHome }), []);

        const configPath = resolveAntigravityUserMcpConfigPath(path, tempHome);
        yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({
            mcpServers: {
              context7: { serverUrl: "https://mcp.context7.com/mcp" },
              shadcn: { command: "node", args: ["server.js"] },
            },
          }),
        );

        assert.deepEqual(yield* readAntigravityUserMcpServers({ userHome: tempHome }), [
          { type: "http", name: "context7", url: "https://mcp.context7.com/mcp", headers: [] },
          { name: "shadcn", command: "node", args: ["server.js"], env: [] },
        ]);

        assert.deepEqual(
          yield* readAntigravityUserMcpServers({
            userHome: tempHome,
            env: { comspec: "E:\\Env\\cmd.exe" },
          }).pipe(
            Effect.provideService(HostProcess.Platform, "win32"),
            Effect.provideService(SpawnExecutableResolution, (cmd) =>
              cmd === "node" ? "C:\\Tools\\custom.cmd" : undefined,
            ),
          ),
          [
            { type: "http", name: "context7", url: "https://mcp.context7.com/mcp", headers: [] },
            {
              name: "shadcn",
              command: "E:\\Env\\cmd.exe",
              args: ["/d", "/c", "node", "server.js"],
              env: [],
            },
          ],
        );

        const oversized = JSON.stringify({
          mcpServers: {
            huge: {
              command: "npx",
              args: ["x".repeat(ANTIGRAVITY_USER_MCP_CONFIG_MAX_BYTES + 100)],
            },
          },
        });
        yield* fs.writeFileString(configPath, oversized);
        assert.deepEqual(yield* readAntigravityUserMcpServers({ userHome: tempHome }), []);
      }),
  );
});
