import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { defaultCcrStore } from "@t3tools/provider-core/server/ccrStore";
import { compressToolOutput } from "@t3tools/provider-core/server/contextCompressor";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RsiService from "../orchestration-v2/RsiService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
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

describe("context_retrieve MCP tool", () => {
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:ccr-mcp-test"),
    requestNamespace: "provider-session:ccr-mcp-test",
    thread: {
      threadId: ThreadId.make("thread:ccr-mcp-test"),
      providerSessionId: "provider-session:ccr-mcp-test",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  it("exposes context_retrieve as a read-only tool on OrchestratorToolkit", () => {
    const tool = OrchestratorToolkit.tools.context_retrieve;
    assert.isDefined(tool);
    assert.isTrue(Context.get(tool.annotations, Tool.Readonly));
    assert.isFalse(Context.get(tool.annotations, Tool.Destructive));
  });

  const threadManagementMock = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({
        id: ThreadId.make("thread:ccr-mcp-test"),
        deletedAt: null,
        archivedAt: null,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        activeRunId: "run:ccr-mcp-active",
        pendingBackgroundTasks: [],
        runtimeMode: "full-access",
        interactionMode: "default",
      } as never),
  });

  it.effect("retrieves exact line slices and query matches from defaultCcrStore", () =>
    Effect.gen(function* () {
      const logLines = Array.from({ length: 120 }, (_, idx) => {
        const lineNo = idx + 1;
        if (lineNo === 47) {
          return "2026-11-13T01:00:47Z ERROR database migration checksum mismatch on table runs";
        }
        if (lineNo === 83) {
          return "2026-11-13T01:01:23Z FATAL unable to acquire lock on projection store";
        }
        return `2026-11-13T01:00:00Z INFO heartbeat tick=${lineNo} worker=pool-${lineNo % 4} status=healthy`;
      });
      const compressed = compressToolOutput({
        text: logLines.join("\n"),
        threadId: scope.thread!.threadId,
        sourceLabel: "Bash",
        store: defaultCcrStore,
      });
      assert.isTrue(compressed.compressed);
      assert.isDefined(compressed.ccrId);
      const ccrId = compressed.ccrId!;

      const otherThreadCompressed = compressToolOutput({
        text: logLines.join("\n"),
        threadId: "thread:ccr-other-thread",
        sourceLabel: "Bash",
        store: defaultCcrStore,
      });
      assert.isTrue(otherThreadCompressed.compressed);
      assert.isDefined(otherThreadCompressed.ccrId);

      const toolkit = yield* OrchestratorToolkit;

      const sliceOpt = yield* Stream.runHead(
        yield* toolkit.handle("context_retrieve", {
          ccrId,
          startLine: 46,
          endLine: 48,
        }),
      );
      assert.isTrue(Option.isSome(sliceOpt));
      if (Option.isNone(sliceOpt)) return;
      assert.isFalse(sliceOpt.value.isFailure);
      const sliceResult = sliceOpt.value.result;
      assert.isTrue("found" in sliceResult);
      if (!("found" in sliceResult)) return;
      assert.isTrue(sliceResult.found);
      assert.equal(sliceResult.threadId, scope.thread!.threadId);
      assert.equal(sliceResult.totalLines, 120);
      assert.equal(sliceResult.matchedLines, 3);
      assert.include(sliceResult.content, "L47: 2026-11-13T01:00:47Z ERROR database migration");

      const explicitThreadOpt = yield* Stream.runHead(
        yield* toolkit.handle("context_retrieve", {
          ccrId: otherThreadCompressed.ccrId!,
          threadId: "thread:ccr-other-thread",
          startLine: 83,
          endLine: 83,
        }),
      );
      assert.isTrue(Option.isSome(explicitThreadOpt));
      if (Option.isNone(explicitThreadOpt)) return;
      assert.isFalse(explicitThreadOpt.value.isFailure);
      const explicitThreadResult = explicitThreadOpt.value.result;
      assert.isTrue("found" in explicitThreadResult);
      if (!("found" in explicitThreadResult)) return;
      assert.isTrue(explicitThreadResult.found);
      assert.equal(explicitThreadResult.threadId, "thread:ccr-other-thread");
      assert.include(explicitThreadResult.content, "L83:");

      const queryOpt = yield* Stream.runHead(
        yield* toolkit.handle("context_retrieve", {
          ccrId,
          query: "ERROR|FATAL",
        }),
      );
      assert.isTrue(Option.isSome(queryOpt));
      if (Option.isNone(queryOpt)) return;
      assert.isFalse(queryOpt.value.isFailure);
      const queryResult = queryOpt.value.result;
      assert.isTrue("found" in queryResult);
      if (!("found" in queryResult)) return;
      assert.isTrue(queryResult.found);
      assert.equal(queryResult.matchedLines, 2);
      assert.include(queryResult.content, "L47:");
      assert.include(queryResult.content, "L83:");

      const boundedOpt = yield* Stream.runHead(
        yield* toolkit.handle("context_retrieve", {
          ccrId,
          maxChars: 120,
        }),
      );
      assert.isTrue(Option.isSome(boundedOpt));
      if (Option.isNone(boundedOpt)) return;
      assert.isFalse(boundedOpt.value.isFailure);
      const boundedResult = boundedOpt.value.result;
      assert.isTrue("found" in boundedResult);
      if (!("found" in boundedResult)) return;
      assert.isTrue(boundedResult.truncated);
      assert.isAtMost(boundedResult.content.length, 120);

      const missingOpt = yield* Stream.runHead(
        yield* toolkit.handle("context_retrieve", {
          ccrId: "ccr_does_not_exist",
        }),
      );
      assert.isTrue(Option.isSome(missingOpt));
      if (Option.isNone(missingOpt)) return;
      assert.isFalse(missingOpt.value.isFailure);
      const missingResult = missingOpt.value.result;
      assert.isTrue("found" in missingResult);
      if (!("found" in missingResult)) return;
      assert.isFalse(missingResult.found);

      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const blankFailure = yield* service
        .contextRetrieve(scope, { ccrId: "   " })
        .pipe(Effect.flip);
      assert.equal(blankFailure.code, "invalid_request");
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
