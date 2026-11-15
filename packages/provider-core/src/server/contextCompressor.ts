import { defaultCcrStore, type CcrStore } from "./ccrStore.ts";

export type CompressionContentType = "json" | "logs" | "diff" | "code" | "text";

export interface CompressToolOutputInput {
  readonly text: string;
  readonly threadId?: string | undefined;
  readonly path?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly contentTypeHint?: CompressionContentType | undefined;
  readonly minChars?: number | undefined;
  readonly store?: CcrStore | undefined;
  readonly includeFooter?: boolean | undefined;
}

export interface CompressToolOutputResult {
  readonly compressed: boolean;
  readonly text: string;
  readonly contentType: CompressionContentType;
  readonly originalChars: number;
  readonly compressedChars: number;
  readonly savedChars: number;
  readonly tokensSavedEst: number;
  readonly ccrId?: string | undefined;
}

export interface DetectContentTypeOptions {
  readonly path?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly contentTypeHint?: CompressionContentType | undefined;
}

const DEFAULT_MIN_CHARS = 2_200;
const MIN_REDUCTION_RATIO = 0.85;

const CRITICAL_JSON_RE =
  /\b(?:error|err|fail|failed|failure|fatal|warn|warning|critical|exception|panic)\b/i;
const CRITICAL_LOG_RE =
  /(?:ERROR|FATAL|Exception|Traceback|FAIL|panic|AssertionError|TypeError|SyntaxError)/;
const ANCHOR_TEXT_RE =
  /\b(?:error|fail|failed|fatal|warn|warning|critical|exception|important|summary|conclusion|result|todo)\b/i;

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".ps1",
  ".sql",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
]);

const JSON_EXTENSIONS = new Set([".json", ".jsonl", ".ndjson"]);
const LOG_EXTENSIONS = new Set([".log", ".out"]);
const DIFF_EXTENSIONS = new Set([".diff", ".patch"]);
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
]);

function getExtension(filePath: string | undefined): string {
  if (filePath === undefined) return "";
  const cleaned = filePath.trim().toLowerCase().split(/[?#]/)[0] ?? "";
  const lastSlash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

function isDiffSample(sample: string): boolean {
  if (/^diff --git /m.test(sample)) return true;
  if (/^---\s+\S+/m.test(sample) && /^\+\+\+\s+\S+/m.test(sample)) return true;
  const hunkMatches = sample.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm);
  return hunkMatches !== null && hunkMatches.length >= 1;
}

function looksLikeNdjson(sample: string): boolean {
  const lines = sample
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 6);
  if (lines.length < 2) return false;
  let parsedCount = 0;
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      JSON.parse(line);
      parsedCount += 1;
    } catch {
      // Not a JSON line.
    }
  }
  return parsedCount >= 2 && parsedCount / lines.length >= 0.6;
}

function looksLikeLogs(sample: string): boolean {
  const lines = sample.split(/\r?\n/).slice(0, 40);
  let logSignals = 0;
  for (const line of lines) {
    if (
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(line) ||
      /^\[\d{2}:\d{2}:\d{2}/.test(line) ||
      /\[(?:INFO|DEBUG|WARN|WARNING|ERROR|FATAL|TRACE)\]/i.test(line) ||
      /^(?:INFO|DEBUG|WARN|WARNING|ERROR|FATAL|TRACE)\b[:\s]/i.test(line) ||
      /^\s+at\s+\S+/.test(line) ||
      /^Traceback \(most recent call last\):/.test(line)
    ) {
      logSignals += 1;
    }
  }
  return logSignals >= 3;
}

function looksLikeCode(sample: string): boolean {
  const lines = sample.split(/\r?\n/).slice(0, 60);
  let codeSignals = 0;
  for (const line of lines) {
    if (
      /^\s*(?:import\s+|export\s+|function\s+|async\s+function\s+|class\s+|interface\s+|type\s+\w+|const\s+\w+|let\s+\w+|def\s+|async\s+def\s+|pub\s+fn\s+|fn\s+|package\s+)/.test(
        line,
      ) ||
      /\bEffect\.fn\b/.test(line)
    ) {
      codeSignals += 1;
    }
  }
  return codeSignals >= 3;
}

export function detectContentType(
  text: string,
  options?: DetectContentTypeOptions,
): CompressionContentType {
  if (options?.contentTypeHint !== undefined) {
    return options.contentTypeHint;
  }

  const sample = text.slice(0, 4_096);
  if (isDiffSample(sample)) {
    return "diff";
  }

  const ext = getExtension(options?.path);
  if (DIFF_EXTENSIONS.has(ext)) return "diff";
  if (JSON_EXTENSIONS.has(ext)) return "json";
  if (LOG_EXTENSIONS.has(ext)) return "logs";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_EXTENSIONS.has(ext)) return "text";

  const trimmed = sample.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      if (looksLikeNdjson(sample)) {
        return "json";
      }
    }
  } else if (looksLikeNdjson(sample)) {
    return "json";
  }

  if (looksLikeLogs(sample)) {
    return "logs";
  }

  if (looksLikeCode(sample)) {
    return "code";
  }

  const label = options?.sourceLabel?.toLowerCase() ?? "";
  if (label.includes("diff")) return "diff";
  if (label.includes("log")) return "logs";

  return "text";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectObjectSchemaKeys(items: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const keys = new Set<string>();
  const sampleCount = Math.min(items.length, 15);
  for (let i = 0; i < sampleCount; i += 1) {
    const item = items[i];
    if (!isRecord(item)) continue;
    for (const key of Object.keys(item)) {
      keys.add(key);
    }
  }
  return [...keys];
}

function truncateLongStringsInValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    if (value.length > 450 && !CRITICAL_JSON_RE.test(value)) {
      return `${value.slice(0, 200)} [... ${value.length - 300} chars omitted ...] ${value.slice(-100)}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.length > 6
      ? crushArrayItems(value)
      : value.map((v) => truncateLongStringsInValue(v, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = truncateLongStringsInValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function crushArrayItems(items: ReadonlyArray<unknown>): Array<unknown> {
  const len = items.length;
  if (len <= 6) {
    return items.map((item) => truncateLongStringsInValue(item, 1));
  }

  const keep = new Uint8Array(len);
  for (let i = 0; i < Math.min(3, len); i += 1) keep[i] = 1;
  for (let i = Math.max(0, len - 2); i < len; i += 1) keep[i] = 1;

  for (let i = 3; i < len - 2; i += 1) {
    const serialized = JSON.stringify(items[i]);
    if (serialized !== undefined && CRITICAL_JSON_RE.test(serialized)) {
      keep[i] = 1;
    }
  }

  const crushed: Array<unknown> = [];
  let omittedRun = 0;
  for (let i = 0; i < len; i += 1) {
    if (keep[i] === 1) {
      if (omittedRun > 0) {
        crushed.push(`[... ${omittedRun} similar items omitted ...]`);
        omittedRun = 0;
      }
      crushed.push(truncateLongStringsInValue(items[i], 1));
    } else {
      omittedRun += 1;
    }
  }
  if (omittedRun > 0) {
    crushed.push(`[... ${omittedRun} similar items omitted ...]`);
  }
  return crushed;
}

function compressJson(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const schemaKeys = collectObjectSchemaKeys(parsed);
      const crushed = crushArrayItems(parsed);
      const header =
        schemaKeys.length > 0
          ? `// JSON array (${parsed.length} items) | keys: ${schemaKeys.join(", ")}\n`
          : `// JSON array (${parsed.length} items)\n`;
      const lines = crushed.map((item) =>
        typeof item === "string" && item.startsWith("[... ")
          ? `  ${item}`
          : `  ${JSON.stringify(item)}`,
      );
      return `${header}[\n${lines.join(",\n")}\n]`;
    }

    if (isRecord(parsed)) {
      const entries = Object.entries(parsed);
      const out: Record<string, unknown> = {};
      if (entries.length > 20) {
        const keepIndices = new Set<number>();
        for (let i = 0; i < 8; i += 1) keepIndices.add(i);
        for (let i = Math.max(0, entries.length - 4); i < entries.length; i += 1)
          keepIndices.add(i);
        for (let i = 0; i < entries.length; i += 1) {
          const [key, val] = entries[i]!;
          const preview = `${key}:${JSON.stringify(val) ?? ""}`;
          if (CRITICAL_JSON_RE.test(preview)) {
            keepIndices.add(i);
          }
        }
        const omittedKeys: Array<string> = [];
        for (let i = 0; i < entries.length; i += 1) {
          const [key, val] = entries[i]!;
          if (keepIndices.has(i)) {
            out[key] = truncateLongStringsInValue(val, 1);
          } else {
            omittedKeys.push(key);
          }
        }
        if (omittedKeys.length > 0) {
          out.__omittedKeys__ = `[... ${omittedKeys.length} keys omitted: ${omittedKeys.slice(0, 12).join(", ")}${omittedKeys.length > 12 ? ", ..." : ""} ...]`;
        }
      } else {
        for (const [key, val] of entries) {
          out[key] = truncateLongStringsInValue(val, 1);
        }
      }
      const compact = JSON.stringify(out, null, 2);
      return compact ?? text;
    }

    return text;
  } catch {
    // Fallback to NDJSON line parsing.
  }

  const rawLines = text.split(/\r?\n/);
  const nonEmpty: Array<{ readonly line: string; readonly parsed: unknown }> = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      nonEmpty.push({ line: trimmed, parsed: JSON.parse(trimmed) });
    } catch {
      return text;
    }
  }

  if (nonEmpty.length <= 6) return text;
  const schemaKeys = collectObjectSchemaKeys(nonEmpty.map((entry) => entry.parsed));
  const keep = new Uint8Array(nonEmpty.length);
  for (let i = 0; i < 3; i += 1) keep[i] = 1;
  for (let i = nonEmpty.length - 2; i < nonEmpty.length; i += 1) keep[i] = 1;
  for (let i = 3; i < nonEmpty.length - 2; i += 1) {
    if (CRITICAL_JSON_RE.test(nonEmpty[i]!.line)) {
      keep[i] = 1;
    }
  }

  const outLines: Array<string> = [];
  if (schemaKeys.length > 0) {
    outLines.push(`// NDJSON (${nonEmpty.length} lines) | keys: ${schemaKeys.join(", ")}`);
  }
  let omitted = 0;
  for (let i = 0; i < nonEmpty.length; i += 1) {
    if (keep[i] === 1) {
      if (omitted > 0) {
        outLines.push(`[... ${omitted} similar items omitted ...]`);
        omitted = 0;
      }
      outLines.push(nonEmpty[i]!.line);
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    outLines.push(`[... ${omitted} similar items omitted ...]`);
  }
  return outLines.join("\n");
}

