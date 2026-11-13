import {
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as LoopCircuitBreaker from "./LoopCircuitBreaker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RsiService from "./RsiService.ts";
import * as VerificationGate from "./VerificationGate.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const TOOL_ITEM_TYPES = new Set<string>([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "dynamic_tool",
]);

function countVerificationGateRetriesSincePass(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): number {
  let retries = 0;
  for (const item of items) {
    if (item.type === "system_notice" && item.message.startsWith("[Verification Gate]")) {
      retries += 1;
      continue;
    }
    if (
      item.type === "command_execution" &&
      item.status === "completed" &&
      VerificationGate.isVerificationCommand(item.input)
    ) {
      retries = 0;
    }
  }
  return retries;
}

function summarizeRunTelemetry(input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): RsiService.RsiRunTelemetryInput {
  const latestTurn = latestProviderTurnForAttempt(input.providerTurns, input.run.activeAttemptId);
  const runItems = input.turnItems.filter((item) => item.runId === input.run.id);
  const usedTokens =
    latestTurn?.tokenUsage?.usedTokens ??
    (latestTurn?.turnTokenUsage?.inputTokens ?? 0) +
      (latestTurn?.turnTokenUsage?.outputTokens ?? 0);
  const cachedInputTokens =
    latestTurn?.tokenUsage?.cachedInputTokens ?? latestTurn?.turnTokenUsage?.cachedInputTokens ?? 0;

  let toolErrorCount = 0;
  let safetyBlockedCount = 0;
  let wastedReads = 0;
  let loopTripped = false;
  let lastFailedItem: OrchestrationV2TurnItem | undefined;
  const seenTargets = new Set<string>();

  for (const item of runItems) {
    if (item.type === "system_notice") {
      if (item.message.startsWith("[Circuit Breaker]")) {
        loopTripped = true;
      }
      if (item.message.startsWith("[Tool Safety Guard]")) {
        safetyBlockedCount += 1;
      }
    }
    if (item.status === "failed" && (TOOL_ITEM_TYPES.has(item.type) || item.type === "error")) {
      toolErrorCount += 1;
      if (TOOL_ITEM_TYPES.has(item.type)) {
        lastFailedItem = item;
      }
    }
    if (item.type === "command_execution" || item.type === "file_change") {
      const signature = LoopCircuitBreaker.canonicalizeToolItemSignature(item);
      const key = `${signature.itemType}:${signature.target}`;
      if (item.status === "failed" && seenTargets.has(key)) {
        wastedReads += 1;
      }
      seenTargets.add(key);
    }
  }

  const startedAt = input.run.workStartedAt ?? input.run.startedAt ?? input.run.requestedAt;
  const durationMs =
    input.run.completedAt !== null
      ? Math.max(
          0,
          DateTime.toEpochMillis(input.run.completedAt) - DateTime.toEpochMillis(startedAt),
        )
      : 0;

  const failureSignature =
    lastFailedItem !== undefined
      ? (() => {
          const signature = LoopCircuitBreaker.canonicalizeToolItemSignature(lastFailedItem);
          return {
            tool: signature.itemType,
            errorSignature: signature.error || "failed",
            title: `Avoid repeated failure in ${signature.itemType} (${signature.target})`,
            guidance: `Inspect error "${signature.error || "failed"}" before retrying ${signature.itemType} on ${signature.target}.`,
          };
        })()
      : loopTripped
        ? {
            tool: "circuit_breaker",
            errorSignature: "loop_tripped",
            title: "Break repeating tool error loops early",
            guidance:
              "Diagnose the root cause or change approach before repeating failing tool calls.",
          }
        : undefined;

  return {
    threadId: input.threadId,
    runId: input.run.id,
    provider: input.run.providerInstanceId,
    model: latestTurn?.model ?? input.run.modelSelection.model,
    usedTokens,
    cachedInputTokens,
    toolErrorCount,
    loopTripped,
    safetyBlockedCount,
    wastedReads,
    outcome: input.run.status,
    durationMs,
    ...(failureSignature !== undefined ? { failureSignature } : {}),
  };
}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;
  const serverSettingsOption = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const rsiServiceOption = yield* Effect.serviceOption(RsiService.RsiService);
  const eventSinkOption = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const idAllocatorOption = yield* Effect.serviceOption(IdAllocator.IdAllocatorV2);

  const readThreadRecordsSafe = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
  }) {
    return yield* Effect.try({
      try: () =>
        projections.getThreadRecords(input.threadId, [
          "runs",
          "providerThreads",
          "providerTurns",
          "turnItems",
        ]),
      catch: (cause) =>
        new RunFinalizationError({
          ...input,
          operation: "refresh-workspace",
          cause,
        }),
    }).pipe(
      Effect.flatten,
      Effect.catchCause(() => Effect.succeed(null)),
    );
  });

  const emitVerificationNotice = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly run: OrchestrationV2Run;
    readonly reason: string;
  }) {
    if (Option.isNone(eventSinkOption) || Option.isNone(idAllocatorOption)) {
      return;
    }
    const eventSink = eventSinkOption.value;
    const idAllocator = idAllocatorOption.value;
    yield* Effect.gen(function* () {
      const now = yield* DateTime.now;
      const event: OrchestrationV2DomainEvent = {
        id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
        type: "turn-item.updated",
        threadId: input.threadId,
        runId: input.run.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.runSignalTurnItem({
            runId: input.run.id,
            signal: "verification-gate",
          }),
          threadId: input.threadId,
          runId: input.run.id,
          nodeId: null,
          providerThreadId: input.run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: "Verification Gate",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "system_notice",
          message: `[Verification Gate] ${input.reason}`,
        },
      };
      yield* eventSink.write({ events: [event] });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to write verification gate notice during run finalization", {
          threadId: input.threadId,
          runId: input.run.id,
          cause,
        }),
      ),
    );
  });

  const evaluateVerificationAndTelemetry = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
  }) {
    const records = yield* readThreadRecordsSafe(input);
    if (records === null) {
      return;
    }
    const run = records.runs.find((candidate) => candidate.id === input.runId);
    if (run === undefined) {
      return;
    }

    if (run.status === "completed") {
      const mode: VerificationGate.VerificationGateMode = Option.isSome(serverSettingsOption)
        ? yield* serverSettingsOption.value.getSettings.pipe(
            Effect.map(
              (settings) =>
                resolveProjectSettings(settings, records.thread.projectId).settings
                  .verificationGateMode ?? "auto",
            ),
            Effect.catchCause(() => Effect.succeed<VerificationGate.VerificationGateMode>("auto")),
          )
        : "auto";
      const hasGoal = records.providerThreads.some(
        (thread) =>
          thread.goal !== undefined &&
          thread.goal !== null &&
          (run.providerThreadId === null || thread.id === run.providerThreadId),
      );
      const trackerState = VerificationGate.collectVerificationStateFromTurnItems(
        records.turnItems,
        input.runId,
      );
      const retryCount = countVerificationGateRetriesSincePass(records.turnItems);
      const gateDecision = VerificationGate.evaluateVerificationTracker(trackerState, {
        hasGoal,
        mode,
        retryCount,
      });
      if (gateDecision.shouldContinue) {
        const reason =
          gateDecision.reason ?? "Source files changed after the last passing verification check.";
        yield* Effect.logWarning("Verification gate flagged unverified changes on run completion", {
          threadId: input.threadId,
          runId: input.runId,
          editsSinceLastVerify: trackerState.editsSinceLastVerify,
          retryCount,
          reason,
        });
        yield* emitVerificationNotice({
          threadId: input.threadId,
          run,
          reason,
        });
      }
    }

    if (Option.isSome(rsiServiceOption)) {
      const telemetryInput = summarizeRunTelemetry({
        threadId: input.threadId,
        run,
        providerTurns: records.providerTurns,
        turnItems: records.turnItems,
      });
      yield* Effect.suspend(() => rsiServiceOption.value.recordRunTelemetry(telemetryInput)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to record RSI telemetry during run finalization", {
            threadId: input.threadId,
            runId: input.runId,
            cause,
          }),
        ),
      );
    }
  });

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      // Retrying a display refresh after the checkpoint is durable blocks the next turn.
      yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId }).pipe(
        Effect.catchTags({
          RunFinalizationRefreshError: (cause) =>
            Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
              ...input,
              cause,
            }),
        }),
      );
    }
    yield* evaluateVerificationAndTelemetry({
      threadId: input.threadId,
      runId: input.runId,
      scopeId: input.scopeId,
    });
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const projects = yield* ProjectService.ProjectService;
    const enrichment = yield* ProjectEnrichment.ProjectEnrichmentService;
    const pullRequestLookups = yield* FiberMap.make<string>();
    const identityRefreshes = yield* FiberMap.make<ProjectId>();
    // A turn can add the first remote (`git remote add`, `gh repo create --push`), which the
    // enrichment and resolver caches would otherwise keep reporting as missing for a minute.
    const refreshMissingRepositoryIdentity = Effect.fn(
      "RunFinalizationService.refreshMissingRepositoryIdentity",
    )(
      function* (projectId: ProjectId) {
        const project = yield* projects.getById(projectId);
        if (Option.isNone(project)) return;
        const { workspaceRoot } = project.value;
        if ((yield* enrichment.readRepositoryIdentity(workspaceRoot)) !== null) return;
        yield* enrichment.refreshRepositoryIdentity(workspaceRoot);
      },
      (effect, projectId) =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to refresh repository identity after run completion", {
              projectId,
              detail: error.message,
            }),
          ),
        ),
    );
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread) return;
          // Forge discovery probes can take seconds; like the PR lookup, the next turn must not wait.
          yield* refreshMissingRepositoryIdentity(thread.projectId).pipe(
            FiberMap.run(identityRefreshes, thread.projectId),
          );
          if (local.refName === null || local.isDefaultRef) return;
          if (thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          // The forge CLI can take minutes, so the next turn must not wait for it. A newer
          // turn's lookup replaces a running one instead of queueing behind the cwd's lock.
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
            FiberMap.run(pullRequestLookups, cwd),
          );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
