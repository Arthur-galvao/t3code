import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { redactCcrSecrets } from "@t3tools/provider-core/server/ccrStore";

/**
 * Unified agent memory: markdown notes written through `memory_write`, the Claude auto-memory
 * folder of the caller's project (read-only) and RSI lessons, searched together with an
 * in-memory SQLite FTS5 index. Notes are files, not database rows, so the user can read and
 * edit them in Obsidian and nothing touches T3's own database schema.
 */

export type MemorySource = "note" | "claude-memory" | "rsi-lesson";

export interface MemoryDoc {
  readonly source: MemorySource;
  readonly title: string;
  readonly body: string;
  readonly path?: string | undefined;
}

export interface MemoryHit {
  readonly source: MemorySource;
  readonly title: string;
  readonly snippet: string;
  readonly path?: string | undefined;
}

const MAX_MEMORY_NOTE_CHARS = 8_000;
const MAX_TITLE_CHARS = 120;
const T3_MEMORY_MARKER = "t3_memory: true";

/** Claude Code stores per-project state under ~/.claude/projects/<cwd with non-alphanumerics as "-">. */
export const claudeProjectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** Case- and slash-insensitive on Windows drive paths, so `C:\x` and `c:/x/` are one project. */
const normalizeRoot = (root: string): string => {
  const slashed = root.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
};

const unquote = (value: string): string => {
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value.replace(/^"(.*)"$/, "$1");
  }
};

const splitFrontmatter = (raw: string): { meta: Map<string, string>; body: string } => {
  const meta = new Map<string, string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trimStart());
  if (match === null) return { meta, body: raw };
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    meta.set(line.slice(0, colon).trim(), unquote(line.slice(colon + 1).trim()));
  }
  return { meta, body: match[2] ?? "" };
};

const readMarkdownDir = Effect.fn("MemoryNotes.readMarkdownDir")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
) {
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const files: Array<{ readonly filePath: string; readonly raw: string }> = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim() !== "") files.push({ filePath, raw });
  }
  return files;
});

/**
 * Notes of the project (or global ones, without projectRoot) plus the project's Claude memory.
 * shortcut: rescans the folders on every search, fine for hundreds of notes; cache by mtime when slower.
 */
export const collectMemoryDocs = Effect.fn("MemoryNotes.collectMemoryDocs")(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly notesDir: string;
  readonly claudeMemoryDir?: string | undefined;
  readonly projectRoot?: string | undefined;
}) {
  const docs: Array<MemoryDoc> = [];
  const project = input.projectRoot === undefined ? undefined : normalizeRoot(input.projectRoot);
  for (const { filePath, raw } of yield* readMarkdownDir(input.fs, input.path, input.notesDir)) {
    const { meta, body } = splitFrontmatter(raw);
    const noteRoot = meta.get("projectRoot");
    if (noteRoot !== undefined && noteRoot !== "" && normalizeRoot(noteRoot) !== project) continue;
    const title = meta.get("title") || input.path.basename(filePath, ".md");
    docs.push({ source: "note", title, body, path: filePath });
  }
  if (input.claudeMemoryDir !== undefined) {
    for (const { filePath, raw } of yield* readMarkdownDir(
      input.fs,
      input.path,
      input.claudeMemoryDir,
    )) {
      // MEMORY.md is only the index of the other files.
      if (input.path.basename(filePath).toUpperCase() === "MEMORY.MD") continue;
      const { meta, body } = splitFrontmatter(raw);
      const title = meta.get("name") || input.path.basename(filePath, ".md");
      const description = meta.get("description");
      docs.push({
        source: "claude-memory",
        title,
        body: description === undefined ? body : `${description}\n${body}`,
        path: filePath,
      });
    }
  }
  return docs;
});

/** Words of the query as quoted FTS5 prefix terms; raw text in MATCH would throw on `:` or `-`. */
export const toFtsQuery = (query: string): string | undefined => {
  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length === 0 ? undefined : words.map((word) => `"${word}"*`).join(" OR ");
};

