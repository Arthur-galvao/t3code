// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface CcrEntry {
  readonly ccrId: string;
  readonly threadId?: string | undefined;
  readonly content: string;
  readonly contentType: string;
  readonly sourceLabel?: string | undefined;
  readonly path?: string | undefined;
  readonly charCount: number;
  readonly byteCount: number;
  readonly totalLines: number;
  readonly createdAtMs?: number | undefined;
}

export interface CcrPutInput {
  readonly content: string;
  readonly contentType: string;
  readonly threadId?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly path?: string | undefined;
}

export interface CcrRetrieveInput {
  readonly ccrId: string;
  readonly threadId?: string | undefined;
  readonly query?: string | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly contextLines?: number | undefined;
  readonly maxChars?: number | undefined;
}

export interface CcrRetrieveResult {
  readonly found: boolean;
  readonly ccrId: string;
  readonly threadId?: string | undefined;
  readonly contentType?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly path?: string | undefined;
  readonly totalLines: number;
  readonly matchedLines: number;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly truncated: boolean;
  readonly content: string;
}

export interface CcrStats {
  readonly entriesCount: number;
  readonly currentBytes: number;
  readonly compressedCallsCount: number;
  readonly totalOriginalChars: number;
  readonly totalCompressedChars: number;
  readonly totalSavedChars: number;
  readonly tokensSavedEst: number;
}

export interface CcrStorePersistenceOptions {
  readonly ttlMs?: number | undefined;
  readonly debounceMs?: number | undefined;
}

