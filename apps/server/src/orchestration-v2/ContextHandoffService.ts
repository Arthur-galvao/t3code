import {
  type OrchestrationV2AppThread,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { compressToolOutput } from "@t3tools/provider-core/server/contextCompressor";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffCoverage,
  historicalMessage,
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export class ContextHandoffPrepareError extends Schema.TaggedError<ContextHandoffPrepareError>()(
  "ContextHandoffPrepareError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to prepare context handoff for run ${this.targetRunId} in thread ${this.threadId}.`;
  }
}

export const ContextHandoffServiceV2Error = Schema.Union([ContextHandoffPrepareError]);
export type ContextHandoffServiceV2Error = typeof ContextHandoffServiceV2Error.Type;

export interface ContextHandoffServiceV2Shape {
  readonly prepareLegacyImport: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly toProviderThreadId: ProviderThreadId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareForkDelta: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareProviderHandoff: (input: {
    readonly threadId: ThreadId;
    /** Thread the items came from, when it is not `threadId` (a fork's source). */
    readonly sourceThreadId?: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly strategy: Extract<
      OrchestrationV2ContextHandoff["strategy"],
      "delta_since_target_last_seen" | "full_thread_summary"
    >;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  /** Parent activity after the fork point, prepended to a side chat's first provider turn. */
  readonly prepareSideChatContext: (input: {
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: NonNullable<OrchestrationV2ContextHandoff["transferId"]>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly parentItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
}

export class ContextHandoffServiceV2 extends Context.Service<
  ContextHandoffServiceV2,
  ContextHandoffServiceV2Shape
>()("t3/orchestration-v2/ContextHandoffService/ContextHandoffServiceV2") {}

function compactText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  const end = maxLength - 3;
  const last = compacted.charCodeAt(end - 1);
  return `${compacted.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}...`;
}

export function visibleDeltaRunOrdinals(
  projection: { readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">> },
  items: ReadonlyArray<Pick<OrchestrationV2TurnItem, "runId">>,
): OrchestrationV2ContextHandoff["coveredRunOrdinals"] {
  const ordinalByRunId = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  let from = Infinity;
  let to = -Infinity;
  for (const item of items) {
    const ordinal = item.runId === null ? undefined : ordinalByRunId.get(item.runId);
    if (ordinal === undefined) continue;
    from = Math.min(from, ordinal);
    to = Math.max(to, ordinal);
  }
  return from === Infinity ? { from: 1, to: 1 } : { from, to };
}

/** Drops rolled-back runs and cancelled queued messages, which are not part of the conversation. */
export function visibleConversationItems(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts">,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2TurnItem> {
  const visible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items,
  });
  return items.filter(visible);
}

type ForkHistorySource = Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "attempts">;

/** Visible rows of `source`'s own runs through `throughRun`, plus its v1 imported rows. */
const readOwnHistoryItems = Effect.fn("orchestrationV2.contextHandoff.readOwnHistoryItems")(
  function* (
    projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
    source: ForkHistorySource,
    throughRun: Pick<OrchestrationV2Run, "ordinal">,
  ) {
    const { turnItems } = yield* projectionStore.getThreadRecords(source.thread.id, ["turnItems"], {
      turnItemRunIds: [
        ...source.runs.filter((run) => run.ordinal <= throughRun.ordinal).map((run) => run.id),
        ...(source.thread.historyOrigin === "v1_import" ? [null] : []),
      ],
    });
    return visibleConversationItems(source, turnItems);
  },
);

/** History `thread` shows from its fork ancestors, oldest first. Side chats inherit no rows. */
export const readInheritedHandoffItems = Effect.fn(
  "orchestrationV2.contextHandoff.readInheritedHandoffItems",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  thread: OrchestrationV2AppThread,
) {
  const segments: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
  const seen = new Set([thread.id]);
  let current = thread;
  while (
    current.forkedFrom?.type === "run" &&
    current.lineage.sideChat !== true &&
    !seen.has(current.forkedFrom.threadId)
  ) {
    const { threadId, runId } = current.forkedFrom;
    seen.add(threadId);
    const source = yield* projectionStore
      .getThreadRecords(threadId, ["runs", "attempts"])
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    const forkRun = source?.runs.find((run) => run.id === runId);
    if (source === null || forkRun === undefined) break;
    segments.unshift(yield* readOwnHistoryItems(projectionStore, source, forkRun));
    current = source.thread;
  }
  return segments.flat();
});

/** What a portable fork from `throughRun` of `source` carries: inherited rows, then its own. */
export const readForkHistoryItems = Effect.fn(
  "orchestrationV2.contextHandoff.readForkHistoryItems",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  source: ForkHistorySource,
  throughRun: Pick<OrchestrationV2Run, "ordinal">,
) {
  return [
    ...(yield* readInheritedHandoffItems(projectionStore, source.thread)),
    ...(yield* readOwnHistoryItems(projectionStore, source, throughRun)),
  ];
});

function boundUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "...";
  const targetBytes = Math.max(0, maxBytes - suffix.length);
  let end = Math.min(text.length, targetBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > targetBytes) {
    end -= Math.max(
      1,
      Math.floor((Buffer.byteLength(text.slice(0, end), "utf8") - targetBytes) / 2),
    );
  }
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
  }
  return end <= 0 ? "" : `${text.slice(0, end)}${suffix}`;
}

const VERIFICATION_COMMAND_RE =
  /\b(test|vitest|jest|mocha|unittest|pytest|cargo\s+test|go\s+test|typecheck|tsc|tsgo|lint|oxlint|eslint|vp(?:\.cmd)?\s+(?:test|lint|check|run)|build|check|verify)\b/i;

const DECISION_LINE_RE =
  /^(?:[-*]\s+|#+\s+)|(?:\b(?:decided|decision|chose|choosing|switched|approach|architecture|implemented|added|fixed|updated|wired|note|constraint)\b)/i;

const NEXT_STEP_LINE_RE =
  /^(?:[-*]\s+)?(?:\b(?:next|todo|remaining|pending|still need|follow[- ]up|blocked on)\b)/i;

function commandOutcomeLabel(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
): string {
  if (
    item.status === "failed" ||
    item.outputIndicatesFailure === true ||
    (item.exitCode !== undefined && item.exitCode !== 0)
  ) {
    return `failed (exit ${item.exitCode ?? "?"})`;
  }
  if (item.status === "completed") {
    return `passed (exit ${item.exitCode ?? 0})`;
  }
  return item.status;
}

const HANDOFF_COMPRESS_MIN_CHARS = 1_200;
const CRITICAL_HANDOFF_LOG_RE =
  /(?:ERROR|FATAL|Exception|Traceback|FAIL|panic|AssertionError|TypeError|SyntaxError)/;

function compressHandoffDeltaText(
  text: string,
  maxLength: number,
  sourceLabel = "handoff",
): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length >= HANDOFF_COMPRESS_MIN_CHARS) {
    const compressed = compressToolOutput({
      text: trimmed,
      minChars: HANDOFF_COMPRESS_MIN_CHARS,
      includeFooter: false,
      sourceLabel,
    });
    const source = compressed.compressed ? compressed.text : trimmed;
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^\[\.\.\. \d+ .* omitted \.\.\.\]$/.test(line));
    const criticalLines = lines.filter((line) => CRITICAL_HANDOFF_LOG_RE.test(line));
    if (criticalLines.length > 0) {
      const selected = criticalLines.slice(0, 3);
      const tail = lines.at(-1);
      if (tail !== undefined && !selected.includes(tail)) {
        selected.push(tail);
      }
      return compactText(selected.join(" | "), Math.max(maxLength, 480));
    }
    return compactText(lines.join(" | "), maxLength);
  }
  return compactText(trimmed, maxLength);
}

function summarizeCommandTail(output: string | undefined, maxLength = 160): string | null {
  if (!output) return null;
  if (output.length >= HANDOFF_COMPRESS_MIN_CHARS) {
    const summary = compressHandoffDeltaText(
      output,
      Math.max(maxLength, 480),
      "handoff-command-output",
    );
    return summary.length > 0 ? summary : null;
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  return compactText(lines.slice(-2).join(" | "), maxLength);
}

function extractHighlightLines(
  text: string,
  matcher: RegExp,
  maxLines: number,
  maxLineLength: number,
): Array<string> {
  const results: Array<string> = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || !matcher.test(trimmed)) continue;
    const line = compactText(trimmed, maxLineLength);
    if (seen.has(line)) continue;
    seen.add(line);
    results.push(line);
    if (results.length >= maxLines) break;
  }
  return results;
}

