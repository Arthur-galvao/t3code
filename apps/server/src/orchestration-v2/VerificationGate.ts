import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export type VerificationGateMode = "off" | "goal" | "auto" | "always";

export interface VerificationGateInput {
  readonly hasGoal: boolean;
  readonly mode: VerificationGateMode;
  readonly editsSinceLastVerify: number;
  readonly lastVerifyPassed: boolean;
  readonly retryCount: number;
  readonly modifiedFiles?: ReadonlyArray<string>;
  readonly lastVerifyCommand?: string | null;
}

export interface VerificationGateDecision {
  readonly shouldContinue: boolean;
  readonly reason: string | null;
}

export interface VerificationTrackerState {
  readonly editsSinceLastVerify: number;
  readonly lastVerifyPassed: boolean;
  readonly lastVerifyCommand: string | null;
  readonly modifiedFiles: ReadonlyArray<string>;
  readonly processedItems: ReadonlyMap<string, string>;
}

export interface VerificationItemLike {
  readonly id?: string | undefined;
  readonly runId?: string | null | undefined;
  readonly type: string;
  readonly status: string;
  readonly fileName?: string | undefined;
  readonly changes?:
    | ReadonlyArray<{
        readonly operation: string;
        readonly path: string;
      }>
    | undefined;
  readonly input?: unknown;
  readonly outputIndicatesFailure?: boolean | undefined;
  readonly exitCode?: number | undefined;
  readonly toolName?: string | null | undefined;
}

const MAX_VERIFICATION_GATE_RETRIES = 2;

const DOC_OR_ASSET_EXTENSION = /\.(?:md|mdx|txt|rst|adoc|png|jpe?g|gif|webp|svg|ico|pdf)$/i;
const DOC_OR_PLAN_DIRECTORY = /(?:^|\/)(?:docs?|plans?|\.agents|\.claude|\.cursor)\//i;
const DOC_BASENAME = /(?:^|\/)(?:README|CHANGELOG|LICENSE|CLAUDE|AGENTS)(?:\.[^/]+)?$/i;

const VERIFICATION_COMMAND_PATTERN =
  /\b(?:vp(?:\.cmd)?\s+(?:test|lint|check)|vitest|pytest|unittest|cargo\s+test|cargo\s+check|typecheck|oxlint|tsc|tsgo|effect-tsgo|golden_suite(?:\.py)?|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check))\b|(?:^|[;&|]\s*)(?:test|lint)\b/i;

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "multi_edit",
]);

export function isSourceCodeFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").trim();
  if (normalized.length === 0) return false;
  if (DOC_OR_ASSET_EXTENSION.test(normalized)) return false;
  if (DOC_OR_PLAN_DIRECTORY.test(normalized)) return false;
  if (DOC_BASENAME.test(normalized)) return false;
  return true;
}

export function isVerificationCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return false;
  return VERIFICATION_COMMAND_PATTERN.test(normalized);
}

export function evaluateCompletionGate(input: VerificationGateInput): VerificationGateDecision {
  if (input.mode === "off") {
    return { shouldContinue: false, reason: null };
  }
  if (input.retryCount >= MAX_VERIFICATION_GATE_RETRIES) {
    return { shouldContinue: false, reason: null };
  }
  if (input.editsSinceLastVerify <= 0) {
    return { shouldContinue: false, reason: null };
  }

  const gateApplies =
    input.hasGoal ||
    input.mode === "always" ||
    (input.mode === "auto" && input.editsSinceLastVerify > 0);
  if (!gateApplies) {
    return { shouldContinue: false, reason: null };
  }

  if (input.lastVerifyPassed) {
    return { shouldContinue: false, reason: null };
  }

  const files = input.modifiedFiles ?? [];
  const previewFiles = files.slice(0, 5).join(", ");
  const extraCount = files.length > 5 ? ` (+${files.length - 5} more)` : "";
  const fileSummary =
    files.length > 0
      ? `modified source file(s): ${previewFiles}${extraCount}`
      : `${input.editsSinceLastVerify} unverified code edit(s)`;

  const reason =
    input.lastVerifyCommand !== undefined && input.lastVerifyCommand !== null
      ? `Verification command "${input.lastVerifyCommand}" did not pass after ${fileSummary}. Run tests/typecheck/lint cleanly before finishing.`
      : `Code was modified without a passing verification check after the last edit (${fileSummary}). Run relevant tests/typecheck/lint before finishing.`;

  return { shouldContinue: true, reason };
}