export interface CcrStoreOptions {
  readonly maxEntries?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxEntriesPerThread?: number | undefined;
  readonly ttlMs?: number | undefined;
  readonly persistPath?: string | undefined;
  readonly debounceMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CcrStore {
  readonly put: (input: CcrPutInput) => CcrEntry;
  readonly get: (ccrId: string, threadId?: string) => CcrEntry | undefined;
  readonly retrieve: (input: CcrRetrieveInput) => CcrRetrieveResult;
  readonly recordCompression: (
    originalChars: number,
    compressedChars: number,
    threadId?: string,
  ) => void;
  readonly getStats: (threadId?: string) => CcrStats;
  readonly configurePersistence: (
    persistPath: string,
    options?: CcrStorePersistenceOptions,
  ) => void;
  readonly hydrate: () => void;
  readonly flush: () => void;
  readonly clear: () => void;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 20_000_000;
const DEFAULT_MAX_ENTRIES_PER_THREAD = 100;
const MAX_CONTEXT_LINES = 20;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_RETRIEVE_MAX_CHARS = 12_000;
const GLOBAL_THREAD_ID = "__global__";

interface CompressionCounters {
  compressedCallsCount: number;
  totalOriginalChars: number;
  totalCompressedChars: number;
  totalSavedChars: number;
}

interface PersistedCcrSnapshot {
  readonly version: 1;
  readonly nextSeq: number;
  readonly entries: ReadonlyArray<CcrEntry>;
  readonly globalCompression?: CompressionCounters | undefined;
  readonly threadCompression?: Readonly<Record<string, CompressionCounters>> | undefined;
}

function createEmptyCounters(): CompressionCounters {
  return {
    compressedCallsCount: 0,
    totalOriginalChars: 0,
    totalCompressedChars: 0,
    totalSavedChars: 0,
  };
}

function normalizeThreadId(threadId: string | undefined): string {
  const trimmed = threadId?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : GLOBAL_THREAD_ID;
}

function parseCcrSeq(ccrId: string): number {
  const match = /^ccr_(\d+)$/.exec(ccrId);
  if (match === null) return 0;
  const parsed = Number.parseInt(match[1] ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitLines(content: string): ReadonlyArray<string> {
  if (content === "") return [];
  return content.split(/\r?\n/);
}

function buildLineMatcher(query: string): (line: string) => boolean {
  const trimmed = query.trim();
  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const lastSlash = trimmed.lastIndexOf("/");
    const pattern = trimmed.slice(1, lastSlash);
    const rawFlags = trimmed.slice(lastSlash + 1);
    const flags = rawFlags.replaceAll(/[gy]/g, "");
    const caseInsensitiveFlags = flags.includes("i") ? flags : `${flags}i`;
    try {
      const regex = new RegExp(pattern, caseInsensitiveFlags);
      return (line) => regex.test(line);
    } catch {
      // Fall back to literal substring matching when regex syntax is invalid.
    }
  }

  try {
    const regex = new RegExp(query, "i");
    return (line) => regex.test(line);
  } catch {
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
}

function sanitizeCounters(raw: unknown): CompressionCounters | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Partial<CompressionCounters>;
  const toNonNegInt = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  return {
    compressedCallsCount: toNonNegInt(record.compressedCallsCount),
    totalOriginalChars: toNonNegInt(record.totalOriginalChars),
    totalCompressedChars: toNonNegInt(record.totalCompressedChars),
    totalSavedChars: toNonNegInt(record.totalSavedChars),
  };
}

export function createCcrStore(options?: CcrStoreOptions): CcrStore {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxBytes = Math.max(1, options?.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxEntriesPerThread = Math.max(
    1,
    options?.maxEntriesPerThread ?? DEFAULT_MAX_ENTRIES_PER_THREAD,
  );
  const now = options?.now ?? (() => Date.now());

  let ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  let persistPath = options?.persistPath;
  let debounceMs = options?.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let tempWriteSeq = 0;

  const entries = new Map<string, CcrEntry>();
  const linesCache = new Map<string, ReadonlyArray<string>>();
  const threadCompression = new Map<string, CompressionCounters>();
  let globalCompression = createEmptyCounters();
  let nextSeq = 1;
  let currentBytes = 0;

  const deleteEntry = (ccrId: string) => {
    const existing = entries.get(ccrId);
    entries.delete(ccrId);
    linesCache.delete(ccrId);
    if (existing !== undefined) {
      currentBytes = Math.max(0, currentBytes - existing.byteCount);
    }
  };

  const isExpired = (entry: CcrEntry, nowMs: number): boolean => {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    if (entry.createdAtMs === undefined || !Number.isFinite(entry.createdAtMs)) return false;
    return nowMs - entry.createdAtMs >= ttlMs;
  };

  const pruneExpired = (nowMs: number): boolean => {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    let removed = false;
    for (const [ccrId, entry] of entries) {
      if (isExpired(entry, nowMs)) {
        deleteEntry(ccrId);
        removed = true;
      }
    }
    return removed;
  };

  const evictOldestForThreadIfNeeded = (threadId: string) => {
    const threadKeys: Array<string> = [];
    for (const [ccrId, entry] of entries) {
      if (normalizeThreadId(entry.threadId) === threadId) {
        threadKeys.push(ccrId);
      }
    }
    while (threadKeys.length >= maxEntriesPerThread) {
      const oldestThreadKey = threadKeys.shift();
      if (oldestThreadKey === undefined) break;
      deleteEntry(oldestThreadKey);
    }
  };

  const evictOldestIfNeeded = (incomingBytes: number) => {
    while (entries.size > 0) {
      if (entries.size < maxEntries && currentBytes + incomingBytes <= maxBytes) {
        break;
      }
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      deleteEntry(oldestKey);
    }
  };

  const writeSnapshotSync = () => {
    if (persistPath === undefined) return;
    pruneExpired(now());
    const threadRecord: Record<string, CompressionCounters> = {};
    for (const [tid, counters] of threadCompression) {
      threadRecord[tid] = { ...counters };
    }
    const snapshot: PersistedCcrSnapshot = {
      version: 1,
      nextSeq,
      entries: [...entries.values()],
      globalCompression: { ...globalCompression },
      threadCompression: threadRecord,
    };
    const targetPath = persistPath;
    tempWriteSeq += 1;
    const tempPath = `${targetPath}.${tempWriteSeq}.tmp`;
    try {
      NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });
      NodeFS.writeFileSync(tempPath, JSON.stringify(snapshot), "utf8");
      NodeFS.renameSync(tempPath, targetPath);
    } catch {
      try {
        if (NodeFS.existsSync(tempPath)) {
          NodeFS.rmSync(tempPath, { force: true });
        }
      } catch {
        // Ignore cleanup errors during best-effort persistence.
      }
    }
  };

  const cancelPendingPersist = () => {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
  };

  const schedulePersist = () => {
    if (persistPath === undefined) return;
    cancelPendingPersist();
    if (debounceMs <= 0) {
      writeSnapshotSync();
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      writeSnapshotSync();
    }, debounceMs);
    persistTimer.unref?.();
  };

  const findEntry = (ccrId: string, threadId?: string): CcrEntry | undefined => {
    pruneExpired(now());
    if (threadId !== undefined) {
      const preferredThread = normalizeThreadId(threadId);
      const direct = entries.get(ccrId);
      if (direct !== undefined && normalizeThreadId(direct.threadId) === preferredThread) {
        return direct;
      }
      for (const entry of entries.values()) {
        if (entry.ccrId === ccrId && normalizeThreadId(entry.threadId) === preferredThread) {
          return entry;
        }
      }
    }
    return entries.get(ccrId);
  };

  const hydrate = () => {
    if (persistPath === undefined) return;
    let raw: string;
    try {
      raw = NodeFS.readFileSync(persistPath, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as Partial<PersistedCcrSnapshot>).version !== 1 ||
      !Array.isArray((parsed as Partial<PersistedCcrSnapshot>).entries)
    ) {
      return;
    }

    const snapshot = parsed as PersistedCcrSnapshot;
    const nowMs = now();
    let maxParsedSeq = 0;

    for (const candidate of snapshot.entries) {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        typeof candidate.ccrId !== "string" ||
        typeof candidate.content !== "string" ||
        typeof candidate.contentType !== "string"
      ) {
        continue;
      }
      const seqNum = parseCcrSeq(candidate.ccrId);
      if (seqNum > maxParsedSeq) maxParsedSeq = seqNum;
      if (isExpired(candidate, nowMs)) continue;
      if (entries.has(candidate.ccrId)) continue;

      const lines = splitLines(candidate.content);
      const byteCount = Buffer.byteLength(candidate.content, "utf8");
      const entryThreadId = normalizeThreadId(candidate.threadId);
      const hydratedEntry: CcrEntry = {
        ccrId: candidate.ccrId,
        threadId: entryThreadId,
        content: candidate.content,
        contentType: candidate.contentType,
        ...(candidate.sourceLabel !== undefined ? { sourceLabel: candidate.sourceLabel } : {}),
        ...(candidate.path !== undefined ? { path: candidate.path } : {}),
        charCount: candidate.content.length,
        byteCount,
        totalLines: lines.length,
        ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
      };

      evictOldestForThreadIfNeeded(entryThreadId);
      evictOldestIfNeeded(byteCount);
      entries.set(hydratedEntry.ccrId, hydratedEntry);
      linesCache.set(hydratedEntry.ccrId, lines);
      currentBytes += byteCount;
    }

    const snapshotNextSeq =
      typeof snapshot.nextSeq === "number" && Number.isFinite(snapshot.nextSeq)
        ? Math.floor(snapshot.nextSeq)
        : 1;
    nextSeq = Math.max(nextSeq, snapshotNextSeq, maxParsedSeq + 1);

    if (globalCompression.compressedCallsCount === 0 && snapshot.globalCompression !== undefined) {
      const sanitizedGlobal = sanitizeCounters(snapshot.globalCompression);
      if (sanitizedGlobal !== undefined) {
        globalCompression = sanitizedGlobal;
      }
    }
    if (
      threadCompression.size === 0 &&
      snapshot.threadCompression !== undefined &&
      typeof snapshot.threadCompression === "object"
    ) {
      for (const [tid, counters] of Object.entries(snapshot.threadCompression)) {
        const sanitized = sanitizeCounters(counters);
        if (sanitized !== undefined) {
          threadCompression.set(normalizeThreadId(tid), sanitized);
        }
      }
    }
  };

