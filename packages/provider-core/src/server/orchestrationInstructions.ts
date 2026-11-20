import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool when the child uses your provider, a model it offers and no settings beyond yours (Claude \`Agent\`, \`run_in_background:false\`; Codex \`spawn_agent\`, then wait). Use \`delegate_task\` for another provider's model, user-asked settings, a separate checkout (\`isolation:"worktree"\`), or \`delegate_task\` by name. A native type on another provider's model counts too. Background agent: \`delegate_task\`, never a background \`Agent\`. Workflow only when asked.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked or fall back to native tools, Workflow or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Don't poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- As a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`. Honor a requested base. Otherwise independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. Shell worktrees don't bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it. Asked to settle a thread, this one too: \`t3_thread_organize\`.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` and that machine's \`threadId\` to T3 tools.
- Unlinked ("delegate this to my vps"): \`t3_environment_link\` with a \`hint\` from the user's words, never a pairing code in chat. No link tools: say to enable Settings → Labs → Linked environments.
- In your reply, mention a thread by its \`link\`, verbatim, never a plain title or bare id.
- A login, token, PIN, pairing code or sudo password only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. Sudo: if \`sudo -n <cmd>\` needs a password, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. Asked only to schedule: \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Don't repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
  `### Automatic workflow, routing, and advisor

Quota and cache are the budget. Apply subagent routing automatically (Workflow stays ask-only): do tiny tasks yourself (<=5 tool calls, <=3 files); offload larger or noisy work so raw output stays out of your context. User-named models win.

- Search, logs, inventory, mechanical edits: Claude Haiku 5.5 (\`high\`), or OpenCode free if low-stakes.
- Clear-spec impl, tests, scripts: Gemini 4 Hydrogen (\`high\`, separate quota), else Claude Sonnet 5.5.
- Hardest debugging, tough design, UI/visuals, huge inputs: Gemini 4 Neon (\`high\`).
- Cross-cutting refactors, complex reviews, long jobs (saves Gemini quota): Claude Opus 5.5 (\`medium\`; \`high\` if stuck).
- Patterns: (1) Builder vs verifier: for diffs >~30 lines or >1 file, run a fresh read-only verifier (\`Haiku\` for spec/diff; Advisor if high-risk), fixing small findings yourself. (2) Disjoint lanes: parallelize independent areas with exclusive paths; never overlap writers or sequential planning. (3) Specialized reviewers: split sensitive reviews into fresh read-only lenses (edge cases, security, simplicity). (4) Eval-gated Best-of-N (\`Hydrogen\` worktrees) when tests pick winners; blind council (hide model names) for subjective design.
- Advisor: Gemini 4 Neon (\`high\`), or Claude Opus 5.5 (\`high\`) if already Neon, saving Gemini quota, or Antigravity unavailable (only unasked switch). Top-level, skip trivial tasks: before multi-file/hard-to-undo plans, after 2 failed attempts, before handing back non-trivial work; native advisor tool or \`delegate_task\` (\`role:"review"\`, <=200 words; never implements).

Briefs stand alone: goal, done, exclusive paths, constraints, report shape.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

/** Session-invariant terseness, prompt-distillation, and Tailscale preview instructions when output shaper is enabled. */
export const T3_CODE_OUTPUT_SHAPER_INSTRUCTIONS = `<output_shaper>
Lead with answer/diff; no filler; terse bullets + file:line. Spec vague/non-English prompts in English (reply in user's lang); <=3 short Qs if unclear. Call \`context_retrieve\` for \`[T3 CCR:...]\`. If Tailscale up, publish previews via \`tailscale serve --bg --https=<p> http://127.0.0.1:<p>\` (never 443, never \`funnel\`), verify & send \`.ts.net\` URL.
</output_shaper>`;

export interface TechnicalPromptSpec {
  readonly isNonEnglish: boolean;
  readonly needsClarification: boolean;
  readonly domains: ReadonlyArray<string>;
  readonly specHint: string | undefined;
}

const NON_ENGLISH_DIACRITICS_RE = /[àáâãçéêíóôõúüñ]/i;
const PORTUGUESE_SIGNAL_RE =
  /\b(?:você|voce|para|como|fazer|crie|criar|ajustar|ajuste|melhorar|melhora|corrigir|sistema|arquivo|código|codigo|tela|botão|botao|quero|preciso|olhada|pode|tudo|ainda|sobre|usando|sem)\b/i;
const BROAD_DESIGN_ACTION_RE =
  /\b(?:create|build|implement|refactor|optimize|redesign|crie|criar|implementar|refatorar|melhorar|otimizar|sistema|arquitetura)\b/i;
const CONCRETE_TARGET_RE =
  /(?:[a-z0-9_-]+\.[a-z0-9]{1,8}|`[^`]+`|(?:apps|packages|src|scripts)\/[a-z0-9_./-]+)/i;

const PROMPT_DOMAIN_MATCHERS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "ui-frontend",
    /\b(?:ui|frontend|react|css|tailwind|component|modal|button|screen|layout|tela|botão|botao|página|pagina|interface)\b/i,
  ],
  [
    "backend-service",
    /\b(?:api|server|database|sql|sqlite|service|endpoint|rpc|websocket|servidor|banco|serviço|servico)\b/i,
  ],
  [
    "orchestration-mcp",
    /\b(?:mcp|agent|subagent|workflow|skill|orchestr|obsidian|rsi|swarm|hook|orquestr|agente|habilidade)\b/i,
  ],
  ["token-economy", /\b(?:token|cache|ccr|compress|context|prompt|budget|quota|custo|economia)\b/i],
  [
    "build-release",
    /\b(?:build|release|exe|installer|desktop|github|tag|ci|action|compil|instalador)\b/i,
  ],
  ["test-verify", /\b(?:test|vitest|lint|typecheck|oxlint|knip|verify|verifica|teste)\b/i],
  ["bugfix-debug", /\b(?:fix|bug|error|fail|crash|debug|corrig|erro|falha|quebr)\b/i],
];

/** Detect non-English or underspecified requests for zero-command Technical English refinement. */
export function distillTechnicalPromptSpec(prompt: string): TechnicalPromptSpec {
  const trimmed = prompt.trim();
  if (trimmed === "" || trimmed.startsWith("/")) {
    return { isNonEnglish: false, needsClarification: false, domains: [], specHint: undefined };
  }
  const isNonEnglish =
    NON_ENGLISH_DIACRITICS_RE.test(trimmed) || PORTUGUESE_SIGNAL_RE.test(trimmed);
  const needsClarification =
    trimmed.length >= 15 &&
    trimmed.length <= 240 &&
    BROAD_DESIGN_ACTION_RE.test(trimmed) &&
    !CONCRETE_TARGET_RE.test(trimmed);
  const domains = PROMPT_DOMAIN_MATCHERS.flatMap(([tag, re]) => (re.test(trimmed) ? [tag] : []));
  if (!isNonEnglish && !needsClarification) {
    return { isNonEnglish, needsClarification, domains, specHint: undefined };
  }
  const domainPart = domains.length > 0 ? ` (${domains.slice(0, 4).join(",")})` : "";
  const clarifyPart = needsClarification
    ? "; ask 1-3 brief clarifying questions if scope/constraints are ambiguous before editing"
    : "";
  return {
    isNonEnglish,
    needsClarification,
    domains,
    specHint: `[Auto-Spec] Formulate a terse Technical English spec internally${domainPart}${clarifyPart}; reply in user's language.`,
  };
}

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

function formatRsiLessonsBlock(rsiPrefix: string | undefined): string | undefined {
  const trimmed = rsiPrefix?.trim() ?? "";
  return trimmed === "" ? undefined : `<t3_code_rsi_lessons>\n${trimmed}\n</t3_code_rsi_lessons>`;
}

/** Prepend session-start RSI lessons only when establishing a new session (KV-cache safe). */
export function withSessionRsiLessonsPrefix(input: {
  readonly prompt: string;
  readonly rsiPrefix?: string | undefined;
  readonly isNewSession: boolean;
}): string {
  if (!input.isNewSession) return input.prompt;
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  const block = formatRsiLessonsBlock(input.rsiPrefix);
  if (block === undefined) return input.prompt;
  return input.prompt.trim() === "" ? block : `${block}\n\n${input.prompt}`;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
  readonly rsiPrefix?: string | undefined;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const rsiBlock =
    input.previousState === undefined ? formatRsiLessonsBlock(input.rsiPrefix) : undefined;
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
    ...(rsiBlock !== undefined ? [rsiBlock] : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
  readonly rsiPrefix?: string | undefined;
}): string {
  if (!input.hasT3Mcp) {
    return withSessionRsiLessonsPrefix({
      prompt: input.prompt,
      rsiPrefix: input.rsiPrefix,
      isNewSession: !input.orchestrationDelivered,
    });
  }
  if (!input.orchestrationDelivered) {
    const rsiBlock = formatRsiLessonsBlock(input.rsiPrefix);
    const instructions =
      rsiBlock === undefined
        ? orchestrationInstructions(input.hasDeviceTools)
        : `${orchestrationInstructions(input.hasDeviceTools).trim()}\n\n${rsiBlock}`;
    return prependT3OrchestrationInstructions(input.prompt, instructions);
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
