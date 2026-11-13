import { assert, it } from "@effect/vitest";

import {
  canonicalizeToolItemSignature,
  createLoopCircuitBreakerState,
  evaluateLoopCircuitBreaker,
  type LoopCircuitBreakerItemLike,
} from "./LoopCircuitBreaker.ts";

function feedItems(items: ReadonlyArray<LoopCircuitBreakerItemLike>) {
  let state = createLoopCircuitBreakerState();
  for (const item of items) {
    state = evaluateLoopCircuitBreaker(state, item).state;
  }
  return state;
}

it("trips on 3 consecutive identical command_execution failures", () => {
  const state = feedItems([
    {
      id: "cmd-1",
      type: "command_execution",
      status: "failed",
      input: "vp   test   run",
      output: "Error: connection refused at 2026-11-12T10:00:00Z pid=101",
      exitCode: 1,
    },
    {
      id: "cmd-2",
      type: "command_execution",
      status: "completed",
      input: "vp test run",
      output: "Error: connection refused at 2026-11-12T10:01:00Z pid=202",
      exitCode: 1,
      outputIndicatesFailure: true,
    },
    {
      id: "cmd-3",
      type: "command_execution",
      status: "failed",
      input: "vp test run",
      output: "Error: connection refused at 2026-11-12T10:02:00Z pid=303",
      exitCode: 1,
    },
  ]);

  assert.isTrue(state.decision.tripped);
  assert.strictEqual(state.decision.category, "consecutive_failure");
  assert.strictEqual(state.decision.consecutiveSameFailure, 3);
  assert.include(state.decision.reason ?? "", "Repeated command_execution failure (3x in a row)");
});

it("resets consecutiveSameFailure on ANY successful run of the same tool/target (never cumulative lockout)", () => {
  const items: ReadonlyArray<LoopCircuitBreakerItemLike> = [
    { id: "c1", type: "command_execution", status: "failed", input: "pnpm test", output: "fail" },
    { id: "c2", type: "command_execution", status: "failed", input: "pnpm test", output: "fail" },
    { id: "c3", type: "command_execution", status: "completed", input: "pnpm test", exitCode: 0 },
    { id: "c4", type: "command_execution", status: "failed", input: "pnpm test", output: "fail" },
    { id: "c5", type: "command_execution", status: "failed", input: "pnpm test", output: "fail" },
  ];

  const state = feedItems(items);
  assert.isFalse(state.decision.tripped);
  assert.strictEqual(state.consecutiveSameFailure, 2);

  // One more failure trips at 3 consecutive failures.
  const tripped = evaluateLoopCircuitBreaker(state, {
    id: "c6",
    type: "command_execution",
    status: "failed",
    input: "pnpm test",
    output: "fail",
  });
  assert.isTrue(tripped.decision.tripped);
  assert.strictEqual(tripped.decision.category, "consecutive_failure");
});

it("detects A->B->A->B oscillation cycles (>= 2 cycles) across mixed tool types", () => {
  const failA: Omit<LoopCircuitBreakerItemLike, "id"> = {
    type: "file_change",
    status: "failed",
    fileName: "src/app.ts",
    error: "patch conflict",
  };
  const failB: Omit<LoopCircuitBreakerItemLike, "id"> = {
    type: "mcp_tool_call",
    status: "failed",
    toolName: "run_checks",
    input: { suite: "unit" },
    error: "lint error",
  };

  // Single A -> B -> A alternation does not trip yet (1 cycle).
  const beforeThreshold = feedItems([
    { ...failA, id: "a1" },
    { ...failB, id: "b1" },
    { ...failA, id: "a2" },
  ]);
  assert.isFalse(beforeThreshold.decision.tripped);
  assert.strictEqual(beforeThreshold.decision.oscillationCycles, 1);

  // Fourth alternating failure (A -> B -> A -> B) reaches 2 cycles and trips.
  const atThreshold = evaluateLoopCircuitBreaker(beforeThreshold, { ...failB, id: "b2" });
  assert.isTrue(atThreshold.decision.tripped);
  assert.strictEqual(atThreshold.decision.category, "oscillation");
  assert.strictEqual(atThreshold.decision.oscillationCycles, 2);
});

it("deduplicates repeated terminal snapshots for the same turn item id", () => {
  const repeatedItem: LoopCircuitBreakerItemLike = {
    id: "item-same",
    type: "dynamic_tool_call",
    status: "failed",
    toolName: "read_file",
    input: { path: "missing.ts" },
    output: { isError: true, message: "ENOENT" },
  };

  const state = feedItems([
    { ...repeatedItem, status: "running" },
    repeatedItem,
    repeatedItem,
    repeatedItem,
  ]);
  assert.isFalse(state.decision.tripped);
  assert.strictEqual(state.consecutiveSameFailure, 1);
});

it("canonicalizes dynamic_tool objects deterministically regardless of key order", () => {
  const sig1 = canonicalizeToolItemSignature({
    type: "dynamic_tool",
    status: "failed",
    toolName: "delegate_task",
    input: { b: 2, a: 1 },
    output: { isError: true, error: "Bad UUID 123e4567-e89b-12d3-a456-426614174000" },
  });
  const sig2 = canonicalizeToolItemSignature({
    type: "dynamic_tool",
    status: "failed",
    toolName: "delegate_task",
    input: { a: 1, b: 2 },
    output: { isError: true, error: "Bad UUID aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  });
  assert.strictEqual(sig1.key, sig2.key);
});
