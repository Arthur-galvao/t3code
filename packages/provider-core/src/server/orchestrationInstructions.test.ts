import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS,
  distillTechnicalPromptSpec,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
  withSessionRsiLessonsPrefix,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });

  it("injects RSI lessons only at session start to keep mid-thread KV prefixes stable", () => {
    const rsiPrefix = "[RSI Lessons]\n- Run targeted unit tests before full build.";

    assert.include(
      withSessionRsiLessonsPrefix({
        prompt: "Fix the failing parser.",
        rsiPrefix,
        isNewSession: true,
      }),
      "<t3_code_rsi_lessons>\n[RSI Lessons]",
    );
    assert.equal(
      withSessionRsiLessonsPrefix({
        prompt: "Continue with the tests.",
        rsiPrefix,
        isNewSession: false,
      }),
      "Continue with the tests.",
    );
    assert.equal(
      withSessionRsiLessonsPrefix({
        prompt: "/compact",
        rsiPrefix,
        isNewSession: true,
      }),
      "/compact",
    );

    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    assert.include(
      t3AcpPromptWithInstructions({ prompt: "Start", state, rsiPrefix }),
      "<t3_code_rsi_lessons>",
    );
    // Even if device tools turn on mid-thread, RSI prefix must not be injected on existing ACP sessions.
    assert.notInclude(
      t3AcpPromptWithInstructions({
        prompt: "Next",
        state: { ...state, hasDeviceTools: true },
        previousState: state,
        rsiPrefix,
      }),
      "<t3_code_rsi_lessons>",
    );

    assert.include(
      t3OrchestrationPrompt({
        prompt: "Start",
        hasT3Mcp: false,
        hasDeviceTools: false,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
        rsiPrefix,
      }),
      "<t3_code_rsi_lessons>",
    );
    assert.notInclude(
      t3OrchestrationPrompt({
        prompt: "Turn 2",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered: false,
        rsiPrefix,
      }),
      "<t3_code_rsi_lessons>",
    );
  });

  it("exports concise KV-cache-friendly output shaper instructions", () => {
    assert.include(T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS, "<output_shaper>");
    assert.include(T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS, "context_retrieve");
    assert.include(T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS, "tailscale serve");
    assert.match(T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS, /never [`']?funnel[`']?/i);
    assert.isBelow(T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS.length, 400);
  });

  it("distills non-English and underspecified prompts into a terse Technical English Auto-Spec hint", () => {
    const ptBroad = distillTechnicalPromptSpec(
      "melhorar o sistema de tela e criar um botão novo com economia de token",
    );
    assert.isTrue(ptBroad.isNonEnglish);
    assert.isTrue(ptBroad.needsClarification);
    assert.include(ptBroad.domains, "ui-frontend");
    assert.include(ptBroad.domains, "token-economy");
    assert.include(ptBroad.specHint ?? "", "[Auto-Spec]");
    assert.include(ptBroad.specHint ?? "", "ask 1-3 brief clarifying questions");

    const concreteEnglish = distillTechnicalPromptSpec(
      "Fix the failing parser in apps/server/src/parser.ts",
    );
    assert.isFalse(concreteEnglish.isNonEnglish);
    assert.isFalse(concreteEnglish.needsClarification);
    assert.isUndefined(concreteEnglish.specHint);
  });

  it("routes UI and advisor roles to available models while keeping Codex section byte limits", () => {
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Fable 5.2");
    assert.notInclude(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Gemini 4 Argon");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Advisor: Claude Opus 5.5");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Gemini 4 Neon");
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      assert.isBelow(Buffer.byteLength(section, "utf8"), 4_000);
    }
  });
});
