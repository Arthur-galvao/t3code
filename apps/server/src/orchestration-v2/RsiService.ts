import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type CcrStore, defaultCcrStore } from "@t3tools/provider-core/server/ccrStore";
import { distillTechnicalPromptSpec } from "@t3tools/provider-core/server/orchestrationInstructions";

export const MAX_LESSONS = 25;
const DEFAULT_SESSION_PREFIX_MAX_CHARS = 600;
const SIMILARITY_MERGE_THRESHOLD = 0.72;
const TELEMETRY_SUMMARY_RECENT_LIMIT = 20;
const CONFIDENCE_FLOOR = 0.15;
const MAX_TRACKED_RUN_LESSONS = 500;

export type RsiLessonScope = "global" | "glob";

export interface RsiLesson {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly guidance: string;
  readonly rationaleTrace: string;
  readonly triggerCondition: string;
  readonly scope: RsiLessonScope;
  readonly globs: ReadonlyArray<string>;
  readonly projectRoot?: string | undefined;
  readonly confidence: number;
  readonly hits: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RsiRecordLessonInput {
  readonly id?: string | undefined;
  readonly key?: string | undefined;
  readonly provider?: string | undefined;
  readonly tool?: string | undefined;
  readonly errorSignature?: string | undefined;
  readonly title: string;
  readonly guidance: string;
  readonly rationaleTrace?: string | undefined;
  readonly triggerCondition?: string | undefined;
  readonly scope?: RsiLessonScope | undefined;
  readonly globs?: ReadonlyArray<string> | undefined;
  readonly projectRoot?: string | undefined;
  readonly confidence?: number | undefined;
  readonly hits?: number | undefined;
}

export interface RsiQueryLessonsInput {
  readonly scope?: RsiLessonScope | undefined;
  readonly provider?: string | undefined;
  readonly tool?: string | undefined;
  readonly cwd?: string | null | undefined;
  readonly activePaths?: ReadonlyArray<string> | undefined;
  readonly query?: string | undefined;
  readonly minConfidence?: number | undefined;
  readonly limit?: number | undefined;
}

export interface RsiRunFailureSignature {
  readonly tool: string;
  readonly errorSignature: string;
  readonly title?: string | undefined;
  readonly guidance?: string | undefined;
  readonly triggerCondition?: string | undefined;
  readonly rationaleTrace?: string | undefined;
  readonly scope?: RsiLessonScope | undefined;
  readonly globs?: ReadonlyArray<string> | undefined;
}

export interface RsiRecoveredCommandPair {
  readonly failedCommand: string;
  readonly succeededCommand: string;
}

export interface RsiRunTelemetryInput {
  readonly threadId: string;
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly usedTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheHitRate?: number | undefined;
  readonly toolErrorCount: number;
  readonly loopTripped: boolean;
  readonly safetyBlockedCount: number;
  readonly wastedReads: number;
  readonly outcome: string;
  readonly durationMs: number;
  readonly tokensSavedEst?: number | undefined;
  readonly compressedCallsCount?: number | undefined;
  readonly failureSignature?: RsiRunFailureSignature | undefined;
  readonly appliedLessonIds?: ReadonlyArray<string> | undefined;
  readonly editedFiles?: ReadonlyArray<string> | undefined;
  readonly verifiedCommands?: ReadonlyArray<string> | undefined;
  readonly recoveredCommandPair?: RsiRecoveredCommandPair | undefined;
  readonly cwd?: string | undefined;
  readonly timestamp?: string | undefined;
}

export interface RsiRunTelemetryRecord {
  readonly threadId: string;
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly usedTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheHitRate: number;
  readonly toolErrorCount: number;
  readonly loopTripped: boolean;
  readonly safetyBlockedCount: number;
  readonly wastedReads: number;
  readonly outcome: string;
  readonly durationMs: number;
  readonly tokensSavedEst?: number | undefined;
  readonly compressedCallsCount?: number | undefined;
  readonly failureKey?: string | undefined;
  readonly timestamp: string;
}

export interface RsiProviderTelemetryBreakdown {
  readonly provider: string;
  readonly runs: number;
  readonly failures: number;
  readonly loopTrips: number;
  readonly safetyBlocks: number;
  readonly avgCacheHitRate: number;
}

export interface RsiTelemetrySummaryInput {
  readonly threadId?: string | undefined;
  readonly provider?: string | undefined;
  readonly limit?: number | undefined;
}

export interface RsiTelemetrySummary {
  readonly totalRuns: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly loopTrips: number;
  readonly safetyBlocks: number;
  readonly totalToolErrors: number;
  readonly totalWastedReads: number;
  readonly totalTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalTokensSavedEst: number;
  readonly totalCompressedCalls: number;
  readonly avgCacheHitRate: number;
  readonly avgDurationMs: number;
  readonly byProvider: ReadonlyArray<RsiProviderTelemetryBreakdown>;
  readonly recentRuns: ReadonlyArray<RsiRunTelemetryRecord>;
}

export interface RsiDemoteLessonInput {
  readonly id: string;
  readonly delta?: number | undefined;
}

export interface RsiDemoteLessonResult {
  readonly demoted: boolean;
  readonly removed: boolean;
  readonly lesson: RsiLesson | null;
}

export interface RsiDeleteLessonInput {
  readonly id: string;
}

export interface RsiDeleteLessonResult {
  readonly deleted: boolean;
}

export interface RsiFormatSessionPrefixInput {
  readonly cwd?: string | null | undefined;
  readonly activePaths?: ReadonlyArray<string> | undefined;
  readonly provider?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly runId?: string | undefined;
  readonly userPrompt?: string | undefined;
  readonly maxChars?: number | undefined;
}

export interface RsiFormattedSessionPrefix {
  readonly prefix: string;
  readonly lessonIds: ReadonlyArray<string>;
}

export interface RsiAppliedLessonsLookupInput {
  readonly threadId: string;
  readonly runId?: string | undefined;
  readonly provider?: string | undefined;
}

export interface RsiServiceShape {
  readonly recordRunTelemetry: (
    input: RsiRunTelemetryInput,
  ) => Effect.Effect<RsiRunTelemetryRecord>;
  readonly queryLessons: (input?: RsiQueryLessonsInput) => Effect.Effect<ReadonlyArray<RsiLesson>>;
  readonly recordLesson: (input: RsiRecordLessonInput) => Effect.Effect<RsiLesson>;
  readonly demoteLesson: (input: RsiDemoteLessonInput) => Effect.Effect<RsiDemoteLessonResult>;
  readonly deleteLesson: (input: RsiDeleteLessonInput) => Effect.Effect<RsiDeleteLessonResult>;
  readonly getTelemetrySummary: (
    input?: RsiTelemetrySummaryInput,
  ) => Effect.Effect<RsiTelemetrySummary>;
  readonly formatSessionPrefix: (input: RsiFormatSessionPrefixInput) => Effect.Effect<string>;
  readonly formatSessionPrefixWithMetadata: (
    input: RsiFormatSessionPrefixInput,
  ) => Effect.Effect<RsiFormattedSessionPrefix>;
  readonly getAppliedLessonIds: (
    input: RsiAppliedLessonsLookupInput,
  ) => Effect.Effect<ReadonlyArray<string>>;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.05, Math.min(1, Math.round(value * 1_000) / 1_000));
}

function clampNonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function normalizeSignaturePart(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/(?:[a-z]:)?(?:[\\/][^\\/\s:]+){2,}/gi, "<path>")
    .replace(/:\d+(?::\d+)?/g, ":<line>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[^a-z0-9<>_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return collapsed === "" ? "unknown" : collapsed.slice(0, 96);
}

export function buildAutoLessonKey(input: {
  readonly provider: string;
  readonly tool: string;
  readonly errorSignature: string;
}): string {
  return [
    "auto",
    normalizeSignaturePart(input.provider),
    normalizeSignaturePart(input.tool),
    normalizeSignaturePart(input.errorSignature),
  ].join("::");
}

function resolveLessonKey(input: RsiRecordLessonInput): string {
  if (input.key !== undefined && input.key.trim() !== "") {
    return input.key.trim();
  }
  if (
    input.provider !== undefined ||
    input.tool !== undefined ||
    input.errorSignature !== undefined
  ) {
    return buildAutoLessonKey({
      provider: input.provider ?? "global",
      tool: input.tool ?? "general",
      errorSignature: input.errorSignature ?? input.title,
    });
  }
  return `manual::${normalizeSignaturePart(input.title)}`;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "before",
  "after",
  "then",
  "than",
  "use",
  "using",
  "avoid",
  "always",
  "never",
]);

function lessonTokens(
  lesson: Pick<RsiLesson, "title" | "guidance" | "triggerCondition">,
): Set<string> {
  const words = `${lesson.title} ${lesson.guidance} ${lesson.triggerCondition}`
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return new Set(words);
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeGlobs(globs: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  if (globs === undefined) return [];
  return Array.from(
    new Set(
      globs.map((glob) => glob.trim().replaceAll("\\", "/")).filter((glob) => glob.length > 0),
    ),
  );
}

function normalizeRelativePath(filePath: string, cwd?: string | null): string {
  const normalizedPath = filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (cwd == null || cwd.trim() === "") return normalizedPath;
  const normalizedCwd = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedPath.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedCwd.length + 1);
  }
  return normalizedPath;
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let pattern = "^";
  let index = 0;
  while (index < normalized.length) {
    const ch = normalized[index]!;
    if (ch === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 3;
          continue;
        }
        pattern += ".*";
        index += 2;
        continue;
      }
      pattern += "[^/]*";
      index += 1;
      continue;
    }
    if (ch === "?") {
      pattern += "[^/]";
      index += 1;
      continue;
    }
    if (ch === "{") {
      const closeIndex = normalized.indexOf("}", index + 1);
      if (closeIndex > index + 1) {
        const alternatives = normalized
          .slice(index + 1, closeIndex)
          .split(",")
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        pattern += `(?:${alternatives.join("|")})`;
        index = closeIndex + 1;
        continue;
      }
    }
    pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  pattern += "$";
  return new RegExp(pattern, "i");
}

function matchesAnyGlob(
  globs: ReadonlyArray<string>,
  activePaths: ReadonlyArray<string>,
  cwd?: string | null,
): boolean {
  if (globs.length === 0 || activePaths.length === 0) return false;
  const regexes = globs.map(globToRegExp);
  return activePaths.some((candidate) => {
    const relative = normalizeRelativePath(candidate, cwd);
    const basename = relative.split("/").at(-1) ?? relative;
    return regexes.some((regex) => regex.test(relative) || regex.test(basename));
  });
}

