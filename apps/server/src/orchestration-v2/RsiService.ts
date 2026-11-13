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

export const MAX_LESSONS = 25;
const DEFAULT_SESSION_PREFIX_MAX_CHARS = 600;
const SIMILARITY_MERGE_THRESHOLD = 0.72;
const TELEMETRY_SUMMARY_RECENT_LIMIT = 20;

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
  readonly failureSignature?: RsiRunFailureSignature | undefined;
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
  readonly avgCacheHitRate: number;
  readonly avgDurationMs: number;
  readonly byProvider: ReadonlyArray<RsiProviderTelemetryBreakdown>;
  readonly recentRuns: ReadonlyArray<RsiRunTelemetryRecord>;
}

export interface RsiFormatSessionPrefixInput {
  readonly cwd?: string | null | undefined;
  readonly activePaths?: ReadonlyArray<string> | undefined;
  readonly provider?: string | undefined;
  readonly maxChars?: number | undefined;
}

export interface RsiServiceShape {
  readonly recordRunTelemetry: (
    input: RsiRunTelemetryInput,
  ) => Effect.Effect<RsiRunTelemetryRecord>;
  readonly queryLessons: (input?: RsiQueryLessonsInput) => Effect.Effect<ReadonlyArray<RsiLesson>>;
  readonly recordLesson: (input: RsiRecordLessonInput) => Effect.Effect<RsiLesson>;
  readonly getTelemetrySummary: (
    input?: RsiTelemetrySummaryInput,
  ) => Effect.Effect<RsiTelemetrySummary>;
  readonly formatSessionPrefix: (input: RsiFormatSessionPrefixInput) => Effect.Effect<string>;
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

function lessonUtilityScore(lesson: RsiLesson): number {
  const updatedMs = Date.parse(lesson.updatedAt);
  const recencyTieBreaker = Number.isFinite(updatedMs) ? (updatedMs % 1_000_000_000) / 1e14 : 0;
  return lesson.confidence * (1 + Math.log1p(Math.max(1, lesson.hits))) + recencyTieBreaker;
}

function mergeLessonRecords(existing: RsiLesson, incoming: RsiLesson): RsiLesson {
  const mergedGlobs = Array.from(new Set([...existing.globs, ...incoming.globs]));
  const mergedScope: RsiLessonScope =
    existing.scope === "global" || incoming.scope === "global" ? "global" : "glob";
  return {
    ...existing,
    // Keep the richer guidance/rationale while bumping hits & confidence.
    title: incoming.title.length > existing.title.length ? incoming.title : existing.title,
    guidance:
      incoming.guidance.length >= existing.guidance.length ? incoming.guidance : existing.guidance,
    rationaleTrace:
      incoming.rationaleTrace.length > existing.rationaleTrace.length
        ? incoming.rationaleTrace
        : existing.rationaleTrace,
    triggerCondition:
      incoming.triggerCondition.length > existing.triggerCondition.length
        ? incoming.triggerCondition
        : existing.triggerCondition,
    scope: mergedScope,
    globs: mergedScope === "global" ? mergedGlobs : mergedGlobs,
    confidence: clampConfidence(Math.max(existing.confidence, incoming.confidence) + 0.05),
    hits: existing.hits + Math.max(1, incoming.hits),
    updatedAt: incoming.updatedAt,
  };
}

function curateLessonStore(
  currentLessons: ReadonlyArray<RsiLesson>,
  candidate: RsiLesson,
): { readonly lessons: ReadonlyArray<RsiLesson>; readonly stored: RsiLesson } {
  const next = [...currentLessons];
  let stored: RsiLesson | undefined;

  const exactIndex = next.findIndex((lesson) => lesson.key === candidate.key);
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
    next.sort((a, b) => lessonUtilityScore(b) - lessonUtilityScore(a));
    next.length = MAX_LESSONS;
    if (!next.some((lesson) => lesson.id === stored!.id)) {
      // Candidate itself lost to higher-utility lessons; keep the top MAX_LESSONS and return it.
      return { lessons: next, stored: stored! };
    }
  } else {
    next.sort((a, b) => lessonUtilityScore(b) - lessonUtilityScore(a));
  }

  return { lessons: next, stored: stored! };
}

