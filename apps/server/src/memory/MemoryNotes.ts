import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { redactCcrSecrets } from "@t3tools/provider-core/server/ccrStore";

/**
 * Shared `~/.agents/memory/` (Claude auto-memory + Antigravity GEMINI.md) and RSI lessons,
 * searched via in-memory SQLite FTS5; `memory_write` writes frontmatter + a `MEMORY.md` line.
 */

export type MemorySource = "memory" | "rsi-lesson";

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
const INDEX_FILE = "MEMORY.md";
let atomicWriteSeq = 0;

/** Case- and slash-insensitive on Windows drive paths, so `C:\x` and `c:/x/` are one project. */
const normalizeRoot = (root: string): string => {
  const slashed = root.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
};

const unquote = (value: string): string => {
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (!value.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value.replace(/^"(.*)"$/, "$1");
  }
};

/** Flat key/value view of the frontmatter; nested `metadata:` keys are read like top-level ones. */
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

/**
 * Memories of the caller's project (or without a projectRoot) from the shared folder.
 * shortcut: rescans the folder on every search, fine for hundreds of files; cache by mtime when slower.
 */
export const collectMemoryDocs = Effect.fn("MemoryNotes.collectMemoryDocs")(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly memoryDir: string;
  readonly projectRoot?: string | undefined;
}) {
  const project = input.projectRoot === undefined ? undefined : normalizeRoot(input.projectRoot);
  const entries = yield* input.fs
    .readDirectory(input.memoryDir)
    .pipe(Effect.orElseSucceed(() => []));
  const docs: Array<MemoryDoc> = [];
  for (const entry of entries) {
    // MEMORY.md is only the index of the other files.
    if (!entry.toLowerCase().endsWith(".md") || entry.toUpperCase() === INDEX_FILE.toUpperCase()) {
      continue;
    }
    const filePath = input.path.join(input.memoryDir, entry);
    const raw = yield* input.fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim() === "") continue;
    const { meta, body } = splitFrontmatter(raw);
    const noteRoot = meta.get("projectRoot");
    if (noteRoot !== undefined && noteRoot !== "" && normalizeRoot(noteRoot) !== project) continue;
    const description = meta.get("description");
    docs.push({
      source: "memory",
      title: meta.get("name") || meta.get("title") || input.path.basename(filePath, ".md"),
      body: description === undefined ? body : `${description}\n${body}`,
      path: filePath,
    });
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

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 3).trimEnd()}...`;
};

const formatMemoryNote = (input: {
  readonly slug: string;
  readonly description: string;
  readonly body: string;
  readonly projectRoot?: string | undefined;
  readonly nowIso: string;
}): string =>
  [
    "---",
    `name: ${input.slug}`,
    `description: ${JSON.stringify(input.description)}`,
    "metadata:",
    `  type: ${input.projectRoot === undefined ? "reference" : "project"}`,
    "  t3_memory: true",
    ...(input.projectRoot === undefined
      ? []
      : [`  projectRoot: ${JSON.stringify(input.projectRoot)}`]),
    `  modified: ${input.nowIso}`,
    "---",
    "",
    input.body,
    "",
  ].join("\n");

/** MEMORY.md keeps one `- [title](file) - hook` line per memory; replace ours or append it. */
const upsertIndexLine = (index: string, fileName: string, line: string): string => {
  const lines = index.replace(/(?:\r?\n)+$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0]?.trim() === "") lines.length = 0;
  const at = lines.findIndex((existing) => existing.includes(`](${fileName})`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return `${lines.join("\n")}\n`;
};

/**
 * Writes (or updates) one memory in the shared folder and its MEMORY.md line. Agents call this,
 * so: strict slug file names inside the folder only, size cap, secrets redacted, tmp + rename,
 * and a file T3 did not write is never overwritten (the memory goes to a "-2" sibling instead).
 */
export const writeMemoryNote = Effect.fn("MemoryNotes.writeMemoryNote")(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly memoryDir: string;
  readonly title: string;
  readonly content: string;
  readonly projectRoot?: string | undefined;
  readonly nowIso: string;
}) {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  const baseSlug = slugifyMemoryTitle(title);
  if (baseSlug === "") return yield* new MemoryWriteError({ message: "Memory title is empty." });
  const content = input.content.trim();
  if (content === "") return yield* new MemoryWriteError({ message: "Memory content is empty." });
  if (content.length > MAX_MEMORY_NOTE_CHARS) {
    return yield* new MemoryWriteError({
      message: `Memory content exceeds ${MAX_MEMORY_NOTE_CHARS} characters.`,
    });
  }
  const body = redactCcrSecrets(content).text;

  yield* input.fs.makeDirectory(input.memoryDir, { recursive: true });
  let slug = baseSlug;
  for (let suffix = 2; ; suffix += 1) {
    const existing = yield* input.fs
      .readFileString(input.path.join(input.memoryDir, `${slug}.md`))
      .pipe(Effect.orElseSucceed(() => null as string | null));
    if (existing === null || splitFrontmatter(existing).meta.get("t3_memory") === "true") break;
    if (suffix > 50) {
      return yield* new MemoryWriteError({ message: "Too many memories with this title." });
    }
    slug = `${baseSlug}-${suffix}`;
  }
  const fileName = `${slug}.md`;
  const filePath = input.path.join(input.memoryDir, fileName);
  const writeAtomic = (target: string, text: string) => {
    const tmp = `${target}.${process.pid}.${(atomicWriteSeq += 1)}.tmp`;
    return input.fs.writeFileString(tmp, text).pipe(
      Effect.andThen(input.fs.rename(tmp, target)),
      Effect.tapError(() => input.fs.remove(tmp).pipe(Effect.ignore)),
    );
  };
  yield* writeAtomic(
    filePath,
    formatMemoryNote({
      slug,
      description: title,
      body,
      projectRoot: input.projectRoot,
      nowIso: input.nowIso,
    }),
  );
  const indexPath = input.path.join(input.memoryDir, INDEX_FILE);
  const index = yield* input.fs.readFileString(indexPath).pipe(Effect.orElseSucceed(() => ""));
  yield* writeAtomic(
    indexPath,
    upsertIndexLine(
      index,
      fileName,
      `- [${oneLine(title, 60)}](${fileName}) - ${oneLine(body, 100)}`,
    ),
  );
  return { path: filePath, title };
});