/** Synthesize multi-turn / cross-provider activity into structured sections within a byte cap. */
export function buildStructuredHandoffSummary(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  maxBytes = DEFAULT_HANDOFF_TOKEN_CAP,
): string {
  const userObjectives: Array<string> = [];
  const decisionLines: Array<string> = [];
  const filesByPath = new Map<string, string>();
  const verificationByCmd = new Map<string, string>();
  const openSteps: Array<string> = [];
  let latestTodoList: Extract<OrchestrationV2TurnItem, { readonly type: "todo_list" }> | null =
    null;
  let latestAssistantText: string | null = null;

  for (const item of items) {
    switch (item.type) {
      case "user_message": {
        const text = item.text.trim();
        if (text.length > 0 && text !== "/compact" && text !== "/logout") {
          userObjectives.push(text);
        }
        break;
      }
      case "proposed_plan": {
        const plan = compactText(item.markdown, 500);
        if (plan.length > 0) {
          decisionLines.push(`Plan: ${plan}`);
        }
        break;
      }
      case "assistant_message": {
        const trimmed = item.text.trim();
        if (trimmed.length === 0) break;
        latestAssistantText = trimmed;
        for (const line of extractHighlightLines(trimmed, DECISION_LINE_RE, 3, 280)) {
          if (!decisionLines.includes(line)) {
            decisionLines.push(line);
          }
        }
        break;
      }
      case "compaction": {
        if (item.summary) {
          decisionLines.push(
            `Compacted summary: ${compressHandoffDeltaText(item.summary, 360, "handoff-compaction")}`,
          );
        }
        break;
      }
      case "file_change": {
        if (item.changes && item.changes.length > 0) {
          for (const change of item.changes) {
            const detail = change.oldPath
              ? `${change.operation}: ${change.path} (from ${change.oldPath})`
              : `${change.operation}: ${change.path}`;
            filesByPath.set(change.path, detail);
          }
        } else {
          filesByPath.set(item.fileName, item.fileName);
        }
        break;
      }
      case "checkpoint": {
        for (const file of item.files) {
          if (!filesByPath.has(file.path)) {
            filesByPath.set(file.path, `${file.kind}: ${file.path}`);
          }
        }
        break;
      }
      case "command_execution": {
        const command = compactText(item.input, 160);
        if (command.length === 0) break;
        const outcome = commandOutcomeLabel(item);
        const isVerification = VERIFICATION_COMMAND_RE.test(item.input);
        const isFailure = outcome.startsWith("failed");
        if (isVerification || isFailure) {
          const tail = isFailure ? summarizeCommandTail(item.output) : null;
          verificationByCmd.set(
            command,
            tail ? `\`${command}\` -> ${outcome} (${tail})` : `\`${command}\` -> ${outcome}`,
          );
        }
        break;
      }
      case "todo_list": {
        latestTodoList = item;
        break;
      }
      case "error": {
        openSteps.push(
          `Resolve provider error (${item.failure.class}): ${compressHandoffDeltaText(item.failure.message, 240, "handoff-error")}`,
        );
        break;
      }
      case "run_interrupt_result": {
        openSteps.push(`Interrupted: ${compactText(item.message, 200)}`);
        break;
      }
      case "user_input_request":
      case "approval_request": {
        if (item.status !== "completed") {
          openSteps.push(`Pending ${item.type} (${item.requestId})`);
        }
        break;
      }
      default:
        break;
    }
  }

  const objectiveBullets: Array<string> = [];
  if (userObjectives.length === 0) {
    objectiveBullets.push("- No user objective recorded.");
  } else {
    objectiveBullets.push(`- Primary: ${compactText(userObjectives[0]!, 500)}`);
    const latest = userObjectives.at(-1)!;
    if (userObjectives.length > 1 && latest !== userObjectives[0]) {
      objectiveBullets.push(`- Latest request: ${compactText(latest, 400)}`);
    }
  }

  if (decisionLines.length === 0 && latestAssistantText !== null) {
    decisionLines.push(compressHandoffDeltaText(latestAssistantText, 400, "handoff-assistant"));
  }
  const decisionBullets =
    decisionLines.length === 0
      ? ["- No key decisions recorded."]
      : decisionLines.slice(-6).map((line) => (line.startsWith("- ") ? line : `- ${line}`));

  const fileEntries = Array.from(filesByPath.values());
  const fileBullets =
    fileEntries.length === 0
      ? ["- None recorded."]
      : fileEntries.slice(-25).map((entry) => `- ${entry}`);

  const verificationEntries = Array.from(verificationByCmd.values());
  const verificationBullets =
    verificationEntries.length === 0
      ? ["- No verification commands recorded."]
      : verificationEntries.slice(-10).map((entry) => `- ${entry}`);

  if (latestTodoList !== null) {
    for (const step of latestTodoList.steps) {
      if (step.status !== "completed") {
        openSteps.push(`[${step.status}] ${compactText(step.text, 200)}`);
      }
    }
  }
  if (openSteps.length === 0 && latestAssistantText !== null) {
    for (const line of extractHighlightLines(latestAssistantText, NEXT_STEP_LINE_RE, 3, 240)) {
      openSteps.push(line.replace(/^[-*]\s+/, ""));
    }
  }
  const nextStepBullets =
    openSteps.length === 0
      ? ["- Continue from the latest completed state."]
      : openSteps.slice(-6).map((step) => `- ${step}`);

  const renderSections = (limits: {
    readonly files: number;
    readonly verification: number;
    readonly decisions: number;
    readonly nextSteps: number;
  }) =>
    [
      "## Objective",
      ...objectiveBullets,
      "",
      "## Key Decisions",
      ...decisionBullets.slice(-limits.decisions),
      "",
      "## Files Modified",
      ...fileBullets.slice(-limits.files),
      "",
      "## Verification State",
      ...verificationBullets.slice(-limits.verification),
      "",
      "## Open Next Steps",
      ...nextStepBullets.slice(-limits.nextSteps),
    ].join("\n");

  const candidateLimits = [
    { files: 25, verification: 10, decisions: 6, nextSteps: 6 },
    { files: 15, verification: 6, decisions: 3, nextSteps: 4 },
    { files: 8, verification: 4, decisions: 2, nextSteps: 2 },
    { files: 4, verification: 2, decisions: 1, nextSteps: 1 },
  ];
  for (const limits of candidateLimits) {
    const rendered = renderSections(limits);
    if (Buffer.byteLength(rendered, "utf8") <= maxBytes) {
      return rendered;
    }
  }
  return boundUtf8(
    renderSections({ files: 4, verification: 2, decisions: 1, nextSteps: 1 }),
    maxBytes,
  );
}

function summarizeDeltaItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `- User: ${compressHandoffDeltaText(item.text, 240, "handoff-user")}`;
    case "assistant_message":
      return `- Assistant: ${compressHandoffDeltaText(item.text, 240, "handoff-assistant")}`;
    case "command_execution": {
      const command = compactText(item.input, 320);
      const outcome = commandOutcomeLabel(item);
      const tail =
        outcome.startsWith("failed") || (item.output?.length ?? 0) >= HANDOFF_COMPRESS_MIN_CHARS
          ? summarizeCommandTail(item.output, 240)
          : null;
      return tail
        ? `- Command (${outcome}): ${command} (${tail})`
        : `- Command (${outcome}): ${command}`;
    }
    case "file_change":
      return `- File change: ${compactText(item.changes?.map((change) => change.path).join(", ") ?? item.fileName, 400)}`;
    case "checkpoint":
      return `- Checkpoint: ${item.files.length} files`;
    case "proposed_plan":
      return `- Plan: ${compressHandoffDeltaText(item.markdown, 320, "handoff-plan")}`;
    case "error":
      return `- Error (${item.failure.class}): ${compressHandoffDeltaText(item.failure.message, 320, "handoff-error")}`;
    case "handoff":
      return `- Handoff: ${compressHandoffDeltaText(item.summary ?? item.strategy, 240, "handoff-summary")}`;
    default:
      return null;
  }
}

