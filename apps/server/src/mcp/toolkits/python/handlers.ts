import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as PythonRepl from "../../../pythonRepl/PythonRepl.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { PythonToolkit } from "./tools.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const handlers = {
  python: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, caller, limits } = yield* loadCaller();
      if (!scope.capabilities.has("python") || caller === undefined) {
        return yield* failure("capability_denied", "Python REPL mode is off for this thread.");
      }
      // Python is unsandboxed, so a plan-mode (read-only) thread cannot use it.
      if (limits.interactionMode === "plan") {
        return yield* failure("capability_denied", "Python is not available in plan mode.");
      }
      const project = yield* (yield* ProjectService.ProjectService)
        .getById(caller.projectId)
        .pipe(Effect.mapError(unavailable));
      const cwd = caller.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
      if (cwd === undefined) return yield* failure("invalid_request", "The project was not found.");
      return yield* (yield* PythonRepl.PythonRepl)
        .run({
          threadId: caller.id,
          cwd,
          code: input.code,
          timeoutSeconds: input.timeout_seconds,
          reset: input.reset,
        })
        .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PythonToolkit.tools>;

export const layer = McpToolAccess.toLayer(PythonToolkit, handlers);
