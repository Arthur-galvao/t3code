import { defaultCcrStore, type CcrStore } from "./ccrStore.ts";

export type CompressionContentType = "json" | "logs" | "diff" | "code" | "text";

export interface CompressToolOutputInput {
  readonly text: string;
  readonly threadId?: string | undefined;
  readonly path?: string | undefined;
  readonly sourceLabel?: string | undefined;
  readonly command?: string | undefined;
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
  readonly command?: string | undefined;
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

const LINE_NUMBER_PREFIX_RE = /^\s*\d+(?:→|:\s|\t|\|\s?)/;
const DATA_URI_BASE64_RE = /data:([a-zA-Z0-9.+/-]+);base64,([A-Za-z0-9+/=]{200,})/g;

export function stripLineNumberPrefix(line: string): string {
  return line.replace(LINE_NUMBER_PREFIX_RE, "");
}

export function normalizeTerminalText(text: string): string {
  const lf = text.replaceAll("\r\n", "\n");
  if (!lf.includes("\r")) {
    return lf;
  }
  return lf
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const frames = line.split("\r");
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        const frame = frames[i];
        if (frame !== undefined && frame.length > 0) {
          return frame;
        }
      }
      return "";
    })
    .join("\n");
}

function isMinifiedOrBlobLine(line: string): boolean {
  if (line.length <= 1_200) return false;
  let whitespaceCount = 0;
  let currentRun = 0;
  let maxRun = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charCodeAt(i);
    const isWs = ch === 32 || ch === 9 || ch === 11 || ch === 12;
    if (isWs) {
      whitespaceCount += 1;
      if (currentRun > maxRun) maxRun = currentRun;
      currentRun = 0;
    } else {
      currentRun += 1;
    }
  }
  if (currentRun > maxRun) maxRun = currentRun;
  return whitespaceCount / line.length <= 0.12 || maxRun >= 160;
}

export function collapseBlobLines(text: string): string {
  const collapsedDataUris = text.replace(
    DATA_URI_BASE64_RE,
    (_match, mime: string, payload: string) =>
      `data:${mime};base64,[... ${payload.length} chars omitted ...]`,
  );
  const lines = collapsedDataUris.split("\n");
  let changed = collapsedDataUris !== text;
  const out = lines.map((line) => {
    if (!isMinifiedOrBlobLine(line)) {
      return line;
    }
    changed = true;
    const omitted = line.length - 240;
    return `${line.slice(0, 160)} [... ${omitted} chars omitted ...] ${line.slice(-80)}`;
  });
  return changed ? out.join("\n") : text;
}

function looksLikeCode(sample: string): boolean {
  const lines = sample.split(/\r?\n/).slice(0, 60);
  let codeSignals = 0;
  for (const line of lines) {
    const normalized = stripLineNumberPrefix(line);
    if (
      /^\s*(?:import\s+|export\s+|function\s+|async\s+function\s+|class\s+|interface\s+|type\s+\w+|const\s+\w+|let\s+\w+|def\s+|async\s+def\s+|pub\s+fn\s+|fn\s+|package\s+)/.test(
        normalized,
      ) ||
      /\bEffect\.fn\b/.test(normalized)
    ) {
      codeSignals += 1;
    }
  }
  return codeSignals >= 3;
}

const ESC_CHAR = String.fromCharCode(0x1b);
const BEL_CHAR = String.fromCharCode(0x07);
const ANSI_OSC_RE = new RegExp(
  `${ESC_CHAR}\\][^${BEL_CHAR}${ESC_CHAR}]*(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`,
  "g",
);
const ANSI_CSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_CHARSET_RE = new RegExp(`${ESC_CHAR}[()][AB012]`, "g");

export function stripAnsi(text: string): string {
  if (!text.includes(ESC_CHAR)) {
    return text;
  }
  return text.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(ANSI_CHARSET_RE, "");
}