  const configurePersistence = (
    nextPersistPath: string,
    persistenceOptions?: CcrStorePersistenceOptions,
  ) => {
    persistPath = nextPersistPath;
    if (persistenceOptions?.ttlMs !== undefined) {
      ttlMs = persistenceOptions.ttlMs;
    }
    if (persistenceOptions?.debounceMs !== undefined) {
      debounceMs = persistenceOptions.debounceMs;
    }
    hydrate();
  };

  const flush = () => {
    cancelPendingPersist();
    writeSnapshotSync();
  };

  const put = (input: CcrPutInput): CcrEntry => {
    const nowMs = now();
    pruneExpired(nowMs);

    const threadId = normalizeThreadId(input.threadId);
    const ccrId = `ccr_${String(nextSeq).padStart(4, "0")}`;
    nextSeq += 1;

    const lines = splitLines(input.content);
    const byteCount = Buffer.byteLength(input.content, "utf8");
    const entry: CcrEntry = {
      ccrId,
      threadId,
      content: input.content,
      contentType: input.contentType,
      ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      charCount: input.content.length,
      byteCount,
      totalLines: lines.length,
      createdAtMs: nowMs,
    };

    evictOldestForThreadIfNeeded(threadId);
    evictOldestIfNeeded(byteCount);
    entries.set(ccrId, entry);
    linesCache.set(ccrId, lines);
    currentBytes += byteCount;
    schedulePersist();
    return entry;
  };

