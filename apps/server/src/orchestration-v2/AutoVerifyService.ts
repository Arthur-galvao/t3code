import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { countVerificationGateRetriesSincePass } from "./RunFinalizationService.ts";
import * as VerificationGate from "./VerificationGate.ts";

const ACTIVE_RUN_STATUSES = new Set<string>(["queued", "starting", "running", "interrupting"]);

export type AutoVerifyRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "providerThreads" | "runtimeRequests" | "messages"
>;

export interface AutoVerifyEvaluationInput extends AutoVerifyRecords {
  readonly runId: RunId;
  readonly autoVerifyEnabled: boolean;
  readonly verificationGateMode: VerificationGate.VerificationGateMode;
}

function countAutoVerifyMessagesSinceLastPass(
  messages: AutoVerifyRecords["messages"],
  turnItems: AutoVerifyRecords["turnItems"],
): number {
  let lastPassMs = Number.NEGATIVE_INFINITY;
  for (const item of turnItems) {
    if (
      item.type === "command_execution" &&
      item.status === "completed" &&
      typeof item.input === "string" &&
      VerificationGate.isVerificationCommand(item.input) &&
      item.outputIndicatesFailure !== true &&
      (item.exitCode === undefined || item.exitCode === 0)
    ) {
      const candidateMs = DateTime.toEpochMillis(
        item.completedAt ?? item.updatedAt ?? item.startedAt,
      );
      if (candidateMs > lastPassMs) {
        lastPassMs = candidateMs;
      }
    }
  }

  let count = 0;
  for (const message of messages) {
    if (!message.id.startsWith("auto-verify:")) continue;
    if (DateTime.toEpochMillis(message.createdAt) >= lastPassMs) {
      count += 1;
    }
  }
  return count;
}

export function evaluateAutoVerifyPrompt(input: AutoVerifyEvaluationInput): string | null {
  if (!input.autoVerifyEnabled || input.verificationGateMode === "off") {
    return null;
  }
  if (
    input.thread.deletedAt !== null ||
    input.thread.archivedAt !== null ||
    input.thread.settledAt !== null
  ) {
    return null;
  }
  const targetRun = input.runs.find((candidate) => candidate.id === input.runId);
  if (targetRun === undefined || targetRun.status !== "completed") {
    return null;
  }
  if (input.runs.some((candidate) => ACTIVE_RUN_STATUSES.has(candidate.status))) {
    return null;
  }
  if (input.runs.at(-1)?.id !== input.runId) {
    return null;
  }
  if (input.runtimeRequests.some((request) => request.status === "pending")) {
    return null;
  }
  if (
    derivePendingBackgroundWork({
      latestRun: targetRun,
      runs: input.runs,
      providerThreads: input.providerThreads,
      turnItems: input.turnItems,
      activeProviderThreadId: input.thread.activeProviderThreadId,
    }).length > 0
  ) {
    return null;
  }

  const hasGoal = input.providerThreads.some(
    (providerThread) =>
      providerThread.goal !== undefined &&
      providerThread.goal !== null &&
      (targetRun.providerThreadId === null || providerThread.id === targetRun.providerThreadId),
  );
  const trackerState = VerificationGate.collectVerificationStateFromTurnItems(
    input.turnItems,
    input.runId,
  );
  const retryCount = Math.max(
    countVerificationGateRetriesSincePass(input.turnItems),
    countAutoVerifyMessagesSinceLastPass(input.messages, input.turnItems),
  );
  const decision = VerificationGate.evaluateVerificationTracker(trackerState, {
    hasGoal,
    mode: input.verificationGateMode,
    retryCount,
  });
  if (!decision.shouldContinue) {
    return null;
  }

  const reason =
    decision.reason ?? "Source code was modified without a passing verification check.";
  return `[Auto-Verify] ${reason} Run the relevant verification checks (tests, typecheck, and lint) and fix any failures before finishing.`;
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const verifyWhenDue = Effect.fn("AutoVerifyService.verifyWhenDue")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": threadId,
      "orchestration_v2.run_id": runId,
    });

    const settings = yield* serverSettings.getSettings;
    if (!settings.autoVerifyEnabled) {
      return false;
    }

    const records = yield* orchestrator.getThreadRecords(threadId, [
      "runs",
      "turnItems",
      "providerThreads",
      "runtimeRequests",
      "messages",
    ]);
    const verificationGateMode =
      resolveProjectSettings(settings, records.thread.projectId).settings.verificationGateMode ??
      "auto";

    const prompt = evaluateAutoVerifyPrompt({
      thread: records.thread,
      runId,
      runs: records.runs,
      turnItems: records.turnItems,
      providerThreads: records.providerThreads,
      runtimeRequests: records.runtimeRequests,
      messages: records.messages,
      autoVerifyEnabled: settings.autoVerifyEnabled,
      verificationGateMode,
    });
    if (prompt === null) {
      return false;
    }

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`server:auto-verify:${threadId}:${runId}`),
      threadId,
      messageId: MessageId.make(`auto-verify:${threadId}:${runId}`),
      text: prompt,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    return true;
  });

  const start = Effect.fn("AutoVerifyService.start")(function* () {
    const fibers = yield* FiberMap.make<ThreadId>();
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "run.updated" || event.payload.status !== "completed") {
          return Effect.void;
        }
        const { threadId } = event;
        const runId = event.payload.id;
        return FiberMap.run(
          fibers,
          threadId,
          verifyWhenDue(threadId, runId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Auto-verify worker failed for completed run", {
                threadId,
                runId,
                cause,
              }),
            ),
            Effect.asVoid,
          ),
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Auto-verify stream terminated unexpectedly", { cause }),
      ),
      Effect.forkScoped,
    );
  });

  return {
    start,
    verifyWhenDue,
  } as const;
});