export function searchMemoryDocs(
  docs: ReadonlyArray<MemoryDoc>,
  query: string,
  limit = 8,
): ReadonlyArray<MemoryHit> {
  const match = toFtsQuery(query);
  if (match === undefined || docs.length === 0) return [];
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    // remove_diacritics: notes mix Portuguese and English ("validacao" finds "validação").
    db.exec(
      "CREATE VIRTUAL TABLE memory USING fts5(title, body, tokenize='unicode61 remove_diacritics 2')",
    );
    const insert = db.prepare("INSERT INTO memory(rowid, title, body) VALUES (?, ?, ?)");
    docs.forEach((doc, index) => insert.run(index + 1, doc.title, doc.body));
    const rows = db
      .prepare(
        "SELECT rowid, snippet(memory, 1, '[', ']', '...', 24) AS snippet FROM memory WHERE memory MATCH ? ORDER BY bm25(memory, 5.0, 1.0) LIMIT ?",
      )
      .all(match, Math.max(1, Math.min(25, Math.floor(limit)))) as Array<{
      rowid: number;
      snippet: string;
    }>;
    return rows.flatMap((row) => {
      const doc = docs[row.rowid - 1];
      return doc === undefined
        ? []
        : [{ source: doc.source, title: doc.title, snippet: row.snippet, path: doc.path }];
    });
  } finally {
    db.close();
  }
}

const slugifyMemoryTitle = (title: string): string =>
  title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");

export class MemoryWriteError extends Schema.TaggedError<MemoryWriteError>()("MemoryWriteError", {
  message: Schema.String,
}) {}

const formatMemoryNote = (input: {
  readonly title: string;
  readonly body: string;
  readonly projectRoot?: string | undefined;
  readonly nowIso: string;
}): string =>
  [
    "---",
    T3_MEMORY_MARKER,
    `title: ${JSON.stringify(input.title)}`,
    ...(input.projectRoot === undefined
      ? []
      : [`projectRoot: ${JSON.stringify(input.projectRoot)}`]),
    `updatedAt: ${JSON.stringify(input.nowIso)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body,
    "",
  ].join("\n");

/**
 * Writes (or updates) one note in notesDir. Agents call this, so: strict slug file names inside
 * notesDir only, size cap, secrets redacted, tmp + rename, and a file T3 did not write is never
 * overwritten (the note goes to a "-2" sibling instead).
 */
export const writeMemoryNote = Effect.fn("MemoryNotes.writeMemoryNote")(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly notesDir: string;
  readonly title: string;
  readonly content: string;
  readonly projectRoot?: string | undefined;
  readonly nowIso: string;
}) {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  const slug = slugifyMemoryTitle(title);
  if (slug === "") return yield* new MemoryWriteError({ message: "Memory title is empty." });
  const content = input.content.trim();
  if (content === "") return yield* new MemoryWriteError({ message: "Memory content is empty." });
  if (content.length > MAX_MEMORY_NOTE_CHARS) {
    return yield* new MemoryWriteError({
      message: `Memory content exceeds ${MAX_MEMORY_NOTE_CHARS} characters.`,
    });
  }
  const note = formatMemoryNote({
    title,
    body: redactCcrSecrets(content).text,
    projectRoot: input.projectRoot,
    nowIso: input.nowIso,
  });

  yield* input.fs.makeDirectory(input.notesDir, { recursive: true });
  let filePath = input.path.join(input.notesDir, `${slug}.md`);
  for (let suffix = 2; ; suffix += 1) {
    const existing = yield* input.fs
      .readFileString(filePath)
      .pipe(Effect.orElseSucceed(() => null as string | null));
    if (existing === null || splitFrontmatter(existing).meta.get("t3_memory") === "true") break;
    if (suffix > 50)
      return yield* new MemoryWriteError({ message: "Too many notes with this title." });
    filePath = input.path.join(input.notesDir, `${slug}-${suffix}.md`);
  }
  const tmpPath = `${filePath}.tmp`;
  yield* input.fs.writeFileString(tmpPath, note);
  yield* input.fs.rename(tmpPath, filePath);
  return { path: filePath, title };
});
