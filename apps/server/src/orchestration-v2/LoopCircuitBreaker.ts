import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export type LoopCircuitBreakerCategory = "consecutive_failure" | "oscillation";

export type LoopBreakerToolItemType =
  | "command_execution"
  | "file_change"
  | "dynamic_tool"
  | "mcp_tool_call"
  | "dynamic_tool_call";

export interface LoopSignature {
  readonly itemType: LoopBreakerToolItemType;
  readonly target: string;
  readonly error: string;
  readonly toolTargetKey: string;
  readonly key: string;
}

export type LoopCircuitBreakerDecision =
  | {
      readonly tripped: false;
      readonly category: null;
      readonly reason: null;
      readonly signature: LoopSignature | null;
      readonly consecutiveSameFailure: number;
      readonly oscillationCycles: number;
    }
  | {
      readonly tripped: true;
      readonly category: LoopCircuitBreakerCategory;
      readonly reason: string;
      readonly signature: LoopSignature;
      readonly consecutiveSameFailure: number;
      readonly oscillationCycles: number;
    };

export interface LoopCircuitBreakerState {
  readonly consecutiveSameFailure: number;
  readonly lastFailedSignature: LoopSignature | null;
  readonly recentFailedSignatures: ReadonlyArray<LoopSignature>;
  readonly processedTerminalItems: ReadonlyMap<string, string>;
  readonly decision: LoopCircuitBreakerDecision;
}

export interface LoopCircuitBreakerItemLike {
  readonly id?: string;
  readonly type: string;
  readonly status: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly outputIndicatesFailure?: boolean;
  readonly exitCode?: number;
  readonly fileName?: string;
  readonly changes?: ReadonlyArray<{
    readonly operation: string;
    readonly path: string;
  }>;
  readonly toolName?: string | null;
  readonly error?: unknown;
}

export type LoopCircuitBreakerInput = OrchestrationV2TurnItem | LoopCircuitBreakerItemLike;

export interface EvaluateLoopCircuitBreakerResult {
  readonly state: LoopCircuitBreakerState;
  readonly decision: LoopCircuitBreakerDecision;
}

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const OSCILLATION_CYCLE_THRESHOLD = 2;
const MAX_RECENT_FAILURES = 12;

const TRACKED_ITEM_TYPES = new Set<string>([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "mcp_tool_call",
  "dynamic_tool_call",
]);

const TERMINAL_ITEM_STATUSES = new Set<string>(["completed", "failed", "interrupted", "cancelled"]);

