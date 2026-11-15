import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
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
