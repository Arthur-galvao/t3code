import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { routineSpan } from "@t3tools/shared/observability";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;
export const USAGE_LIMIT_FALLBACK_PROMPT =
  "Continue where you left off using the fallback provider.";

export interface UsageLimitFallbackInput {
  readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  readonly currentModelSelection: ModelSelection;
  readonly fallbackModelSelection: ModelSelection | null;
  readonly autoFallback: boolean;
  readonly nowMs: number;
}

export function usageLimitFallbackCommands(
  input: UsageLimitFallbackInput,
): ReadonlyArray<OrchestrationV2Command> {
  const { thread, currentModelSelection, fallbackModelSelection, autoFallback, nowMs } = input;
  if (
    !autoFallback ||
    fallbackModelSelection === null ||
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  ) {
    return [];
  }
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs) {
    return [];
  }
  if (thread.usageLimitResetAt != null) {
    const resetMs = Date.parse(thread.usageLimitResetAt);
    if (Number.isFinite(resetMs) && nowMs - resetMs > MAX_OVERDUE_ARM_MS) {
      return [];
    }
  }
  if (
    currentModelSelection.instanceId === fallbackModelSelection.instanceId &&
    currentModelSelection.model === fallbackModelSelection.model
  ) {
    return [];
  }
  const identity = `${thread.id}:${thread.latestRunId}:${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
  return [
    {
      type: "provider.switch",
      commandId: CommandId.make(`limit-fallback-switch:${identity}`),
      threadId: thread.id,
      modelSelection: fallbackModelSelection,
    },
    {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-fallback-continue:${identity}`),
      messageId: MessageId.make(`limit-fallback-continue:${identity}`),
      threadId: thread.id,
      modelSelection: fallbackModelSelection,
      manualContinuationOfRunId: thread.latestRunId,
      text: USAGE_LIMIT_FALLBACK_PROMPT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    },
  ];
}

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  const attemptedFallbackRuns = new Set<string>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(
    Stream.runForEach(settings.streamChanges, () =>
      Effect.sync(() => {
        attemptedFallbackRuns.clear();
      }).pipe(Effect.andThen(due.invalidate)),
    ),
  );
  return Effect.fn("UsageLimitRecoveryWorker.sweep", { attributes: routineSpan })(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const fallbackSelection =
      preferences.autoFallbackOnUsageLimit === true
        ? (preferences.fallbackModelSelection ?? null)
        : null;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads || fallbackSelection !== null,
      snooze: preferences.snoozeLimitedThreads,
    });
    let acted = false;
    for (const thread of candidates) {
      if (fallbackSelection !== null && thread.latestRunId !== null) {
        const fallbackKey = `${thread.id}:${thread.latestRunId}:${fallbackSelection.instanceId}:${fallbackSelection.model}`;
        if (!attemptedFallbackRuns.has(fallbackKey)) {
          const appThread = yield* projections
            .getThread(thread.id)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          const targetEnabled =
            appThread !== null &&
            (preferences.providerInstances === undefined ||
              resolveProjectProviderInstanceEnabled(
                preferences,
                appThread.projectId,
                fallbackSelection.instanceId,
              ));
          const fallbackCommands =
            appThread !== null && targetEnabled
              ? usageLimitFallbackCommands({
                  thread,
                  currentModelSelection: appThread.modelSelection,
                  fallbackModelSelection: fallbackSelection,
                  autoFallback: preferences.autoFallbackOnUsageLimit,
                  nowMs,
                })
              : [];
          if (fallbackCommands.length > 0) {
            acted = true;
            attemptedFallbackRuns.add(fallbackKey);
            yield* Effect.forEach(fallbackCommands, (cmd) => threads.dispatch(cmd), {
              discard: true,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.limit-recovery.fallback-failed", {
                  threadId: thread.id,
                  cause,
                }),
              ),
            );
            continue;
          }
        }
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