const MAX_DISPLAY_COMMAND_CHARS = 80;
const MAX_TITLE_CHARS = 59;
const MAX_ERROR_TEXT_CHARS = 160;
const LESSON_DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_IN_MEMORY_TELEMETRY = 500;
const TELEMETRY_COMPACT_LINE_THRESHOLD = 1_000;
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "py", "node", "tsx", "ts-node"]);
const PATH_EXTENSION_REGEX =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rs|go|css|scss|html|json|md|mdx|yml|yaml)$/i;
const WINDOWS_ABS_PATH_REGEX = /(?:[a-zA-Z]:\\|[a-zA-Z]:\/)[^\s"'`<>|;,)\]]+/g;
const UNIX_ABS_PATH_REGEX =
  /(?<![:\w/])\/(?:Users|home|root|tmp|var|opt|etc|mnt|Volumes|[a-zA-Z]\/Users|[a-zA-Z]\/home)\/[^\s"'`<>|;,)\]]*/gi;

export function scrubErrorText(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  if (firstLine === "") return "";
  const scrubbed = firstLine
    .replace(WINDOWS_ABS_PATH_REGEX, "<path>")
    .replace(UNIX_ABS_PATH_REGEX, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.slice(0, MAX_ERROR_TEXT_CHARS).trimEnd();
}

function extractBacktickedCommands(guidance: string): ReadonlyArray<string> {
  const commands: Array<string> = [];
  const regex = /`([^`]+)`/g;
  for (const match of guidance.matchAll(regex)) {
    const normalized = normalizeVerifiedCommand(match[1] ?? "");
    if (normalized !== "") {
      commands.push(normalized.toLowerCase());
    }
  }
  return commands;
}

function isLessonRelatedToRun(
  lesson: RsiLesson,
  context: {
    readonly verifiedCommands: ReadonlyArray<string>;
    readonly editedFiles: ReadonlyArray<string>;
    readonly cwd?: string | undefined;
  },
): boolean {
  if (
    lesson.globs.length > 0 &&
    context.editedFiles.length > 0 &&
    matchesAnyGlob(lesson.globs, context.editedFiles, context.cwd)
  ) {
    return true;
  }
  if (context.verifiedCommands.length > 0) {
    const normalizedRunCommands = context.verifiedCommands
      .map((cmd) => normalizeVerifiedCommand(cmd))
      .filter((cmd) => cmd !== "");
    if (normalizedRunCommands.length > 0) {
      const lessonCommands = new Set(extractBacktickedCommands(lesson.guidance));
      for (const cmd of normalizedRunCommands) {
        if (lessonCommands.has(cmd.toLowerCase())) {
          return true;
        }
        const sig = normalizeSignaturePart(cmd);
        if (
          lesson.key.startsWith("auto::") &&
          (lesson.key.endsWith(`::${sig}`) || lesson.key.endsWith(`::${sig.slice(0, 48)}`))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function normalizeProjectRoot(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const replaced = raw.trim().replaceAll("\\", "/");
  if (replaced === "") return undefined;
  if (replaced === "/" || /^[a-zA-Z]:\/$/.test(replaced)) return replaced;
  return replaced.replace(/\/+$/, "");
}

// Unifies `/c/x`, `C:\x`, `\\?\C:\x` and `c:/x/`; only drive-letter paths (Windows) are case-insensitive.
function comparablePath(raw: string | null | undefined): string | undefined {
  const root = normalizeProjectRoot(raw?.trim().replace(/^\\\\\?\\/, ""))?.replace(
    /^\/([a-zA-Z])(?=\/|$)/,
    "$1:",
  );
  return root !== undefined && /^[a-zA-Z]:/.test(root) ? root.toLowerCase() : root;
}

function isSameOrInsidePath(candidateCwd: string | null | undefined, projectRoot: string): boolean {
  const normCwd = comparablePath(candidateCwd);
  const normRoot = comparablePath(projectRoot);
  if (normCwd === undefined || normRoot === undefined) return false;
  if (normCwd === normRoot) return true;
  const prefix = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  return normCwd.startsWith(prefix);
}

// The `auto::` id prefix is also built for manual lessons that supply provider/tool/errorSignature,
// so the auto-distiller's own rationaleTrace stamp is required too.
// shortcut: distilled lessons that took a failure signature's rationaleTrace are not recognized and are kept.
const AUTO_DISTILL_RATIONALE = /^(?:Auto-distilled|Post-success)/;

function isLegacyUnscopedAutoLesson(
  lesson: Pick<RsiLesson, "id" | "scope" | "projectRoot" | "rationaleTrace">,
): boolean {
  return (
    lesson.id.startsWith("rsi_lesson_auto_") &&
    AUTO_DISTILL_RATIONALE.test(lesson.rationaleTrace) &&
    lesson.scope === "global" &&
    (lesson.projectRoot === undefined || lesson.projectRoot.trim() === "")
  );
}

function sameProjectScope(a: string | undefined, b: string | undefined): boolean {
  const normA = normalizeProjectRoot(a)?.toLowerCase();
  const normB = normalizeProjectRoot(b)?.toLowerCase();
  if (normA === undefined && normB === undefined) return true;
  return normA === normB;
}

export function extractBaseToolName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? "";
  const basename = firstToken.replaceAll("\\", "/").split("/").at(-1) ?? firstToken;
  return basename.replace(/\.(?:cmd|exe|bat|ps1|sh)$/i, "").toLowerCase();
}

export function normalizeVerifiedCommand(raw: string): string {
  let cmd = raw.trim().replace(/\s+/g, " ");
  if (cmd === "") return "";
  while (/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:;|&&)\s*/i.test(cmd)) {
    cmd = cmd.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:;|&&)\s*/i, "");
  }
  cmd = cmd.replace(/^timeout\s+(?:-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/i, "");
  cmd = cmd
    .replace(/\s*\|\s*.*$/, "")
    .replace(/\s*(?:2>&1|1>&2|>\s*\/dev\/null)\s*$/g, "")
    .trim();
  if (cmd === "") return "";
  const tokens = cmd.split(/\s+/);
  const head = tokens[0]!;
  const headTool = extractBaseToolName(head);
  const kept: Array<string> = [head];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--") continue;
    const isInterpreterScript = i === 1 && tokens.length === 2 && SCRIPT_INTERPRETERS.has(headTool);
    const isPathToken =
      !isInterpreterScript &&
      !token.startsWith("-") &&
      !token.startsWith("@") &&
      (token.includes("/") || token.includes("\\") || PATH_EXTENSION_REGEX.test(token));
    if (!isPathToken) {
      kept.push(token);
    }
  }
  return kept.join(" ").trim();
}

export function extractToolSubcommand(normalizedCmd: string): string {
  const tokens = normalizedCmd.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const tool = extractBaseToolName(tokens[0]!);
  return [tool, ...tokens.slice(1)].join(" ").trim();
}

export function capTitle(raw: string, maxLen = MAX_TITLE_CHARS): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length <= maxLen) return collapsed;
  const sliced = collapsed.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace > 12) {
    return sliced.slice(0, lastSpace).trimEnd();
  }
  return sliced.trimEnd();
}

function shortPathHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function lessonUtilityScore(lesson: RsiLesson, nowMs?: number): number {
  const updatedMs = Date.parse(lesson.updatedAt);
  const baseScore = lesson.confidence * (1 + Math.log1p(Math.max(1, lesson.hits)));
  const ageMs =
    nowMs !== undefined && Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : 0;
  const decayFactor = 1 / (1 + ageMs / LESSON_DECAY_HALF_LIFE_MS);
  const recencyTieBreaker = Number.isFinite(updatedMs) ? (updatedMs % 1_000_000_000) / 1e14 : 0;
  return baseScore * decayFactor + recencyTieBreaker;
}

function mergeLessonRecords(existing: RsiLesson, incoming: RsiLesson): RsiLesson {
  const mergedGlobs = Array.from(new Set([...existing.globs, ...incoming.globs]));
  const mergedScope: RsiLessonScope =
    existing.scope === "global" || incoming.scope === "global" ? "global" : "glob";
  const newer = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const older = newer === incoming ? existing : incoming;
  const mergedProjectRoot = newer.projectRoot ?? older.projectRoot;
  return {
    ...existing,
    title: newer.title,
    guidance: newer.guidance,
    rationaleTrace: newer.rationaleTrace || older.rationaleTrace,
    triggerCondition: newer.triggerCondition || older.triggerCondition,
    scope: mergedScope,
    globs: mergedGlobs,
    ...(mergedProjectRoot === undefined ? {} : { projectRoot: mergedProjectRoot }),
    confidence: clampConfidence(Math.max(existing.confidence, incoming.confidence) + 0.05),
    hits: existing.hits + Math.max(1, incoming.hits),
    updatedAt: newer.updatedAt,
  };
}

function curateLessonStore(
  currentLessons: ReadonlyArray<RsiLesson>,
  candidate: RsiLesson,
  nowMs?: number,
): { readonly lessons: ReadonlyArray<RsiLesson>; readonly stored: RsiLesson } {
  const next = [...currentLessons];
  let stored: RsiLesson | undefined;

  const exactIndex = next.findIndex(
    (lesson) =>
      lesson.key === candidate.key && sameProjectScope(lesson.projectRoot, candidate.projectRoot),
  );
  if (exactIndex >= 0) {
    const merged = mergeLessonRecords(next[exactIndex]!, candidate);
    next[exactIndex] = merged;
    stored = merged;
  } else {
    const candidateTokens = lessonTokens(candidate);
    let bestMatchIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < next.length; i += 1) {
      const existing = next[i]!;
      if (existing.scope !== candidate.scope) continue;
      if (!sameProjectScope(existing.projectRoot, candidate.projectRoot)) continue;
      // Auto lessons already use normalized (provider, tool, signature) keys as canonical identity.
      if (existing.key.startsWith("auto::") && candidate.key.startsWith("auto::")) continue;
      const similarity = jaccardSimilarity(candidateTokens, lessonTokens(existing));
      if (similarity >= SIMILARITY_MERGE_THRESHOLD && similarity > bestScore) {
        bestScore = similarity;
        bestMatchIndex = i;
      }
    }
    if (bestMatchIndex >= 0) {
      const merged = mergeLessonRecords(next[bestMatchIndex]!, candidate);
      next[bestMatchIndex] = merged;
      stored = merged;
    } else {
      next.push(candidate);
      stored = candidate;
    }
  }

  if (next.length > MAX_LESSONS) {
    next.sort((a, b) => lessonUtilityScore(b, nowMs) - lessonUtilityScore(a, nowMs));
    next.length = MAX_LESSONS;
    if (!next.some((lesson) => lesson.id === stored!.id)) {
      // Candidate itself lost to higher-utility lessons; keep the top MAX_LESSONS and return it.
      return { lessons: next, stored: stored! };
    }
  } else {
    next.sort((a, b) => lessonUtilityScore(b, nowMs) - lessonUtilityScore(a, nowMs));
  }

  return { lessons: next, stored: stored! };
}

function stableLessonId(key: string, nowIso: string, projectRoot?: string): string {
  const slug = normalizeSignaturePart(key).slice(0, 48);
  const stamp = nowIso.replace(/[^0-9]/g, "").slice(0, 14) || "0";
  const projectSuffix =
    projectRoot !== undefined ? `_${shortPathHash(projectRoot.toLowerCase())}` : "";
  return `rsi_lesson_${slug}${projectSuffix}_${stamp}`;
}

function extractProviderFromKey(key: string): string | undefined {
  if (!key.startsWith("auto::")) return undefined;
  const parts = key.split("::");
  return parts[1] && parts[1] !== "global" ? parts[1] : undefined;
}

function extractToolFromKey(key: string): string | undefined {
  if (!key.startsWith("auto::")) return undefined;
  const parts = key.split("::");
  return parts[2] && parts[2] !== "general" ? parts[2] : undefined;
}

function isFailureOutcome(outcome: string): boolean {
  const normalized = outcome.trim().toLowerCase();
  return (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "interrupted" ||
    normalized === "cancelled"
  );
}

function isSuccessOutcome(outcome: string): boolean {
  const normalized = outcome.trim().toLowerCase();
  return normalized === "completed" || normalized === "success";
}

function roundConfidence(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function setBoundedMap<V>(
  current: ReadonlyMap<string, V>,
  key: string,
  value: V,
  maxEntries: number,
): ReadonlyMap<string, V> {
  const next = new Map(current);
  if (next.has(key)) {
    next.delete(key);
  }
  next.set(key, value);
  while (next.size > maxEntries) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

interface PersistenceHandles {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly rsiDir: string;
  readonly lessonsPath: string;
  readonly telemetryPath: string;
  readonly resolveObsidianBrainDir?: () => Effect.Effect<string | null>;
}

function parseLessonsFileWithStats(raw: string): {
  readonly lessons: ReadonlyArray<RsiLesson>;
  readonly droppedLegacy: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    const list: unknown = Array.isArray(parsed)
      ? parsed
      : parsed !== null &&
          typeof parsed === "object" &&
          "lessons" in parsed &&
          Array.isArray((parsed as { readonly lessons: unknown }).lessons)
        ? (parsed as { readonly lessons: unknown[] }).lessons
        : [];
    if (!Array.isArray(list)) return { lessons: [], droppedLegacy: false };
    const valid: Array<RsiLesson> = [];
    let droppedLegacy = false;
    for (const entry of list) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as RsiLesson).id === "string" &&
        typeof (entry as RsiLesson).key === "string" &&
        typeof (entry as RsiLesson).title === "string" &&
        typeof (entry as RsiLesson).guidance === "string"
      ) {
        const record = entry as Partial<RsiLesson>;
        const scope: RsiLessonScope = record.scope === "glob" ? "glob" : "global";
        const projectRoot =
          typeof record.projectRoot === "string"
            ? normalizeProjectRoot(record.projectRoot)
            : undefined;
        const lesson: RsiLesson = {
          id: record.id!,
          key: record.key!,
          title: record.title!,
          guidance: record.guidance!,
          rationaleTrace: typeof record.rationaleTrace === "string" ? record.rationaleTrace : "",
          triggerCondition:
            typeof record.triggerCondition === "string" ? record.triggerCondition : "",
          scope,
          globs: Array.isArray(record.globs)
            ? record.globs.filter((item): item is string => typeof item === "string")
            : [],
          ...(projectRoot === undefined ? {} : { projectRoot }),
          confidence: clampConfidence(
            typeof record.confidence === "number" ? record.confidence : 0.7,
          ),
          hits: typeof record.hits === "number" && record.hits > 0 ? Math.floor(record.hits) : 1,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        };
        if (isLegacyUnscopedAutoLesson(lesson)) {
          droppedLegacy = true;
          continue;
        }
        valid.push(lesson);
      }
    }
    return { lessons: valid.slice(0, MAX_LESSONS), droppedLegacy };
  } catch {
    return { lessons: [], droppedLegacy: false };
  }
}

function parseTelemetryJsonl(raw: string): ReadonlyArray<RsiRunTelemetryRecord> {
  const rows: Array<RsiRunTelemetryRecord> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as RsiRunTelemetryRecord).threadId === "string" &&
        typeof (parsed as RsiRunTelemetryRecord).runId === "string"
      ) {
        rows.push(parsed as RsiRunTelemetryRecord);
      }
    } catch {
      // Ignore partial or malformed lines.
    }
  }
  return rows;
}

function encodeLessonsPayload(lessons: ReadonlyArray<RsiLesson>): string {
  return `${JSON.stringify({ version: 1, maxLessons: MAX_LESSONS, lessons }, null, 2)}\n`;
}

function encodeTelemetryLine(record: RsiRunTelemetryRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function escapeWikilinkAlias(raw: string): string {
  return raw.replace(/[\r\n|[\]]+/g, " ").trim() || "Untitled Lesson";
}

function obsidianLessonFileName(lessonId: string): string {
  return `${lessonId.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`;
}

function formatObsidianLessonMarkdown(lesson: RsiLesson): string {
  const frontmatter = [
    "---",
    `id: ${JSON.stringify(lesson.id)}`,
    `key: ${JSON.stringify(lesson.key)}`,
    `title: ${JSON.stringify(lesson.title)}`,
    `scope: ${lesson.scope}`,
    `confidence: ${lesson.confidence.toFixed(2)}`,
    `hits: ${lesson.hits}`,
    `globs: ${JSON.stringify(lesson.globs)}`,
    ...(lesson.projectRoot === undefined
      ? []
      : [`projectRoot: ${JSON.stringify(lesson.projectRoot)}`]),
    `createdAt: ${JSON.stringify(lesson.createdAt)}`,
    `updatedAt: ${JSON.stringify(lesson.updatedAt)}`,
    `tags: ${JSON.stringify(["t3-memory", "rsi-lesson", lesson.scope])}`,
    "---",
  ].join("\n");

  const globSuffix =
    lesson.globs.length > 0 ? ` (${lesson.globs.map((g) => `\`${g}\``).join(", ")})` : "";
  const lines: Array<string> = [
    frontmatter,
    "",
    `# ${lesson.title}`,
    "",
    `> **Scope:** \`${lesson.scope}\`${globSuffix} | **Confidence:** ${lesson.confidence.toFixed(2)} | **Hits:** ${lesson.hits}`,
    "> **Index:** [[00-MOC-Memory]]",
    "",
    "## Guidance",
    "",
    lesson.guidance,
  ];
  if (lesson.triggerCondition.trim() !== "") {
    lines.push("", "## Trigger Condition", "", lesson.triggerCondition);
  }
  if (lesson.rationaleTrace.trim() !== "") {
    lines.push("", "## Rationale Trace", "", lesson.rationaleTrace);
  }
  lines.push("");
  return lines.join("\n");
}

function latestLessonUpdatedAt(lessons: ReadonlyArray<RsiLesson>): string {
  let latest = "";
  for (const lesson of lessons) {
    if (lesson.updatedAt > latest) {
      latest = lesson.updatedAt;
    }
  }
  return latest !== "" ? latest : "1970-01-01T00:00:00.000Z";
}

function formatObsidianMocMarkdown(lessons: ReadonlyArray<RsiLesson>, updatedAt: string): string {
  const sorted = [...lessons].toSorted(
    (a, b) => b.confidence - a.confidence || b.hits - a.hits || a.id.localeCompare(b.id),
  );
  const globalLessons = sorted.filter((lesson) => lesson.scope === "global");
  const globLessons = sorted.filter((lesson) => lesson.scope === "glob");

  const frontmatter = [
    "---",
    'title: "T3 Code Second Brain: Memory MOC"',
    `updatedAt: ${JSON.stringify(updatedAt)}`,
    `totalLessons: ${sorted.length}`,
    'tags: ["t3-memory", "moc"]',
    "---",
  ].join("\n");

  const renderEntry = (lesson: RsiLesson, includeGlobs: boolean): string => {
    const noteStem = obsidianLessonFileName(lesson.id).slice(0, -3);
    const alias = escapeWikilinkAlias(lesson.title);
    const globList =
      includeGlobs && lesson.globs.length > 0
        ? ` [${lesson.globs.map((g) => `\`${g}\``).join(", ")}]`
        : "";
    return `- [[Lessons/${noteStem}|${alias}]]: \`${lesson.key}\`${globList} (confidence: ${lesson.confidence.toFixed(2)}, hits: ${lesson.hits})`;
  };

  const lines: Array<string> = [
    frontmatter,
    "",
    "# T3 Code Second Brain: Memory MOC",
    "",
    `Active distilled lessons: **${sorted.length}** (${globalLessons.length} global, ${globLessons.length} scoped).`,
    "",
    `## Global Lessons (${globalLessons.length})`,
    "",
    ...(globalLessons.length > 0
      ? globalLessons.map((lesson) => renderEntry(lesson, false))
      : ["_No global lessons recorded yet._"]),
    "",
    `## Scoped (Glob) Lessons (${globLessons.length})`,
    "",
    ...(globLessons.length > 0
      ? globLessons.map((lesson) => renderEntry(lesson, true))
      : ["_No scoped lessons recorded yet._"]),
    "",
  ];
  return lines.join("\n");
}