function compressLogs(text: string): string {
  const lines = text.split("\n");
  const len = lines.length;
  if (len <= 12) return text;

  const criticalProtected = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    if (CRITICAL_LOG_RE.test(lines[i] ?? "")) {
      const start = Math.max(0, i - 2);
      const end = Math.min(len - 1, i + 2);
      for (let j = start; j <= end; j += 1) {
        criticalProtected[j] = 1;
      }
    }
  }

  // First pass: keep critical±2 byte-for-byte, and collapse consecutive identical unprotected lines.
  interface CollapsedLogEntry {
    readonly line: string;
    readonly protected: boolean;
    readonly repeated: boolean;
  }
  const collapsed: Array<CollapsedLogEntry> = [];
  let idx = 0;
  while (idx < len) {
    const current = lines[idx] ?? "";
    if (criticalProtected[idx] === 1) {
      collapsed.push({ line: current, protected: true, repeated: false });
      idx += 1;
      continue;
    }

    let runEnd = idx + 1;
    while (runEnd < len && criticalProtected[runEnd] === 0 && (lines[runEnd] ?? "") === current) {
      runEnd += 1;
    }
    const runLen = runEnd - idx;
    if (runLen >= 2) {
      collapsed.push({ line: `${current} [x${runLen}]`, protected: false, repeated: true });
      idx = runEnd;
    } else {
      collapsed.push({ line: current, protected: false, repeated: false });
      idx += 1;
    }
  }

  if (collapsed.length <= 20) {
    return collapsed.map((entry) => entry.line).join("\n");
  }

  // Second pass: keep head (5), tail (5), all protected lines, and all [xN] repeat summaries.
  const keep = new Uint8Array(collapsed.length);
  for (let i = 0; i < Math.min(5, collapsed.length); i += 1) keep[i] = 1;
  for (let i = Math.max(0, collapsed.length - 5); i < collapsed.length; i += 1) keep[i] = 1;
  for (let i = 0; i < collapsed.length; i += 1) {
    const item = collapsed[i]!;
    if (item.protected || item.repeated) {
      keep[i] = 1;
    }
  }

  const out: Array<string> = [];
  let omitted = 0;
  for (let i = 0; i < collapsed.length; i += 1) {
    if (keep[i] === 1) {
      if (omitted >= 2) {
        out.push(`[... ${omitted} log lines omitted ...]`);
      } else if (omitted === 1) {
        out.push(collapsed[i - 1]!.line);
      }
      omitted = 0;
      out.push(collapsed[i]!.line);
    } else {
      omitted += 1;
    }
  }
  if (omitted >= 2) {
    out.push(`[... ${omitted} log lines omitted ...]`);
  } else if (omitted === 1) {
    out.push(collapsed[collapsed.length - 1]!.line);
  }

  return out.join("\n");
}

function isGeneratedOrLockfilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (LOCKFILE_BASENAMES.has(base)) return true;
  if (/\.min\.(?:js|css|mjs|cjs|map)$/i.test(base)) return true;
  if (base.endsWith(".map")) return true;
  if (
    normalized.includes("/dist/") ||
    normalized.includes("/_generated/") ||
    normalized.includes("/vendor/")
  ) {
    return true;
  }
  return false;
}

function extractDiffSectionPath(sectionLines: ReadonlyArray<string>): string {
  for (const line of sectionLines.slice(0, 6)) {
    if (line.startsWith("+++ b/")) return line.slice(6).trim();
    if (line.startsWith("+++ ")) return line.slice(4).trim();
    const gitMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (gitMatch?.[1]) return gitMatch[1].trim();
  }
  return "unknown";
}

function compressDiff(text: string): string {
  const lines = text.split("\n");
  const sections: Array<Array<string>> = [];
  let current: Array<string> = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current);
  }

  const outSections: Array<string> = [];
  for (const section of sections) {
    const filePath = extractDiffSectionPath(section);
    const sectionTextLength = section.reduce((sum, l) => sum + l.length + 1, 0);
    if (isGeneratedOrLockfilePath(filePath) && (section.length > 15 || sectionTextLength > 500)) {
      const headerLines: Array<string> = [];
      let added = 0;
      let removed = 0;
      let inHunk = false;
      for (const line of section) {
        if (!inHunk && (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"))) {
          if (line.startsWith("+++ ") || line.startsWith("--- ")) {
            headerLines.push(line);
            continue;
          }
          inHunk = true;
        }
        if (!inHunk) {
          headerLines.push(line);
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
      }
      outSections.push(
        `${headerLines.join("\n")}\n[... generated/lockfile diff omitted for ${filePath}: +${added} -${removed} lines (${section.length} total lines) ...]`,
      );
    } else {
      outSections.push(section.join("\n"));
    }
  }

  return outSections.join("\n");
}

function isTopLevelOrExportedDeclaration(line: string): boolean {
  if (/^\s*(?:import\b|from\s+\S+\s+import\b)/.test(line)) return true;
  if (
    /^(?:export\b|class\b|interface\b|type\b|enum\b|function\s|async\s+function\s|const\s|let\s|var\s|def\s|async\s+def\s)/.test(
      line,
    )
  ) {
    return true;
  }
  if (/\bEffect\.fn\b/.test(line)) return true;
  if (
    /^\s{2,4}(?:def\s+|async\s+def\s+|(?:public|private|protected|static|async|readonly|override)\s+[a-zA-Z_$][\w$]*\s*\(|(?!(?:if|for|while|switch|catch|else|return)\b)[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^=>{]+)?\{)/.test(
      line,
    )
  ) {
    return true;
  }
  return false;
}

function compressCode(text: string): string {
  const lines = text.split("\n");
  const len = lines.length;
  if (len <= 30) return text;

  const keep = new Uint8Array(len);
  let inMultiLineImport = false;
  let inSignature = false;

  for (let i = 0; i < len; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (
      i === 0 &&
      (trimmed.startsWith("#!") || trimmed.startsWith('"use ') || trimmed.startsWith("'use "))
    ) {
      keep[i] = 1;
      continue;
    }

    if (inMultiLineImport) {
      keep[i] = 1;
      if (trimmed.includes(" from ") || trimmed.endsWith(";") || trimmed.endsWith(")")) {
        inMultiLineImport = false;
      }
      continue;
    }

    if (inSignature) {
      keep[i] = 1;
      if (trimmed.includes("{") || trimmed.endsWith(";") || trimmed.endsWith(":")) {
        inSignature = false;
      }
      continue;
    }

    if (isTopLevelOrExportedDeclaration(line)) {
      keep[i] = 1;
      if (/^\s*import\b/.test(line) && !trimmed.includes(" from ") && !trimmed.endsWith(";")) {
        inMultiLineImport = true;
      } else if (
        trimmed.includes("(") &&
        !trimmed.includes(")") &&
        !trimmed.includes("{") &&
        !trimmed.endsWith(";")
      ) {
        inSignature = true;
      }
    }
  }

  const out: Array<string> = [];
  let gapStart = -1;

  const flushGap = (gapEndInclusive: number) => {
    if (gapStart < 0) return;
    const gapLen = gapEndInclusive - gapStart + 1;
    if (gapLen >= 4) {
      out.push(`  [... L${gapStart + 1}-L${gapEndInclusive + 1} (${gapLen} lines) omitted ...]`);
    } else {
      for (let j = gapStart; j <= gapEndInclusive; j += 1) {
        out.push(`L${j + 1}: ${lines[j] ?? ""}`);
      }
    }
    gapStart = -1;
  };

  for (let i = 0; i < len; i += 1) {
    if (keep[i] === 1) {
      flushGap(i - 1);
      out.push(`L${i + 1}: ${lines[i] ?? ""}`);
    } else if (gapStart < 0) {
      gapStart = i;
    }
  }
  flushGap(len - 1);

  return out.join("\n");
}

function compressText(text: string): string {
  const collapsedBlanks = text.replaceAll(/\n{3,}/g, "\n\n");
  const rawParagraphs = collapsedBlanks.split(/\n\n+/);

  if (rawParagraphs.length <= 6) {
    const lines = collapsedBlanks.split("\n");
    if (lines.length <= 20) return collapsedBlanks;

    const keep = new Uint8Array(lines.length);
    for (let i = 0; i < 5; i += 1) keep[i] = 1;
    for (let i = lines.length - 5; i < lines.length; i += 1) keep[i] = 1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (ANCHOR_TEXT_RE.test(line) || /^#{1,4}\s/.test(line)) {
        if (i > 0) keep[i - 1] = 1;
        keep[i] = 1;
        if (i + 1 < lines.length) keep[i + 1] = 1;
      }
    }

    const out: Array<string> = [];
    let omitted = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (keep[i] === 1) {
        if (omitted >= 2) out.push(`[... ${omitted} lines omitted ...]`);
        else if (omitted === 1) out.push(lines[i - 1] ?? "");
        omitted = 0;
        out.push(lines[i] ?? "");
      } else {
        omitted += 1;
      }
    }
    if (omitted >= 2) out.push(`[... ${omitted} lines omitted ...]`);
    else if (omitted === 1) out.push(lines[lines.length - 1] ?? "");
    return out.join("\n");
  }

  const seenParagraphs = new Set<string>();
  const deduped: Array<string> = [];
  for (const para of rawParagraphs) {
    const normalized = para.trim();
    if (normalized.length >= 40 && seenParagraphs.has(normalized)) {
      if (deduped[deduped.length - 1] !== "[... duplicate paragraph omitted ...]") {
        deduped.push("[... duplicate paragraph omitted ...]");
      }
      continue;
    }
    if (normalized.length >= 40) {
      seenParagraphs.add(normalized);
    }
    deduped.push(para);
  }

  if (deduped.length <= 8) {
    return deduped.join("\n\n");
  }

  const keep = new Uint8Array(deduped.length);
  for (let i = 0; i < 3; i += 1) keep[i] = 1;
  for (let i = deduped.length - 2; i < deduped.length; i += 1) keep[i] = 1;
  for (let i = 3; i < deduped.length - 2; i += 1) {
    const p = deduped[i] ?? "";
    if (ANCHOR_TEXT_RE.test(p) || /^#{1,4}\s/m.test(p)) {
      keep[i] = 1;
    }
  }

  const out: Array<string> = [];
  let omitted = 0;
  for (let i = 0; i < deduped.length; i += 1) {
    if (keep[i] === 1) {
      if (omitted >= 2) out.push(`[... ${omitted} paragraphs omitted ...]`);
      else if (omitted === 1) out.push(deduped[i - 1] ?? "");
      omitted = 0;
      out.push(deduped[i] ?? "");
    } else {
      omitted += 1;
    }
  }
  if (omitted >= 2) out.push(`[... ${omitted} paragraphs omitted ...]`);
  else if (omitted === 1) out.push(deduped[deduped.length - 1] ?? "");

  return out.join("\n\n");
}

function runCompressor(contentType: CompressionContentType, text: string): string {
  switch (contentType) {
    case "json":
      return compressJson(text);
    case "logs":
      return compressLogs(text);
    case "diff":
      return compressDiff(text);
    case "code":
      return compressCode(text);
    case "text":
      return compressText(text);
  }
}

function formatCcrFooter(input: {
  readonly ccrId: string;
  readonly contentType: CompressionContentType;
  readonly originalChars: number;
  readonly compressedChars: number;
}): string {
  const tokensSavedEst = Math.round(Math.max(0, input.originalChars - input.compressedChars) / 4);
  return `[T3 CCR:${input.ccrId} (${input.contentType}): ${input.originalChars} -> ${input.compressedChars} chars (~${tokensSavedEst} tok saved) | call context_retrieve(ccrId="${input.ccrId}") for exact lines/search]`;
}

export function compressToolOutput(input: CompressToolOutputInput): CompressToolOutputResult {
  const originalChars = input.text.length;
  const minChars = input.minChars ?? DEFAULT_MIN_CHARS;
  const contentType = detectContentType(input.text, {
    path: input.path,
    sourceLabel: input.sourceLabel,
    contentTypeHint: input.contentTypeHint,
  });

  if (originalChars < minChars) {
    return {
      compressed: false,
      text: input.text,
      contentType,
      originalChars,
      compressedChars: originalChars,
      savedChars: 0,
      tokensSavedEst: 0,
    };
  }

  const candidateBody = runCompressor(contentType, input.text);
  const includeFooter = input.includeFooter !== false;

  if (!includeFooter) {
    if (candidateBody.length >= originalChars * MIN_REDUCTION_RATIO) {
      return {
        compressed: false,
        text: input.text,
        contentType,
        originalChars,
        compressedChars: originalChars,
        savedChars: 0,
        tokensSavedEst: 0,
      };
    }
    const compressedChars = candidateBody.length;
    const savedChars = originalChars - compressedChars;
    return {
      compressed: true,
      text: candidateBody,
      contentType,
      originalChars,
      compressedChars,
      savedChars,
      tokensSavedEst: Math.round(savedChars / 4),
    };
  }

  const estimatedFooterLen = 150;
  if (candidateBody.length + estimatedFooterLen >= originalChars * MIN_REDUCTION_RATIO) {
    return {
      compressed: false,
      text: input.text,
      contentType,
      originalChars,
      compressedChars: originalChars,
      savedChars: 0,
      tokensSavedEst: 0,
    };
  }

  const store = input.store ?? defaultCcrStore;
  const entry = store.put({
    content: input.text,
    contentType,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
  });

  let compressedChars = candidateBody.length + 2 + estimatedFooterLen;
  let footer = formatCcrFooter({
    ccrId: entry.ccrId,
    contentType,
    originalChars,
    compressedChars,
  });
  let finalText = `${candidateBody}\n\n${footer}`;
  if (finalText.length !== compressedChars) {
    compressedChars = finalText.length;
    footer = formatCcrFooter({
      ccrId: entry.ccrId,
      contentType,
      originalChars,
      compressedChars,
    });
    finalText = `${candidateBody}\n\n${footer}`;
  }

  const actualCompressedChars = finalText.length;
  store.recordCompression(originalChars, actualCompressedChars, input.threadId);
  const savedChars = originalChars - actualCompressedChars;

  return {
    compressed: true,
    text: finalText,
    contentType,
    originalChars,
    compressedChars: actualCompressedChars,
    savedChars,
    tokensSavedEst: Math.round(savedChars / 4),
    ccrId: entry.ccrId,
  };
}