function makeForkDeltaSummary(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly maxBytes?: number;
}): string {
  const header = [
    "Merge-back context from forked conversation.",
    `Source thread: ${input.sourceThreadId}`,
    `Target thread: ${input.targetThreadId}`,
    `Covered fork runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
  ].join("\n");
  if (input.deltaItems.length === 0) {
    return `${header}Fork delta:\n- No user-visible delta items.`;
  }
  const budget = Math.max(
    512,
    (input.maxBytes ?? DEFAULT_HANDOFF_TOKEN_CAP) - Buffer.byteLength(header, "utf8"),
  );
  return `${header}${buildStructuredHandoffSummary(input.deltaItems, budget)}`;
}

const SIDE_CHAT_CONTEXT_MAX_CHARS = 8_000;

/** Oldest first; raw parent items are summarized only until the context cap is reached. */
export function makeSideChatContext(input: {
  readonly parentThreadId: ThreadId;
  readonly digest: ReadonlyArray<string | OrchestrationV2TurnItem>;
}): string {
  const framing =
    "You are in a side chat beside the main thread. The main thread may still be running in the same worktree. Answer the user's questions; do not continue or redo the main thread's task.";
  const header = "Main thread activity since this side chat's starting point:";
  const truncated = "- Earlier items truncated.";
  const footer = `Use t3_thread_read on thread ${input.parentThreadId} to see the main thread's live state.`;
  const kept: Array<string> = [];
  let omitted = false;
  // The cap covers the whole block, so the fixed lines are reserved before any digest line.
  let remaining =
    SIDE_CHAT_CONTEXT_MAX_CHARS - [framing, "", header, truncated, "", footer].join("\n").length;
  for (let index = input.digest.length - 1; index >= 0; index--) {
    const item = input.digest[index]!;
    const line = typeof item === "string" ? item : summarizeDeltaItem(item);
    if (line === null) continue;
    if (line.length + 1 > remaining) {
      omitted = true;
      break;
    }
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  return [
    framing,
    ...(kept.length === 0 ? [] : ["", header, ...(omitted ? [truncated] : []), ...kept]),
    "",
    footer,
  ].join("\n");
}

/** Side chat context is prepended to the provider prompt, never replayed as budgeted history. */
export const isSideChatContextHandoff = (handoff: OrchestrationV2ContextHandoff): boolean =>
  handoff.strategy === "manual_context" && handoff.transferId != null;

function makeLegacyImportSummary(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const sections = items.flatMap((item) => {
    switch (item.type) {
      case "user_message":
        return [{ label: "User", body: item.text }];
      case "assistant_message":
        return [{ label: "Assistant", body: item.text }];
      default:
        return [];
    }
  });
  const header =
    "Imported conversation history from the previous T3 Code orchestrator. Use it as context; do not repeat it unless the user asks.";
  const maxChars = 32_000;
  const selected: Array<string> = [];
  let remaining = maxChars - header.length - 2;
  for (const section of sections.toReversed()) {
    if (remaining <= 0) break;
    const fullSection = `${section.label}:\n${section.body}`;
    if (fullSection.length <= remaining) {
      selected.unshift(fullSection);
      remaining -= fullSection.length + 2;
      continue;
    }

    const prefix = `${section.label}:\n... `;
    const bodyBudget = remaining - prefix.length;
    if (bodyBudget <= 0) continue;

    const initialStart = section.body.length - bodyBudget;
    let bodyStart = Math.max(0, initialStart);
    if (
      bodyStart > 0 &&
      !/\s/.test(section.body[bodyStart - 1] ?? "") &&
      !/\s/.test(section.body[bodyStart] ?? "")
    ) {
      const nextWhitespace = section.body.slice(bodyStart).search(/\s/);
      if (nextWhitespace !== -1) {
        bodyStart += nextWhitespace;
      }
    }
    const codeUnitAtStart = section.body.charCodeAt(bodyStart);
    const codeUnitBeforeStart = section.body.charCodeAt(bodyStart - 1);
    if (
      codeUnitAtStart >= 0xdc00 &&
      codeUnitAtStart <= 0xdfff &&
      codeUnitBeforeStart >= 0xd800 &&
      codeUnitBeforeStart <= 0xdbff
    ) {
      bodyStart += 1;
    }
    const bodySuffix = section.body.slice(bodyStart).trimStart();
    if (bodySuffix.length === 0) continue;

    const suffix = `${prefix}${bodySuffix}`;
    selected.unshift(suffix);
    remaining -= suffix.length + 2;
  }
  return [header, ...selected].join("\n\n");
}

const makeContextHandoffService = Effect.fn("orchestrationV2.ContextHandoffService.layer")(
  function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const tokenCap = yield* handoffTokenCapConfig.pipe(
      Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
    );

    const prepareLegacyImport = Effect.fn("orchestrationV2.contextHandoff.prepareLegacyImport")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly targetRunId: RunId;
        readonly toProviderThreadId: ProviderThreadId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.threadId,
            fromProviderInstanceId: ProviderInstanceId.make("legacy"),
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: [],
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({ ...input, coveredRunOrdinals: { from: 1, to: 1 } });
        const selected = selectHistory({
          messages: input.items.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: null,
          threadId: input.threadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeLegacyImportSummary(input.items),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareForkDelta = Effect.fn("orchestrationV2.contextHandoff.prepareForkDelta")(
      function* (input: {
        readonly sourceThreadId: ThreadId;
        readonly targetThreadId: ThreadId;
        readonly targetRunId: RunId;
        readonly transferId: OrchestrationV2ContextHandoff["transferId"];
        readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
        readonly toProviderThreadId: ProviderThreadId;
        readonly fromProviderInstanceId: ProviderInstanceId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
        readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.targetThreadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.targetThreadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({
          threadId: input.sourceThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          items: input.deltaItems,
        });
        const selected = selectHistory({
          messages: input.deltaItems.flatMap((item) => {
            const message = historicalMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.targetThreadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          strategy: "fork_delta_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeForkDeltaSummary({ ...input, maxBytes: tokenCap }),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareProviderHandoff = Effect.fn(
      "orchestrationV2.contextHandoff.prepareProviderHandoff",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly sourceThreadId?: ThreadId;
      readonly targetRunId: RunId;
      readonly transferId: OrchestrationV2ContextHandoff["transferId"];
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
      readonly fromProviderInstanceId: ProviderInstanceId;
      readonly toProviderInstanceId: ProviderInstanceId;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly runs?: ReadonlyArray<OrchestrationV2Run>;
      readonly strategy: Extract<
        OrchestrationV2ContextHandoff["strategy"],
        "delta_since_target_last_seen" | "full_thread_summary"
      >;
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
      readonly createdAt: DateTime.Utc;
    }) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      const runStatuses = new Map(input.runs?.map((run) => [run.id, run.status]));
      const baseCoverage = handoffCoverage({
        ...input,
        threadId: input.sourceThreadId ?? input.threadId,
      });
      // Keep structured synthesis under ContextHandoffDelivery's 4KB / half-budget coverage limit
      // so the target provider receives exact files touched and verification state verbatim.
      const maxCoverageCost = Math.min(3_800, Math.floor(tokenCap / 2));
      let synthesisBudget = Math.max(
        0,
        maxCoverageCost - historyCost([], `${baseCoverage}\n\n`) - 128,
      );
      let structuredSynthesis =
        synthesisBudget >= 256 ? buildStructuredHandoffSummary(input.items, synthesisBudget) : "";
      while (
        structuredSynthesis.length > 0 &&
        historyCost([], `${baseCoverage}\n\n${structuredSynthesis}`) > maxCoverageCost &&
        synthesisBudget > 256
      ) {
        synthesisBudget = Math.floor(synthesisBudget * 0.75);
        structuredSynthesis = buildStructuredHandoffSummary(input.items, synthesisBudget);
      }
      const coverage =
        structuredSynthesis.length > 0 &&
        historyCost([], `${baseCoverage}\n\n${structuredSynthesis}`) <= maxCoverageCost
          ? `${baseCoverage}\n\n${structuredSynthesis}`
          : baseCoverage;
      const selected = selectHistory({
        messages: input.items.flatMap((item) => {
          const message = historicalMessage(item);
          return message === null
            ? []
            : [
                {
                  ...message,
                  ...(item.runId === null ? {} : { runStatus: runStatuses.get(item.runId) }),
                },
              ];
        }),
        coverage,
        budget: tokenCap,
      });
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: input.strategy,
        status: "ready",
        summaryMessageId: null,
        summaryText: renderHistory(selected.messages, selected.context),
        history: {
          messages: selected.messages,
          coverage,
          omittedItems: selected.omittedItems,
          omittedItemIds: selected.omittedItemIds,
        },
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareSideChatContext = Effect.fn(
      "orchestrationV2.contextHandoff.prepareSideChatContext",
    )(function* (input: Parameters<ContextHandoffServiceV2Shape["prepareSideChatContext"]>[0]) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: [],
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: [],
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: "manual_context",
        status: "ready",
        summaryMessageId: null,
        summaryText: makeSideChatContext({
          parentThreadId: input.parentThreadId,
          digest: input.parentItems,
        }),
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    return ContextHandoffServiceV2.of({
      prepareLegacyImport,
      prepareForkDelta,
      prepareProviderHandoff,
      prepareSideChatContext,
    });
  },
);

export const layer: Layer.Layer<ContextHandoffServiceV2, never, IdAllocator.IdAllocatorV2> =
  Layer.effect(ContextHandoffServiceV2, makeContextHandoffService());