// Strip ANSI escapes without literal control characters in regex syntax.
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stableSerialize(value: unknown, depth = 0): string {
  if (depth > 4) return "...";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return normalizeWhitespace(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${key}:${stableSerialize(entry, depth + 1)}`);
    return `{${entries.join(",")}}`;
  }
  return String(value);
}

function normalizeTarget(item: LoopCircuitBreakerInput): string {
  switch (item.type) {
    case "command_execution":
      return typeof item.input === "string"
        ? normalizeWhitespace(item.input)
        : stableSerialize(item.input);
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      if (changes.length > 0) {
        return changes
          .map((change) => `${change.operation}:${change.path.replace(/\\/g, "/")}`)
          .toSorted()
          .join(",");
      }
      return typeof item.fileName === "string" ? item.fileName.replace(/\\/g, "/").trim() : "";
    }
    case "dynamic_tool":
    case "mcp_tool_call":
    case "dynamic_tool_call": {
      const toolName =
        typeof item.toolName === "string" && item.toolName.trim().length > 0
          ? item.toolName.trim()
          : "unknown";
      const serializedInput = stableSerialize(item.input);
      return serializedInput.length > 0 ? `${toolName}:${serializedInput}` : toolName;
    }
    default:
      return "";
  }
}

function extractRawErrorText(item: LoopCircuitBreakerInput): string {
  const errorValue = "error" in item ? item.error : undefined;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    return errorValue;
  }
  if (errorValue !== undefined && errorValue !== null) {
    return stableSerialize(errorValue);
  }
  const outputValue = "output" in item ? item.output : undefined;
  if (typeof outputValue === "string" && outputValue.trim().length > 0) {
    return outputValue;
  }
  if (outputValue && typeof outputValue === "object") {
    const record = outputValue as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim().length > 0) return record.error;
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }
    return stableSerialize(outputValue);
  }
  if ("exitCode" in item && typeof item.exitCode === "number" && item.exitCode !== 0) {
    return `exit_${item.exitCode}`;
  }
  return "failed";
}

function normalizeErrorSignature(rawError: string): string {
  const cleaned = rawError
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/\bpid[=:\s]+\d+\b/gi, "pid=<pid>")
    .replace(/:\d+:\d+\b/g, ":<loc>")
    .replace(/\\/g, "/");
  const normalized = normalizeWhitespace(cleaned).toLowerCase().slice(0, 200);
  return normalized.length > 0 ? normalized : "failed";
}

export function canonicalizeToolItemSignature(item: LoopCircuitBreakerInput): LoopSignature {
  const itemType = item.type as LoopBreakerToolItemType;
  const target = normalizeTarget(item);
  const error = normalizeErrorSignature(extractRawErrorText(item));
  const toolTargetKey = `${itemType}::${target}`;
  return {
    itemType,
    target,
    error,
    toolTargetKey,
    key: `${toolTargetKey}::${error}`,
  };
}

function classifyItemOutcome(item: LoopCircuitBreakerInput): "failure" | "success" | "ignore" {
  if (!TRACKED_ITEM_TYPES.has(item.type)) return "ignore";
  if (!TERMINAL_ITEM_STATUSES.has(item.status)) return "ignore";
  if (item.status === "interrupted" || item.status === "cancelled") return "ignore";

  if (item.status === "failed") return "failure";

  if (item.type === "command_execution") {
    const indicatesFailure =
      "outputIndicatesFailure" in item && item.outputIndicatesFailure === true;
    const nonZeroExit =
      "exitCode" in item && typeof item.exitCode === "number" && item.exitCode !== 0;
    return indicatesFailure || nonZeroExit ? "failure" : "success";
  }

  if (
    (item.type === "dynamic_tool" ||
      item.type === "mcp_tool_call" ||
      item.type === "dynamic_tool_call") &&
    "output" in item &&
    item.output !== null &&
    typeof item.output === "object"
  ) {
    const record = item.output as Record<string, unknown>;
    if (record.isError === true) return "failure";
  }

  return "success";
}

/**
 * Counts trailing A -> B -> A -> B alternation cycles in failed signatures.
 * A single A -> B -> A alternation yields 1; A -> B -> A -> B yields 2.
 */
function countOscillationCycles(recentFailures: ReadonlyArray<LoopSignature>): number {
  const len = recentFailures.length;
  if (len < 3) return 0;
  const last = recentFailures[len - 1]!;
  const prev = recentFailures[len - 2]!;
  if (last.key === prev.key) return 0;

  let alternatingLen = 2;
  for (let i = len - 3; i >= 0; i -= 1) {
    const expected = (len - 1 - i) % 2 === 0 ? last.key : prev.key;
    if (recentFailures[i]!.key !== expected) {
      break;
    }
    alternatingLen += 1;
  }
  return alternatingLen >= 3 ? Math.floor(alternatingLen / 2) : 0;
}

export function createLoopCircuitBreakerState(): LoopCircuitBreakerState {
  return {
    consecutiveSameFailure: 0,
    lastFailedSignature: null,
    recentFailedSignatures: [],
    processedTerminalItems: new Map(),
    decision: {
      tripped: false,
      category: null,
      reason: null,
      signature: null,
      consecutiveSameFailure: 0,
      oscillationCycles: 0,
    },
  };
}

export function evaluateLoopCircuitBreaker(
  state: LoopCircuitBreakerState,
  item: LoopCircuitBreakerInput,
): EvaluateLoopCircuitBreakerResult {
  if (state.decision.tripped) {
    return { state, decision: state.decision };
  }

  const outcome = classifyItemOutcome(item);
  if (outcome === "ignore") {
    return { state, decision: state.decision };
  }

  const signature = canonicalizeToolItemSignature(item);
  const snapshotKey =
    outcome === "failure" ? `failure:${signature.key}` : `success:${signature.toolTargetKey}`;

  if (item.id !== undefined) {
    if (state.processedTerminalItems.get(item.id) === snapshotKey) {
      return { state, decision: state.decision };
    }
  }

  const processedTerminalItems = new Map(state.processedTerminalItems);
  if (item.id !== undefined) {
    processedTerminalItems.set(item.id, snapshotKey);
  }

  if (outcome === "success") {
    const matchesLastFailedTarget =
      state.lastFailedSignature?.toolTargetKey === signature.toolTargetKey;
    const recentIncludesTarget = state.recentFailedSignatures.some(
      (entry) => entry.toolTargetKey === signature.toolTargetKey,
    );
    const nextState: LoopCircuitBreakerState = {
      consecutiveSameFailure: matchesLastFailedTarget ? 0 : state.consecutiveSameFailure,
      lastFailedSignature: matchesLastFailedTarget ? null : state.lastFailedSignature,
      // Clearing oscillation history when a participating tool succeeds ensures recovery is never punished later.
      recentFailedSignatures: recentIncludesTarget ? [] : state.recentFailedSignatures,
      processedTerminalItems,
      decision: {
        tripped: false,
        category: null,
        reason: null,
        signature: null,
        consecutiveSameFailure: matchesLastFailedTarget ? 0 : state.consecutiveSameFailure,
        oscillationCycles: 0,
      },
    };
    return { state: nextState, decision: nextState.decision };
  }

  const consecutiveSameFailure =
    state.lastFailedSignature?.key === signature.key ? state.consecutiveSameFailure + 1 : 1;
  const recentFailedSignatures = [...state.recentFailedSignatures, signature].slice(
    -MAX_RECENT_FAILURES,
  );
  const oscillationCycles = countOscillationCycles(recentFailedSignatures);

  if (consecutiveSameFailure >= CONSECUTIVE_FAILURE_THRESHOLD) {
    const decision: LoopCircuitBreakerDecision = {
      tripped: true,
      category: "consecutive_failure",
      reason: `Repeated ${signature.itemType} failure (${consecutiveSameFailure}x in a row) on "${signature.target || "unknown"}": ${signature.error}`,
      signature,
      consecutiveSameFailure,
      oscillationCycles,
    };
    return {
      state: {
        consecutiveSameFailure,
        lastFailedSignature: signature,
        recentFailedSignatures,
        processedTerminalItems,
        decision,
      },
      decision,
    };
  }

  if (oscillationCycles >= OSCILLATION_CYCLE_THRESHOLD) {
    const prevSignature = recentFailedSignatures[recentFailedSignatures.length - 2]!;
    const decision: LoopCircuitBreakerDecision = {
      tripped: true,
      category: "oscillation",
      reason: `Detected alternating tool failure oscillation (${oscillationCycles} cycles) between "${prevSignature.target || prevSignature.itemType}" and "${signature.target || signature.itemType}".`,
      signature,
      consecutiveSameFailure,
      oscillationCycles,
    };
    return {
      state: {
        consecutiveSameFailure,
        lastFailedSignature: signature,
        recentFailedSignatures,
        processedTerminalItems,
        decision,
      },
      decision,
    };
  }

  const decision: LoopCircuitBreakerDecision = {
    tripped: false,
    category: null,
    reason: null,
    signature: null,
    consecutiveSameFailure,
    oscillationCycles,
  };
  return {
    state: {
      consecutiveSameFailure,
      lastFailedSignature: signature,
      recentFailedSignatures,
      processedTerminalItems,
      decision,
    },
    decision,
  };
}
