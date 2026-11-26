import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { historyCost } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";

const layerTest = ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(layerTest)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffService.ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.effect("caps the side chat context block without summarizing discarded parent history", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:side-chat-parent");
    let summarizedItems = 0;
    const parentItems = Array.from({ length: 60 }, (_, index) => ({
      ...importedItem({
        role: index % 2 === 0 ? "user" : "assistant",
        id: `parent-${index}`,
        text: `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`,
        ordinal: index,
      }),
      get text() {
        summarizedItems++;
        return `item-${index} ${"x".repeat(228)}😀${"x".repeat(70)}`;
      },
    }));
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handoff = yield* service.prepareSideChatContext({
      parentThreadId,
      threadId: ThreadId.make("thread:side-chat"),
      targetRunId: RunId.make("run:side-chat"),
      transferId: ContextTransferId.make("transfer:side-chat"),
      toProviderThreadId: ProviderThreadId.make("provider-thread:side-chat"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      coveredRunOrdinals: { from: 1, to: 1 },
      parentItems,
      createdAt: DateTime.makeUnsafe(0),
    });
    const context = handoff.summaryText;
    assert.isBelow(summarizedItems, parentItems.length);

    assert.include(context, "- Earlier items truncated.");
    assert.notInclude(context, "item-0 ");
    assert.include(context, "- Assistant: item-59 ");
    assert.isAtMost(context.length, 8_000);
    assert.isTrue(context.isWellFormed());
    assert.isTrue(
      context.endsWith(
        `Use t3_thread_read on thread ${parentThreadId} to see the main thread's live state.`,
      ),
    );

    const framingOnly = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [],
    });
    assert.isTrue(framingOnly.startsWith("You are in a side chat beside the main thread."));
    assert.notInclude(framingOnly, "Main thread activity");

    const multiFilePatch = ContextHandoffService.makeSideChatContext({
      parentThreadId,
      digest: [
        {
          id: TurnItemId.make("turn-item:patch"),
          threadId: parentThreadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 60,
          status: "completed",
          title: null,
          startedAt: null,
          completedAt: null,
          updatedAt: DateTime.makeUnsafe(0),
          type: "file_change",
          fileName: "src/a.ts",
          changes: [
            { operation: "update", path: "src/a.ts" },
            { operation: "add", path: "src/b.ts" },
            { operation: "update", path: "src/new.ts", oldPath: "src/old.ts" },
          ],
        },
      ],
    });
    assert.include(multiFilePatch, "- File change: src/a.ts, src/b.ts, src/new.ts");
  }).pipe(Effect.provide(layerTest)),
);

it("covers the run range of a very long delta", () => {
  const runs = [
    { id: RunId.make("run:long-delta-early"), ordinal: 2 },
    { id: RunId.make("run:long-delta-late"), ordinal: 5 },
  ];
  const items = Array.from({ length: 150_000 }, (_, index) => ({
    runId: runs[index % 2]!.id,
  }));

  assert.deepEqual(
    ContextHandoffService.visibleDeltaRunOrdinals({ runs }, [...items, { runId: null }]),
    { from: 2, to: 5 },
  );
});

it.effect("inherited history stops at a missing fork ancestor", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const threadId = ThreadId.make("thread:fork-of-missing");
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:fork-of-missing"),
      title: "Fork of a missing thread",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: {
        type: "run",
        threadId: ThreadId.make("thread:missing-ancestor"),
        runId: RunId.make("run:missing-ancestor"),
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
    };
    const items = yield* ContextHandoffService.readInheritedHandoffItems(
      {
        getForkSourceRunIds: () => Effect.succeed([]),
        getThreadRecords: (missing) =>
          Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: missing })),
      },
      thread,
    );
    assert.deepEqual(items, []);
  }),
);

