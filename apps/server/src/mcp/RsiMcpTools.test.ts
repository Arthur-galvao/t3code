import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as RsiService from "../orchestration-v2/RsiService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";

describe("RSI MCP tools", () => {
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:rsi-mcp-test"),
    requestNamespace: "provider-session:rsi-mcp-test",
    thread: {
      threadId: ThreadId.make("thread:rsi-mcp-test"),
      providerSessionId: "provider-session:rsi-mcp-test",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  it("exposes rsi_query_lessons, rsi_record_lesson, and rsi_telemetry_summary on OrchestratorToolkit", () => {
    assert.isDefined(OrchestratorToolkit.tools.rsi_query_lessons);
    assert.isDefined(OrchestratorToolkit.tools.rsi_record_lesson);
    assert.isDefined(OrchestratorToolkit.tools.rsi_telemetry_summary);
    assert.isDefined(OrchestratorToolkit.tools.memory_search);
    assert.isDefined(OrchestratorToolkit.tools.memory_write);
  });

  const threadManagementMock = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        id: ThreadId.make("thread:rsi-mcp-test"),
        deletedAt: null,
        archivedAt: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        activeRunId: "run:rsi-mcp-active",
        pendingBackgroundTasks: [],
        runtimeMode: "full-access",
        interactionMode: "default",
      } as never),
  });

  it.effect("executes RSI MCP handlers through McpToolAccess.toLayer and shared RsiService", () =>
    Effect.gen(function* () {
      const rsi = yield* RsiService.RsiService;
      yield* rsi.recordRunTelemetry({
        threadId: "thread:rsi-mcp-test",
        runId: "run:rsi-mcp-1",
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        usedTokens: 1000,
        cachedInputTokens: 800,
        toolErrorCount: 1,
        loopTripped: false,
        safetyBlockedCount: 1,
        wastedReads: 2,
        outcome: "completed",
        durationMs: 2500,
      });

      const toolkit = yield* OrchestratorToolkit;

      const recordedOpt = yield* Stream.runHead(
        yield* toolkit.handle("rsi_record_lesson", {
          title: "Keep MCP tool schemas concise",
          guidance: "Preserve JSON schema budget in OrchestratorToolkit.",
          scope: "global",
          confidence: 0.9,
        }),
      );
      assert.isTrue(Option.isSome(recordedOpt));
      if (Option.isNone(recordedOpt)) return;
      assert.isFalse(recordedOpt.value.isFailure);
      const recordedResult = recordedOpt.value.result;
      assert.isTrue("lesson" in recordedResult);
      if (!("lesson" in recordedResult)) return;
      assert.equal(recordedResult.lesson.title, "Keep MCP tool schemas concise");

      const queriedOpt = yield* Stream.runHead(
        yield* toolkit.handle("rsi_query_lessons", {
          query: "schemas concise",
          minConfidence: 0.5,
        }),
      );
      assert.isTrue(Option.isSome(queriedOpt));
      if (Option.isNone(queriedOpt)) return;
      assert.isFalse(queriedOpt.value.isFailure);
      const queriedResult = queriedOpt.value.result;
      assert.isTrue("lessons" in queriedResult);
      if (!("lessons" in queriedResult)) return;
      assert.equal(queriedResult.count, 1);
      assert.equal(queriedResult.lessons[0]?.title, "Keep MCP tool schemas concise");

      const summaryOpt = yield* Stream.runHead(
        yield* toolkit.handle("rsi_telemetry_summary", {
          provider: "claudeAgent",
        }),
      );
      assert.isTrue(Option.isSome(summaryOpt));
      if (Option.isNone(summaryOpt)) return;
      assert.isFalse(summaryOpt.value.isFailure);
      const summaryResult = summaryOpt.value.result;
      assert.isTrue("totalRuns" in summaryResult);
      if (!("totalRuns" in summaryResult)) return;
      assert.equal(summaryResult.totalRuns, 1);
      assert.equal(summaryResult.safetyBlocks, 1);
      assert.equal(summaryResult.avgCacheHitRate, 0.8);

      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const failure = yield* service
        .rsiRecordLesson(scope, { title: "   ", guidance: "   " })
        .pipe(Effect.flip);
      assert.equal(failure.code, "invalid_request");

      // memory_search ranks RSI lessons alongside notes even without a notes folder.
      const memoryOpt = yield* Stream.runHead(
        yield* toolkit.handle("memory_search", { query: "schema budget" }),
      );
      assert.isTrue(Option.isSome(memoryOpt));
      if (Option.isNone(memoryOpt)) return;
      assert.isFalse(memoryOpt.value.isFailure);
      const memoryResult = memoryOpt.value.result;
      assert.isTrue("hits" in memoryResult);
      if (!("hits" in memoryResult)) return;
      assert.equal(memoryResult.hits[0]?.title, "Keep MCP tool schemas concise");
      assert.equal(memoryResult.hits[0]?.source, "rsi-lesson");
      const writeFailure = yield* service
        .memoryWrite(scope, { title: "x", content: "y" })
        .pipe(Effect.flip);
      assert.equal(writeFailure.code, "invalid_request");
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
          Layer.provideMerge(
            OrchestratorMcpService.layer.pipe(
              Layer.provideMerge(RsiService.layer),
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  ServerSettings.layerTest(),
                  threadManagementMock,
                  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
                  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                ),
              ),
            ),
          ),
          Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
          Layer.provideMerge(threadManagementMock),
          Layer.provideMerge(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provideMerge(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provideMerge(Layer.mock(PeerLinks.PeerLinks)({})),
          Layer.provideMerge(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
          Layer.provideMerge(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
        ),
      ),
    ),
  );
});

describe("memory MCP tools scoped to the caller's project", () => {
  const projectId = "project:memory-mcp";
  const scopeFor = (threadId: string): McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:memory-mcp"),
    requestNamespace: `provider-session:${threadId}`,
    thread: {
      threadId: ThreadId.make(threadId),
      providerSessionId: `provider-session:${threadId}`,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });

  it.effect("writes notes with the caller's project root and hides them from other projects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-mcp-" });
      const roots: Record<string, string> = {
        "thread:repo-a": path.join(stateDir, "repo-a"),
        "thread:repo-b": path.join(stateDir, "repo-b"),
      };
      const projectsByThread = new Map(
        Object.entries(roots).map(([threadId, root]) => [threadId, root] as const),
      );
      const layer = OrchestratorMcpService.layer.pipe(
        Layer.provideMerge(
          RsiService.RsiService.makeLayer({ persistCcr: false }).pipe(
            Layer.provide(ServerConfig.layerTest(stateDir, stateDir)),
          ),
        ),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            ServerSettings.layerTest(),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed({ id: threadId, projectId: `${projectId}:${threadId}` } as never),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeed(
                  Option.fromNullishOr(
                    projectsByThread.get(String(id).slice(projectId.length + 1)),
                  ).pipe(Option.map((workspaceRoot) => ({ workspaceRoot }) as never)),
                ),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const written = yield* service.memoryWrite(scopeFor("thread:repo-a"), {
          title: "Deploy steps",
          content: "Deploy with the release workflow.",
        });
        expect(yield* fs.readFileString(written.path)).toContain(
          `projectRoot: ${JSON.stringify(roots["thread:repo-a"])}`,
        );
        const fromA = yield* service.memorySearch(scopeFor("thread:repo-a"), { query: "deploy" });
        expect(fromA.hits.map((hit) => hit.title)).toEqual(["Deploy steps"]);
        const fromB = yield* service.memorySearch(scopeFor("thread:repo-b"), { query: "deploy" });
        expect(fromB.hits).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
