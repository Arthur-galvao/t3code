// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { createCcrStore } from "./ccrStore.ts";

describe("createCcrStore", () => {
  it("stores entries with monotonic ccr_XXXX ids and retrieves exact 1-indexed line slices", () => {
    const store = createCcrStore();
    const first = store.put({
      content: "alpha\nbeta\ngamma\ndelta\nepsilon",
      contentType: "text",
      sourceLabel: "readTextFile",
      path: "/repo/notes.txt",
    });
    const second = store.put({
      content: '{"ok":true}',
      contentType: "json",
    });

    assert.equal(first.ccrId, "ccr_0001");
    assert.equal(first.totalLines, 5);
    assert.equal(second.ccrId, "ccr_0002");
    assert.equal(store.get("ccr_0001")?.path, "/repo/notes.txt");

    const slice = store.retrieve({ ccrId: "ccr_0001", startLine: 2, endLine: 4 });
    assert.equal(slice.found, true);
    assert.equal(slice.totalLines, 5);
    assert.equal(slice.matchedLines, 3);
    assert.equal(slice.startLine, 2);
    assert.equal(slice.endLine, 4);
    assert.equal(slice.truncated, false);
    assert.equal(slice.content, "L2: beta\nL3: gamma\nL4: delta");
  });

  it("supports case-insensitive regex and substring fallback search within optional line ranges", () => {
    const store = createCcrStore();
    const entry = store.put({
      content: [
        "INFO starting worker",
        "WARN cache cold",
        "ERROR: failed to parse foo(bar",
        "INFO retrying",
        "FATAL: connection dropped",
      ].join("\n"),
      contentType: "logs",
    });

    const regexResult = store.retrieve({ ccrId: entry.ccrId, query: "error|fatal" });
    assert.equal(regexResult.found, true);
    assert.equal(regexResult.matchedLines, 2);
    assert.equal(
      regexResult.content,
      "L3: ERROR: failed to parse foo(bar\nL5: FATAL: connection dropped",
    );

    const invalidRegexFallback = store.retrieve({ ccrId: entry.ccrId, query: "FOO(BAR" });
    assert.equal(invalidRegexFallback.matchedLines, 1);
    assert.equal(invalidRegexFallback.content, "L3: ERROR: failed to parse foo(bar");

    const slashRegex = store.retrieve({ ccrId: entry.ccrId, query: "/^warn/g" });
    assert.equal(slashRegex.matchedLines, 1);
    assert.equal(slashRegex.content, "L2: WARN cache cold");
  });

  it("enforces maxChars truncation and handles missing ccrIds cleanly", () => {
    const store = createCcrStore();
    const entry = store.put({
      content: Array.from({ length: 50 }, (_, idx) => `line_${idx + 1}_payload`).join("\n"),
      contentType: "text",
    });

    const truncated = store.retrieve({ ccrId: entry.ccrId, maxChars: 60 });
    assert.equal(truncated.found, true);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.matchedLines, 50);
    assert.isAtMost(truncated.content.length, 60);

    const missing = store.retrieve({ ccrId: "ccr_9999" });
    assert.equal(missing.found, false);
    assert.equal(missing.matchedLines, 0);
    assert.include(missing.content, "not found");
  });

  it("evicts oldest entries when over maxEntries or maxBytes and tracks compression stats", () => {
    const entryBudgetStore = createCcrStore({ maxEntries: 2 });
    entryBudgetStore.put({ content: "one", contentType: "text" });
    entryBudgetStore.put({ content: "two", contentType: "text" });
    entryBudgetStore.put({ content: "three", contentType: "text" });

    assert.isUndefined(entryBudgetStore.get("ccr_0001"));
    assert.isDefined(entryBudgetStore.get("ccr_0002"));
    assert.isDefined(entryBudgetStore.get("ccr_0003"));

    const byteBudgetStore = createCcrStore({ maxEntries: 100, maxBytes: 12 });
    byteBudgetStore.put({ content: "aaaaaa", contentType: "text" });
    byteBudgetStore.put({ content: "bbbbbb", contentType: "text" });
    byteBudgetStore.put({ content: "cccccc", contentType: "text" });

    assert.isUndefined(byteBudgetStore.get("ccr_0001"));
    assert.isDefined(byteBudgetStore.get("ccr_0002"));
    assert.isDefined(byteBudgetStore.get("ccr_0003"));
    assert.equal(byteBudgetStore.getStats().currentBytes, 12);

    byteBudgetStore.recordCompression(4000, 1000);
    byteBudgetStore.recordCompression(2000, 500);
    const stats = byteBudgetStore.getStats();
    assert.equal(stats.compressedCallsCount, 2);
    assert.equal(stats.totalOriginalChars, 6000);
    assert.equal(stats.totalCompressedChars, 1500);
    assert.equal(stats.totalSavedChars, 4500);
    assert.equal(stats.tokensSavedEst, 1125);
  });

  it("scopes per-thread eviction and stats while keeping global fallback and id-safe retrieval", () => {
    const store = createCcrStore({ maxEntries: 10, maxEntriesPerThread: 2 });

    const globalEntry = store.put({ content: "global-1", contentType: "text" });
    const t1First = store.put({ content: "t1-1", contentType: "text", threadId: "thread-1" });
    const t1Second = store.put({ content: "t1-2", contentType: "text", threadId: "thread-1" });
    const t2First = store.put({ content: "t2-1", contentType: "text", threadId: "thread-2" });
    const t1Third = store.put({ content: "t1-3", contentType: "text", threadId: "thread-1" });

    assert.equal(globalEntry.threadId, "__global__");
    assert.isUndefined(store.get(t1First.ccrId));
    assert.isDefined(store.get(t1Second.ccrId));
    assert.isDefined(store.get(t1Third.ccrId));
    assert.isDefined(store.get(t2First.ccrId));
    assert.isDefined(store.get(globalEntry.ccrId));

    // Explicit ccrId retrieval works both with matching threadId and fallback when threadId differs.
    assert.equal(store.retrieve({ ccrId: t2First.ccrId, threadId: "thread-2" }).found, true);
    assert.equal(store.retrieve({ ccrId: t2First.ccrId, threadId: "thread-1" }).found, true);

    store.recordCompression(1_000, 200, "thread-1");
    store.recordCompression(800, 300, "thread-2");
    store.recordCompression(400, 100);

    const t1Stats = store.getStats("thread-1");
    assert.equal(t1Stats.entriesCount, 2);
    assert.equal(t1Stats.compressedCallsCount, 1);
    assert.equal(t1Stats.totalSavedChars, 800);

    const t2Stats = store.getStats("thread-2");
    assert.equal(t2Stats.entriesCount, 1);
    assert.equal(t2Stats.compressedCallsCount, 1);
    assert.equal(t2Stats.totalSavedChars, 500);

    const globalOnlyStats = store.getStats("__global__");
    assert.equal(globalOnlyStats.entriesCount, 1);
    assert.equal(globalOnlyStats.totalSavedChars, 300);

    const allStats = store.getStats();
    assert.equal(allStats.entriesCount, 4);
    assert.equal(allStats.compressedCallsCount, 3);
    assert.equal(allStats.totalSavedChars, 1_600);
  });

  it("persists to disk, hydrates synchronously on configure, and prunes expired TTL entries", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ccr-store-"));
    try {
      const persistPath = NodePath.join(tempDir, "nested", "ccr-cache.json");
      let clockMs = 1_000_000;
      const ttlMs = 5_000;

      const writer = createCcrStore({
        persistPath,
        ttlMs,
        debounceMs: 50,
        now: () => clockMs,
      });

      const early = writer.put({
        content: "early-line-1\nearly-line-2",
        contentType: "text",
        threadId: "thread-a",
      });
      clockMs += 3_000;
      const late = writer.put({
        content: "late-line-1",
        contentType: "text",
        threadId: "thread-b",
      });
      writer.recordCompression(2_000, 500, "thread-a");
      writer.flush();

      assert.equal(NodeFS.existsSync(persistPath), true);

      // Advance clock so `early` is expired (age 6000 >= 5000) while `late` is still valid (age 3000 < 5000).
      clockMs += 3_000;
      const reader = createCcrStore({ now: () => clockMs });
      reader.configurePersistence(persistPath, { ttlMs, debounceMs: 0 });

      assert.isUndefined(reader.get(early.ccrId));
      assert.equal(reader.retrieve({ ccrId: early.ccrId }).found, false);
      assert.equal(reader.retrieve({ ccrId: late.ccrId }).content, "L1: late-line-1");
      assert.equal(reader.getStats().entriesCount, 1);
      assert.equal(reader.getStats("thread-a").tokensSavedEst, 375);

      const next = reader.put({ content: "after-hydrate", contentType: "text" });
      assert.equal(next.ccrId, "ccr_0003");
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("supports contextLines around query matches, merges overlapping ranges, and clamps to 20", () => {
    const store = createCcrStore();
    const lines = Array.from({ length: 60 }, (_, idx) => {
      const lineNum = idx + 1;
      if (lineNum === 5 || lineNum === 8 || lineNum === 40) {
        return `ERROR line ${lineNum}`;
      }
      return `info line ${lineNum}`;
    });
    const entry = store.put({
      content: lines.join("\n"),
      contentType: "logs",
    });

    const withContext = store.retrieve({
      ccrId: entry.ccrId,
      query: "ERROR",
      contextLines: 2,
    });
    assert.equal(withContext.found, true);
    assert.equal(withContext.matchedLines, 3);
    assert.equal(withContext.startLine, 3);
    assert.equal(withContext.endLine, 42);
    // Lines 5 and 8 with ±2 merge continuously (3..10) with no duplicate lines and `--` before 38..42.
    assert.equal(
      withContext.content,
      [
        "L3: info line 3",
        "L4: info line 4",
        "L5: ERROR line 5",
        "L6: info line 6",
        "L7: info line 7",
        "L8: ERROR line 8",
        "L9: info line 9",
        "L10: info line 10",
        "--",
        "L38: info line 38",
        "L39: info line 39",
        "L40: ERROR line 40",
        "L41: info line 41",
        "L42: info line 42",
      ].join("\n"),
    );

    // Clamping > 20 around line 40 gives 20..60 (since 40-20=20, 40+20=60), while 5±20 gives 1..25 (disjoint from 20? No, 20<=25+1 -> merges!).
    const clamped = store.retrieve({
      ccrId: entry.ccrId,
      query: "ERROR",
      startLine: 30,
      endLine: 60,
      contextLines: 50,
    });
    assert.equal(clamped.matchedLines, 1);
    assert.equal(clamped.startLine, 30);
    assert.equal(clamped.endLine, 60);
  });

  it("never leaves a trailing '--' separator when contextLines output is truncated by maxChars", () => {
    const store = createCcrStore();
    const lines = Array.from({ length: 30 }, (_, idx) => {
      const lineNum = idx + 1;
      return lineNum === 2 || lineNum === 25 ? `ERROR at ${lineNum}` : `row ${lineNum}`;
    });
    const entry = store.put({ content: lines.join("\n"), contentType: "logs" });

    // First hunk L1..L3 is 34 chars; "--" brings length to 37, while L24 overflows maxChars=38.
    const exactBoundary = store.retrieve({
      ccrId: entry.ccrId,
      query: "ERROR",
      contextLines: 1,
      maxChars: 38,
    });
    assert.equal(exactBoundary.truncated, true);
    assert.isFalse(exactBoundary.content.endsWith("--"));
    assert.equal(exactBoundary.endLine, 3);
  });
});
