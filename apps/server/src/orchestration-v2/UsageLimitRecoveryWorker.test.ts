import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  limitRecoveryCommand,
  USAGE_LIMIT_FALLBACK_PROMPT,
  usageLimitFallbackCommands,
} from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

describe("cross-provider usage-limit fallback", () => {
  const claudeSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-4-6",
  };
  const agySelection = {
    instanceId: ProviderInstanceId.make("antigravity"),
    model: "gemini-3.1-pro",
  };

  it("emits provider.switch + continuation dispatch immediately before resetAt for Claude <-> Antigravity", () => {
    // Future reset (5 hours ahead): fallback should NOT stall waiting for resetAt.
    const thread = failedThread(1_000, -5 * HOUR_MS);
    const commands = usageLimitFallbackCommands({
      thread,
      currentModelSelection: claudeSelection,
      fallbackModelSelection: agySelection,
      autoFallback: true,
      nowMs,
    });
    assert.lengthOf(commands, 2);
    assert.deepEqual(commands[0], {
      type: "provider.switch",
      commandId: commands[0]!.commandId,
      threadId: thread.id,
      modelSelection: agySelection,
    });
    assert.equal(commands[1]?.type, "message.dispatch");
    if (commands[1]?.type === "message.dispatch") {
      assert.equal(commands[1].modelSelection?.instanceId, agySelection.instanceId);
      assert.equal(commands[1].modelSelection?.model, agySelection.model);
      assert.equal(commands[1].manualContinuationOfRunId, thread.latestRunId);
      assert.equal(commands[1].text, USAGE_LIMIT_FALLBACK_PROMPT);
      assert.deepEqual(commands[1].dispatchMode, { type: "start_immediately" });
    }

    const reverse = usageLimitFallbackCommands({
      thread,
      currentModelSelection: agySelection,
      fallbackModelSelection: claudeSelection,
      autoFallback: true,
      nowMs,
    });
    assert.lengthOf(reverse, 2);
    assert.equal(reverse[0]?.type, "provider.switch");
  });

  it("returns no fallback commands when disabled, unset, or already on fallback model", () => {
    const thread = failedThread(1_000, -HOUR_MS);
    assert.isEmpty(
      usageLimitFallbackCommands({
        thread,
        currentModelSelection: claudeSelection,
        fallbackModelSelection: agySelection,
        autoFallback: false,
        nowMs,
      }),
    );
    assert.isEmpty(
      usageLimitFallbackCommands({
        thread,
        currentModelSelection: claudeSelection,
        fallbackModelSelection: null,
        autoFallback: true,
        nowMs,
      }),
    );
    assert.isEmpty(
      usageLimitFallbackCommands({
        thread,
        currentModelSelection: agySelection,
        fallbackModelSelection: agySelection,
        autoFallback: true,
        nowMs,
      }),
    );
  });

  it.effect("sweep dispatches fallback switch + continuation when usage_limit occurs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const thread = failedThread(1_000, -4 * HOUR_MS);
      const dispatched = yield* Queue.unbounded<OrchestrationV2Command>();
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getLimitRecoveryCandidates: () => Effect.succeed([thread]),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
              getThread: () =>
                Effect.succeed({
                  id: thread.id,
                  projectId: ProjectId.make("project:fallback"),
                  modelSelection: claudeSelection,
                } as never),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Queue.offer(dispatched, command as OrchestrationV2Command).pipe(
                  Effect.as({} as never),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({
                autoResumeLimitedThreads: false,
                snoozeLimitedThreads: false,
                autoFallbackOnUsageLimit: true,
                fallbackModelSelection: agySelection,
                providerInstances: {
                  [agySelection.instanceId]: {
                    driver: ProviderDriverKind.make("antigravity"),
                    enabled: true,
                  },
                },
                projectSettingsOverrides: {},
              } as never),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const first = yield* Queue.take(dispatched);
        const second = yield* Queue.take(dispatched);
        assert.equal(first.type, "provider.switch");
        assert.equal(second.type, "message.dispatch");
        if (second.type === "message.dispatch") {
          assert.equal(second.text, USAGE_LIMIT_FALLBACK_PROMPT);
          assert.equal(second.modelSelection?.instanceId, agySelection.instanceId);
        }
      }).pipe(Effect.provide(layer));
    }),
  );
});