it.layer(layerTest)("ContextHandoffService structured cross-provider synthesis", (it) => {
  it.effect(
    "preserves files touched, decisions, verification state, and open steps across Claude <-> Antigravity switch",
    () =>
      Effect.gen(function* () {
        const now = DateTime.makeUnsafe("2026-11-12T18:00:00.000Z");
        const threadId = ThreadId.make("thread:claude-to-agy");
        const base = {
          threadId,
          runId: RunId.make("run:1"),
          nodeId: null,
          providerThreadId: ProviderThreadId.make("provider-thread:claude"),
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        const items: ReadonlyArray<OrchestrationV2TurnItem> = [
          {
            ...base,
            id: TurnItemId.make("item:1"),
            ordinal: 1,
            type: "user_message",
            messageId: MessageId.make("msg:1"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            attachments: [],
            text: "Implement automatic Claude <-> Antigravity quota fallback and structured context handoff synthesis.",
          },
          {
            ...base,
            id: TurnItemId.make("item:2"),
            ordinal: 2,
            type: "assistant_message",
            messageId: MessageId.make("msg:2"),
            streaming: false,
            text: "Approach:\n- Decided to synthesize structured sections inside ContextHandoffService.\n- Implemented UsageLimitRecoveryWorker fallback routing.",
          },
          {
            ...base,
            id: TurnItemId.make("item:3"),
            ordinal: 3,
            type: "file_change",
            fileName: "packages/contracts/src/settings.ts",
            changes: [
              { operation: "update", path: "packages/contracts/src/settings.ts" },
              {
                operation: "update",
                path: "apps/server/src/orchestration-v2/ContextHandoffService.ts",
              },
            ],
          },
          {
            ...base,
            id: TurnItemId.make("item:4"),
            ordinal: 4,
            type: "command_execution",
            status: "failed",
            input: "vp.cmd test run src/orchestration-v2/ContextHandoffService.test.ts",
            exitCode: 1,
            output: "FAIL AssertionError: expected section header",
          },
          {
            ...base,
            id: TurnItemId.make("item:5"),
            ordinal: 5,
            type: "command_execution",
            status: "completed",
            input: "vp.cmd test run src/orchestration-v2/ContextHandoffService.test.ts",
            exitCode: 0,
            output: "Test Files 1 passed (1)",
          },
          {
            ...base,
            id: TurnItemId.make("item:6"),
            ordinal: 6,
            type: "command_execution",
            status: "failed",
            input: "vp.cmd lint apps/server/src/orchestration-v2/ContextHandoffService.ts",
            exitCode: 1,
            output: "error: prefer-effect-fn violation at line 42",
          },
          {
            ...base,
            id: TurnItemId.make("item:7"),
            ordinal: 7,
            type: "todo_list",
            planId: PlanId.make("plan:1"),
            steps: [
              { id: "step-1", text: "Update settings schema", status: "completed" },
              {
                id: "step-2",
                text: "Fix oxlint warning and run full typecheck",
                status: "pending",
              },
            ],
          },
          {
            ...base,
            id: TurnItemId.make("item:8"),
            ordinal: 8,
            type: "error",
            status: "failed",
            failure: {
              class: "usage_limit",
              code: null,
              message: "Claude rate limit reached; switching to Antigravity.",
              retryable: true,
            },
          },
        ];

        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const handoff = yield* service.prepareProviderHandoff({
          threadId,
          targetRunId: RunId.make("run:2"),
          transferId: ContextTransferId.make("transfer:claude-to-agy"),
          fromProviderThreadIds: [ProviderThreadId.make("provider-thread:claude")],
          toProviderThreadId: ProviderThreadId.make("provider-thread:antigravity"),
          fromProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
          toProviderInstanceId: ProviderInstanceId.make("antigravity"),
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          items,
          createdAt: now,
        });

        const coverage = handoff.history?.coverage ?? "";
        assert.isAtMost(historyCost([], coverage), 3_800);
        for (const section of [
          "## Objective",
          "## Key Decisions",
          "## Files Modified",
          "## Verification State",
          "## Open Next Steps",
        ]) {
          assert.include(coverage, section);
          assert.include(handoff.summaryText, section);
        }
        assert.include(coverage, "packages/contracts/src/settings.ts");
        assert.include(coverage, "apps/server/src/orchestration-v2/ContextHandoffService.ts");
        assert.include(
          coverage,
          "`vp.cmd test run src/orchestration-v2/ContextHandoffService.test.ts` -> passed (exit 0)",
        );
        assert.notInclude(
          coverage,
          "`vp.cmd test run src/orchestration-v2/ContextHandoffService.test.ts` -> failed (exit 1)",
        );
        assert.include(
          coverage,
          "`vp.cmd lint apps/server/src/orchestration-v2/ContextHandoffService.ts` -> failed (exit 1)",
        );
        assert.include(coverage, "[pending] Fix oxlint warning and run full typecheck");
        assert.include(coverage, "usage_limit");
      }),
  );

  it("bounds structured synthesis within a tight byte budget without breaking UTF-16", () => {
    const now = DateTime.makeUnsafe("2026-11-12T18:00:00.000Z");
    const threadId = ThreadId.make("thread:bounded");
    const items: Array<OrchestrationV2TurnItem> = [
      {
        id: TurnItemId.make("item:u1"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: MessageId.make("msg:u1"),
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        attachments: [],
        text: `${"Objective 🧪 ".repeat(40)}done`,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: TurnItemId.make(`item:f${index}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 2,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "file_change" as const,
        fileName: `src/module-${index}/file-${index}.ts`,
      })),
    ];

    const summary = ContextHandoffService.buildStructuredHandoffSummary(items, 900);
    assert.isAtMost(Buffer.byteLength(summary, "utf8"), 900);
    assert.isTrue(summary.isWellFormed());
    assert.include(summary, "## Objective");
    assert.include(summary, "## Files Modified");
  });

  it.effect(
    "compresses oversized failed command logs in handoffs while preserving ERROR and FATAL lines without CCR footer bloat",
    () =>
      Effect.gen(function* () {
        const now = DateTime.makeUnsafe("2026-11-13T01:00:00.000Z");
        const threadId = ThreadId.make("thread:oversized-handoff-logs");
        const noisyLog = [
          ...Array.from(
            { length: 30 },
            (_, idx) => `2026-11-13T01:00:00Z INFO compiling module_${idx} status=ok`,
          ),
          "2026-11-13T01:00:31Z FATAL schema checksum mismatch in migration 042",
          "2026-11-13T01:00:32Z ERROR TypeError: cannot read property 'id' of undefined",
          ...Array.from(
            { length: 30 },
            (_, idx) => `2026-11-13T01:01:00Z INFO cleanup step_${idx} done`,
          ),
          "Command exited with status 1",
        ].join("\n");
        assert.isAtLeast(noisyLog.length, 1_200);

        const items: ReadonlyArray<OrchestrationV2TurnItem> = [
          {
            id: TurnItemId.make("item:user-1"),
            threadId,
            runId: RunId.make("run:1"),
            nodeId: null,
            providerThreadId: ProviderThreadId.make("provider-thread:claude"),
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make("msg:1"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            attachments: [],
            text: "Fix the failing verification run and hand off to Antigravity.",
          },
          {
            id: TurnItemId.make("item:cmd-1"),
            threadId,
            runId: RunId.make("run:1"),
            nodeId: null,
            providerThreadId: ProviderThreadId.make("provider-thread:claude"),
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "command_execution",
            input: "vp.cmd run verify",
            exitCode: 1,
            output: noisyLog,
          },
        ];

        const service = yield* ContextHandoffService.ContextHandoffServiceV2;
        const handoff = yield* service.prepareProviderHandoff({
          threadId,
          targetRunId: RunId.make("run:2"),
          transferId: ContextTransferId.make("transfer:oversized-logs"),
          fromProviderThreadIds: [ProviderThreadId.make("provider-thread:claude")],
          toProviderThreadId: ProviderThreadId.make("provider-thread:antigravity"),
          fromProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
          toProviderInstanceId: ProviderInstanceId.make("antigravity"),
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          items,
          createdAt: now,
        });

        const coverage = handoff.history?.coverage ?? "";
        assert.include(coverage, "FATAL schema checksum mismatch in migration 042");
        assert.include(coverage, "ERROR TypeError: cannot read property 'id' of undefined");
        assert.notInclude(coverage, "[T3 CCR:");
        assert.notInclude(handoff.summaryText, "[T3 CCR:");

        const sideChat = ContextHandoffService.makeSideChatContext({
          parentThreadId: threadId,
          digest: items,
        });
        assert.include(sideChat, "FATAL schema checksum mismatch in migration 042");
        assert.include(sideChat, "ERROR TypeError: cannot read property 'id' of undefined");
        assert.notInclude(sideChat, "[T3 CCR:");
      }),
  );

  it("flags unverified source file edits in verification state and open next steps", () => {
    const now = DateTime.makeUnsafe("2026-11-14T12:00:00.000Z");
    const threadId = ThreadId.make("thread:unverified-handoff");
    const summary = ContextHandoffService.buildStructuredHandoffSummary([
      {
        id: TurnItemId.make("item:u1"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: MessageId.make("msg:u1"),
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        attachments: [],
        text: "Refactor ContextHandoffService verification gate summary.",
      },
      {
        id: TurnItemId.make("item:f1"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "file_change",
        fileName: "apps/server/src/orchestration-v2/ContextHandoffService.ts",
        changes: [
          {
            operation: "update",
            path: "apps/server/src/orchestration-v2/ContextHandoffService.ts",
          },
        ],
      },
    ]);
    assert.include(
      summary,
      "Unverified source edits (apps/server/src/orchestration-v2/ContextHandoffService.ts)",
    );
    assert.include(
      summary,
      "Verify modified source files (apps/server/src/orchestration-v2/ContextHandoffService.ts) with scoped tests/typecheck",
    );
  });
});

const clearNow = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const clearAncestorId = ThreadId.make("thread:ancestor-before-clear");
const clearSourceId = ThreadId.make("thread:source-with-clear");
const clearAncestorRunId = RunId.make("run:ancestor-1");

function clearRun(id: RunId, threadId: ThreadId, ordinal: number, freshContext?: boolean) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: ProviderThreadId.make(`pt:${id}`),
    userMessageId: MessageId.make(`msg:${id}`),
    rootNodeId: null as never,
    activeAttemptId: null,
    status: "completed" as const,
    queuePosition: null,
    requestedAt: clearNow,
    startedAt: clearNow,
    completedAt: clearNow,
    checkpointId: null,
    contextHandoffId: null,
    ...(freshContext ? { freshContext: true } : {}),
  };
}

function clearUserItem(
  id: string,
  threadId: ThreadId,
  runId: RunId,
  text: string,
  ordinal: number,
  scheduledTaskId?: string,
) {
  return {
    ...importedItem({ role: "user", id, text, ordinal }),
    threadId,
    runId,
    ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
  } as OrchestrationV2TurnItem;
}

function clearThread(
  id: ThreadId,
  forkedFrom: OrchestrationV2AppThread["forkedFrom"],
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:clear-fork"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: clearAncestorId },
    forkedFrom,
    createdAt: clearNow,
    updatedAt: clearNow,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
  };
}

/** Portable fork history of a source forked from an ancestor, through its last run. */
const readClearFork = Effect.fn(function* (
  sourceRuns: ReadonlyArray<ReturnType<typeof clearRun>>,
  sourceItems: ReadonlyArray<OrchestrationV2TurnItem>,
) {
  const sourceThread = clearThread(clearSourceId, {
    type: "run",
    threadId: clearAncestorId,
    runId: clearAncestorRunId,
  });
  const fork = clearThread(ThreadId.make("thread:clear-fork"), {
    type: "run",
    threadId: clearSourceId,
    runId: sourceRuns.at(-1)!.id,
  });
  const store = {
    getForkSourceRunIds: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === clearSourceId ? [clearAncestorRunId] : sourceRuns.map((run) => run.id),
      ),
    getThreadRecords: (threadId: ThreadId) =>
      Effect.succeed(
        (threadId === clearAncestorId
          ? {
              thread: clearThread(clearAncestorId, null),
              runs: [clearRun(clearAncestorRunId, clearAncestorId, 1)],
              attempts: [],
              turnItems: [
                clearUserItem("anc", clearAncestorId, clearAncestorRunId, "ancestor history", 1),
              ],
            }
          : {
              thread: sourceThread,
              runs: sourceRuns,
              attempts: [],
              turnItems: sourceItems,
            }) as never,
      ),
  };
  const items = yield* ContextHandoffService.readForkHistoryItems(
    store as never,
    { thread: sourceThread, runs: sourceRuns, attempts: [] } as never,
    sourceRuns.at(-1)!,
    fork,
  );
  return items.map((item) => (item.type === "user_message" ? item.text : ""));
});

it.effect("portable fork history stops at /clear (freshContext) and drops ancestor history", () =>
  Effect.gen(function* () {
    const before = RunId.make("run:source-1");
    const clear = RunId.make("run:source-2-clear");
    const texts = yield* readClearFork(
      [clearRun(before, clearSourceId, 1), clearRun(clear, clearSourceId, 2, true)],
      [
        clearUserItem("old", clearSourceId, before, "before clear", 1),
        clearUserItem("new", clearSourceId, clear, "after clear", 2),
      ],
    );
    assert.deepEqual(texts, ["after clear"]);
  }),
);

it.effect("portable fork history keeps history past a restarted scheduled fresh run", () =>
  Effect.gen(function* () {
    const before = RunId.make("run:source-1");
    const scheduled = RunId.make("run:source-2-scheduled");
    const after = RunId.make("run:source-3");
    // A steering restart points userMessageId at the steer, which carries no scheduledTaskId.
    const scheduledRun = {
      ...clearRun(scheduled, clearSourceId, 2, true),
      userMessageId: MessageId.make("message:steer"),
    };
    const texts = yield* readClearFork(
      [clearRun(before, clearSourceId, 1), scheduledRun, clearRun(after, clearSourceId, 3)],
      [
        clearUserItem("old", clearSourceId, before, "before schedule", 1),
        clearUserItem("sched", clearSourceId, scheduled, "scheduled prompt", 2, "task-1"),
        clearUserItem("steer", clearSourceId, scheduled, "steer", 3),
        clearUserItem("new", clearSourceId, after, "after schedule", 4),
      ],
    );
    assert.deepEqual(texts, [
      "ancestor history",
      "before schedule",
      "scheduled prompt",
      "steer",
      "after schedule",
    ]);
  }),
);
