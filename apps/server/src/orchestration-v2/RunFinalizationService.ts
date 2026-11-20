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
import * as FiberSet from "effect/FiberSet";
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

const EDIT_TOOL_NAMES = new Set<string>([
  "write",
  "edit",
  "replace",
  "patch",
  "multiedit",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "apply_patch",
]);

export function countVerificationGateRetriesSincePass(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): number {
  let retries = 0;
  for (const item of items) {
    if (
      item.type === "system_notice" &&
      (item.message.startsWith("[Verification Gate]") || item.message.startsWith("[Auto-Verify]"))
    ) {
      retries += 1;
      continue;
    }
    if (
      item.type === "command_execution" &&
      item.status === "completed" &&
      VerificationGate.isVerificationCommand(item.input) &&
      item.outputIndicatesFailure !== true &&
      (item.exitCode === undefined || item.exitCode === 0)
    ) {
      retries = 0;
    }
  }
  return retries;
}

function extractEditedSourceFiles(item: OrchestrationV2TurnItem): ReadonlyArray<string> {
  if (item.status !== "completed") return [];
  const candidates: Array<string> = [];
  if (item.type === "file_change") {
    if (typeof item.fileName === "string" && item.fileName.trim().length > 0) {
      candidates.push(item.fileName.replace(/\\/g, "/").trim());
    }
    if (Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (typeof change.path === "string" && change.path.trim().length > 0) {
          candidates.push(change.path.replace(/\\/g, "/").trim());
        }
      }
    }
  } else if (
    item.type === "dynamic_tool" &&
    typeof item.toolName === "string" &&
    EDIT_TOOL_NAMES.has(item.toolName.toLowerCase()) &&
    item.input !== null &&
    typeof item.input === "object"
  ) {
    const record = item.input as Record<string, unknown>;
    const candidate = record.path ?? record.filePath ?? record.file_path ?? record.TargetFile;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      candidates.push(candidate.replace(/\\/g, "/").trim());
    }
  }
  return candidates.filter(VerificationGate.isSourceCodeFile);
}

function extractRawErrorMessage(item: OrchestrationV2TurnItem): string {
  const like = item as LoopCircuitBreaker.LoopCircuitBreakerItemLike;
  if (typeof like.error === "string" && like.error.trim() !== "") {
    return like.error;
  }
  if (typeof like.output === "string" && like.output.trim() !== "") {
    return like.output;
  }
  if (like.output && typeof like.output === "object") {
    const record = like.output as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim() !== "") {
      return record.error;
    }
    if (typeof record.message === "string" && record.message.trim() !== "") {
      return record.message;
    }
  }
  return "";
}

function summarizeFailureTitle(signature: LoopCircuitBreaker.LoopSignature): string {
  if (signature.itemType === "command_execution") {
    const subcommand = RsiService.extractToolSubcommand(
      RsiService.normalizeVerifiedCommand(signature.target),
    );
    return RsiService.capTitle(
      subcommand !== "" ? `Avoid ${subcommand} failure` : "Avoid command failure",
    );
  }
  if (signature.itemType === "file_change") {
    return "Avoid repeated file edit failure";
  }
  const toolName = signature.target.split(":")[0]?.trim() || signature.itemType;
  return RsiService.capTitle(`Avoid ${toolName} failure`);
}