function parseFrontmatterScalar(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatterArray(rawValue: string): ReadonlyArray<string> {
  const trimmed = rawValue.trim();
  if (trimmed === "" || trimmed === "[]") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Support unquoted YAML flow sequences such as [apps/server/**/*.ts]
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((part) => parseFrontmatterScalar(part))
      .filter((part) => part !== "");
  }
  return [parseFrontmatterScalar(trimmed)].filter((part) => part !== "");
}

function parseObsidianLessonMarkdown(
  raw: string,
  fileName: string,
  fallbackNowIso: string,
): RsiLesson | null {
  const stem = fileName.replace(/\.md$/i, "").trim();
  if (stem === "" || stem.startsWith("00-MOC")) return null;

  let body = raw;
  const meta = new Map<string, string>();
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trimStart());
  if (fmMatch !== null) {
    const fmBlock = fmMatch[1] ?? "";
    body = fmMatch[2] ?? "";
    for (const line of fmBlock.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx <= 0) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key !== "") {
        meta.set(key, val);
      }
    }
  }

  let headingTitle = "";
  let currentSection: "guidance" | "trigger" | "rationale" | "other" = "other";
  const guidanceLines: Array<string> = [];
  const triggerLines: Array<string> = [];
  const rationaleLines: Array<string> = [];
  const fallbackLines: Array<string> = [];

  for (const line of body.split(/\r?\n/)) {
    const h1Match = /^#\s+(.+)$/.exec(line);
    if (h1Match !== null && headingTitle === "") {
      headingTitle = h1Match[1]!.trim();
      continue;
    }
    const h2Match = /^##\s+(.+)$/.exec(line);
    if (h2Match !== null) {
      const sectionName = h2Match[1]!.trim().toLowerCase();
      if (sectionName === "guidance") currentSection = "guidance";
      else if (sectionName === "trigger condition") currentSection = "trigger";
      else if (sectionName === "rationale trace") currentSection = "rationale";
      else currentSection = "other";
      continue;
    }
    if (/^>\s*\*\*(?:Scope|Index):\*\*/i.test(line)) {
      continue;
    }
    if (currentSection === "guidance") guidanceLines.push(line);
    else if (currentSection === "trigger") triggerLines.push(line);
    else if (currentSection === "rationale") rationaleLines.push(line);
    else fallbackLines.push(line);
  }

  const title = parseFrontmatterScalar(meta.get("title") ?? "") || headingTitle || stem;
  const guidance = guidanceLines.join("\n").trim() || fallbackLines.join("\n").trim();
  if (title === "" || guidance === "") return null;

  const globs = normalizeGlobs(parseFrontmatterArray(meta.get("globs") ?? ""));
  const rawScope = parseFrontmatterScalar(meta.get("scope") ?? "").toLowerCase();
  const scope: RsiLessonScope =
    rawScope === "glob" && globs.length > 0
      ? "glob"
      : rawScope === "global"
        ? "global"
        : globs.length > 0
          ? "glob"
          : "global";

  const id =
    parseFrontmatterScalar(meta.get("id") ?? "") || `obsidian_${normalizeSignaturePart(stem)}`;
  const key =
    parseFrontmatterScalar(meta.get("key") ?? "") || `obsidian::${normalizeSignaturePart(title)}`;

  const parsedConfidence = Number(parseFrontmatterScalar(meta.get("confidence") ?? ""));
  const confidence = clampConfidence(
    Number.isFinite(parsedConfidence) && parsedConfidence > 0 ? parsedConfidence : 0.75,
  );
  const parsedHits = Number.parseInt(parseFrontmatterScalar(meta.get("hits") ?? ""), 10);
  const hits = Number.isFinite(parsedHits) && parsedHits > 0 ? parsedHits : 1;
  const createdAt = parseFrontmatterScalar(meta.get("createdAt") ?? "") || fallbackNowIso;
  const updatedAt = parseFrontmatterScalar(meta.get("updatedAt") ?? "") || fallbackNowIso;
  const projectRoot = normalizeProjectRoot(parseFrontmatterScalar(meta.get("projectRoot") ?? ""));

  return {
    id,
    key,
    title,
    guidance,
    rationaleTrace: rationaleLines.join("\n").trim(),
    triggerCondition: triggerLines.join("\n").trim(),
    scope,
    globs,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    confidence,
    hits,
    createdAt,
    updatedAt,
  };
}

