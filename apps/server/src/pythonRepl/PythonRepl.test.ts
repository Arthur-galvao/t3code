import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { defaultCcrStore } from "@t3tools/provider-core/server/ccrStore";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PythonRepl from "./PythonRepl.ts";

const threadId = ThreadId.make("thread-python-repl");
const cwd = process.cwd();
const TestLayer = PythonRepl.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live("keeps variables, reports tracebacks, and restarts on reset or timeout", () =>
  Effect.gen(function* () {
    const repl = yield* PythonRepl.PythonRepl;
    const run = (code: string, extra?: { reset?: boolean; timeoutSeconds?: number }) =>
      repl.run({ threadId, cwd, code, ...extra });

    yield* run("x = 41");
    expect(yield* run("print('hi')\nx + 1")).toEqual({ output: "hi\n42\n" });

    const failed = yield* run("1 / 0");
    expect(failed.error).toContain("ZeroDivisionError");
    expect((yield* run("x")).output).toBe("41\n");

    const timedOut = yield* run("while True: pass", { timeoutSeconds: 0.5 });
    expect(timedOut.note).toContain("Timed out");
    expect((yield* run("x")).error).toContain("NameError");

    yield* run("y = 1");
    expect((yield* run("y", { reset: true })).error).toContain("NameError");
  }).pipe(Effect.provide(TestLayer)),
);

it.live("stores oversized output in thread-scoped CCR instead of lossy clipping", () =>
  Effect.gen(function* () {
    const repl = yield* PythonRepl.PythonRepl;
    const ccrThreadId = ThreadId.make("thread-python-repl-ccr");
    const result = yield* repl.run({
      threadId: ccrThreadId,
      cwd,
      code: "for i in range(600): print(f'line-{i:04d}-' + ('x' * 50))",
    });

    expect(result.output).toContain("[T3 CCR:");
    const match = /\[T3 CCR:(ccr_\d+)/.exec(result.output);
    expect(match).not.toBeNull();
    const ccrId = match![1]!;

    const retrieved = defaultCcrStore.retrieve({
      ccrId,
      threadId: ccrThreadId,
      startLine: 1,
      endLine: 601,
      maxChars: 100_000,
    });
    expect(retrieved.found).toBe(true);
    expect(retrieved.threadId).toBe(ccrThreadId);
    expect(retrieved.content).toContain("L1: line-0000-");
    expect(retrieved.content).toContain("L300: line-0299-");
    expect(retrieved.content).toContain("L600: line-0599-");
    expect(defaultCcrStore.getStats(ccrThreadId).entriesCount).toBe(1);
    expect(defaultCcrStore.getStats(ccrThreadId).compressedCallsCount).toBe(1);

    // Output that compresses (>15% reduction) yet still exceeds MAX_OUTPUT_CHARS must not double-put or double-count.
    const partialThreadId = ThreadId.make("thread-python-repl-ccr-partial");
    const partialResult = yield* repl.run({
      threadId: partialThreadId,
      cwd,
      code: "for i in range(450): print(f'ERROR item-{i:04d} ' + ('z' * 80))\nfor j in range(400): print('INFO noise line')",
    });
    expect(partialResult.output.length).toBeLessThanOrEqual(30_000);
    expect(partialResult.output).toContain("[T3 CCR:");
    expect(defaultCcrStore.getStats(partialThreadId).entriesCount).toBe(1);
    expect(defaultCcrStore.getStats(partialThreadId).compressedCallsCount).toBe(1);
  }).pipe(Effect.provide(TestLayer)),
);

it.live("leaves output up to 6k chars alone and compresses it above that", () =>
  Effect.gen(function* () {
    const repl = yield* PythonRepl.PythonRepl;
    const threadId = ThreadId.make("thread-python-repl-threshold");
    // ~5.4k chars: agents re-fetch stubs this small too often, so it stays verbatim.
    const small = yield* repl.run({
      threadId,
      cwd,
      code: "for i in range(90): print(f'row-{i:03d}-' + ('y' * 50))",
    });
    expect(small.output).not.toContain("[T3 CCR:");
    expect(small.output).toContain("row-045-");
    // ~7.2k chars: compressed into a line-aware stub with a CCR id.
    const large = yield* repl.run({
      threadId,
      cwd,
      code: "for i in range(120): print(f'row-{i:03d}-' + ('y' * 50))",
    });
    expect(large.output).toContain("[T3 CCR:");
    expect(large.output).toContain("row-000-");
    expect(large.output).toContain("row-119-");
    expect(large.output.length).toBeLessThan(3_000);
  }).pipe(Effect.provide(TestLayer)),
);
