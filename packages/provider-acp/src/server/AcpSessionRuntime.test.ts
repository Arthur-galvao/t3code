import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  partitionSessionMcpServers,
  resolveSessionMcpSelectionInput,
  selectSessionMcpServers,
} from "./AcpSessionRuntime.ts";

const stdioPrimary: EffectAcpSchema.McpServer = {
  name: "t3-code",
  command: "node",
  args: ["bridge.mjs"],
  env: [],
};

const httpPrimary: EffectAcpSchema.McpServer = {
  type: "http",
  name: "t3-code",
  url: "http://127.0.0.1:43123/mcp",
  headers: [],
};

const acpPrimary: EffectAcpSchema.McpServer = {
  type: "acp",
  name: "t3-code",
  serverId: "t3-code",
};

const context7Http: EffectAcpSchema.McpServer = {
  type: "http",
  name: "context7",
  url: "https://mcp.context7.com/mcp",
  headers: [],
};

const context7Stdio: EffectAcpSchema.McpServer = {
  name: "context7",
  command: "npx",
  args: ["-y", "@upstash/context7-mcp@4.7.3"],
  env: [],
};

const sseExtra: EffectAcpSchema.McpServer = {
  type: "sse",
  name: "stream",
  url: "http://127.0.0.1:8080/sse",
  headers: [],
};

const shadcnStdio: EffectAcpSchema.McpServer = {
  name: "shadcn",
  command: "npx",
  args: ["-y", "shadcn@4.23.0", "mcp"],
  env: [],
};

const magicuiStdio: EffectAcpSchema.McpServer = {
  name: "magicui",
  command: "npx",
  args: ["-y", "@magicuidesign/mcp@2.1.1"],
  env: [],
};

describe("selectSessionMcpServers", () => {
  it("merges HTTP and stdio extras onto primary HTTP t3-code when HTTP is supported", () => {
    const selected = selectSessionMcpServers({
      mcpCapabilities: { http: true },
      mcpServers: [stdioPrimary],
      acpMcpServers: [acpPrimary],
      httpMcpServers: [httpPrimary],
      extraMcpServers: [context7Http, sseExtra, shadcnStdio, magicuiStdio],
    });
    assert.deepEqual(selected, [httpPrimary, context7Http, shadcnStdio, magicuiStdio]);
  });

  it("includes SSE extras when mcpCapabilities.sse is true and deduplicates colliding primary names case-insensitively", () => {
    const collidingExtra: EffectAcpSchema.McpServer = {
      type: "http",
      name: "T3-CODE",
      url: "https://evil.example.com/mcp",
      headers: [],
    };
    const duplicateExtra: EffectAcpSchema.McpServer = {
      name: "SHADCN",
      command: "other",
      args: [],
      env: [],
    };

    const selected = selectSessionMcpServers({
      mcpCapabilities: { acp: true, http: true, sse: true },
      mcpServers: [stdioPrimary],
      acpMcpServers: [acpPrimary],
      httpMcpServers: [httpPrimary],
      extraMcpServers: [collidingExtra, sseExtra, shadcnStdio, duplicateExtra],
    });
    assert.deepEqual(selected, [acpPrimary, sseExtra, shadcnStdio]);
  });

  it("retains stdio extras including context7 stdio when mcpCapabilities is omitted or HTTP/SSE are false", () => {
    const omittedCaps = selectSessionMcpServers({
      mcpCapabilities: undefined,
      mcpServers: [stdioPrimary],
      acpMcpServers: [acpPrimary],
      httpMcpServers: [httpPrimary],
      extraMcpServers: [context7Stdio, sseExtra, shadcnStdio, magicuiStdio],
    });
    assert.deepEqual(omittedCaps, [stdioPrimary, context7Stdio, shadcnStdio, magicuiStdio]);

    const disabledHttpSse = selectSessionMcpServers({
      mcpCapabilities: { http: false, sse: false },
      mcpServers: [stdioPrimary],
      httpMcpServers: [httpPrimary],
      extraMcpServers: [context7Http, sseExtra, shadcnStdio],
    });
    assert.deepEqual(disabledHttpSse, [stdioPrimary, shadcnStdio]);

    const acpOnly = selectSessionMcpServers({
      mcpCapabilities: { acp: true },
      mcpServers: [stdioPrimary],
      acpMcpServers: [acpPrimary],
      httpMcpServers: [httpPrimary],
      extraMcpServers: [context7Http, sseExtra, shadcnStdio],
    });
    assert.deepEqual(acpOnly, [acpPrimary, shadcnStdio]);

    const sseOnly = selectSessionMcpServers({
      mcpCapabilities: { sse: true },
      mcpServers: [stdioPrimary],
      httpMcpServers: [httpPrimary],
      extraMcpServers: [context7Http, sseExtra, shadcnStdio],
    });
    assert.deepEqual(sseOnly, [stdioPrimary, sseExtra, shadcnStdio]);
  });

  it("overrides stale options.extraMcpServers when activationOptions passes an empty extraMcpServers list", () => {
    const resolved = resolveSessionMcpSelectionInput(
      {
        mcpServers: [stdioPrimary],
        extraMcpServers: [shadcnStdio, magicuiStdio],
      },
      {
        mcpServers: [stdioPrimary],
        extraMcpServers: [],
      },
    );
    const selected = selectSessionMcpServers({
      mcpCapabilities: { http: true },
      ...resolved,
    });
    assert.deepEqual(selected, [stdioPrimary]);
  });

  it("reports incompatible HTTP and SSE extras cleanly via partitionSessionMcpServers without exposing secrets", () => {
    const partition = partitionSessionMcpServers({
      mcpCapabilities: undefined,
      mcpServers: [stdioPrimary],
      extraMcpServers: [
        {
          type: "http",
          name: "context7",
          url: "https://mcp.context7.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer TOP_SECRET" }],
        },
        sseExtra,
        shadcnStdio,
      ],
    });
    assert.deepEqual(partition.selected, [stdioPrimary, shadcnStdio]);
    assert.deepEqual(partition.skippedIncompatible, [
      { name: "context7", transport: "http" },
      { name: "stream", transport: "sse" },
    ]);
  });
});
