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
});