function summarizeRunTelemetry(input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly cwd?: string | undefined;
}): RsiService.RsiRunTelemetryInput {
  const latestTurn = latestProviderTurnForAttempt(input.providerTurns, input.run.activeAttemptId);
  const runItems = input.turnItems.filter((item) => item.runId === input.run.id);
  const usedTokens =
    latestTurn?.tokenUsage?.usedTokens ??
    (latestTurn?.turnTokenUsage?.inputTokens ?? 0) +
      (latestTurn?.turnTokenUsage?.outputTokens ?? 0);
  const cachedInputTokens =
    latestTurn?.tokenUsage?.cachedInputTokens ?? latestTurn?.turnTokenUsage?.cachedInputTokens ?? 0;
  // Spend, not context size: every turn of this attempt (Codex goals span several), incl. subagents.
  let spentTokens: number | undefined;
  for (const turn of input.providerTurns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.localCommand === true) continue;
    if (turn.runAttemptId !== input.run.activeAttemptId) continue;
    spentTokens =
      (spentTokens ?? 0) +
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.otherUsage?.inputTokens ?? 0) +
      (usage.otherUsage?.outputTokens ?? 0);
  }

  let toolErrorCount = 0;
  let safetyBlockedCount = 0;
  let wastedReads = 0;
  let loopTripped = false;
  let lastFailedItem: OrchestrationV2TurnItem | undefined;
  let recoveredCommandPair: RsiService.RsiRecoveredCommandPair | undefined;
  const seenTargets = new Set<string>();
  const editedFilesSet = new Set<string>();
  const verifiedCommandsSet = new Set<string>();
  const failedCommandsByTool = new Map<string, string>();

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
    for (const editedFile of extractEditedSourceFiles(item)) {
      editedFilesSet.add(editedFile);
    }
    if (item.type === "command_execution" && typeof item.input === "string") {
      const rawCmd = item.input.trim();
      const normalizedCmd = RsiService.normalizeVerifiedCommand(rawCmd);
      if (normalizedCmd !== "") {
        const baseTool = RsiService.extractBaseToolName(normalizedCmd);
        const commandFailed =
          item.status === "failed" ||
          item.outputIndicatesFailure === true ||
          (typeof item.exitCode === "number" && item.exitCode !== 0);
        if (commandFailed) {
          failedCommandsByTool.set(baseTool, normalizedCmd);
        } else if (item.status === "completed") {
          const priorFailed = failedCommandsByTool.get(baseTool);
          if (
            priorFailed !== undefined &&
            priorFailed.toLowerCase() !== normalizedCmd.toLowerCase()
          ) {
            recoveredCommandPair = {
              failedCommand: priorFailed,
              succeededCommand: normalizedCmd,
            };
          }
          failedCommandsByTool.delete(baseTool);
        }
      }
      if (
        item.status === "completed" &&
        VerificationGate.isVerificationCommand(item.input) &&
        item.outputIndicatesFailure !== true &&
        (item.exitCode === undefined || item.exitCode === 0)
      ) {
        verifiedCommandsSet.add(rawCmd);
      }
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
          const title = summarizeFailureTitle(signature);
          const rawFirstLine = RsiService.scrubErrorText(extractRawErrorMessage(lastFailedItem));
          const scrubbedError =
            rawFirstLine || RsiService.scrubErrorText(signature.error) || "failed";
          return {
            tool: signature.itemType,
            errorSignature: scrubbedError,
            title,
            guidance: `Inspect error "${scrubbedError}" before retrying ${signature.itemType}.`,
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

  const editedFiles = [...editedFilesSet];
  const verifiedCommands = [...verifiedCommandsSet];

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
    ...(spentTokens !== undefined ? { spentTokens } : {}),
    ...(input.cwd !== undefined && input.cwd.trim() !== "" ? { cwd: input.cwd.trim() } : {}),
    ...(failureSignature !== undefined ? { failureSignature } : {}),
    ...(editedFiles.length > 0 ? { editedFiles } : {}),
    ...(verifiedCommands.length > 0 ? { verifiedCommands } : {}),
    ...(recoveredCommandPair !== undefined ? { recoveredCommandPair } : {}),
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
    readonly cwd?: string | undefined;
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
      const appliedLessonIds = yield* Effect.suspend(() =>
        rsiServiceOption.value.getAppliedLessonIds({
          threadId: input.threadId,
          runId: input.runId,
          provider: run.providerInstanceId,
        }),
      ).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<string>)));
      const baseTelemetryInput = summarizeRunTelemetry({
        threadId: input.threadId,
        run,
        providerTurns: records.providerTurns,
        turnItems: records.turnItems,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      const telemetryInput: RsiService.RsiRunTelemetryInput =
        appliedLessonIds.length > 0
          ? { ...baseTelemetryInput, appliedLessonIds }
          : baseTelemetryInput;
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
  const refreshes = yield* FiberSet.make<void>();

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
      // The refresh only updates the display, so the thread's next turn must not wait for it.
      // Never replaced by a newer one: back-to-back turns would interrupt each before it publishes.
      yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId }).pipe(
        Effect.catchTags({
          RunFinalizationRefreshError: (cause) =>
            Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
              ...input,
              cause,
            }),
        }),
        FiberSet.run(refreshes),
      );
    }
    yield* evaluateVerificationAndTelemetry({
      threadId: input.threadId,
      runId: input.runId,
      scopeId: input.scopeId,
      ...(cwd === undefined ? {} : { cwd }),
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
