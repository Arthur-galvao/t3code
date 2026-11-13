export interface CcrEntry {
  readonly ccrId: string;
  readonly content: string;
  readonly contentType: string;
  readonly sourceLabel?: string | undefined;
  readonly path?: string | undefined;
  readonly charCount: number;
  readonly byteCount: number;
  readonly totalLines: number;
}

export interface CcrPutInput {
  readonly content: string;
  readonly contentType: string;
  readonly sourceLabel?: string | undefined;
  readonly path?: string | undefined;
}

export interface CcrRetrieveInput {
  readonly ccrId: string;
  readonly query?: string | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly maxChars?: number | undefined;
}

export interface CcrRetrieveResult {
  readonly found: boolean;
  readonly ccrId: string;
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

export interface CcrStoreOptions {
  readonly maxEntries?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface CcrStore {
  readonly put: (input: CcrPutInput) => CcrEntry;
  readonly get: (ccrId: string) => CcrEntry | undefined;
  readonly retrieve: (input: CcrRetrieveInput) => CcrRetrieveResult;
  readonly recordCompression: (originalChars: number, compressedChars: number) => void;
  readonly getStats: () => CcrStats;
  readonly clear: () => void;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 20_000_000;
const DEFAULT_RETRIEVE_MAX_CHARS = 12_000;

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

export function createCcrStore(options?: CcrStoreOptions): CcrStore {
  const maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxBytes = Math.max(1, options?.maxBytes ?? DEFAULT_MAX_BYTES);

  const entries = new Map<string, CcrEntry>();
  const linesCache = new Map<string, ReadonlyArray<string>>();
  let nextSeq = 1;
  let currentBytes = 0;
  let compressedCallsCount = 0;
  let totalOriginalChars = 0;
  let totalCompressedChars = 0;
  let totalSavedChars = 0;

  const evictOldestIfNeeded = (incomingBytes: number) => {
    while (
      entries.size > 0 &&
      (entries.size >= maxEntries || currentBytes + incomingBytes > maxBytes)
    ) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = entries.get(oldestKey);
      entries.delete(oldestKey);
      linesCache.delete(oldestKey);
      if (oldest !== undefined) {
        currentBytes = Math.max(0, currentBytes - oldest.byteCount);
      }
    }
  };

  const put = (input: CcrPutInput): CcrEntry => {
    const ccrId = `ccr_${String(nextSeq).padStart(4, "0")}`;
    nextSeq += 1;

    const lines = splitLines(input.content);
    const byteCount = Buffer.byteLength(input.content, "utf8");
    const entry: CcrEntry = {
      ccrId,
      content: input.content,
      contentType: input.contentType,
      ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
      charCount: input.content.length,
      byteCount,
      totalLines: lines.length,
    };

    evictOldestIfNeeded(byteCount);
    entries.set(ccrId, entry);
    linesCache.set(ccrId, lines);
    currentBytes += byteCount;
    return entry;
  };

  const get = (ccrId: string): CcrEntry | undefined => entries.get(ccrId);

  const retrieve = (input: CcrRetrieveInput): CcrRetrieveResult => {
    const entry = entries.get(input.ccrId);
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

    const lines = linesCache.get(input.ccrId) ?? splitLines(entry.content);
    const totalLines = lines.length;
    const maxChars = Math.max(1, Math.floor(input.maxChars ?? DEFAULT_RETRIEVE_MAX_CHARS));

    if (totalLines === 0) {
      return {
        found: true,
        ccrId: entry.ccrId,
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

    const matched: Array<{ readonly lineNum: number; readonly formatted: string }> = [];
    for (let lineNum = effectiveStart; lineNum <= effectiveEnd; lineNum += 1) {
      const lineText = lines[lineNum - 1] ?? "";
      if (matcher === undefined || matcher(lineText)) {
        matched.push({
          lineNum,
          formatted: `L${lineNum}: ${lineText}`,
        });
      }
    }

    if (matched.length === 0) {
      return {
        found: true,
        ccrId: entry.ccrId,
        contentType: entry.contentType,
        ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
        ...(entry.path !== undefined ? { path: entry.path } : {}),
        totalLines,
        matchedLines: 0,
        truncated: false,
        content: "",
      };
    }

    const outputLines: Array<string> = [];
    let usedChars = 0;
    let firstIncludedLine: number | undefined;
    let lastIncludedLine: number | undefined;
    let truncated = false;

    for (const item of matched) {
      const separatorChars = outputLines.length === 0 ? 0 : 1;
      const neededChars = separatorChars + item.formatted.length;
      if (usedChars + neededChars > maxChars) {
        if (outputLines.length === 0) {
          outputLines.push(item.formatted.slice(0, maxChars));
          firstIncludedLine = item.lineNum;
          lastIncludedLine = item.lineNum;
        }
        truncated = true;
        break;
      }
      outputLines.push(item.formatted);
      usedChars += neededChars;
      firstIncludedLine ??= item.lineNum;
      lastIncludedLine = item.lineNum;
    }

    return {
      found: true,
      ccrId: entry.ccrId,
      contentType: entry.contentType,
      ...(entry.sourceLabel !== undefined ? { sourceLabel: entry.sourceLabel } : {}),
      ...(entry.path !== undefined ? { path: entry.path } : {}),
      totalLines,
      matchedLines: matched.length,
      ...(firstIncludedLine !== undefined ? { startLine: firstIncludedLine } : {}),
      ...(lastIncludedLine !== undefined ? { endLine: lastIncludedLine } : {}),
      truncated,
      content: outputLines.join("\n"),
    };
  };

  const recordCompression = (originalChars: number, compressedChars: number) => {
    const safeOrig = Math.max(0, Math.floor(originalChars));
    const safeComp = Math.max(0, Math.min(safeOrig, Math.floor(compressedChars)));
    compressedCallsCount += 1;
    totalOriginalChars += safeOrig;
    totalCompressedChars += safeComp;
    totalSavedChars += safeOrig - safeComp;
  };

  const getStats = (): CcrStats => ({
    entriesCount: entries.size,
    currentBytes,
    compressedCallsCount,
    totalOriginalChars,
    totalCompressedChars,
    totalSavedChars,
    tokensSavedEst: Math.round(totalSavedChars / 4),
  });

  const clear = () => {
    entries.clear();
    linesCache.clear();
    currentBytes = 0;
    compressedCallsCount = 0;
    totalOriginalChars = 0;
    totalCompressedChars = 0;
    totalSavedChars = 0;
    nextSeq = 1;
  };

  return {
    put,
    get,
    retrieve,
    recordCompression,
    getStats,
    clear,
  };
}

export const defaultCcrStore: CcrStore = createCcrStore();
