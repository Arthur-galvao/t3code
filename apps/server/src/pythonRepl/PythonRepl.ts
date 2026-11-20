import type { ThreadId } from "@t3tools/contracts";
import { defaultCcrStore } from "@t3tools/provider-core/server/ccrStore";
import { compressToolOutput } from "@t3tools/provider-core/server/contextCompressor";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_CHARS = 30_000;
// Measured on 981 REPL calls: below ~6k chars a CCR stub made agents re-fetch 30-43% of the time
// (vs ~10% uncompressed), which costs more than the tokens saved; above 6k the excess fell to ~10%.
const COMPRESS_MIN_CHARS = 6_000;

// fd 0 and 1 move to private handles so user code and its children cannot corrupt the protocol.
const DRIVER = String.raw`
import ast, contextlib, io, json, os, sys, traceback
requests = os.fdopen(os.dup(0), "r", encoding="utf-8", newline="\n")
replies = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
os.dup2(2, 1)
scope = {"__name__": "__main__"}
for line in requests:
    code = json.loads(line)["code"]
    buffer = io.StringIO()
    error = ""
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        try:
            tree = ast.parse(code, "<python>")
            last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, "<python>", "exec"), scope)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), "<python>", "eval"), scope)
                if value is not None:
                    print(repr(value))
        except BaseException:
            error = traceback.format_exc()
    replies.write(json.dumps({"output": buffer.getvalue(), "error": error}) + "\n")
    replies.flush()
`;

export class PythonReplStartError extends Schema.TaggedError<PythonReplStartError>()(
  "PythonReplStartError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface PythonReplResult {
  readonly output: string;
  readonly error?: string;
  readonly note?: string;
}

const Reply = Schema.Struct({ output: Schema.String, error: Schema.String });
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));
const encodeRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String })),
);
const encoder = new TextEncoder();

const clip = (text: string, max: number) =>
  text.length <= max
    ? text
    : `${text.slice(0, max / 2)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-max / 2)}`;

const formatReplCcrFooter = (ccrId: string, originalLen: number, finalLen: number): string => {
  const tokensSavedEst = Math.max(0, Math.round((originalLen - finalLen) / 4));
  return `[T3 CCR:${ccrId} (text): ${originalLen} -> ${finalLen} chars (~${tokensSavedEst} tok saved) | call context_retrieve(ccrId="${ccrId}") for exact lines/search]`;
};

const stripTrailingCcrFooter = (text: string): string =>
  text.replace(/\n\n\[T3 CCR:ccr_\d+[^\n]*\]$/, "");

const buildClippedCcrText = (bodySource: string, originalLen: number, ccrId: string): string => {
  const clippedBody = clip(bodySource, MAX_OUTPUT_CHARS - 240);
  let finalLen = clippedBody.length + 2 + 160;
  let finalText = `${clippedBody}\n\n${formatReplCcrFooter(ccrId, originalLen, finalLen)}`;
  for (let i = 0; i < 3 && finalText.length !== finalLen; i += 1) {
    finalLen = finalText.length;
    finalText = `${clippedBody}\n\n${formatReplCcrFooter(ccrId, originalLen, finalLen)}`;
  }
  return finalText;
};

const shapeReplText = (text: string, threadId: ThreadId, sourceLabel: string): string => {
  if (text.length <= COMPRESS_MIN_CHARS) {
    return text;
  }
  const compressed = compressToolOutput({
    text,
    threadId,
    sourceLabel,
    minChars: COMPRESS_MIN_CHARS,
    store: defaultCcrStore,
  });
  if (compressed.compressed) {
    if (compressed.text.length <= MAX_OUTPUT_CHARS) {
      return compressed.text;
    }
    if (compressed.ccrId !== undefined) {
      return buildClippedCcrText(
        stripTrailingCcrFooter(compressed.text),
        text.length,
        compressed.ccrId,
      );
    }
  }
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  const entry = defaultCcrStore.put({
    content: text,
    contentType: "text",
    threadId,
    sourceLabel,
  });
  const finalText = buildClippedCcrText(text, text.length, entry.ccrId);
  defaultCcrStore.recordCompression(text.length, finalText.length, threadId);
  return finalText;
};

interface Session {
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly requests: Queue.Queue<Uint8Array>;
  readonly replies: Queue.Queue<string>;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
}