function resolveCommandHint(command?: string, sourceLabel?: string): string | undefined {
  if (command !== undefined && command.trim().length > 0) {
    return command.trim();
  }
  if (sourceLabel !== undefined) {
    const match = /^terminal:\s*(.+)$/i.exec(sourceLabel.trim());
    if (match?.[1] !== undefined && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}

export function detectContentType(
  text: string,
  options?: DetectContentTypeOptions,
): CompressionContentType {
  if (options?.contentTypeHint !== undefined) {
    return options.contentTypeHint;
  }

  const sample = stripAnsi(text.slice(0, 4_096));
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

  const commandHint = resolveCommandHint(options?.command, options?.sourceLabel);
  if (
    commandHint !== undefined &&
    (TEST_RUNNER_CMD_RE.test(commandHint) ||
      TYPECHECK_LINT_CMD_RE.test(commandHint) ||
      BUILD_INSTALL_CMD_RE.test(commandHint))
  ) {
    return "logs";
  }
  if (
    commandHint !== undefined &&
    (SEARCH_CMD_RE.test(commandHint) || DIR_LIST_CMD_RE.test(commandHint))
  ) {
    return "text";
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
  const prepared = collapseBlobLines(normalizeTerminalText(text));
  const lines = prepared.split("\n");
  const len = lines.length;
  if (len <= 12) return prepared;

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

const DIFF_OVERSIZED_TOTAL_CHARS = 10_000;
const DIFF_OVERSIZED_SECTION_LINES = 140;
const DIFF_HEAD_LINES = 45;
const DIFF_TAIL_LINES = 20;

function computeDiffStats(section: ReadonlyArray<string>): {
  readonly headerLines: Array<string>;
  readonly added: number;
  readonly removed: number;
} {
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
  return { headerLines, added, removed };
}

function isDiffHeaderOrHunkLine(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("@@ ") ||
    line === "@@"
  );
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

  const isOversizedDiff = text.length > DIFF_OVERSIZED_TOTAL_CHARS;
  const outSections: Array<string> = [];
  for (const section of sections) {
    const filePath = extractDiffSectionPath(section);
    const sectionTextLength = section.reduce((sum, l) => sum + l.length + 1, 0);
    if (isGeneratedOrLockfilePath(filePath) && (section.length > 15 || sectionTextLength > 500)) {
      const { headerLines, added, removed } = computeDiffStats(section);
      outSections.push(
        `${headerLines.join("\n")}\n[... generated/lockfile diff omitted for ${filePath}: +${added} -${removed} lines (${section.length} total lines) ...]`,
      );
    } else if (
      (isOversizedDiff || section.length > DIFF_OVERSIZED_SECTION_LINES) &&
      section.length > DIFF_HEAD_LINES + DIFF_TAIL_LINES
    ) {
      const { added, removed } = computeDiffStats(section);
      const keep = new Uint8Array(section.length);
      for (let i = 0; i < Math.min(DIFF_HEAD_LINES, section.length); i += 1) keep[i] = 1;
      for (let i = Math.max(0, section.length - DIFF_TAIL_LINES); i < section.length; i += 1) {
        keep[i] = 1;
      }
      for (let i = 0; i < section.length; i += 1) {
        if (isDiffHeaderOrHunkLine(section[i] ?? "")) {
          keep[i] = 1;
        }
      }
      outSections.push(
        collapseKeptLines(
          section,
          keep,
          (omitted) =>
            `[... ${omitted} diff lines omitted for ${filePath} (+${added} -${removed}) ...]`,
        ),
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
  if (len <= 30) {
    let changed = false;
    const processed = lines.map((line) => {
      const isDecl = isTopLevelOrExportedDeclaration(stripLineNumberPrefix(line));
      if (len > 3 && isDecl) {
        return line;
      }
      const collapsed = collapseBlobLines(line);
      if (collapsed !== line) changed = true;
      return collapsed;
    });
    return changed ? processed.join("\n") : text;
  }

  const keep = new Uint8Array(len);
  let inMultiLineImport = false;
  let inSignature = false;

  for (let i = 0; i < len; i += 1) {
    const rawLine = lines[i] ?? "";
    const strippedLine = stripLineNumberPrefix(rawLine);
    const trimmed = strippedLine.trim();

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

    if (isTopLevelOrExportedDeclaration(strippedLine)) {
      keep[i] = 1;
      if (
        /^\s*import\b/.test(strippedLine) &&
        !trimmed.includes(" from ") &&
        !trimmed.endsWith(";")
      ) {
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
        out.push(`L${j + 1}: ${collapseBlobLines(lines[j] ?? "")}`);
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
  const collapsedBlobs = collapseBlobLines(text.replaceAll("\r\n", "\n"));
  const collapsedBlanks = collapsedBlobs.replaceAll(/\n{3,}/g, "\n\n");
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

const TEST_RUNNER_CMD_RE =
  /\b(?:vitest|jest|pytest|unittest|playwright|cypress|cargo\s+test|go\s+test|bun\s+test|mvn\s+test|dotnet\s+test|vp(?:\.cmd)?\s+test|(?:pnpm(?:\.cmd)?|npm(?:\.cmd)?|yarn(?:\.cmd)?)\s+(?:run\s+)?test)\b/i;
const TYPECHECK_LINT_CMD_RE =
  /\b(?:tsc|tsgo|effect-tsgo|typecheck|eslint|oxlint|oxfmt|biome|ruff|mypy|knip|flake8|pylint|golangci-lint|vp(?:\.cmd)?\s+(?:lint|check|fmt)|(?:pnpm(?:\.cmd)?|npm(?:\.cmd)?|yarn(?:\.cmd)?)\s+(?:run\s+)?(?:typecheck|lint|check))\b/i;
const GIT_STATUS_CMD_RE = /\bgit\s+status\b/i;
const GIT_LOG_CMD_RE = /\bgit\s+log\b/i;
const SEARCH_CMD_RE =
  /(?:^|(?:&&|\|\||[;|])\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+-c(?:ommand)?|pwsh(?:\.exe)?\s+-c(?:ommand)?)\s+)?(?:[^\s"'\\/]+[\\/])*(?:rg|ripgrep|grep|git\s+grep|Select-String|ag|ack)(?:\.exe)?(?:\s|$)/i;
const DIR_LIST_CMD_RE =
  /(?:^|(?:&&|\|\||[;|])\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+-c(?:ommand)?|pwsh(?:\.exe)?\s+-c(?:ommand)?)\s+)?(?:[^\s"'\\/]+[\\/])*(?:ls|dir|find|tree|git\s+ls-files|Get-ChildItem|fd)(?:\.exe)?(?:\s|$)/i;
const BUILD_INSTALL_CMD_RE =
  /\b(?:pnpm(?:\.cmd)?|npm(?:\.cmd)?|yarn(?:\.cmd)?|bun)\s+(?:i|install|add|update|ci|build)\b|\b(?:cargo\s+build|vite\s+build|vp(?:\.cmd)?\s+build|pip|uv|poetry|docker\s+build|gh\s+(?:run|pr)|make|cmake)\b/i;
const TEST_EXIT_CODE_LINE_RE = /\bexit(?:ed with)?\s+code\b/i;

const PASSING_TEST_LINE_RE =
  /^\s*(?:✓|✔|PASS\b|PASSED\b|ok\s+\S+|\.\.\.\s+ok\b|test\s+\S+\s+\.\.\.\s+ok)/i;
const TEST_SUMMARY_LINE_RE =
  /^\s*(?:Test Files|Tests|Snapshots|Start at|Duration|=== .* (?:passed|failed)|test result:|FAIL\s+|ok\s+\S+\s+\d)/i;
const TEST_FAILURE_LINE_RE =
  /\b(?:FAIL|FAILED|AssertionError|Error:|Expected|Received|Traceback|panic)\b|^\s*(?:✗|×|at\s+\S+:\d+)/;

const DIAG_HEADER_LINE_RE =
  /^(?:\S+.*\(\d+,\d+\):\s*(?:error|warning)\b|\S+:\d+:\d+(?:\s*[-:])?\s*(?:error|warning|info)?|error\[E\d+\]|warning\[|✖|×|\s*(?:error|warning)\b[:\s])/i;
const DIAG_SUMMARY_LINE_RE =
  /^(?:Found\s+\d+\s+errors?|Finished in\b|Checked\s+\d+\s+files?|✖\s+\d+\s+problems?|\d+\s+(?:error|warning)s?\b)/i;

const GIT_STATUS_HINT_RE = /^\s*\(use "git [^"]+"[^)]*\)\s*$/;
const GIT_STATUS_SECTION_RE =
  /^(?:Changes to be committed:|Changes not staged for commit:|Untracked files:|Unmerged paths:)/;

const BUILD_CHURN_LINE_RE =
  /^\s*(?:Progress:|Downloading\b|Resolved\b|Resolving\b|Fetching\b|Compiling\b|Reusing\b|Already up to date|Packages:\s+[+-]\d|\|+|\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/i;
const BUILD_WARN_LINE_RE = /\bwarn(?:ing)?\b/i;

function markProtectedWindow(keep: Uint8Array, index: number, radius: number): void {
  const start = Math.max(0, index - radius);
  const end = Math.min(keep.length - 1, index + radius);
  for (let i = start; i <= end; i += 1) {
    keep[i] = 1;
  }
}

function collapseKeptLines(
  lines: ReadonlyArray<string>,
  keep: Uint8Array,
  omittedLabel: (count: number) => string,
): string {
  const out: Array<string> = [];
  let omitted = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i] === 1) {
      if (omitted >= 2) {
        out.push(omittedLabel(omitted));
      } else if (omitted === 1) {
        out.push(lines[i - 1] ?? "");
      }
      omitted = 0;
      out.push(lines[i] ?? "");
    } else {
      omitted += 1;
    }
  }
  if (omitted >= 2) {
    out.push(omittedLabel(omitted));
  } else if (omitted === 1) {
    out.push(lines[lines.length - 1] ?? "");
  }
  return out.join("\n");
}

function looksLikeTestRunnerOutput(lines: ReadonlyArray<string>): boolean {
  let passingCount = 0;
  let hasSummary = false;
  for (const line of lines) {
    if (PASSING_TEST_LINE_RE.test(line)) passingCount += 1;
    if (TEST_SUMMARY_LINE_RE.test(line)) hasSummary = true;
    if (passingCount >= 4 && hasSummary) return true;
  }
  return false;
}

function compressTestRunnerOutput(lines: ReadonlyArray<string>): string {
  if (lines.length <= 12) return lines.join("\n");

  const len = lines.length;
  const keep = new Uint8Array(len);
  for (let i = 0; i < Math.min(3, len); i += 1) keep[i] = 1;
  for (let i = Math.max(0, len - 8); i < len; i += 1) keep[i] = 1;

  for (let i = 0; i < len; i += 1) {
    const line = lines[i] ?? "";
    if (TEST_SUMMARY_LINE_RE.test(line) || TEST_EXIT_CODE_LINE_RE.test(line)) {
      keep[i] = 1;
    }
    if (TEST_FAILURE_LINE_RE.test(line) || CRITICAL_LOG_RE.test(line)) {
      markProtectedWindow(keep, i, 5);
    }
  }

  const out: Array<string> = [];
  let passingOmitted = 0;
  let otherOmitted = 0;

  const flushPassing = () => {
    if (passingOmitted === 0) return;
    out.push(`[... ${passingOmitted} passing test lines omitted ...]`);
    passingOmitted = 0;
  };
  const flushOther = (endIdx: number) => {
    if (otherOmitted === 0) return;
    if (otherOmitted === 1) {
      out.push(lines[endIdx - 1] ?? "");
    } else {
      out.push(`[... ${otherOmitted} lines omitted ...]`);
    }
    otherOmitted = 0;
  };

  for (let i = 0; i < len; i += 1) {
    const line = lines[i] ?? "";
    if (keep[i] === 1) {
      flushPassing();
      flushOther(i);
      out.push(line);
      continue;
    }
    if (PASSING_TEST_LINE_RE.test(line)) {
      flushOther(i);
      passingOmitted += 1;
      continue;
    }
    if (passingOmitted > 0 && line.trim() === "") {
      continue;
    }
    flushPassing();
    otherOmitted += 1;
  }
  flushPassing();
  flushOther(len);

  return out.join("\n");
}

function compressTypecheckLintOutput(lines: ReadonlyArray<string>): string {
  const nonBlank = lines.filter((line) => line.trim() !== "");
  if (nonBlank.length <= 12) return nonBlank.join("\n");

  const summaryLines: Array<string> = [];
  const blocks: Array<Array<string>> = [];
  const prefixNonDiag: Array<string> = [];
  let currentBlock: Array<string> | null = null;

  for (const line of nonBlank) {
    if (DIAG_SUMMARY_LINE_RE.test(line.trim())) {
      if (currentBlock !== null) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      summaryLines.push(line);
      continue;
    }
    if (DIAG_HEADER_LINE_RE.test(line)) {
      if (currentBlock !== null) {
        blocks.push(currentBlock);
      }
      currentBlock = [line];
      continue;
    }
    if (currentBlock !== null && currentBlock.length < 5) {
      currentBlock.push(line);
    } else if (currentBlock === null) {
      prefixNonDiag.push(line);
    }
  }
  if (currentBlock !== null) {
    blocks.push(currentBlock);
  }

  // Fold consecutive identical non-diagnostic lines.
  const compactedPrefix: Array<string> = [];
  let idx = 0;
  while (idx < prefixNonDiag.length) {
    const line = prefixNonDiag[idx] ?? "";
    let end = idx + 1;
    while (end < prefixNonDiag.length && (prefixNonDiag[end] ?? "") === line) {
      end += 1;
    }
    const runLen = end - idx;
    compactedPrefix.push(runLen >= 2 ? `${line} [x${runLen}]` : line);
    idx = end;
  }

  // Group repeated identical diagnostic messages (ignoring leading file:line:col / file(line,col): prefix)
  // keeping first 5 occurrences so repetitive errors don't hide unique errors.
  const MAX_OCCURRENCES_PER_DIAG_GROUP = 5;
  const diagGroups: Array<{ readonly occurrences: Array<ReadonlyArray<string>> }> = [];
  const groupIndexByKey = new Map<string, number>();
  for (const block of blocks) {
    const key = normalizeDiagnosticKey(block);
    const existingIdx = groupIndexByKey.get(key);
    if (existingIdx !== undefined) {
      diagGroups[existingIdx]!.occurrences.push(block);
    } else {
      groupIndexByKey.set(key, diagGroups.length);
      diagGroups.push({ occurrences: [block] });
    }
  }

  const formatDiagGroup = (group: {
    readonly occurrences: ReadonlyArray<ReadonlyArray<string>>;
  }) => {
    const kept = group.occurrences
      .slice(0, MAX_OCCURRENCES_PER_DIAG_GROUP)
      .map((occ) => occ.join("\n"));
    if (group.occurrences.length > MAX_OCCURRENCES_PER_DIAG_GROUP) {
      kept.push(`[+${group.occurrences.length - MAX_OCCURRENCES_PER_DIAG_GROUP} more occurrences]`);
    }
    return kept.join("\n");
  };

  const out: Array<string> = [...compactedPrefix];
  if (diagGroups.length > 40) {
    for (const group of diagGroups.slice(0, 30)) {
      out.push(formatDiagGroup(group));
    }
    out.push(`[... ${diagGroups.length - 35} diagnostics omitted ...]`);
    for (const group of diagGroups.slice(-5)) {
      out.push(formatDiagGroup(group));
    }
  } else {
    for (const group of diagGroups) {
      out.push(formatDiagGroup(group));
    }
  }

  out.push(...summaryLines);
  return out.join("\n");
}

const DIAG_LOCATION_PREFIX_RE =
  /^(?:(?:[A-Za-z]:)?[^(\r\n]+\(\d+,\d+\):\s*|(?:[A-Za-z]:)?[^:\r\n]+:\d+(?::\d+)?(?:\s*[-:])?\s*)/;

function normalizeDiagnosticKey(block: ReadonlyArray<string>): string {
  const head = block[0] ?? "";
  const normalizedHead = head.replace(DIAG_LOCATION_PREFIX_RE, "").trim();
  const keyHead = normalizedHead !== "" ? normalizedHead : head.trim();
  return [keyHead, ...block.slice(1)].join("\n");
}

interface ParsedSearchLine {
  readonly filePath: string;
  readonly lineNum?: string | undefined;
  readonly text: string;
}

const SEARCH_WITH_LINE_RE = /^((?:[A-Za-z]:)?[^:\r\n]+):(\d+):(.*)$/;
const SEARCH_NO_LINE_RE = /^((?:[A-Za-z]:)?[^:\s][^:\r\n]*):(.*)$/;
const SEARCH_TIMESTAMP_PREFIX_RE = /^\d{2}:\d{2}:\d{2}/;
const SEARCH_DIAG_NOISE_RE = /\berror\s+TS\d+:/i;

function looksLikeSearchFilePath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed === "" || /^\d+$/.test(trimmed)) return false;
  if (/^(?:https?|ftp|file|mailto)$/i.test(trimmed)) return false;
  if (/^(?:error|warn|warning|info|debug|trace|fatal)$/i.test(trimmed)) return false;
  return trimmed.includes("/") || trimmed.includes("\\") || /\.[A-Za-z0-9]{1,10}$/.test(trimmed);
}

function parseSearchLine(line: string): ParsedSearchLine | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || SEARCH_TIMESTAMP_PREFIX_RE.test(trimmed)) {
    return undefined;
  }
  const withLine = SEARCH_WITH_LINE_RE.exec(line);
  if (withLine !== null) {
    const filePath = withLine[1]?.trim() ?? "";
    const lineNum = withLine[2];
    const text = withLine[3] ?? "";
    if (looksLikeSearchFilePath(filePath)) {
      return {
        filePath,
        ...(lineNum !== undefined ? { lineNum } : {}),
        text,
      };
    }
  }
  const noLine = SEARCH_NO_LINE_RE.exec(line);
  if (noLine !== null) {
    const filePath = noLine[1]?.trim() ?? "";
    const text = noLine[2] ?? "";
    if (!text.startsWith("//") && looksLikeSearchFilePath(filePath)) {
      return {
        filePath,
        text,
      };
    }
  }
  return undefined;
}

function looksLikeSearchOutput(lines: ReadonlyArray<string>): boolean {
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length < 8) return false;
  let matchCount = 0;
  for (const line of nonEmpty.slice(0, 60)) {
    if (DIAG_HEADER_LINE_RE.test(line) || SEARCH_DIAG_NOISE_RE.test(line)) {
      continue;
    }
    const parsed = parseSearchLine(line);
    if (parsed !== undefined && parsed.lineNum !== undefined) {
      matchCount += 1;
    }
  }
  const sampled = Math.min(nonEmpty.length, 60);
  return matchCount >= 8 && matchCount / sampled >= 0.6;
}

function compressSearchOutput(lines: ReadonlyArray<string>): string {
  const MAX_SEARCH_FILES = 40;
  const MAX_MATCHES_BEFORE_COLLAPSE = 5;
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length <= 12) return lines.join("\n");

  const fileOrder: Array<string> = [];
  const byFile = new Map<string, Array<ParsedSearchLine>>();
  const extraLines: Array<string> = [];

  for (const line of nonEmpty) {
    const parsed = parseSearchLine(line);
    if (parsed !== undefined) {
      let bucket = byFile.get(parsed.filePath);
      if (bucket === undefined) {
        bucket = [];
        byFile.set(parsed.filePath, bucket);
        fileOrder.push(parsed.filePath);
      }
      bucket.push(parsed);
    } else if (
      CRITICAL_LOG_RE.test(line) ||
      /\b(?:error|warning|permission denied)\b/i.test(line)
    ) {
      extraLines.push(line);
    }
  }

  if (fileOrder.length === 0) {
    return lines.join("\n");
  }

  const formatMatch = (match: ParsedSearchLine): string =>
    match.lineNum !== undefined ? `  ${match.lineNum}: ${match.text}` : `  ${match.text}`;

  const out: Array<string> = [];
  for (const filePath of fileOrder.slice(0, MAX_SEARCH_FILES)) {
    const matches = byFile.get(filePath)!;
    out.push(`${filePath} (${matches.length} ${matches.length === 1 ? "match" : "matches"})`);
    if (matches.length > MAX_MATCHES_BEFORE_COLLAPSE) {
      for (const match of matches.slice(0, 4)) {
        out.push(formatMatch(match));
      }
      const omitted = matches.length - 5;
      out.push(`  ... (+${omitted} more matches)`);
      out.push(formatMatch(matches[matches.length - 1]!));
    } else {
      for (const match of matches) {
        out.push(formatMatch(match));
      }
    }
  }

  if (fileOrder.length > MAX_SEARCH_FILES) {
    const remainingFiles = fileOrder.slice(MAX_SEARCH_FILES);
    let remainingMatches = 0;
    for (const filePath of remainingFiles) {
      remainingMatches += byFile.get(filePath)?.length ?? 0;
    }
    out.push(`[... +${remainingFiles.length} more files (${remainingMatches} total matches) ...]`);
  }

  if (extraLines.length > 0) {
    out.push(...extraLines.slice(0, 10));
  }

  return out.join("\n");
}

const DIR_ERROR_LINE_RE =
  /\b(?:error|warning|cannot access|permission denied|no such file|access is denied|not found)\b/i;

function compressDirectoryListing(lines: ReadonlyArray<string>): string {
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length <= 25) return lines.join("\n");

  const errorLines: Array<string> = [];
  const dirOrder: Array<string> = [];
  const byDir = new Map<string, Array<string>>();
  const otherLines: Array<string> = [];
  let currentDir: string | undefined;

  const pushFile = (dirKey: string, fileName: string) => {
    let bucket = byDir.get(dirKey);
    if (bucket === undefined) {
      bucket = [];
      byDir.set(dirKey, bucket);
      dirOrder.push(dirKey);
    }
    bucket.push(fileName);
  };

  for (const rawLine of nonEmpty) {
    const line = rawLine.trim();
    if (CRITICAL_LOG_RE.test(line) || DIR_ERROR_LINE_RE.test(line)) {
      errorLines.push(rawLine);
      continue;
    }
    const gciDirMatch = /^Directory:\s+(.+)$/i.exec(line);
    if (gciDirMatch?.[1] !== undefined) {
      currentDir = `${gciDirMatch[1].trim().replaceAll("\\", "/").replace(/\/+$/, "")}/`;
      continue;
    }
    if (line.endsWith(":") && !line.includes(" ")) {
      currentDir = `${line.slice(0, -1).replaceAll("\\", "/").replace(/\/+$/, "")}/`;
      continue;
    }
    const lsLongMatch =
      /^[d\-lcbps][rwxstST-]{9}[.+@]?\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (lsLongMatch?.[1] !== undefined) {
      const entryName = lsLongMatch[1].trim();
      if (entryName !== "." && entryName !== "..") {
        pushFile(currentDir ?? "./", entryName);
      }
      continue;
    }
    const gciRowMatch =
      /^[dlarhs-]{5,6}\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+(?:\S+\s+)?(.+)$/i.exec(
        line,
      );
    if (gciRowMatch?.[1] !== undefined) {
      pushFile(currentDir ?? "./", gciRowMatch[1].trim());
      continue;
    }
    if (
      /^total\s+\d+$/i.test(line) ||
      /^Mode\s+LastWriteTime/i.test(line) ||
      /^-+\s+-+/.test(line)
    ) {
      continue;
    }
    if (/^[│├└─\s]+/.test(rawLine) && (rawLine.includes("├──") || rawLine.includes("└──"))) {
      otherLines.push(rawLine);
      continue;
    }
    if (!line.includes("\t")) {
      const normalized = line.replaceAll("\\", "/");
      if (normalized.endsWith("/")) {
        continue;
      }
      const lastSlash = normalized.lastIndexOf("/");
      const dirKey = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : (currentDir ?? "./");
      const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
      if (fileName !== "") {
        pushFile(dirKey, fileName);
        continue;
      }
    }
    otherLines.push(rawLine);
  }

  if (
    dirOrder.length === 0 ||
    (otherLines.length > nonEmpty.length * 0.5 && otherLines.length > 25)
  ) {
    const head = nonEmpty.slice(0, 20);
    const tail = nonEmpty.slice(-5);
    const omitted = nonEmpty.length - 25;
    return [...head, `[... ${omitted} directory entries omitted ...]`, ...tail, ...errorLines].join(
      "\n",
    );
  }

  const MAX_DIRS = 40;
  const MAX_FILES_PER_DIR = 4;
  const out: Array<string> = [];
  for (const dir of dirOrder.slice(0, MAX_DIRS)) {
    const files = byDir.get(dir)!;
    const countLabel = `${files.length} ${files.length === 1 ? "file" : "files"}`;
    if (files.length > MAX_FILES_PER_DIR) {
      out.push(
        `${dir} (${countLabel}): ${files.slice(0, MAX_FILES_PER_DIR).join(", ")} (+${files.length - MAX_FILES_PER_DIR} more)`,
      );
    } else {
      out.push(`${dir} (${countLabel}): ${files.join(", ")}`);
    }
  }

  if (dirOrder.length > MAX_DIRS) {
    const remainingDirs = dirOrder.slice(MAX_DIRS);
    let remainingFiles = 0;
    for (const dir of remainingDirs) {
      remainingFiles += byDir.get(dir)?.length ?? 0;
    }
    out.push(`[... +${remainingDirs.length} more directories (${remainingFiles} files) ...]`);
  }

  if (errorLines.length > 0) {
    out.push(...errorLines);
  }

  return out.join("\n");
}

function compressGitStatusOutput(lines: ReadonlyArray<string>): string {
  const MAX_FILES_PER_SECTION = 20;
  const out: Array<string> = [];
  let inSection = false;
  let sectionFileCount = 0;
  let sectionOmitted = 0;

  const flushSectionOmitted = () => {
    if (sectionOmitted > 0) {
      out.push(`\t[... ${sectionOmitted} more files in section ...]`);
      sectionOmitted = 0;
    }
  };

  for (const line of lines) {
    if (GIT_STATUS_HINT_RE.test(line)) {
      continue;
    }
    if (GIT_STATUS_SECTION_RE.test(line.trim())) {
      flushSectionOmitted();
      inSection = true;
      sectionFileCount = 0;
      out.push(line);
      continue;
    }
    if (inSection) {
      if (line.trim() === "") {
        flushSectionOmitted();
        inSection = false;
        out.push(line);
        continue;
      }
      sectionFileCount += 1;
      if (sectionFileCount <= MAX_FILES_PER_SECTION) {
        out.push(line);
      } else {
        sectionOmitted += 1;
      }
      continue;
    }
    out.push(line);
  }
  flushSectionOmitted();
  return out.join("\n");
}

function compressGitLogOutput(lines: ReadonlyArray<string>): string {
  const MAX_COMMITS = 25;
  const hasCommitHeaders = lines.some((line) => /^commit\s+[0-9a-f]{7,}/i.test(line));
  if (!hasCommitHeaders) {
    if (lines.length <= MAX_COMMITS) return lines.join("\n");
    return [
      ...lines.slice(0, MAX_COMMITS),
      `[... ${lines.length - MAX_COMMITS} more commits omitted ...]`,
    ].join("\n");
  }

  const commits: Array<Array<string>> = [];
  let current: Array<string> = [];
  let sawSubject = false;

  for (const line of lines) {
    if (/^commit\s+[0-9a-f]{7,}/i.test(line)) {
      if (current.length > 0) commits.push(current);
      current = [line];
      sawSubject = false;
      continue;
    }
    if (current.length === 0) continue;
    const trimmed = line.trim();
    if (/^(?:Author:|Date:|Merge:)/i.test(trimmed)) {
      current.push(line);
      continue;
    }
    if (!sawSubject && trimmed !== "") {
      current.push(line);
      sawSubject = true;
    }
  }
  if (current.length > 0) commits.push(current);

  const kept = commits.slice(0, MAX_COMMITS).map((c) => c.join("\n"));
  if (commits.length > MAX_COMMITS) {
    kept.push(`[... ${commits.length - MAX_COMMITS} more commits omitted ...]`);
  }
  return kept.join("\n\n");
}

function compressBuildInstallOutput(lines: ReadonlyArray<string>): string {
  const len = lines.length;
  if (len <= 12) return lines.join("\n");

  const isImportant = (line: string) => CRITICAL_LOG_RE.test(line) || BUILD_WARN_LINE_RE.test(line);
  const isChurn = (line: string) =>
    !isImportant(line) && (BUILD_CHURN_LINE_RE.test(line) || line.trim() === "");

  const nonChurnIndices: Array<number> = [];
  for (let i = 0; i < len; i += 1) {
    if (!isChurn(lines[i] ?? "")) {
      nonChurnIndices.push(i);
    }
  }

  const keep = new Uint8Array(len);
  for (const idx of nonChurnIndices.slice(0, 3)) keep[idx] = 1;
  for (const idx of nonChurnIndices.slice(-8)) keep[idx] = 1;

  for (let i = 0; i < len; i += 1) {
    if (isImportant(lines[i] ?? "")) {
      const start = Math.max(0, i - 2);
      const end = Math.min(len - 1, i + 2);
      for (let j = start; j <= end; j += 1) {
        if (!isChurn(lines[j] ?? "") || j === i) {
          keep[j] = 1;
        }
      }
    }
  }

  return collapseKeptLines(lines, keep, (n) => `[... ${n} build/install lines omitted ...]`);
}

function compressCliOutput(rawText: string, commandHint?: string): string | undefined {
  const cleaned = collapseBlobLines(normalizeTerminalText(stripAnsi(rawText)));
  const lines = cleaned.split("\n");

  if (commandHint !== undefined) {
    if (TEST_RUNNER_CMD_RE.test(commandHint)) {
      return compressTestRunnerOutput(lines);
    }
    if (TYPECHECK_LINT_CMD_RE.test(commandHint)) {
      return compressTypecheckLintOutput(lines);
    }
    if (GIT_STATUS_CMD_RE.test(commandHint)) {
      return compressGitStatusOutput(lines);
    }
    if (GIT_LOG_CMD_RE.test(commandHint)) {
      return compressGitLogOutput(lines);
    }
    if (SEARCH_CMD_RE.test(commandHint)) {
      return compressSearchOutput(lines);
    }
    if (DIR_LIST_CMD_RE.test(commandHint)) {
      return compressDirectoryListing(lines);
    }
    if (BUILD_INSTALL_CMD_RE.test(commandHint)) {
      return compressBuildInstallOutput(lines);
    }
  }

  if (looksLikeTestRunnerOutput(lines)) {
    return compressTestRunnerOutput(lines);
  }
  if (looksLikeSearchOutput(lines)) {
    return compressSearchOutput(lines);
  }
  return undefined;
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
  const commandHint = resolveCommandHint(input.command, input.sourceLabel);
  const contentType = detectContentType(input.text, {
    path: input.path,
    sourceLabel: input.sourceLabel,
    command: commandHint,
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

  const genericInput =
    contentType === "logs" || contentType === "diff" ? stripAnsi(input.text) : input.text;
  const genericCandidate = runCompressor(contentType, genericInput);
  const cliCandidate =
    contentType !== "json" && contentType !== "code" && contentType !== "diff"
      ? compressCliOutput(input.text, commandHint)
      : undefined;
  const candidateBody = cliCandidate !== undefined ? cliCandidate : genericCandidate;
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
