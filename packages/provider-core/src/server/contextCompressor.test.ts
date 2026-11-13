import { assert, describe, it } from "@effect/vitest";

import { createCcrStore } from "./ccrStore.ts";
import { compressToolOutput, detectContentType } from "./contextCompressor.ts";

describe("detectContentType", () => {
  it("detects diff, json, logs, code, and text from hints, paths, and content", () => {
    assert.equal(detectContentType("anything", { contentTypeHint: "logs" }), "logs");
    assert.equal(
      detectContentType("diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts"),
      "diff",
    );
    assert.equal(detectContentType('{"items":[1,2,3]}', { path: "data.json" }), "json");
    assert.equal(detectContentType("const x = 1;", { path: "src/index.ts" }), "code");
    assert.equal(
      detectContentType(
        "2026-11-13T01:00:00Z INFO booting\n2026-11-13T01:00:01Z INFO ready\n2026-11-13T01:00:02Z WARN slow",
      ),
      "logs",
    );
    assert.equal(
      detectContentType("# Heading\n\nSome plain documentation.", { path: "README.md" }),
      "text",
    );
  });
});

describe("compressToolOutput", () => {
  it("returns a fast no-op below minChars", () => {
    const store = createCcrStore();
    const short = "INFO ok\n".repeat(50);
    const result = compressToolOutput({ text: short, store });

    assert.equal(result.compressed, false);
    assert.equal(result.text, short);
    assert.equal(result.savedChars, 0);
    assert.equal(store.getStats().entriesCount, 0);
  });

  it("applies SmartCrusher to JSON arrays while keeping schema keys, head/tail, and error items", () => {
    const store = createCcrStore();
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      status: i === 57 ? "error" : "ok",
      message: i === 57 ? "CRITICAL: database deadlock detected" : `processed record ${i + 1}`,
    }));
    const raw = JSON.stringify(rows, null, 2);
    const result = compressToolOutput({ text: raw, path: "report.json", store });

    assert.equal(result.compressed, true);
    assert.equal(result.contentType, "json");
    assert.isDefined(result.ccrId);
    assert.include(result.text, "keys: id, status, message");
    assert.include(result.text, '"id":1');
    assert.include(result.text, '"id":3');
    assert.include(result.text, "CRITICAL: database deadlock detected");
    assert.include(result.text, '"id":120');
    assert.include(result.text, "similar items omitted");
    assert.include(result.text, `[T3 CCR:${result.ccrId} (json):`);
    assert.equal(store.retrieve({ ccrId: result.ccrId!, query: "deadlock" }).matchedLines, 1);
  });

  it("applies LogCompressor while preserving ERROR/FATAL/Traceback + ±2 context byte-for-byte", () => {
    const store = createCcrStore();
    const lines: Array<string> = [];
    for (let i = 0; i < 150; i += 1) {
      if (i === 70) {
        lines.push("2026-11-13T01:00:70Z DEBUG context-before-2");
      } else if (i === 71) {
        lines.push("2026-11-13T01:00:71Z DEBUG context-before-1");
      } else if (i === 72) {
        lines.push("2026-11-13T01:00:72Z ERROR connection refused on port 5432");
      } else if (i === 73) {
        lines.push("2026-11-13T01:00:73Z DEBUG context-after-1");
      } else if (i === 74) {
        lines.push("2026-11-13T01:00:74Z DEBUG context-after-2");
      } else {
        lines.push("2026-11-13T01:00:00Z INFO heartbeat poll completed successfully");
      }
    }
    const raw = lines.join("\n");
    const result = compressToolOutput({ text: raw, contentTypeHint: "logs", store });

    assert.equal(result.compressed, true);
    assert.equal(result.contentType, "logs");
    assert.include(result.text, "[x70]");
    assert.include(result.text, "2026-11-13T01:00:70Z DEBUG context-before-2");
    assert.include(result.text, "2026-11-13T01:00:71Z DEBUG context-before-1");
    assert.include(result.text, "2026-11-13T01:00:72Z ERROR connection refused on port 5432");
    assert.include(result.text, "2026-11-13T01:00:73Z DEBUG context-after-1");
    assert.include(result.text, "2026-11-13T01:00:74Z DEBUG context-after-2");
    assert.include(result.text, "[x75]");
  });

  it("applies DiffCompressor to collapse lockfiles while preserving source code hunks", () => {
    const store = createCcrStore();
    const lockHunk = [
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "index 1111111..2222222 100644",
      "--- a/pnpm-lock.yaml",
      "+++ b/pnpm-lock.yaml",
      "@@ -1,80 +1,80 @@",
      ...Array.from(
        { length: 80 },
        (_, i) => `+  pkg-${i}@1.0.${i}: { integrity: sha512-${"x".repeat(40)} }`,
      ),
    ].join("\n");
    const sourceHunk = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 3333333..4444444 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,3 +10,4 @@",
      " export function main() {",
      "-  return 1;",
      "+  return 2;",
      " }",
    ].join("\n");
    const raw = `${lockHunk}\n${sourceHunk}`;
    const result = compressToolOutput({ text: raw, store });

    assert.equal(result.compressed, true);
    assert.equal(result.contentType, "diff");
    assert.include(result.text, "generated/lockfile diff omitted for pnpm-lock.yaml");
    assert.include(result.text, "+  return 2;");
  });

  it("applies CodeCompressor to keep imports/declarations with line numbers and collapse long bodies", () => {
    const store = createCcrStore();
    const bodyLines = Array.from({ length: 60 }, (_, i) => `  const step${i} = ${i} * 2;`);
    const raw = [
      'import { Effect } from "effect";',
      "",
      "export interface DemoConfig {",
      "  readonly enabled: boolean;",
      "}",
      "",
      "export function computeHeavy(input: number): number {",
      ...bodyLines,
      "  return step59 + input;",
      "}",
      "",
      "export const runTask = Effect.fn(function* () {",
      ...bodyLines,
      "  return true;",
      "});",
    ].join("\n");

    const result = compressToolOutput({ text: raw, path: "src/heavy.ts", store });
    assert.equal(result.compressed, true);
    assert.equal(result.contentType, "code");
    assert.include(result.text, 'L1: import { Effect } from "effect";');
    assert.include(result.text, "L3: export interface DemoConfig {");
    assert.include(result.text, "L7: export function computeHeavy(input: number): number {");
    assert.include(result.text, "lines) omitted ...]");
    assert.include(result.text, "L71: export const runTask = Effect.fn(function* () {");
  });

  it("applies TextCrusher and supports compact mode without CCR footer for handoffs", () => {
    const store = createCcrStore();
    const repeatedPara =
      "This is a very repetitive boilerplate paragraph explaining standard status checks across environments.";
    const raw = [
      "# Execution Summary",
      "",
      repeatedPara,
      "",
      ...Array.from({ length: 40 }, () => repeatedPara),
      "",
      "CRITICAL: Final check failed with exit code 1.",
      "",
      "Conclusion: fix the broken import.",
    ].join("\n\n");

    const compact = compressToolOutput({
      text: raw,
      minChars: 1_200,
      includeFooter: false,
      store,
    });

    assert.equal(compact.compressed, true);
    assert.equal(compact.contentType, "text");
    assert.isUndefined(compact.ccrId);
    assert.notInclude(compact.text, "[T3 CCR:");
    assert.include(compact.text, "CRITICAL: Final check failed with exit code 1.");
    assert.equal(store.getStats().entriesCount, 0);
  });

  it("does not replace output when reduction is under 15%", () => {
    const store = createCcrStore();
    const allCriticalLogs = Array.from(
      { length: 60 },
      (_, i) => `2026-11-13T01:00:00Z ERROR critical check #${i}: ${"abcdefghij".repeat(4)}`,
    ).join("\n");
    const result = compressToolOutput({ text: allCriticalLogs, contentTypeHint: "logs", store });

    assert.equal(result.compressed, false);
    assert.equal(result.text, allCriticalLogs);
    assert.equal(store.getStats().entriesCount, 0);
  });
});