export class PythonRepl extends Context.Service<
  PythonRepl,
  {
    readonly run: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly code: string;
      readonly timeoutSeconds?: number | undefined;
      readonly reset?: boolean | undefined;
    }) => Effect.Effect<PythonReplResult, PythonReplStartError>;
    readonly close: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/pythonRepl/PythonRepl") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const lock = yield* KeyedLock.make<ThreadId>();
  const sessions = new Map<ThreadId, Session>();

  const interpreters: ReadonlyArray<readonly [string, ReadonlyArray<string>]> =
    platform === "win32"
      ? [
          ["py", ["-3"]],
          ["python", []],
        ]
      : [
          ["python3", []],
          ["python", []],
        ];

  const findInterpreter = Effect.fn("PythonRepl.findInterpreter")(function* () {
    for (const [command, args] of interpreters) {
      const resolved = yield* resolveCommandPath(command).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (resolved !== null) return { command: resolved, args };
    }
    return yield* new PythonReplStartError({
      reason: "Python 3 was not found on this machine's PATH.",
    });
  });

  const start = Effect.fn("PythonRepl.start")(function* (threadId: ThreadId, cwd: string) {
    const interpreter = yield* findInterpreter();
    const scope = yield* Scope.make();
    const requests = yield* Queue.unbounded<Uint8Array>();
    const replies = yield* Queue.unbounded<string>();
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(interpreter.command, [...interpreter.args, "-u", "-c", DRIVER], {
            cwd,
            extendEnv: true,
            env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
            stdin: Stream.fromQueue(requests),
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "2 seconds",
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) => new PythonReplStartError({ reason: "Python could not be started.", cause }),
          ),
        );
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(replies, line)),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
      const session: Session = { cwd, scope, requests, replies, child };
      sessions.set(threadId, session);
      return session;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  });

  const stop = Effect.fn("PythonRepl.stop")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (session === undefined) return;
    sessions.delete(threadId);
    yield* Scope.close(session.scope, Exit.void);
  });

  const run: PythonRepl["Service"]["run"] = Effect.fn("PythonRepl.run")(function* (input) {
    return yield* lock.withLock(
      input.threadId,
      Effect.gen(function* () {
        let note: string | undefined;
        const existing = sessions.get(input.threadId);
        if (existing !== undefined) {
          const running = yield* existing.child.isRunning.pipe(Effect.orElseSucceed(() => false));
          if (input.reset === true) {
            yield* stop(input.threadId);
          } else if (!running || existing.cwd !== input.cwd) {
            yield* stop(input.threadId);
            note = running
              ? "The working directory changed, so Python was restarted and earlier variables are gone."
              : "The Python process had exited, so it was restarted and earlier variables are gone.";
          }
        }
        const session = sessions.get(input.threadId) ?? (yield* start(input.threadId, input.cwd));
        const seconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        yield* Queue.offer(
          session.requests,
          encoder.encode(`${encodeRequest({ code: input.code })}\n`),
        );
        const outcome = yield* Effect.raceFirst(
          Queue.take(session.replies).pipe(Effect.map((line) => ({ line }) as const)),
          session.child.exitCode.pipe(Effect.ignore, Effect.as("exited" as const)),
        ).pipe(
          Effect.timeoutOption(`${seconds * 1000} millis`),
          Effect.map(Option.getOrElse(() => "timeout" as const)),
          Effect.onInterrupt(() => stop(input.threadId)),
        );
        if (outcome === "timeout" || outcome === "exited") {
          yield* stop(input.threadId);
          return {
            output: "",
            note:
              outcome === "timeout"
                ? `Timed out after ${seconds}s. Python was restarted and all variables are gone.`
                : "The Python process exited during the call. It will restart on the next call and all variables are gone.",
          };
        }
        const reply = decodeReply(outcome.line);
        if (Option.isNone(reply)) {
          yield* stop(input.threadId);
          return {
            output: "",
            note: "Python returned an unreadable reply and was restarted; all variables are gone.",
          };
        }
        return {
          output: shapeReplText(reply.value.output, input.threadId, "python:stdout"),
          ...(reply.value.error === ""
            ? {}
            : { error: shapeReplText(reply.value.error, input.threadId, "python:stderr") }),
          ...(note === undefined ? {} : { note }),
        };
      }),
    );
  });

  const close: PythonRepl["Service"]["close"] = Effect.fn("PythonRepl.close")(function* (threadId) {
    yield* lock.withLock(threadId, stop(threadId));
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(Array.from(sessions.keys()), stop, { discard: true }),
  );

  return PythonRepl.of({ run, close });
});

export const layer = Layer.effect(PythonRepl, make);
