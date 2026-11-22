// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import { createCcrStore, redactCcrSecrets } from "./ccrStore.ts";

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

  it("redacts high-confidence secrets on put() in memory, retrieve(), and persisted disk cache without false positives", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ccr-redact-"));
    try {
      const persistPath = NodePath.join(tempDir, "ccr-cache.json");
      const store = createCcrStore({ persistPath, debounceMs: 0 });

      const secretPayload = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEpAIBAAKCAQEA1234567890abcdef",
        "-----END RSA PRIVATE KEY-----",
        "Authorization: Bearer super_secret_bearer_token_value_1234",
        "ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
        "GITHUB=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        "AWS=AKIAIOSFODNN7EXAMPLE123",
        "OPENAI_API_KEY=my_real_secret_key_987654321",
        'DB_PASSWORD="actual_db_password_999"',
        "auth_token=real_cookie_auth_token_12345; ct0=real_ct0_csrf_token_67890",
        "DUMMY_API_KEY=example_placeholder_value",
        "TEMPLATE_SECRET=${MY_TEMPLATE_SECRET}",
        "DOC_PASSWORD=<your-password>",
        "uuid=550e8400-e29b-41d4-a716-446655440000",
        "commit=4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      ].join("\n");

      const entry = store.put({ content: secretPayload, contentType: "logs", threadId: "t-sec" });
      assert.equal(entry.redacted, true);
      assert.notInclude(entry.content, "MIIEpAIBAAKCAQEA1234567890abcdef");
      assert.notInclude(entry.content, "super_secret_bearer_token_value_1234");
      assert.notInclude(entry.content, "sk-ant-api03-");
      assert.notInclude(entry.content, "ghp_1234567890");
      assert.notInclude(entry.content, "my_real_secret_key_987654321");
      assert.notInclude(entry.content, "actual_db_password_999");
      assert.notInclude(entry.content, "real_cookie_auth_token_12345");
      assert.notInclude(entry.content, "real_ct0_csrf_token_67890");

      assert.include(entry.content, "[REDACTED_PRIVATE_KEY]");
      assert.include(entry.content, "Authorization: Bearer [REDACTED]");
      assert.include(entry.content, "[REDACTED_TOKEN]");
      assert.include(entry.content, "OPENAI_API_KEY=[REDACTED]");
      assert.include(entry.content, 'DB_PASSWORD="[REDACTED]"');
      assert.include(entry.content, "DUMMY_API_KEY=example_placeholder_value");
      assert.include(entry.content, "TEMPLATE_SECRET=${MY_TEMPLATE_SECRET}");
      assert.include(entry.content, "DOC_PASSWORD=<your-password>");
      assert.include(entry.content, "uuid=550e8400-e29b-41d4-a716-446655440000");
      assert.include(entry.content, "commit=4b825dc642cb6eb9a060e54bf8d69288fbee4904");

      const retrieved = store.retrieve({ ccrId: entry.ccrId, startLine: 1, endLine: 20 });
      assert.equal(retrieved.redacted, true);
      assert.notInclude(retrieved.content, "my_real_secret_key_987654321");

      const persistedRaw = NodeFS.readFileSync(persistPath, "utf8");
      assert.notInclude(persistedRaw, "my_real_secret_key_987654321");
      assert.notInclude(persistedRaw, "MIIEpAIBAAKCAQEA1234567890abcdef");

      const codeSnippet = [
        "const password = getPasswordFromEnv();",
        "const cfg = { CLIENT_SECRET: process.env.CLIENT_SECRET, api_key: options.apiKey };",
        "plain uuid 550e8400-e29b-41d4-a716-446655440000",
      ].join("\n");
      const cleanResult = redactCcrSecrets(codeSnippet);
      assert.equal(cleanResult.redacted, false);
      assert.equal(cleanResult.text, codeSnippet);

      const jsonAndLower = [
        '{"password": "json_real_secret_value_99", "api_key": "lower_api_secret_1234"}',
        "api_key=unquoted_lower_secret_5678",
      ].join("\n");
      const jsonRedacted = redactCcrSecrets(jsonAndLower);
      assert.equal(jsonRedacted.redacted, true);
      assert.notInclude(jsonRedacted.text, "json_real_secret_value_99");
      assert.notInclude(jsonRedacted.text, "lower_api_secret_1234");
      assert.notInclude(jsonRedacted.text, "unquoted_lower_secret_5678");
      assert.include(jsonRedacted.text, '"password": "[REDACTED]"');
      assert.include(jsonRedacted.text, '"api_key": "[REDACTED]"');
      assert.include(jsonRedacted.text, "api_key=[REDACTED]");

      const cleanEntry = store.put({ content: "clean log line", contentType: "logs" });
      assert.isUndefined(cleanEntry.redacted);
      assert.isUndefined(store.retrieve({ ccrId: cleanEntry.ccrId }).redacted);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("caps per-entry bytes cleanly without splitting UTF-8 multi-byte chars or evicting the whole store", () => {
    const store = createCcrStore({ maxBytes: 1_000, maxEntryBytes: 120 });
    const small = store.put({ content: "keep-me", contentType: "text" });
    const giantUtf8 = "😀".repeat(60); // 240 UTF-8 bytes
    const capped = store.put({ content: giantUtf8, contentType: "text" });

    assert.isDefined(store.get(small.ccrId));
    assert.isAtMost(capped.byteCount, 120);
    assert.include(capped.content, "[... truncated to CCR entry byte cap ...]");
    assert.isFalse(capped.content.includes("\uFFFD"));
  });

  it("rejects long or nested-quantifier ReDoS queries and falls back to literal matching", () => {
    const store = createCcrStore();
    const evilInput = `${"a".repeat(32)}!`;
    const entry = store.put({
      content: ["alpha", evilInput, "literal /(a+)+/ pattern", "omega"].join("\n"),
      contentType: "text",
    });

    const nested = store.retrieve({ ccrId: entry.ccrId, query: "/(a+)+/" });
    assert.equal(nested.found, true);
    assert.equal(nested.matchedLines, 1);
    assert.equal(nested.content, "L3: literal /(a+)+/ pattern");

    const plainNested = store.retrieve({ ccrId: entry.ccrId, query: "([a-z]+)*" });
    assert.equal(plainNested.found, true);
    assert.equal(plainNested.matchedLines, 0);

    const overlong = store.retrieve({ ccrId: entry.ccrId, query: "a".repeat(250) });
    assert.equal(overlong.found, true);
    assert.equal(overlong.matchedLines, 0);
  });

  it("purges all entries for a thread via purgeThread while preserving other threads and historical savings", () => {
    const store = createCcrStore();
    const a1 = store.put({ content: "thread-a-1", contentType: "text", threadId: "thread-a" });
    const a2 = store.put({ content: "thread-a-2", contentType: "text", threadId: "thread-a" });
    const b1 = store.put({ content: "thread-b-1", contentType: "text", threadId: "thread-b" });
    store.recordCompression(2_000, 500, "thread-a");

    const purgedCount = store.purgeThread("thread-a");
    assert.equal(purgedCount, 2);
    assert.equal(store.purgeThread("thread-a"), 0);
    assert.isUndefined(store.get(a1.ccrId));
    assert.isUndefined(store.get(a2.ccrId));
    assert.isDefined(store.get(b1.ccrId));

    const statsA = store.getStats("thread-a");
    assert.equal(statsA.entriesCount, 0);
    assert.equal(statsA.currentBytes, 0);
    assert.equal(statsA.tokensSavedEst, 375);
    assert.equal(store.getStats().entriesCount, 1);
    assert.equal(store.getStats().currentBytes, b1.byteCount);
  });

  it("tracks retrieveCallsCount globally, per-thread, and across persistence hydration", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ccr-retrieve-count-"));
    try {
      const persistPath = NodePath.join(tempDir, "ccr-cache.json");
      const writer = createCcrStore({ persistPath, debounceMs: 0 });
      const entry = writer.put({ content: "line1\nline2", contentType: "text", threadId: "t1" });

      writer.retrieve({ ccrId: entry.ccrId, threadId: "t1" });
      writer.retrieve({ ccrId: entry.ccrId, startLine: 1, endLine: 1 });
      writer.retrieve({ ccrId: "ccr_9999", threadId: "t2" });

      assert.equal(writer.getStats("t1").retrieveCallsCount, 2);
      assert.equal(writer.getStats("t2").retrieveCallsCount, 1);
      assert.equal(writer.getStats().retrieveCallsCount, 3);

      const reader = createCcrStore();
      reader.configurePersistence(persistPath, { debounceMs: 0 });
      assert.equal(reader.getStats("t1").retrieveCallsCount, 2);
      assert.equal(reader.getStats("t2").retrieveCallsCount, 1);
      assert.equal(reader.getStats().retrieveCallsCount, 3);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes scoped and __global__ compression baselines via getCompressionBaselines after hydration", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ccr-baselines-"));
    try {
      const persistPath = NodePath.join(tempDir, "ccr-cache.json");
      const writer = createCcrStore({ persistPath, debounceMs: 0 });
      const entry = writer.put({ content: "line1\nline2", contentType: "text", threadId: "t1" });
      writer.recordCompression(1_600, 400, "t1");
      writer.retrieve({ ccrId: entry.ccrId, threadId: "t1" });
      writer.recordCompression(1_200, 200);
      writer.flush();

      const reader = createCcrStore();
      reader.configurePersistence(persistPath, { debounceMs: 0 });
      const baselines = reader.getCompressionBaselines?.();
      assert.isDefined(baselines);
      assert.deepEqual(baselines?.get("t1"), {
        tokensSavedEst: 300,
        compressedCallsCount: 1,
        retrieveCallsCount: 1,
      });
      assert.deepEqual(baselines?.get("__global__"), {
        tokensSavedEst: 250,
        compressedCallsCount: 1,
        retrieveCallsCount: 0,
      });
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