function buildRecurrenceCountsFromTelemetry(
  rows: ReadonlyArray<RsiRunTelemetryRecord>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const fallbackKey =
      row.failureKey ??
      (row.loopTripped ||
      row.safetyBlockedCount > 0 ||
      row.toolErrorCount > 0 ||
      isFailureOutcome(row.outcome)
        ? buildAutoLessonKey({
            provider: row.provider,
            tool: row.loopTripped
              ? "circuit_breaker"
              : row.safetyBlockedCount > 0
                ? "safety_guard"
                : "runtime",
            errorSignature: row.loopTripped
              ? `loop_${row.outcome}`
              : row.safetyBlockedCount > 0
                ? "safety_block"
                : `run_${row.outcome}`,
          })
        : undefined);
    if (fallbackKey !== undefined) {
      counts.set(fallbackKey, (counts.get(fallbackKey) ?? 0) + 1);
    }
  }
  return counts;
}

export const makeRsiService = Effect.fn("RsiService.make")(function* (input?: {
  readonly persistence?: PersistenceHandles;
  readonly isAutoDistillEnabled?: () => Effect.Effect<boolean>;
  readonly ccrStore?: CcrStore;
  readonly persistCcr?: boolean;
}): Effect.fn.Return<RsiServiceShape> {
  const lessonsRef = yield* Ref.make<ReadonlyArray<RsiLesson>>([]);
  const telemetryRef = yield* Ref.make<ReadonlyArray<RsiRunTelemetryRecord>>([]);
  const recurrenceRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const injectedByRunRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<string>>>(new Map());
  const lastSyncedCcrRef = yield* Ref.make<{
    readonly tokensSavedEst: number;
    readonly compressedCallsCount: number;
  }>({ tokensSavedEst: 0, compressedCallsCount: 0 });
  const hydratedRef = yield* Ref.make(false);
  const telemetryFileLinesRef = yield* Ref.make(0);
  const mutex = Semaphore.makeUnsafe(1);

  const persistence = input?.persistence;
  const isAutoDistillEnabled = input?.isAutoDistillEnabled ?? (() => Effect.succeed(true));
  const ccrStore = input?.ccrStore ?? defaultCcrStore;
  if (persistence !== undefined && input?.persistCcr === true) {
    ccrStore.configurePersistence(persistence.path.join(persistence.rsiDir, "ccr-cache.json"));
  }

  const syncObsidianBrainLocked = Effect.fn("RsiService.syncObsidianBrainLocked")(function* (
    lessons: ReadonlyArray<RsiLesson>,
  ) {
    if (persistence?.resolveObsidianBrainDir === undefined) return;
    const brainDir = yield* persistence.resolveObsidianBrainDir();
    if (brainDir === null || brainDir.trim() === "") return;

    const lessonsDir = persistence.path.join(brainDir, "Lessons");
    yield* Effect.gen(function* () {
      yield* persistence.fs.makeDirectory(lessonsDir, { recursive: true });
      const expectedFiles = new Set<string>();
      for (const lesson of lessons) {
        const fileName = obsidianLessonFileName(lesson.id);
        expectedFiles.add(fileName);
        const filePath = persistence.path.join(lessonsDir, fileName);
        const nextContent = formatObsidianLessonMarkdown(lesson);
        const existingContent = yield* persistence.fs
          .readFileString(filePath)
          .pipe(Effect.orElseSucceed(() => null as string | null));
        if (existingContent !== nextContent) {
          yield* persistence.fs.writeFileString(filePath, nextContent);
        }
      }

      const existingEntries = yield* persistence.fs
        .readDirectory(lessonsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const entry of existingEntries) {
        if (entry.endsWith(".md") && !expectedFiles.has(entry)) {
          yield* persistence.fs
            .remove(persistence.path.join(lessonsDir, entry), { force: true })
            .pipe(Effect.ignore);
        }
      }

      const mocPath = persistence.path.join(brainDir, "00-MOC-Memory.md");
      const mocMarkdown = formatObsidianMocMarkdown(lessons, latestLessonUpdatedAt(lessons));
      const existingMoc = yield* persistence.fs
        .readFileString(mocPath)
        .pipe(Effect.orElseSucceed(() => null as string | null));
      if (existingMoc !== mocMarkdown) {
        yield* persistence.fs.writeFileString(mocPath, mocMarkdown);
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("RsiService: failed to sync Obsidian second-brain vault", { cause }),
      ),
    );
  });

  const importObsidianLessonsLocked = Effect.fn("RsiService.importObsidianLessonsLocked")(
    function* (currentLessons: ReadonlyArray<RsiLesson>, nowIso: string) {
      if (persistence?.resolveObsidianBrainDir === undefined) {
        return { lessons: currentLessons, changed: false };
      }
      const brainDir = yield* persistence.resolveObsidianBrainDir();
      if (brainDir === null || brainDir.trim() === "") {
        return { lessons: currentLessons, changed: false };
      }

      const lessonsDir = persistence.path.join(brainDir, "Lessons");
      const entries = yield* persistence.fs
        .readDirectory(lessonsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      const markdownEntries = entries.filter((entry) => entry.endsWith(".md"));
      if (markdownEntries.length === 0) {
        return { lessons: currentLessons, changed: false };
      }

      const parsedNowMs = Date.parse(nowIso);
      const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : undefined;
      let next = [...currentLessons];
      let changed = false;
      for (const fileName of markdownEntries) {
        const raw = yield* persistence.fs
          .readFileString(persistence.path.join(lessonsDir, fileName))
          .pipe(Effect.orElseSucceed(() => ""));
        if (raw.trim() === "") continue;
        const parsed = parseObsidianLessonMarkdown(raw, fileName, nowIso);
        if (parsed === null || isLegacyUnscopedAutoLesson(parsed)) continue;

        const existingIdx = next.findIndex(
          (lesson) =>
            (lesson.id === parsed.id || lesson.key === parsed.key) &&
            sameProjectScope(lesson.projectRoot, parsed.projectRoot),
        );
        if (existingIdx < 0) {
          const curated = curateLessonStore(next, parsed, nowMs);
          next = [...curated.lessons];
          changed = true;
          continue;
        }

        const existing = next[existingIdx]!;
        const globsEqual =
          existing.globs.length === parsed.globs.length &&
          existing.globs.every((g, idx) => g === parsed.globs[idx]);
        const confidenceChanged = Math.abs(parsed.confidence - existing.confidence) >= 0.02;
        const editedInObsidian =
          parsed.title !== existing.title ||
          parsed.guidance !== existing.guidance ||
          parsed.triggerCondition !== existing.triggerCondition ||
          parsed.rationaleTrace !== existing.rationaleTrace ||
          parsed.scope !== existing.scope ||
          !globsEqual ||
          confidenceChanged ||
          parsed.hits > existing.hits ||
          parsed.updatedAt > existing.updatedAt;

        const strictlyOlder =
          parsed.updatedAt !== "" &&
          existing.updatedAt !== "" &&
          parsed.updatedAt < existing.updatedAt;
        if (!strictlyOlder && editedInObsidian) {
          next[existingIdx] = {
            ...existing,
            title: parsed.title,
            guidance: parsed.guidance,
            triggerCondition: parsed.triggerCondition,
            rationaleTrace: parsed.rationaleTrace,
            scope: parsed.scope,
            globs: parsed.globs,
            confidence: confidenceChanged ? parsed.confidence : existing.confidence,
            hits: Math.max(existing.hits, parsed.hits),
            updatedAt: parsed.updatedAt > existing.updatedAt ? parsed.updatedAt : nowIso,
          };
          changed = true;
        }
      }

      if (changed) {
        next.sort((a, b) => lessonUtilityScore(b, nowMs) - lessonUtilityScore(a, nowMs));
      }
      return { lessons: next, changed };
    },
  );

  const hydrateLocked = Effect.fn("RsiService.hydrateLocked")(function* () {
    if (yield* Ref.get(hydratedRef)) return;
    if (persistence !== undefined) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const lessonsRaw = yield* persistence.fs
        .readFileString(persistence.lessonsPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const parsedLessons =
        lessonsRaw.trim() !== ""
          ? parseLessonsFileWithStats(lessonsRaw)
          : { lessons: [], droppedLegacy: false };
      let loadedLessons = parsedLessons.lessons;
      const imported = yield* importObsidianLessonsLocked(loadedLessons, nowIso);
      if (imported.changed) {
        loadedLessons = imported.lessons;
        yield* Ref.set(lessonsRef, loadedLessons);
        yield* persistLessonsLocked(loadedLessons);
      } else if (parsedLessons.droppedLegacy) {
        yield* Ref.set(lessonsRef, loadedLessons);
        yield* persistLessonsLocked(loadedLessons);
      } else if (loadedLessons.length > 0) {
        yield* Ref.set(lessonsRef, loadedLessons);
        yield* syncObsidianBrainLocked(loadedLessons);
      }
      const telemetryRaw = yield* persistence.fs
        .readFileString(persistence.telemetryPath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (telemetryRaw.trim() !== "") {
        const rawLineCount = telemetryRaw
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "").length;
        const telemetryRows = parseTelemetryJsonl(telemetryRaw);
        const retained = telemetryRows.slice(-MAX_IN_MEMORY_TELEMETRY);
        yield* Ref.set(telemetryRef, retained);
        yield* Ref.set(recurrenceRef, buildRecurrenceCountsFromTelemetry(retained));
        if (rawLineCount > TELEMETRY_COMPACT_LINE_THRESHOLD) {
          yield* writeCompactedTelemetryLocked(retained);
          yield* Ref.set(telemetryFileLinesRef, retained.length);
        } else {
          yield* Ref.set(telemetryFileLinesRef, rawLineCount);
        }
      }
    }
    yield* Ref.set(hydratedRef, true);
  });

  const writeCompactedTelemetryLocked = (rows: ReadonlyArray<RsiRunTelemetryRecord>) => {
    if (persistence === undefined) return Effect.void;
    const payload = rows.map((row) => encodeTelemetryLine(row)).join("");
    return Effect.gen(function* () {
      yield* persistence.fs
        .makeDirectory(persistence.rsiDir, { recursive: true })
        .pipe(Effect.ignore);
      const tmpPath = `${persistence.telemetryPath}.tmp`;
      yield* persistence.fs.writeFileString(tmpPath, payload);
      yield* persistence.fs.rename(tmpPath, persistence.telemetryPath);
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Failed to compact RSI telemetry", { cause })),
    );
  };

  const persistLessonsLocked = Effect.fn("RsiService.persistLessonsLocked")(function* (
    lessons: ReadonlyArray<RsiLesson>,
  ) {
    if (persistence === undefined) return;
    yield* persistence.fs
      .makeDirectory(persistence.rsiDir, { recursive: true })
      .pipe(Effect.ignore);
    const payload = encodeLessonsPayload(lessons);
    yield* persistence.fs
      .writeFileString(persistence.lessonsPath, payload)
      .pipe(Effect.catch((cause) => Effect.logWarning("Failed to write RSI lessons", { cause })));
    yield* syncObsidianBrainLocked(lessons);
  });

  const appendTelemetryLocked = Effect.fn("RsiService.appendTelemetryLocked")(function* (
    record: RsiRunTelemetryRecord,
    retainedRows: ReadonlyArray<RsiRunTelemetryRecord>,
  ) {
    if (persistence === undefined) return;
    const nextLines = (yield* Ref.get(telemetryFileLinesRef)) + 1;
    if (nextLines > TELEMETRY_COMPACT_LINE_THRESHOLD) {
      yield* writeCompactedTelemetryLocked(retainedRows);
      yield* Ref.set(telemetryFileLinesRef, retainedRows.length);
      return;
    }
    yield* persistence.fs
      .makeDirectory(persistence.rsiDir, { recursive: true })
      .pipe(Effect.ignore);
    const line = encodeTelemetryLine(record);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* persistence.fs.open(persistence.telemetryPath, { flag: "a" });
        yield* handle.writeAll(new TextEncoder().encode(line));
      }),
    ).pipe(Effect.catch((cause) => Effect.logWarning("Failed to append RSI telemetry", { cause })));
    yield* Ref.set(telemetryFileLinesRef, nextLines);
  });

  const recordLessonLocked = Effect.fn("RsiService.recordLessonLocked")(function* (
    lessonInput: RsiRecordLessonInput,
    nowIso: string,
  ) {
    const key = resolveLessonKey(lessonInput);
    const scope: RsiLessonScope =
      lessonInput.scope ?? (lessonInput.globs?.length ? "glob" : "global");
    const globs = normalizeGlobs(lessonInput.globs);
    const projectRoot = normalizeProjectRoot(lessonInput.projectRoot);
    const candidate: RsiLesson = {
      id: lessonInput.id?.trim() || stableLessonId(key, nowIso, projectRoot),
      key,
      title: lessonInput.title.trim(),
      guidance: lessonInput.guidance.trim(),
      rationaleTrace: lessonInput.rationaleTrace?.trim() ?? "",
      triggerCondition: lessonInput.triggerCondition?.trim() ?? "",
      scope: scope === "glob" && globs.length > 0 ? "glob" : "global",
      globs,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      confidence: clampConfidence(lessonInput.confidence ?? 0.7),
      hits:
        lessonInput.hits !== undefined && Number.isFinite(lessonInput.hits) && lessonInput.hits > 0
          ? Math.floor(lessonInput.hits)
          : 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const parsedNowMs = Date.parse(nowIso);
    const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : undefined;
    const current = yield* Ref.get(lessonsRef);
    const curated = curateLessonStore(current, candidate, nowMs);
    yield* Ref.set(lessonsRef, curated.lessons);
    yield* persistLessonsLocked(curated.lessons);
    return curated.stored;
  });

  const recordLesson: RsiServiceShape["recordLesson"] = Effect.fn("RsiService.recordLesson")(
    function* (lessonInput) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* hydrateLocked();
          return yield* recordLessonLocked(lessonInput, nowIso);
        }),
      );
    },
  );

  const demoteLessonLocked = Effect.fn("RsiService.demoteLessonLocked")(function* (
    lessonIds: ReadonlySet<string>,
    delta: number,
    nowIso: string,
  ): Effect.fn.Return<{
    readonly matched: boolean;
    readonly removedIds: ReadonlyArray<string>;
    readonly updatedLesson: RsiLesson | null;
  }> {
    const current = yield* Ref.get(lessonsRef);
    let matched = false;
    let updatedLesson: RsiLesson | null = null;
    const removedIds: Array<string> = [];
    const next: Array<RsiLesson> = [];

    for (const lesson of current) {
      if (!lessonIds.has(lesson.id) && !lessonIds.has(lesson.key)) {
        next.push(lesson);
        continue;
      }
      matched = true;
      const nextConfidence = roundConfidence(lesson.confidence - delta);
      if (nextConfidence < CONFIDENCE_FLOOR) {
        removedIds.push(lesson.id);
        continue;
      }
      const nextRecord: RsiLesson = {
        ...lesson,
        confidence: Math.min(1, nextConfidence),
        updatedAt: nowIso,
      };
      updatedLesson = nextRecord;
      next.push(nextRecord);
    }

    if (!matched) {
      return { matched: false, removedIds: [], updatedLesson: null };
    }

    const parsedNowMs = Date.parse(nowIso);
    const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : undefined;
    next.sort((a, b) => lessonUtilityScore(b, nowMs) - lessonUtilityScore(a, nowMs));
    yield* Ref.set(lessonsRef, next);
    yield* persistLessonsLocked(next);
    return { matched: true, removedIds, updatedLesson };
  });

  const boostLessonsLocked = Effect.fn("RsiService.boostLessonsLocked")(function* (
    lessonIds: ReadonlySet<string>,
    delta: number,
    nowIso: string,
  ) {
    const current = yield* Ref.get(lessonsRef);
    let changed = false;
    const next = current.map((lesson) => {
      if (!lessonIds.has(lesson.id) && !lessonIds.has(lesson.key)) {
        return lesson;
      }
      changed = true;
      return {
        ...lesson,
        confidence: clampConfidence(lesson.confidence + delta),
        hits: lesson.hits + 1,
        updatedAt: nowIso,
      };
    });

    if (!changed) return;
    const parsedNowMs = Date.parse(nowIso);
    const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : undefined;
    next.sort((a, b) => lessonUtilityScore(b, nowMs) - lessonUtilityScore(a, nowMs));
    yield* Ref.set(lessonsRef, next);
    yield* persistLessonsLocked(next);
  });

  const demoteLesson: RsiServiceShape["demoteLesson"] = Effect.fn("RsiService.demoteLesson")(
    function* (demoteInput) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const effectiveDelta =
        demoteInput.delta !== undefined &&
        Number.isFinite(demoteInput.delta) &&
        demoteInput.delta > 0
          ? demoteInput.delta
          : 0.15;
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* hydrateLocked();
          const result = yield* demoteLessonLocked(
            new Set([demoteInput.id.trim()]),
            effectiveDelta,
            nowIso,
          );
          if (!result.matched) {
            return { demoted: false, removed: false, lesson: null };
          }
          return {
            demoted: true,
            removed: result.removedIds.length > 0 && result.updatedLesson === null,
            lesson: result.updatedLesson,
          };
        }),
      );
    },
  );

  const deleteLesson: RsiServiceShape["deleteLesson"] = Effect.fn("RsiService.deleteLesson")(
    function* (deleteInput) {
      const targetId = deleteInput.id.trim();
      return yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* hydrateLocked();
          const current = yield* Ref.get(lessonsRef);
          const next = current.filter(
            (lesson) => lesson.id !== targetId && lesson.key !== targetId,
          );
          if (next.length === current.length) {
            return { deleted: false };
          }
          yield* Ref.set(lessonsRef, next);
          yield* persistLessonsLocked(next);
          return { deleted: true };
        }),
      );
    },
  );

  const resolveTrackedLessonIds = Effect.fn("RsiService.resolveTrackedLessonIds")(function* (
    lookup: {
      readonly threadId: string;
      readonly runId?: string | undefined;
      readonly provider?: string | undefined;
    },
    consumeRunId: boolean,
  ): Effect.fn.Return<ReadonlyArray<string>> {
    if (lookup.runId === undefined || lookup.runId.trim() === "") {
      return [];
    }
    const runId = lookup.runId.trim();
    const byRun = yield* Ref.get(injectedByRunRef);
    const matched = byRun.get(runId);
    if (matched === undefined) {
      return [];
    }
    if (consumeRunId) {
      yield* Ref.update(injectedByRunRef, (current) => {
        const copy = new Map(current);
        copy.delete(runId);
        return copy;
      });
    }
    return matched;
  });

  const recordRunTelemetry: RsiServiceShape["recordRunTelemetry"] = Effect.fn(
    "RsiService.recordRunTelemetry",
  )(function* (telemetryInput) {
    const nowIso = telemetryInput.timestamp ?? DateTime.formatIso(yield* DateTime.now);
    const usedTokens = clampNonNegativeNumber(telemetryInput.usedTokens);
    const cachedInputTokens = clampNonNegativeNumber(telemetryInput.cachedInputTokens);
    const computedRate =
      telemetryInput.cacheHitRate !== undefined && Number.isFinite(telemetryInput.cacheHitRate)
        ? Math.max(0, Math.min(1, telemetryInput.cacheHitRate))
        : usedTokens > 0
          ? Math.max(0, Math.min(1, cachedInputTokens / usedTokens))
          : 0;

    const autoDistill = yield* isAutoDistillEnabled();

    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* hydrateLocked();

        const storeStats = ccrStore.getStats();
        const lastSynced = yield* Ref.get(lastSyncedCcrRef);
        const baseTokens =
          storeStats.tokensSavedEst < lastSynced.tokensSavedEst ? 0 : lastSynced.tokensSavedEst;
        const baseCalls =
          storeStats.compressedCallsCount < lastSynced.compressedCallsCount
            ? 0
            : lastSynced.compressedCallsCount;
        const deltaTokens = Math.max(0, storeStats.tokensSavedEst - baseTokens);
        const deltaCalls = Math.max(0, storeStats.compressedCallsCount - baseCalls);

        const resolvedTokensSavedEst =
          telemetryInput.tokensSavedEst !== undefined
            ? Math.floor(clampNonNegativeNumber(telemetryInput.tokensSavedEst))
            : deltaTokens > 0
              ? deltaTokens
              : undefined;
        const resolvedCompressedCallsCount =
          telemetryInput.compressedCallsCount !== undefined
            ? Math.floor(clampNonNegativeNumber(telemetryInput.compressedCallsCount))
            : deltaCalls > 0
              ? deltaCalls
              : undefined;

        if (
          telemetryInput.tokensSavedEst === undefined ||
          telemetryInput.compressedCallsCount === undefined
        ) {
          yield* Ref.set(lastSyncedCcrRef, {
            tokensSavedEst:
              telemetryInput.tokensSavedEst === undefined
                ? storeStats.tokensSavedEst
                : lastSynced.tokensSavedEst,
            compressedCallsCount:
              telemetryInput.compressedCallsCount === undefined
                ? storeStats.compressedCallsCount
                : lastSynced.compressedCallsCount,
          });
        }

        const sig = telemetryInput.failureSignature;
        const normalizedSafetyBlocks = Math.floor(
          clampNonNegativeNumber(telemetryInput.safetyBlockedCount),
        );
        const normalizedToolErrors = Math.floor(
          clampNonNegativeNumber(telemetryInput.toolErrorCount),
        );
        const failureOutcome = isFailureOutcome(telemetryInput.outcome);
        const hasFailureSignal =
          telemetryInput.loopTripped ||
          normalizedSafetyBlocks > 0 ||
          normalizedToolErrors > 0 ||
          failureOutcome;
        const failureTool =
          sig?.tool ??
          (telemetryInput.loopTripped
            ? "circuit_breaker"
            : normalizedSafetyBlocks > 0
              ? "safety_guard"
              : "runtime");
        const rawFailureErrorSignature =
          sig?.errorSignature ??
          (telemetryInput.loopTripped
            ? `loop_${telemetryInput.outcome}`
            : normalizedSafetyBlocks > 0
              ? "safety_block"
              : `run_${telemetryInput.outcome}`);
        const failureErrorSignature = scrubErrorText(rawFailureErrorSignature) || "failed";
        const scrubbedSigGuidance =
          sig?.guidance === undefined ? undefined : scrubErrorText(sig.guidance) || undefined;
        const scrubbedSigTrigger =
          sig?.triggerCondition === undefined
            ? undefined
            : scrubErrorText(sig.triggerCondition) || undefined;
        const recurrenceKey = hasFailureSignal
          ? buildAutoLessonKey({
              provider: telemetryInput.provider,
              tool: failureTool,
              errorSignature: failureErrorSignature,
            })
          : undefined;

        const record: RsiRunTelemetryRecord = {
          threadId: telemetryInput.threadId,
          runId: telemetryInput.runId,
          provider: telemetryInput.provider,
          model: telemetryInput.model,
          usedTokens,
          cachedInputTokens,
          cacheHitRate: Math.round(computedRate * 10_000) / 10_000,
          toolErrorCount: Math.floor(clampNonNegativeNumber(telemetryInput.toolErrorCount)),
          loopTripped: telemetryInput.loopTripped,
          safetyBlockedCount: Math.floor(clampNonNegativeNumber(telemetryInput.safetyBlockedCount)),
          wastedReads: Math.floor(clampNonNegativeNumber(telemetryInput.wastedReads)),
          outcome: telemetryInput.outcome,
          durationMs: Math.round(clampNonNegativeNumber(telemetryInput.durationMs)),
          ...(resolvedTokensSavedEst !== undefined
            ? { tokensSavedEst: resolvedTokensSavedEst }
            : {}),
          ...(resolvedCompressedCallsCount !== undefined
            ? { compressedCallsCount: resolvedCompressedCallsCount }
            : {}),
          ...(recurrenceKey !== undefined ? { failureKey: recurrenceKey } : {}),
          timestamp: nowIso,
        };

        const retainedRows = yield* Ref.updateAndGet(telemetryRef, (rows) =>
          [...rows, record].slice(-MAX_IN_MEMORY_TELEMETRY),
        );
        yield* appendTelemetryLocked(record, retainedRows);

        const resolvedAppliedIds =
          telemetryInput.appliedLessonIds !== undefined
            ? telemetryInput.appliedLessonIds
            : yield* resolveTrackedLessonIds(
                {
                  threadId: record.threadId,
                  runId: record.runId,
                  provider: record.provider,
                },
                true,
              );
        const appliedIdSet = new Set(
          resolvedAppliedIds.map((id) => id.trim()).filter((id) => id !== ""),
        );
        const successOutcome = isSuccessOutcome(record.outcome);
        const cleanSuccess =
          successOutcome &&
          record.toolErrorCount === 0 &&
          !record.loopTripped &&
          record.safetyBlockedCount === 0;
        const shouldDemoteApplied =
          failureOutcome || record.loopTripped || record.safetyBlockedCount > 0;

        if (appliedIdSet.size > 0) {
          if (cleanSuccess) {
            const currentLessons = yield* Ref.get(lessonsRef);
            const runContext = {
              verifiedCommands: telemetryInput.verifiedCommands ?? [],
              editedFiles: telemetryInput.editedFiles ?? [],
              cwd: telemetryInput.cwd,
            };
            const relatedAppliedIds = new Set(
              currentLessons
                .filter(
                  (lesson) =>
                    (appliedIdSet.has(lesson.id) || appliedIdSet.has(lesson.key)) &&
                    isLessonRelatedToRun(lesson, runContext),
                )
                .map((lesson) => lesson.id),
            );
            if (relatedAppliedIds.size > 0) {
              yield* boostLessonsLocked(relatedAppliedIds, 0.05, nowIso);
            }
          } else if (shouldDemoteApplied) {
            yield* demoteLessonLocked(appliedIdSet, 0.1, nowIso);
          }
        }

        const projectRoot = normalizeProjectRoot(telemetryInput.cwd);
        // Without a cwd the lesson would be stored unscoped, injected everywhere and dropped on restart.
        if (!autoDistill || projectRoot === undefined) return record;
        let distilledForSignature = false;

        if (hasFailureSignal && recurrenceKey !== undefined) {
          const nextCount = (yield* Ref.get(recurrenceRef)).get(recurrenceKey) ?? 0;
          const updatedCount = nextCount + 1;
          yield* Ref.update(recurrenceRef, (map) => {
            const copy = new Map(map);
            copy.set(recurrenceKey, updatedCount);
            return copy;
          });

          if (record.loopTripped || updatedCount >= 2) {
            distilledForSignature = true;
            const rawTitle =
              sig?.title ??
              (record.loopTripped
                ? `Avoid ${failureTool} loop (${record.provider})`
                : `Recurring ${failureTool} failure (${record.provider})`);
            const title = capTitle(rawTitle);
            const guidance =
              scrubbedSigGuidance ??
              (record.loopTripped
                ? `Breaker tripped on ${failureTool} (${failureErrorSignature}); inspect tool inputs or switch approach before retrying.`
                : `Repeated ${failureTool} failures for ${failureErrorSignature}; verify preconditions and paths before re-running.`);
            yield* recordLessonLocked(
              {
                key: recurrenceKey,
                provider: record.provider,
                tool: failureTool,
                errorSignature: failureErrorSignature,
                title,
                guidance,
                rationaleTrace:
                  sig?.rationaleTrace ??
                  `Auto-distilled from run ${record.runId} (outcome=${record.outcome}, toolErrors=${record.toolErrorCount}, loopTripped=${record.loopTripped}, occurrences=${updatedCount}).`,
                triggerCondition:
                  scrubbedSigTrigger ??
                  `${record.provider}:${failureTool}:${failureErrorSignature}`,
                ...(sig?.scope === undefined ? {} : { scope: sig.scope }),
                ...(sig?.globs === undefined ? {} : { globs: sig.globs }),
                ...(projectRoot === undefined ? {} : { projectRoot }),
                confidence: record.loopTripped ? 0.78 : 0.65,
              },
              nowIso,
            );
          }
        }

        if (record.wastedReads >= 3) {
          yield* recordLessonLocked(
            {
              key: buildAutoLessonKey({
                provider: record.provider,
                tool: "read_file",
                errorSignature: "wasted_reads",
              }),
              provider: record.provider,
              tool: "read_file",
              errorSignature: "wasted_reads",
              title: capTitle(`Avoid repeated full-file reads (${record.provider})`),
              guidance:
                "Locate symbols first, read bounded line ranges, and use context_retrieve for [T3 CCR:...] blocks instead of re-reading unchanged files.",
              rationaleTrace: `Auto-distilled token-economy rule from run ${record.runId} (wastedReads=${record.wastedReads}).`,
              triggerCondition: "Before opening files in repeated search/read cycles",
              scope: "global",
              ...(projectRoot === undefined ? {} : { projectRoot }),
              confidence: 0.72,
            },
            nowIso,
          );
        }

        // Idle / Post-Success Distillation: extract durable workspace checks or recovery habits.
        if (successOutcome && !record.loopTripped && record.safetyBlockedCount === 0) {
          const editedFiles = Array.from(
            new Set(
              (telemetryInput.editedFiles ?? [])
                .map((filePath) => filePath.trim())
                .filter((filePath) => filePath !== ""),
            ),
          );
          const normalizedCommands = Array.from(
            new Set(
              (telemetryInput.verifiedCommands ?? [])
                .map((cmd) => normalizeVerifiedCommand(cmd))
                .filter((cmd) => cmd !== ""),
            ),
          );

          if (editedFiles.length > 0 && normalizedCommands.length > 0) {
            const primaryCommand = normalizedCommands[0]!;
            const verifyKey = buildAutoLessonKey({
              provider: "global",
              tool: "verify",
              errorSignature: normalizeSignaturePart(primaryCommand).slice(0, 48) || "verify",
            });
            const displayCommands = normalizedCommands
              .filter((cmd) => cmd.length <= MAX_DISPLAY_COMMAND_CHARS)
              .slice(0, 2);
            const guidance =
              displayCommands.length > 0
                ? `Run ${displayCommands.map((cmd) => `\`${cmd}\``).join(" and ")} to verify source edits before finishing.`
                : "Run the project verification check before finishing.";
            const subcommand = extractToolSubcommand(primaryCommand);
            const title = capTitle(
              subcommand !== "" ? `Verify edits with ${subcommand}` : "Verify workspace edits",
            );
            yield* recordLessonLocked(
              {
                key: verifyKey,
                provider: "global",
                tool: "verify",
                errorSignature: primaryCommand,
                title,
                guidance,
                rationaleTrace: `Post-success distillation from run ${record.runId} after editing ${editedFiles.length} file(s) with passing verification.`,
                triggerCondition: "After editing workspace source files",
                scope: "global",
                ...(projectRoot === undefined ? {} : { projectRoot }),
                confidence: 0.72,
              },
              nowIso,
            );
          }

          const pair = telemetryInput.recoveredCommandPair;
          const pairFailed = pair !== undefined ? normalizeVerifiedCommand(pair.failedCommand) : "";
          const pairSucceeded =
            pair !== undefined ? normalizeVerifiedCommand(pair.succeededCommand) : "";
          const hasValidRecoveryPair =
            pairFailed !== "" &&
            pairSucceeded !== "" &&
            pairFailed.length <= MAX_DISPLAY_COMMAND_CHARS &&
            pairSucceeded.length <= MAX_DISPLAY_COMMAND_CHARS &&
            extractBaseToolName(pairFailed) === extractBaseToolName(pairSucceeded) &&
            pairFailed.toLowerCase() !== pairSucceeded.toLowerCase();

          if (!distilledForSignature && hasValidRecoveryPair) {
            const pairSig = `${pairSucceeded}_instead_of_${pairFailed}`;
            const pairKey = buildAutoLessonKey({
              provider: record.provider,
              tool: "recovery",
              errorSignature: pairSig,
            });
            const pairTitle = `Use ${pairSucceeded} instead of ${pairFailed}`;
            yield* recordLessonLocked(
              {
                key: pairKey,
                provider: record.provider,
                tool: "recovery",
                errorSignature: pairSig,
                title: capTitle(
                  pairTitle.length <= MAX_TITLE_CHARS ? pairTitle : `Use ${pairSucceeded}`,
                ),
                guidance: `Use \`${pairSucceeded}\` instead of \`${pairFailed}\`.`,
                rationaleTrace: `Post-success recovery pair from run ${record.runId} (${pairFailed} -> ${pairSucceeded}).`,
                triggerCondition: `When ${extractBaseToolName(pairSucceeded)} command fails`,
                scope: "global",
                ...(projectRoot === undefined ? {} : { projectRoot }),
                confidence: 0.7,
              },
              nowIso,
            );
          } else if (
            record.toolErrorCount > 0 &&
            !distilledForSignature &&
            (normalizedCommands.length > 0 || editedFiles.length > 0 || sig !== undefined)
          ) {
            const recoveryTool = sig?.tool ?? "recovery";
            const recoveryCmd =
              normalizedCommands.length > 0 &&
              normalizedCommands[0]!.length <= MAX_DISPLAY_COMMAND_CHARS
                ? normalizedCommands[0]!
                : undefined;
            const recoverySig =
              scrubErrorText(sig?.errorSignature ?? "") ||
              (recoveryCmd ?? "recovered_after_tool_errors");
            const recoveryKey = buildAutoLessonKey({
              provider: record.provider,
              tool: recoveryTool,
              errorSignature: recoverySig,
            });
            const rawRecoveryTitle = sig?.title
              ? `Recovered: ${sig.title}`
              : `Verify preconditions before ${recoveryTool} (${record.provider})`;
            yield* recordLessonLocked(
              {
                key: recoveryKey,
                provider: record.provider,
                tool: recoveryTool,
                errorSignature: recoverySig,
                title: capTitle(rawRecoveryTitle),
                guidance:
                  recoveryCmd !== undefined
                    ? `Recovered after ${record.toolErrorCount} tool error(s); verify changes with \`${recoveryCmd}\`.`
                    : (scrubbedSigGuidance ??
                      `Recovered after ${record.toolErrorCount} tool error(s); inspect paths and preconditions before editing.`),
                rationaleTrace:
                  sig?.rationaleTrace ??
                  `Post-success recovery distillation from run ${record.runId} (${record.toolErrorCount} tool error(s) resolved).`,
                triggerCondition:
                  scrubbedSigTrigger ?? `${record.provider}:${recoveryTool}:${recoverySig}`,
                scope: sig?.scope ?? "global",
                ...(sig?.globs === undefined ? {} : { globs: sig.globs }),
                ...(projectRoot === undefined ? {} : { projectRoot }),
                confidence: 0.68,
              },
              nowIso,
            );
          }
        }

        return record;
      }),
    );
  });

  const queryLessons: RsiServiceShape["queryLessons"] = Effect.fn("RsiService.queryLessons")(
    function* (queryInput) {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const lessons = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* hydrateLocked();
          return yield* Ref.get(lessonsRef);
        }),
      );
      const minConfidence = queryInput?.minConfidence ?? 0;
      const normalizedProvider =
        queryInput?.provider === undefined
          ? undefined
          : normalizeSignaturePart(queryInput.provider);
      const normalizedTool =
        queryInput?.tool === undefined ? undefined : normalizeSignaturePart(queryInput.tool);
      const searchTerm = queryInput?.query?.trim().toLowerCase() ?? "";
      const activePaths = queryInput?.activePaths ?? [];

      const scored = lessons
        .filter((lesson) => {
          if (lesson.confidence < minConfidence) return false;
          if (queryInput?.scope !== undefined && lesson.scope !== queryInput.scope) return false;
          // A passed cwd (even null) is a session context; omitting it lists everything for the UI.
          if (
            queryInput?.cwd !== undefined &&
            lesson.projectRoot !== undefined &&
            !isSameOrInsidePath(queryInput.cwd, lesson.projectRoot)
          ) {
            return false;
          }
          if (normalizedProvider !== undefined) {
            const lessonProvider = extractProviderFromKey(lesson.key);
            if (lessonProvider !== undefined && lessonProvider !== normalizedProvider) return false;
          }
          if (normalizedTool !== undefined) {
            const lessonTool = extractToolFromKey(lesson.key);
            if (lessonTool !== undefined && lessonTool !== normalizedTool) return false;
          }
          if (searchTerm !== "") {
            const haystack =
              `${lesson.title} ${lesson.guidance} ${lesson.triggerCondition} ${lesson.key}`.toLowerCase();
            if (!haystack.includes(searchTerm)) return false;
          }
          return true;
        })
        .map((lesson) => {
          const globMatched =
            lesson.scope === "glob" && matchesAnyGlob(lesson.globs, activePaths, queryInput?.cwd);
          const priorityBoost = globMatched ? 10 : lesson.scope === "global" ? 2 : 0;
          return { lesson, rank: priorityBoost + lessonUtilityScore(lesson, nowMs), globMatched };
        })
        .filter((entry) =>
          activePaths.length > 0 ? entry.lesson.scope === "global" || entry.globMatched : true,
        )
        .sort((a, b) => b.rank - a.rank)
        .map((entry) => entry.lesson);

      if (queryInput?.limit !== undefined && queryInput.limit > 0) {
        return scored.slice(0, queryInput.limit);
      }
      return scored;
    },
  );

  const getTelemetrySummary: RsiServiceShape["getTelemetrySummary"] = Effect.fn(
    "RsiService.getTelemetrySummary",
  )(function* (summaryInput) {
    const { allRows, lastSynced } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* hydrateLocked();
        return {
          allRows: yield* Ref.get(telemetryRef),
          lastSynced: yield* Ref.get(lastSyncedCcrRef),
        };
      }),
    );
    const filtered = allRows.filter((row) => {
      if (summaryInput?.threadId !== undefined && row.threadId !== summaryInput.threadId) {
        return false;
      }
      if (summaryInput?.provider !== undefined && row.provider !== summaryInput.provider) {
        return false;
      }
      return true;
    });
    const limit =
      summaryInput?.limit !== undefined && summaryInput.limit > 0
        ? summaryInput.limit
        : TELEMETRY_SUMMARY_RECENT_LIMIT;

    let successCount = 0;
    let failureCount = 0;
    let loopTrips = 0;
    let safetyBlocks = 0;
    let totalToolErrors = 0;
    let totalWastedReads = 0;
    const latestByThread = new Map<string, RsiRunTelemetryRecord>();
    let totalTokensSavedEst = 0;
    let totalCompressedCalls = 0;
    let cacheHitRateSum = 0;
    let durationSum = 0;

    const byProviderMap = new Map<
      string,
      {
        runs: number;
        failures: number;
        loopTrips: number;
        safetyBlocks: number;
        cacheRateSum: number;
      }
    >();

    for (const row of filtered) {
      if (isFailureOutcome(row.outcome)) failureCount += 1;
      else successCount += 1;
      if (row.loopTripped) loopTrips += 1;
      safetyBlocks += row.safetyBlockedCount;
      totalToolErrors += row.toolErrorCount;
      totalWastedReads += row.wastedReads;
      latestByThread.set(row.threadId, row);
      totalTokensSavedEst += clampNonNegativeNumber(row.tokensSavedEst ?? 0);
      totalCompressedCalls += Math.floor(clampNonNegativeNumber(row.compressedCallsCount ?? 0));
      cacheHitRateSum += row.cacheHitRate;
      durationSum += row.durationMs;

      const existing = byProviderMap.get(row.provider) ?? {
        runs: 0,
        failures: 0,
        loopTrips: 0,
        safetyBlocks: 0,
        cacheRateSum: 0,
      };
      existing.runs += 1;
      if (isFailureOutcome(row.outcome)) existing.failures += 1;
      if (row.loopTripped) existing.loopTrips += 1;
      existing.safetyBlocks += row.safetyBlockedCount;
      existing.cacheRateSum += row.cacheHitRate;
      byProviderMap.set(row.provider, existing);
    }

    if (summaryInput?.threadId === undefined && summaryInput?.provider === undefined) {
      const storeStats = ccrStore.getStats();
      const baseTokens =
        storeStats.tokensSavedEst < lastSynced.tokensSavedEst ? 0 : lastSynced.tokensSavedEst;
      const baseCalls =
        storeStats.compressedCallsCount < lastSynced.compressedCallsCount
          ? 0
          : lastSynced.compressedCallsCount;
      totalTokensSavedEst += Math.max(0, storeStats.tokensSavedEst - baseTokens);
      totalCompressedCalls += Math.max(0, storeStats.compressedCallsCount - baseCalls);
    }

    // usedTokens is the context size of a run's last message, not spend: count each thread's latest run once.
    let totalTokens = 0;
    let totalCachedInputTokens = 0;
    for (const row of latestByThread.values()) {
      totalTokens += row.usedTokens;
      totalCachedInputTokens += row.cachedInputTokens;
    }

    const totalRuns = filtered.length;
    const byProvider: Array<RsiProviderTelemetryBreakdown> = Array.from(
      byProviderMap.entries(),
    ).map(([provider, stats]) => ({
      provider,
      runs: stats.runs,
      failures: stats.failures,
      loopTrips: stats.loopTrips,
      safetyBlocks: stats.safetyBlocks,
      avgCacheHitRate:
        stats.runs > 0 ? Math.round((stats.cacheRateSum / stats.runs) * 10_000) / 10_000 : 0,
    }));

    return {
      totalRuns,
      successCount,
      failureCount,
      loopTrips,
      safetyBlocks,
      totalToolErrors,
      totalWastedReads,
      totalTokens,
      totalCachedInputTokens,
      totalTokensSavedEst,
      totalCompressedCalls,
      avgCacheHitRate:
        totalRuns > 0 ? Math.round((cacheHitRateSum / totalRuns) * 10_000) / 10_000 : 0,
      avgDurationMs: totalRuns > 0 ? Math.round(durationSum / totalRuns) : 0,
      byProvider,
      recentRuns: filtered.slice(-limit).reverse(),
    };
  });

  const formatSessionPrefixWithMetadata: RsiServiceShape["formatSessionPrefixWithMetadata"] =
    Effect.fn("RsiService.formatSessionPrefixWithMetadata")(function* (prefixInput) {
      const maxChars = Math.max(80, prefixInput.maxChars ?? DEFAULT_SESSION_PREFIX_MAX_CHARS);
      const activePaths = prefixInput.activePaths ?? [];
      const specHint =
        prefixInput.userPrompt !== undefined
          ? distillTechnicalPromptSpec(prefixInput.userPrompt).specHint
          : undefined;
      const lessons = yield* queryLessons({
        cwd: prefixInput.cwd ?? null,
        ...(prefixInput.provider === undefined ? {} : { provider: prefixInput.provider }),
        activePaths,
        minConfidence: 0.4,
      });
      const eligible = lessons.filter(
        (lesson) =>
          (lesson.projectRoot === undefined ||
            isSameOrInsidePath(prefixInput.cwd, lesson.projectRoot)) &&
          (lesson.scope === "global" ||
            (activePaths.length > 0 && matchesAnyGlob(lesson.globs, activePaths, prefixInput.cwd))),
      );

      let prefix = "";
      const lessonIds: Array<string> = [];
      const reservedSpecChars =
        specHint !== undefined && maxChars >= specHint.length + 140 ? specHint.length + 1 : 0;
      const lessonBudget = maxChars - reservedSpecChars;

      if (eligible.length > 0) {
        const header = "[RSI Lessons]";
        const lines: Array<string> = [header];
        let currentLength = header.length;

        for (const lesson of eligible) {
          const line = `- ${lesson.title}: ${lesson.guidance}`;
          const nextLength = currentLength + 1 + line.length;
          if (nextLength <= lessonBudget) {
            lines.push(line);
            lessonIds.push(lesson.id);
            currentLength = nextLength;
            continue;
          }
          const remaining = lessonBudget - currentLength - 4;
          if (remaining > 20 && lines.length === 1) {
            lines.push(`${line.slice(0, remaining).trimEnd()}...`);
            lessonIds.push(lesson.id);
            currentLength = lines.join("\n").length;
          }
          break;
        }
        if (lines.length > 1) {
          if (specHint !== undefined && currentLength + 1 + specHint.length <= maxChars) {
            lines.push(specHint);
          }
          prefix = lines.join("\n");
        }
      }

      if (prefix === "" && specHint !== undefined) {
        prefix = specHint.length <= maxChars ? specHint : specHint.slice(0, maxChars);
      }

      if (
        prefixInput.threadId !== undefined &&
        prefixInput.threadId.trim() !== "" &&
        prefixInput.runId !== undefined &&
        prefixInput.runId.trim() !== ""
      ) {
        const trackedIds: ReadonlyArray<string> = [...lessonIds];
        yield* Ref.update(injectedByRunRef, (map) =>
          setBoundedMap(map, prefixInput.runId!.trim(), trackedIds, MAX_TRACKED_RUN_LESSONS),
        );
      }

      return { prefix, lessonIds };
    });

  const formatSessionPrefix: RsiServiceShape["formatSessionPrefix"] = Effect.fn(
    "RsiService.formatSessionPrefix",
  )(function* (prefixInput) {
    const result = yield* formatSessionPrefixWithMetadata(prefixInput);
    return result.prefix;
  });

  const getAppliedLessonIds: RsiServiceShape["getAppliedLessonIds"] = Effect.fn(
    "RsiService.getAppliedLessonIds",
  )(function* (lookupInput) {
    return yield* resolveTrackedLessonIds(lookupInput, false);
  });

  return {
    recordRunTelemetry,
    queryLessons,
    recordLesson,
    demoteLesson,
    deleteLesson,
    getTelemetrySummary,
    formatSessionPrefix,
    formatSessionPrefixWithMetadata,
    getAppliedLessonIds,
  } satisfies RsiServiceShape;
});