function stableLessonId(key: string, nowIso: string): string {
  const slug = normalizeSignaturePart(key).slice(0, 48);
  const stamp = nowIso.replace(/[^0-9]/g, "").slice(0, 14) || "0";
  return `rsi_lesson_${slug}_${stamp}`;
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

interface PersistenceHandles {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly rsiDir: string;
  readonly lessonsPath: string;
  readonly telemetryPath: string;
}

function parseLessonsFile(raw: string): ReadonlyArray<RsiLesson> {
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
    if (!Array.isArray(list)) return [];
    const valid: Array<RsiLesson> = [];
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
        valid.push({
          id: record.id!,
          key: record.key!,
          title: record.title!,
          guidance: record.guidance!,
          rationaleTrace: typeof record.rationaleTrace === "string" ? record.rationaleTrace : "",
          triggerCondition:
            typeof record.triggerCondition === "string" ? record.triggerCondition : "",
          scope: record.scope === "glob" ? "glob" : "global",
          globs: Array.isArray(record.globs)
            ? record.globs.filter((item): item is string => typeof item === "string")
            : [],
          confidence: clampConfidence(
            typeof record.confidence === "number" ? record.confidence : 0.7,
          ),
          hits: typeof record.hits === "number" && record.hits > 0 ? Math.floor(record.hits) : 1,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        });
      }
    }
    return valid.slice(0, MAX_LESSONS);
  } catch {
    return [];
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

export const makeRsiService = Effect.fn("RsiService.make")(function* (input?: {
  readonly persistence?: PersistenceHandles;
  readonly isAutoDistillEnabled?: () => Effect.Effect<boolean>;
}): Effect.fn.Return<RsiServiceShape> {
  const lessonsRef = yield* Ref.make<ReadonlyArray<RsiLesson>>([]);
  const telemetryRef = yield* Ref.make<ReadonlyArray<RsiRunTelemetryRecord>>([]);
  const recurrenceRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const hydratedRef = yield* Ref.make(false);
  const mutex = Semaphore.makeUnsafe(1);

  const persistence = input?.persistence;
  const isAutoDistillEnabled = input?.isAutoDistillEnabled ?? (() => Effect.succeed(true));

  const hydrateLocked = Effect.fn("RsiService.hydrateLocked")(function* () {
    if (yield* Ref.get(hydratedRef)) return;
    if (persistence !== undefined) {
      const lessonsRaw = yield* persistence.fs
        .readFileString(persistence.lessonsPath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (lessonsRaw.trim() !== "") {
        yield* Ref.set(lessonsRef, parseLessonsFile(lessonsRaw));
      }
      const telemetryRaw = yield* persistence.fs
        .readFileString(persistence.telemetryPath)
        .pipe(Effect.orElseSucceed(() => ""));
      if (telemetryRaw.trim() !== "") {
        yield* Ref.set(telemetryRef, parseTelemetryJsonl(telemetryRaw));
      }
    }
    yield* Ref.set(hydratedRef, true);
  });

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
  });

  const appendTelemetryLocked = Effect.fn("RsiService.appendTelemetryLocked")(function* (
    record: RsiRunTelemetryRecord,
  ) {
    if (persistence === undefined) return;
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
  });

  const recordLessonLocked = Effect.fn("RsiService.recordLessonLocked")(function* (
    lessonInput: RsiRecordLessonInput,
    nowIso: string,
  ) {
    const key = resolveLessonKey(lessonInput);
    const scope: RsiLessonScope =
      lessonInput.scope ?? (lessonInput.globs?.length ? "glob" : "global");
    const globs = normalizeGlobs(lessonInput.globs);
    const candidate: RsiLesson = {
      id: lessonInput.id?.trim() || stableLessonId(key, nowIso),
      key,
      title: lessonInput.title.trim(),
      guidance: lessonInput.guidance.trim(),
      rationaleTrace: lessonInput.rationaleTrace?.trim() ?? "",
      triggerCondition: lessonInput.triggerCondition?.trim() ?? "",
      scope: scope === "glob" && globs.length > 0 ? "glob" : "global",
      globs,
      confidence: clampConfidence(lessonInput.confidence ?? 0.7),
      hits:
        lessonInput.hits !== undefined && Number.isFinite(lessonInput.hits) && lessonInput.hits > 0
          ? Math.floor(lessonInput.hits)
          : 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const current = yield* Ref.get(lessonsRef);
    const curated = curateLessonStore(current, candidate);
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
      timestamp: nowIso,
    };

    const autoDistill = yield* isAutoDistillEnabled();

    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* hydrateLocked();
        yield* Ref.update(telemetryRef, (rows) => [...rows, record]);
        yield* appendTelemetryLocked(record);

        if (!autoDistill) return;
        const sig = telemetryInput.failureSignature;
        const hasFailureSignal =
          record.loopTripped ||
          record.safetyBlockedCount > 0 ||
          record.toolErrorCount > 0 ||
          isFailureOutcome(record.outcome);
        if (!hasFailureSignal) return;

        const tool =
          sig?.tool ??
          (record.loopTripped
            ? "circuit_breaker"
            : record.safetyBlockedCount > 0
              ? "safety_guard"
              : "runtime");
        const errorSignature =
          sig?.errorSignature ??
          (record.loopTripped
            ? `loop_${record.outcome}`
            : record.safetyBlockedCount > 0
              ? "safety_block"
              : `run_${record.outcome}`);
        const recurrenceKey = buildAutoLessonKey({
          provider: record.provider,
          tool,
          errorSignature,
        });
        const nextCount = (yield* Ref.get(recurrenceRef)).get(recurrenceKey) ?? 0;
        const updatedCount = nextCount + 1;
        yield* Ref.update(recurrenceRef, (map) => {
          const copy = new Map(map);
          copy.set(recurrenceKey, updatedCount);
          return copy;
        });

        if (record.loopTripped || updatedCount >= 2) {
          const title =
            sig?.title ??
            (record.loopTripped
              ? `Avoid ${tool} loop (${record.provider})`
              : `Recurring ${tool} failure (${record.provider})`);
          const guidance =
            sig?.guidance ??
            (record.loopTripped
              ? `Breaker tripped on ${tool} (${errorSignature}); inspect tool inputs or switch approach before retrying.`
              : `Repeated ${tool} failures for ${errorSignature}; verify preconditions and paths before re-running.`);
          yield* recordLessonLocked(
            {
              key: recurrenceKey,
              provider: record.provider,
              tool,
              errorSignature,
              title,
              guidance,
              rationaleTrace:
                sig?.rationaleTrace ??
                `Auto-distilled from run ${record.runId} (outcome=${record.outcome}, toolErrors=${record.toolErrorCount}, loopTripped=${record.loopTripped}, occurrences=${updatedCount}).`,
              triggerCondition:
                sig?.triggerCondition ?? `${record.provider}:${tool}:${errorSignature}`,
              ...(sig?.scope === undefined ? {} : { scope: sig.scope }),
              ...(sig?.globs === undefined ? {} : { globs: sig.globs }),
              confidence: record.loopTripped ? 0.78 : 0.65,
            },
            nowIso,
          );
        }
      }),
    );

    return record;
  });

  const queryLessons: RsiServiceShape["queryLessons"] = Effect.fn("RsiService.queryLessons")(
    function* (queryInput) {
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
          return { lesson, rank: priorityBoost + lessonUtilityScore(lesson), globMatched };
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
    const allRows = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* hydrateLocked();
        return yield* Ref.get(telemetryRef);
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
    let totalTokens = 0;
    let totalCachedInputTokens = 0;
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
      totalTokens += row.usedTokens;
      totalCachedInputTokens += row.cachedInputTokens;
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
      avgCacheHitRate:
        totalRuns > 0 ? Math.round((cacheHitRateSum / totalRuns) * 10_000) / 10_000 : 0,
      avgDurationMs: totalRuns > 0 ? Math.round(durationSum / totalRuns) : 0,
      byProvider,
      recentRuns: filtered.slice(-limit).reverse(),
    };
  });

  const formatSessionPrefix: RsiServiceShape["formatSessionPrefix"] = Effect.fn(
    "RsiService.formatSessionPrefix",
  )(function* (prefixInput) {
    const maxChars = Math.max(80, prefixInput.maxChars ?? DEFAULT_SESSION_PREFIX_MAX_CHARS);
    const activePaths = prefixInput.activePaths ?? [];
    const lessons = yield* queryLessons({
      ...(prefixInput.cwd === undefined ? {} : { cwd: prefixInput.cwd }),
      ...(prefixInput.provider === undefined ? {} : { provider: prefixInput.provider }),
      activePaths,
      minConfidence: 0.4,
    });
    const eligible = lessons.filter(
      (lesson) =>
        lesson.scope === "global" ||
        (activePaths.length > 0 && matchesAnyGlob(lesson.globs, activePaths, prefixInput.cwd)),
    );
    if (eligible.length === 0) return "";

    const header = "[RSI Lessons]";
    const lines: Array<string> = [header];
    let currentLength = header.length;

    for (const lesson of eligible) {
      const line = `- ${lesson.title}: ${lesson.guidance}`;
      const nextLength = currentLength + 1 + line.length;
      if (nextLength <= maxChars) {
        lines.push(line);
        currentLength = nextLength;
        continue;
      }
      const remaining = maxChars - currentLength - 4;
      if (remaining > 20 && lines.length === 1) {
        lines.push(`${line.slice(0, remaining).trimEnd()}...`);
      }
      break;
    }

    return lines.length <= 1 ? "" : lines.join("\n");
  });

  return {
    recordRunTelemetry,
    queryLessons,
    recordLesson,
    getTelemetrySummary,
    formatSessionPrefix,
  } satisfies RsiServiceShape;
});

const makeLayerEffect = Effect.gen(function* () {
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
          return {
            fs: fsOpt.value,
            path: pathOpt.value,
            rsiDir,
            lessonsPath: pathOpt.value.join(rsiDir, "lessons.json"),
            telemetryPath: pathOpt.value.join(rsiDir, "telemetry.jsonl"),
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
  });
});

export class RsiService extends Context.Service<RsiService, RsiServiceShape>()(
  "t3/orchestration-v2/RsiService",
) {
  static readonly layer: Layer.Layer<RsiService> = Layer.effect(this, makeLayerEffect);
}

export const layer: Layer.Layer<RsiService> = RsiService.layer;
