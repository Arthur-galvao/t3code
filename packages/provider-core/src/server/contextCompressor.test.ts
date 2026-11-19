import { assert, describe, it } from "@effect/vitest";

import { createCcrStore } from "./ccrStore.ts";
import { compressToolOutput, detectContentType, stripAnsi } from "./contextCompressor.ts";

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

  it("forwards optional threadId to store.put and store.recordCompression", () => {
    const store = createCcrStore();
    const lines = Array.from({ length: 120 }, (_, i) => `2026-11-14T00:00:00Z INFO row ${i % 2}`);
    const result = compressToolOutput({
      text: lines.join("\n"),
      contentTypeHint: "logs",
      threadId: "thread-xyz",
      store,
    });

    assert.equal(result.compressed, true);
    assert.isDefined(result.ccrId);
    assert.equal(store.get(result.ccrId!)?.threadId, "thread-xyz");
    assert.equal(store.getStats("thread-xyz").entriesCount, 1);
    assert.equal(store.getStats("thread-xyz").compressedCallsCount, 1);
    assert.isAbove(store.getStats("thread-xyz").tokensSavedEst, 0);
    assert.equal(store.getStats("other-thread").entriesCount, 0);
  });

  it("strips ANSI and compacts vitest runner output while keeping failures and lossless CCR", () => {
    const store = createCcrStore();
    const esc = String.fromCharCode(0x1b);
    const passing = Array.from(
      { length: 65 },
      (_, i) => ` ${esc}[32m✓${esc}[39m src/feature_${i}.test.ts > case ${i} (3ms)`,
    );
    const raw = [
      `${esc}[1m RUN ${esc}[22m v4.0.0`,
      ...passing,
      ` ${esc}[31m×${esc}[39m src/broken.test.ts > fails cleanly`,
      `   ${esc}[31mAssertionError: expected 1 to equal 2${esc}[39m`,
      "     at src/broken.test.ts:42:10",
      "",
      " Test Files  1 failed | 65 passed (66)",
      "      Tests  1 failed | 65 passed (66)",
      "   Duration  1.84s",
    ].join("\n");

    const result = compressToolOutput({
      text: raw,
      command: "vp.cmd test run",
      store,
    });

    assert.equal(result.compressed, true);
    assert.equal(result.contentType, "logs");
    assert.notInclude(result.text, esc);
    assert.include(result.text, "passing test lines omitted");
    assert.include(result.text, "AssertionError: expected 1 to equal 2");
    assert.include(result.text, "Test Files  1 failed | 65 passed (66)");
    // Lossless original remains in CCR store.
    assert.equal(store.get(result.ccrId!)?.content, raw);
    assert.equal(stripAnsi(`${esc}[32mok${esc}[39m`), "ok");
  });

  it("compacts verbose tsc/linter diagnostics while preserving error locations and summary", () => {
    const store = createCcrStore();
    const diagnostics = Array.from({ length: 48 }, (_, i) => [
      `src/module_${i}.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`,
      "",
      "",
    ]).flat();
    const raw = [...diagnostics, "Found 48 errors in 48 files."].join("\n");

    const result = compressToolOutput({
      text: raw,
      command: "tsc --noEmit",
      store,
    });

    assert.equal(result.compressed, true);
    assert.include(result.text, "src/module_0.ts(1,5): error TS2322");
    assert.include(result.text, "diagnostics omitted");
    assert.include(result.text, "src/module_47.ts(48,5): error TS2322");
    assert.include(result.text, "Found 48 errors in 48 files.");
  });

  it("strips git status helper hints and caps oversized file lists", () => {
    const store = createCcrStore();
    const untracked = Array.from({ length: 95 }, (_, i) => `\tsrc/generated/file_${i}.ts`);
    const raw = [
      "On branch main",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      '  (use "git restore <file>..." to discard changes)',
      "\tmodified:   src/app.ts",
      "",
      "Untracked files:",
      '  (use "git add <file>..." to include in what will be committed)',
      ...untracked,
    ].join("\n");

    const result = compressToolOutput({
      text: raw,
      command: "git status",
      store,
    });

    assert.equal(result.compressed, true);
    assert.notInclude(result.text, '(use "git add');
    assert.include(result.text, "modified:   src/app.ts");
    assert.include(result.text, "more files in section");
    assert.notInclude(result.text, "file_94.ts");
  });

  it("strips pnpm install download churn and infers command from terminal sourceLabel", () => {
    const store = createCcrStore();
    const downloads = Array.from(
      { length: 70 },
      (_, i) => `Downloading registry.npmjs.org/pkg-${i}/-/${i}.tgz: 1.2 MB`,
    );
    const raw = [
      "Lockfile is up to date, resolution step is skipped",
      "Packages: +70",
      ...downloads,
      "WARN deprecated old-pkg@1.0.0: please upgrade",
      "dependencies:",
      "+ vite 6.0.0",
      "Done in 2.4s using pnpm v10.0.0",
    ].join("\n");

    const installResult = compressToolOutput({
      text: raw,
      command: "pnpm install",
      store,
    });
    assert.equal(installResult.compressed, true);
    assert.include(installResult.text, "build/install lines omitted");
    assert.include(installResult.text, "WARN deprecated old-pkg@1.0.0");
    assert.include(installResult.text, "Done in 2.4s using pnpm v10.0.0");

    // Also infer command from ACP terminal sourceLabel when `command` is omitted.
    const vitestRaw = [
      " RUN  v4.0.0",
      ...Array.from({ length: 65 }, (_, i) => ` ✓ src/a_${i}.test.ts > works (2ms)`),
      " Test Files  65 passed (65)",
      "      Tests  65 passed (65)",
    ].join("\n");
    const inferred = compressToolOutput({
      text: vitestRaw,
      sourceLabel: "terminal: vitest run",
      store,
    });
    assert.equal(inferred.compressed, true);
    assert.include(inferred.text, "passing test lines omitted");
  });
});