const makeLayerEffect = Effect.fn("RsiService.makeLayer")(function* (options?: {
  readonly persistCcr?: boolean;
}) {
  const configOpt = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fsOpt = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathOpt = yield* Effect.serviceOption(Path.Path);
  const settingsOpt = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const persistence: PersistenceHandles | undefined =
    Option.isSome(configOpt) &&
    Option.isSome(fsOpt) &&
    Option.isSome(pathOpt) &&
    configOpt.value.stateDir.trim() !== ""
      ? (() => {
          const rsiDir = pathOpt.value.join(configOpt.value.stateDir, "rsi");
          const defaultBrainDir = pathOpt.value.join(
            configOpt.value.stateDir,
            "obsidian-vault",
            "T3-Brain",
          );
          const resolveObsidianBrainDir = (): Effect.Effect<string | null> =>
            Option.isNone(settingsOpt)
              ? Effect.succeed(defaultBrainDir)
              : settingsOpt.value.getSettings.pipe(
                  Effect.map((settings) => {
                    if (
                      "obsidianMemorySyncEnabled" in settings &&
                      settings.obsidianMemorySyncEnabled === false
                    ) {
                      return null;
                    }
                    const customRoot =
                      "obsidianVaultPath" in settings &&
                      typeof settings.obsidianVaultPath === "string"
                        ? settings.obsidianVaultPath.trim()
                        : "";
                    return customRoot !== ""
                      ? pathOpt.value.join(customRoot, "T3-Brain")
                      : defaultBrainDir;
                  }),
                  Effect.orElseSucceed(() => defaultBrainDir),
                );
          return {
            fs: fsOpt.value,
            path: pathOpt.value,
            rsiDir,
            lessonsPath: pathOpt.value.join(rsiDir, "lessons.json"),
            telemetryPath: pathOpt.value.join(rsiDir, "telemetry.jsonl"),
            resolveObsidianBrainDir,
          };
        })()
      : undefined;

  const isAutoDistillEnabled = () =>
    Option.isNone(settingsOpt)
      ? Effect.succeed(true)
      : settingsOpt.value.getSettings.pipe(
          Effect.map((settings) =>
            "rsiAutoDistillEnabled" in settings &&
            typeof settings.rsiAutoDistillEnabled === "boolean"
              ? settings.rsiAutoDistillEnabled
              : true,
          ),
          Effect.orElseSucceed(() => true),
        );

  return yield* makeRsiService({
    ...(persistence === undefined ? {} : { persistence }),
    isAutoDistillEnabled,
    persistCcr: options?.persistCcr ?? true,
  });
});

export class RsiService extends Context.Service<RsiService, RsiServiceShape>()(
  "t3/orchestration-v2/RsiService",
) {
  static readonly makeLayer = (options?: {
    readonly persistCcr?: boolean;
  }): Layer.Layer<RsiService> => Layer.effect(this, makeLayerEffect(options));
  static readonly layer: Layer.Layer<RsiService> = RsiService.makeLayer();
}

export const layer: Layer.Layer<RsiService> = RsiService.layer;