  const get = (ccrId: string, threadId?: string): CcrEntry | undefined =>
    findEntry(ccrId, threadId);

  const retrieve = (input: CcrRetrieveInput): CcrRetrieveResult => {
    const entry = findEntry(input.ccrId, input.threadId);
    if (entry === undefined) {
      return {
        found: false,
        ccrId: input.ccrId,
        totalLines: 0,
        matchedLines: 0,
        truncated: false,
        content: `CCR entry '${input.ccrId}' was not found (it may have been evicted or cleared).`,
      };
    }

    const lines = linesCache.get(entry.ccrId) ?? splitLines(entry.content);
    const totalLines = lines.length;
    const maxChars = Math.max(1, Math.floor(input.maxChars ?? DEFAULT_RETRIEVE_MAX_CHARS));

    if (totalLines === 0) {
      return {
        found: true,
        ccrId: entry.ccrId,
        ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
        contentType: entry.contentType,
        ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        totalLines: 0,
        matchedLines: 0,
        truncated: false,
        content: "",
      };
    }

    const effectiveStart =
      input.startLine !== undefined ? Math.max(1, Math.floor(input.startLine)) : 1;
    const effectiveEnd =
      input.endLine !== undefined ? Math.min(totalLines, Math.floor(input.endLine)) : totalLines;

    if (effectiveStart > effectiveEnd) {
      return {
        found: true,
        ccrId: entry.ccrId,
        ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
        contentType: entry.contentType,
        ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        totalLines,
        matchedLines: 0,
        truncated: false,
        content: "",
      };
    }

    const query = input.query !== undefined && input.query.trim() !== "" ? input.query : undefined;
    const matcher = query !== undefined ? buildLineMatcher(query) : undefined;
    const contextLines =
      matcher !== undefined &&
      input.contextLines !== undefined &&
      Number.isFinite(input.contextLines)
        ? Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(input.contextLines)))
        : 0;

    const matchedLineNumbers: Array<number> = [];
    for (let lineNum = effectiveStart; lineNum <= effectiveEnd; lineNum += 1) {
      const lineText = lines[lineNum - 1] ?? "";
      if (matcher === undefined || matcher(lineText)) {
        matchedLineNumbers.push(lineNum);
      }
    }

    const exactMatchCount = matchedLineNumbers.length;
    if (exactMatchCount === 0) {
      return {
        found: true,
        ccrId: entry.ccrId,
        ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
        contentType: entry.contentType,
        ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        totalLines,
        matchedLines: 0,
        truncated: false,
        content: "",
      };
    }

    const candidateItems: Array<{ readonly lineNum?: number; readonly formatted: string }> = [];
    if (contextLines === 0 || matcher === undefined) {
      for (const lineNum of matchedLineNumbers) {
        candidateItems.push({
          lineNum,
          formatted: `L${lineNum}: ${lines[lineNum - 1] ?? ""}`,
        });
      }
    } else {
      const intervals: Array<{ start: number; end: number }> = [];
      for (const lineNum of matchedLineNumbers) {
        const rangeStart = Math.max(effectiveStart, lineNum - contextLines);
        const rangeEnd = Math.min(effectiveEnd, lineNum + contextLines);
        const last = intervals.at(-1);
        if (last !== undefined && rangeStart <= last.end + 1) {
          last.end = Math.max(last.end, rangeEnd);
        } else {
          intervals.push({ start: rangeStart, end: rangeEnd });
        }
      }
      for (let intervalIdx = 0; intervalIdx < intervals.length; intervalIdx += 1) {
        if (intervalIdx > 0) {
          candidateItems.push({ formatted: "--" });
        }
        const interval = intervals[intervalIdx]!;
        for (let lineNum = interval.start; lineNum <= interval.end; lineNum += 1) {
          candidateItems.push({
            lineNum,
            formatted: `L${lineNum}: ${lines[lineNum - 1] ?? ""}`,
          });
        }
      }
    }

    const outputLines: Array<string> = [];
    let usedChars = 0;
    let firstIncludedLine: number | undefined;
    let lastIncludedLine: number | undefined;
    let truncated = false;

    for (const item of candidateItems) {
      const separatorChars = outputLines.length === 0 ? 0 : 1;
      const neededChars = separatorChars + item.formatted.length;
      if (usedChars + neededChars > maxChars) {
        if (outputLines.length === 0 && item.lineNum !== undefined) {
          outputLines.push(item.formatted.slice(0, maxChars));
          firstIncludedLine = item.lineNum;
          lastIncludedLine = item.lineNum;
        }
        truncated = true;
        break;
      }
      outputLines.push(item.formatted);
      usedChars += neededChars;
      if (item.lineNum !== undefined) {
        firstIncludedLine ??= item.lineNum;
        lastIncludedLine = item.lineNum;
      }
    }
    if (outputLines.at(-1) === "--") {
      outputLines.pop();
    }

    return {
      found: true,
      ccrId: entry.ccrId,
      ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
      contentType: entry.contentType,
      ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      totalLines,
      matchedLines: exactMatchCount,
      ...(firstIncludedLine !== undefined ? { startLine: firstIncludedLine } : {}),
      ...(lastIncludedLine !== undefined ? { endLine: lastIncludedLine } : {}),
      truncated,
      content: outputLines.join("\n"),
    };
  };

  const recordCompression = (originalChars: number, compressedChars: number, threadId?: string) => {
    const safeOrig = Math.max(0, Math.floor(originalChars));
    const safeComp = Math.max(0, Math.min(safeOrig, Math.floor(compressedChars)));
    const saved = safeOrig - safeComp;
    const tid = normalizeThreadId(threadId);

    globalCompression.compressedCallsCount += 1;
    globalCompression.totalOriginalChars += safeOrig;
    globalCompression.totalCompressedChars += safeComp;
    globalCompression.totalSavedChars += saved;

    const existingThread = threadCompression.get(tid) ?? createEmptyCounters();
    existingThread.compressedCallsCount += 1;
    existingThread.totalOriginalChars += safeOrig;
    existingThread.totalCompressedChars += safeComp;
    existingThread.totalSavedChars += saved;
    threadCompression.set(tid, existingThread);

    schedulePersist();
  };

  const getStats = (threadId?: string): CcrStats => {
    pruneExpired(now());
    if (threadId === undefined) {
      return {
        entriesCount: entries.size,
        currentBytes,
        compressedCallsCount: globalCompression.compressedCallsCount,
        totalOriginalChars: globalCompression.totalOriginalChars,
        totalCompressedChars: globalCompression.totalCompressedChars,
        totalSavedChars: globalCompression.totalSavedChars,
        tokensSavedEst: Math.round(globalCompression.totalSavedChars / 4),
      };
    }

    const tid = normalizeThreadId(threadId);
    let threadEntriesCount = 0;
    let threadBytes = 0;
    for (const entry of entries.values()) {
      if (normalizeThreadId(entry.threadId) === tid) {
        threadEntriesCount += 1;
        threadBytes += entry.byteCount;
      }
    }
    const counters = threadCompression.get(tid) ?? createEmptyCounters();
    return {
      entriesCount: threadEntriesCount,
      currentBytes: threadBytes,
      compressedCallsCount: counters.compressedCallsCount,
      totalOriginalChars: counters.totalOriginalChars,
      totalCompressedChars: counters.totalCompressedChars,
      totalSavedChars: counters.totalSavedChars,
      tokensSavedEst: Math.round(counters.totalSavedChars / 4),
    };
  };

  const clear = () => {
    cancelPendingPersist();
    entries.clear();
    linesCache.clear();
    threadCompression.clear();
    globalCompression = createEmptyCounters();
    currentBytes = 0;
    nextSeq = 1;
    schedulePersist();
  };

  if (persistPath !== undefined) {
    hydrate();
  }

  return {
    put,
    get,
    retrieve,
    recordCompression,
    getStats,
    configurePersistence,
    hydrate,
    flush,
    clear,
  };
}

export const defaultCcrStore: CcrStore = createCcrStore();
