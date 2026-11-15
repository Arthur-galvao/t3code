import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PythonRepl from "../../../pythonRepl/PythonRepl.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PythonTool = Tool.make("python", {
  description:
    "Run Python 3 in this thread's persistent interpreter, started in the thread's working directory. Variables, imports and functions stay defined between calls. The value of a final expression is printed. For shell commands use subprocess with capture_output=True.",
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isMinLength(1)).annotate({ description: "Python source." }),
    timeout_seconds: Schema.optional(
      Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3_600 })).annotate({
        description: `Default ${PythonRepl.DEFAULT_TIMEOUT_SECONDS}. On timeout Python restarts and variables are lost.`,
      }),
    ),
    reset: Schema.optional(
      Schema.Boolean.annotate({ description: "Restart Python with no variables before running." }),
    ),
  }),
  success: Schema.Struct({
    output: Schema.String,
    error: Schema.optional(Schema.String),
    note: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    PythonRepl.PythonRepl,
  ],
})
  .annotate(Tool.Title, "Run Python")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true })
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.pythonReplEnabled);

export const PythonToolkit = Toolkit.make(PythonTool);
