import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as AutoVerifyService from "./AutoVerifyService.ts";
import * as Orchestrator from "./Orchestrator.ts";

const NOW_MS = Date.UTC(2026, 10, 14, 18, 0, 0);
const at = (offsetMs = 0) => DateTime.makeUnsafe(NOW_MS + offsetMs);

const threadId = ThreadId.make("thread-auto-verify");
const projectId = ProjectId.make("project-auto-verify");
const runId = RunId.make("run-auto-verify-1");
const messageId = MessageId.make("message-user-1");
const nodeId = NodeId.make("node-root-1");
const instanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const modelSelection = { instanceId, model: "gpt-5" };

function makeBaseInput(
  overrides: Partial<AutoVerifyService.AutoVerifyEvaluationInput> = {},
): AutoVerifyService.AutoVerifyEvaluationInput {
  const defaultRun: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: messageId,
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at(-60_000),
    startedAt: at(-50_000),
    completedAt: at(),
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    thread: {
      id: threadId,
      projectId,
      title: "Auto verify thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-60_000),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runId,
    runs: [defaultRun],
    turnItems: [
      {
        id: TurnItemId.make("edit-1"),
        threadId,
        runId,
        nodeId,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: "Edit file",
        startedAt: at(-20_000),
        completedAt: at(-10_000),
        updatedAt: at(-10_000),
        type: "file_change",
        fileName: "apps/server/src/app.ts",
        changes: [{ operation: "edit", path: "apps/server/src/app.ts" }],
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-60_000),
        updatedAt: at(),
      },
    ],
    runtimeRequests: [],
    messages: [],
    autoVerifyEnabled: true,
    verificationGateMode: "auto",
    ...overrides,
  };
}

describe("evaluateAutoVerifyPrompt", () => {
  it("returns prompt for unverified source edits when enabled", () => {
    const prompt = AutoVerifyService.evaluateAutoVerifyPrompt(makeBaseInput());
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("[Auto-Verify]");
    expect(prompt).toContain("apps/server/src/app.ts");
  });

  it("skips when autoVerifyEnabled is false or verificationGateMode is off", () => {
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt(makeBaseInput({ autoVerifyEnabled: false })),
    ).toBeNull();
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt(makeBaseInput({ verificationGateMode: "off" })),
    ).toBeNull();
  });

  it("skips goal mode without goal and triggers when goal is set", () => {
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt(makeBaseInput({ verificationGateMode: "goal" })),
    ).toBeNull();

    const base = makeBaseInput({ verificationGateMode: "goal" });
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt({
        ...base,
        providerThreads: [
          {
            ...base.providerThreads[0]!,
            goal: { objective: "Ensure tests pass", status: "active" },
          },
        ],
      }),
    ).not.toBeNull();
  });

  it("skips when verification command passed after edit and enforces retry cap of 2", () => {
    const base = makeBaseInput();
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt({
        ...base,
        turnItems: [
          ...base.turnItems,
          {
            id: TurnItemId.make("verify-1"),
            threadId,
            runId,
            nodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "completed",
            title: "Run tests",
            startedAt: at(-5_000),
            completedAt: at(-1_000),
            updatedAt: at(-1_000),
            type: "command_execution",
            input: "vp.cmd test run apps/server/src/app.test.ts",
            exitCode: 0,
          },
        ],
      }),
    ).toBeNull();

    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt({
        ...base,
        messages: [1, 2].map((index) => ({
          id: MessageId.make(`auto-verify:${threadId}:run-${index}`),
          threadId,
          runId: null,
          nodeId,
          role: "user" as const,
          text: "Auto verify",
          attachments: [],
          streaming: false,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          createdAt: at(-5_000 + index),
          updatedAt: at(-5_000 + index),
        })),
      }),
    ).toBeNull();
  });

  it("skips archived threads and threads with pending requests", () => {
    const base = makeBaseInput();
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt({
        ...base,
        thread: { ...base.thread, archivedAt: at() },
      }),
    ).toBeNull();
    expect(
      AutoVerifyService.evaluateAutoVerifyPrompt({
        ...base,
        runtimeRequests: [
          {
            id: "req-1" as never,
            threadId,
            runId,
            nodeId,
            requestKind: "approval",
            status: "pending",
            title: "Approve",
            prompt: null,
            createdAt: at(),
            updatedAt: at(),
          } as never,
        ],
      }),
    ).toBeNull();
  });
});

describe("AutoVerifyService", () => {
  it.effect(
    "streams completed run.updated events and dispatches bounded server auto-verify message",
    () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const dispatched: Array<OrchestrationV2Command> = [];
        const dispatchedDone = yield* Deferred.make<void>();
        const fixture = makeBaseInput();

        const orchestratorLayer = Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(events),
          getThreadRecords: () => Effect.succeed(fixture as never),
          dispatch: ((command: OrchestrationV2Command) =>
            Effect.sync(() => {
              dispatched.push(command);
            }).pipe(
              Effect.andThen(Deferred.succeed(dispatchedDone, undefined)),
              Effect.as({ sequence: 1, storedEvents: [] }),
            )) as never,
        });

        const settingsLayer = ServerSettings.layerTest({
          autoVerifyEnabled: true,
          verificationGateMode: "auto",
        });

        const service = yield* AutoVerifyService.make.pipe(
          Effect.provide(Layer.mergeAll(orchestratorLayer, settingsLayer)),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* service.start();
            yield* Queue.offer(events, {
              id: EventId.make("evt-run-completed-1"),
              type: "run.updated",
              threadId,
              runId,
              nodeId,
              providerInstanceId: instanceId,
              occurredAt: at(),
              payload: fixture.runs[0]!,
            });
            yield* Deferred.await(dispatchedDone);
          }),
        );

        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({
          type: "message.dispatch",
          commandId: CommandId.make(`server:auto-verify:${threadId}:${runId}`),
          threadId,
          messageId: MessageId.make(`auto-verify:${threadId}:${runId}`),
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
      }),
  );

  it.effect("respects verificationGateMode = off setting", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2Command> = [];
      const fixture = makeBaseInput();

      const orchestratorLayer = Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.empty,
        getThreadRecords: () => Effect.succeed(fixture as never),
        dispatch: ((command: OrchestrationV2Command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }).pipe(Effect.as({ sequence: 1, storedEvents: [] }))) as never,
      });

      const settingsLayer = ServerSettings.layerTest({
        autoVerifyEnabled: true,
        verificationGateMode: "off",
      });

      const service = yield* AutoVerifyService.make.pipe(
        Effect.provide(Layer.mergeAll(orchestratorLayer, settingsLayer)),
      );

      const didDispatch = yield* service.verifyWhenDue(threadId, runId);
      expect(didDispatch).toBe(false);
      expect(dispatched).toHaveLength(0);
    }),
  );
});