function createVerificationTrackerState(): VerificationTrackerState {
  return {
    editsSinceLastVerify: 0,
    lastVerifyPassed: false,
    lastVerifyCommand: null,
    modifiedFiles: [],
    processedItems: new Map(),
  };
}

function extractEditedFilePaths(
  item: OrchestrationV2TurnItem | VerificationItemLike,
): ReadonlyArray<string> {
  if (item.type === "file_change") {
    const paths = new Set<string>();
    if (typeof item.fileName === "string" && item.fileName.trim().length > 0) {
      paths.add(item.fileName.replace(/\\/g, "/").trim());
    }
    if (Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (typeof change.path === "string" && change.path.trim().length > 0) {
          paths.add(change.path.replace(/\\/g, "/").trim());
        }
      }
    }
    return [...paths];
  }

  if (
    (item.type === "dynamic_tool" || item.type === "dynamic_tool_call") &&
    typeof item.toolName === "string" &&
    EDIT_TOOL_NAMES.has(item.toolName.toLowerCase()) &&
    item.input !== null &&
    typeof item.input === "object"
  ) {
    const record = item.input as Record<string, unknown>;
    const candidate = record.path ?? record.filePath ?? record.file_path ?? record.TargetFile;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return [candidate.replace(/\\/g, "/").trim()];
    }
  }

  return [];
}

function recordVerificationTurnItem(
  state: VerificationTrackerState,
  item: OrchestrationV2TurnItem | VerificationItemLike,
): VerificationTrackerState {
  if (item.status !== "completed" && item.status !== "failed") {
    return state;
  }

  if (item.id !== undefined && state.processedItems.get(item.id) === item.status) {
    return state;
  }

  const processedItems = new Map(state.processedItems);
  if (item.id !== undefined) {
    processedItems.set(item.id, item.status);
  }

  if (item.status === "completed") {
    const editedPaths = extractEditedFilePaths(item).filter(isSourceCodeFile);
    if (editedPaths.length > 0) {
      const mergedFiles = new Set(state.modifiedFiles);
      for (const filePath of editedPaths) {
        mergedFiles.add(filePath);
      }
      return {
        editsSinceLastVerify: state.editsSinceLastVerify + 1,
        lastVerifyPassed: false,
        lastVerifyCommand: state.lastVerifyCommand,
        modifiedFiles: [...mergedFiles],
        processedItems,
      };
    }
  }

  if (item.type === "command_execution" && typeof item.input === "string") {
    if (!isVerificationCommand(item.input)) {
      return state.processedItems === processedItems ? state : { ...state, processedItems };
    }
    const passed =
      item.status === "completed" &&
      item.outputIndicatesFailure !== true &&
      (item.exitCode === undefined || item.exitCode === 0);
    return {
      editsSinceLastVerify: passed ? 0 : state.editsSinceLastVerify,
      lastVerifyPassed: passed,
      lastVerifyCommand: item.input.trim(),
      modifiedFiles: passed ? [] : state.modifiedFiles,
      processedItems,
    };
  }

  return state.processedItems === processedItems ? state : { ...state, processedItems };
}

export function collectVerificationStateFromTurnItems(
  items: ReadonlyArray<OrchestrationV2TurnItem | VerificationItemLike>,
  runId?: string,
): VerificationTrackerState {
  let state = createVerificationTrackerState();
  for (const item of items) {
    if (runId !== undefined && item.runId !== undefined && item.runId !== runId) {
      continue;
    }
    state = recordVerificationTurnItem(state, item);
  }
  return state;
}

export function evaluateVerificationTracker(
  state: VerificationTrackerState,
  options: {
    readonly hasGoal: boolean;
    readonly mode: VerificationGateMode;
    readonly retryCount: number;
  },
): VerificationGateDecision {
  return evaluateCompletionGate({
    hasGoal: options.hasGoal,
    mode: options.mode,
    editsSinceLastVerify: state.editsSinceLastVerify,
    lastVerifyPassed: state.lastVerifyPassed,
    retryCount: options.retryCount,
    modifiedFiles: state.modifiedFiles,
    lastVerifyCommand: state.lastVerifyCommand,
  });
}
