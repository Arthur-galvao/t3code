import {
  DefaultThemePreference,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";
import * as EnvironmentTheme from "../../../environmentTheme.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const Appearance = Schema.Literals(["light", "dark", "system"]);

// Gemini rejects a numeric enum in a function declaration, and the service writes `version` itself.
const ThemeFileInput = Schema.Struct(Struct.omit(EnvironmentThemeFile.fields, ["version"]));

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    EnvironmentTheme.EnvironmentThemeService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};

const ThemeReadTool = Tool.make("t3_theme_read", {
  ...shared,
  description:
    "Read T3 Code's own themes and the guide to restyle it: color roles and CSS selectors. Call before `t3_theme_set`.",
  parameters: Schema.Struct({
    themeId: Schema.optionalKey(
      EnvironmentThemeId.annotate({ description: "Also return this published theme's file." }),
    ),
  }),
  success: Schema.Struct({
    current: DefaultThemePreference,
    builtIn: Schema.Array(Schema.String),
    published: Schema.Array(
      Schema.Struct({
        id: EnvironmentThemeId,
        name: Schema.String,
        hasCss: Schema.Boolean,
        hasBackground: Schema.Boolean,
      }),
    ),
    theme: Schema.optionalKey(EnvironmentThemeFile),
    themesDir: Schema.String,
    guide: Schema.String,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThemeSetTool = Tool.make("t3_theme_set", {
  ...shared,
  description:
    "Restyle T3 Code itself, only when the user asks. With `theme`, publish it as `themeId` (same id updates it) and switch this server's web app and this machine's desktop app to it, not remote desktop apps. Without `theme`, switch to a built-in or published `themeId`. `appearance` sets light, dark, or system mode. Live full-access or default caller thread only.",
  parameters: Schema.Struct({
    themeId: Schema.optionalKey(EnvironmentThemeId),
    theme: Schema.optionalKey(ThemeFileInput),
    appearance: Schema.optionalKey(Appearance),
  }),
  success: Schema.Struct({
    themeId: Schema.optionalKey(EnvironmentThemeId),
    appearance: Schema.optionalKey(Appearance),
    published: Schema.Boolean,
  }),
}).annotate(Tool.Destructive, true);

export const ThemeToolkit = Toolkit.make(ThemeReadTool, ThemeSetTool);
