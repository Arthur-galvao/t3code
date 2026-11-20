import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { createCcrStore, defaultCcrStore } from "@t3tools/provider-core/server/ccrStore";
import {
  MAX_LESSONS,
  RsiService,
  buildAutoLessonKey,
  makeRsiService,
  normalizeSignaturePart,
} from "./RsiService.ts";

describe("RsiService", () => {
  it.effect(
    "persists lessons.json and telemetry.jsonl under <stateDir>/rsi and reloads across layers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-persist-" });

        const configLayer = ServerConfig.layerTest(tempRoot, tempRoot);
        const serviceLayer = RsiService.makeLayer({ persistCcr: false }).pipe(
          Layer.provide(configLayer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const rsi = yield* RsiService;
          const lesson = yield* rsi.recordLesson({
            title: "Verify TypeScript imports before edit",
            guidance: "Check relative .ts extensions before writing imports.",
            rationaleTrace: "Avoids ERR_MODULE_NOT_FOUND under ESM.",
            triggerCondition: "provider=claude tool=edit",
            scope: "glob",
            globs: ["apps/server/src/**/*.ts"],
            confidence: 0.85,
          });
          expect(lesson.scope).toBe("glob");
          expect(lesson.globs).toEqual(["apps/server/src/**/*.ts"]);

          const telemetry = yield* rsi.recordRunTelemetry({
            threadId: "thread-1",
            runId: "run-1",
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
            usedTokens: 1200,
            cachedInputTokens: 900,
            toolErrorCount: 1,
            loopTripped: false,
            safetyBlockedCount: 0,
            wastedReads: 2,
            outcome: "completed",
            durationMs: 4200,
          });
          expect(telemetry.cacheHitRate).toBe(0.75);
        }).pipe(Effect.provide(serviceLayer));

        const stateDir = yield* Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          return cfg.stateDir;
        }).pipe(Effect.provide(configLayer));

        expect(yield* fs.exists(path.join(stateDir, "rsi", "lessons.json"))).toBe(true);
        expect(yield* fs.exists(path.join(stateDir, "rsi", "telemetry.jsonl"))).toBe(true);

        // Fresh layer instance reads persisted state from disk.
        yield* Effect.gen(function* () {
          const rsi = yield* RsiService;
          const lessons = yield* rsi.queryLessons({ cwd: tempRoot });
          expect(lessons).toHaveLength(1);
          expect(lessons[0]?.title).toBe("Verify TypeScript imports before edit");

          const summary = yield* rsi.getTelemetrySummary();
          expect(summary.totalRuns).toBe(1);
          expect(summary.successCount).toBe(1);
          expect(summary.totalWastedReads).toBe(2);
          expect(summary.avgCacheHitRate).toBe(0.75);
        }).pipe(Effect.provide(serviceLayer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keys auto-distilled lessons by normalized (provider, tool, errorSignature) without title collisions",
    () =>
      Effect.gen(function* () {
        const rsi = yield* RsiService;

        expect(normalizeSignaturePart("  Shell / Bash!!  ")).toBe("shell_bash");
        expect(
          buildAutoLessonKey({
            provider: "ClaudeAgent",
            tool: "Bash",
            errorSignature: "Permission Denied (13)",
          }),
        ).toBe("auto::claudeagent::bash::permission_denied_<n>");

        yield* rsi.recordRunTelemetry({
          threadId: "t-1",
          runId: "r-1",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 500,
          cachedInputTokens: 250,
          toolErrorCount: 1,
          loopTripped: true,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "failed",
          durationMs: 1000,
          cwd: "/repo",
          failureSignature: {
            tool: "Bash",
            errorSignature: "Command Timeout 30s",
            title: "Recurring failure",
            guidance: "Scope commands and pass shorter timeouts.",
          },
        });

        yield* rsi.recordRunTelemetry({
          threadId: "t-1",
          runId: "r-2",
          provider: "codex",
          model: "gpt-5",
          usedTokens: 600,
          cachedInputTokens: 300,
          toolErrorCount: 2,
          loopTripped: true,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "failed",
          durationMs: 1100,
          cwd: "/repo",
          failureSignature: {
            tool: "Write",
            errorSignature: "EACCES protected file",
            title: "Recurring failure",
            guidance: "Do not modify protected test fixtures directly.",
          },
        });

        // Repeat the first signature to confirm hit merge rather than duplication.
        yield* rsi.recordRunTelemetry({
          threadId: "t-1",
          runId: "r-3",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 700,
          cachedInputTokens: 500,
          toolErrorCount: 1,
          loopTripped: true,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "failed",
          durationMs: 900,
          cwd: "/repo",
          failureSignature: {
            tool: "Bash",
            errorSignature: "Command Timeout 30s",
            title: "Recurring failure",
            guidance: "Scope commands and pass shorter timeouts.",
          },
        });

        const lessons = yield* rsi.queryLessons();
        expect(lessons).toHaveLength(2);
        const claudeBash = lessons.find(
          (lesson) =>
            lesson.key ===
            buildAutoLessonKey({
              provider: "claudeAgent",
              tool: "Bash",
              errorSignature: "Command Timeout 30s",
            }),
        );
        const codexWrite = lessons.find(
          (lesson) =>
            lesson.key ===
            buildAutoLessonKey({
              provider: "codex",
              tool: "Write",
              errorSignature: "EACCES protected file",
            }),
        );
        expect(claudeBash).toBeDefined();
        expect(codexWrite).toBeDefined();
        expect(claudeBash?.hits).toBe(2);
        expect(claudeBash?.confidence ?? 0).toBeGreaterThan(codexWrite?.confidence ?? 0);

        // usedTokens is context size: three runs on one thread count once, by the latest run.
        const summary = yield* rsi.getTelemetrySummary();
        expect(summary.totalTokens).toBe(700);
        expect(summary.totalCachedInputTokens).toBe(500);
      }).pipe(Effect.provide(RsiService.layer)),
  );

  it.effect("enforces MAX_LESSONS = 25 with similarity merge and low-confidence pruning", () =>
    Effect.gen(function* () {
      const rsi = yield* RsiService;

      // Record 30 distinct lessons; lower confidence on the first 5 so they get pruned.
      for (let i = 0; i < 30; i += 1) {
        yield* TestClock.adjust("1 second");
        yield* rsi.recordLesson({
          key: `manual:item-${i}`,
          title: `Distinct rule ${i} alpha${i} beta${i}`,
          guidance: `Unique guidance number ${i} token-${i * 97}.`,
          confidence: i < 5 ? 0.2 : 0.75 + (i % 5) * 0.04,
        });
      }

      // Similar title+guidance should merge with an existing lesson instead of growing past MAX_LESSONS.
      const beforeMerge = yield* rsi.queryLessons({ limit: 50 });
      expect(beforeMerge).toHaveLength(MAX_LESSONS);

      const target = beforeMerge[0]!;
      const merged = yield* rsi.recordLesson({
        title: target.title,
        guidance: `${target.guidance}`,
        confidence: 0.9,
      });
      const afterMerge = yield* rsi.queryLessons({ limit: 50 });
      expect(afterMerge).toHaveLength(MAX_LESSONS);
      expect(merged.hits).toBeGreaterThanOrEqual(2);
      expect(afterMerge.some((lesson) => lesson.key === "manual:item-0")).toBe(false);
    }).pipe(Effect.provide(RsiService.layer)),
  );

  it.effect("formatSessionPrefix filters by globs and caps at maxChars (default 600)", () =>
    Effect.gen(function* () {
      const rsi = yield* RsiService;

      expect(yield* rsi.formatSessionPrefix({ cwd: "/repo" })).toBe("");

      yield* rsi.recordLesson({
        title: "Always run workspace vp.cmd",
        guidance: "Use ../../node_modules/.bin/vp.cmd inside packages.",
        scope: "global",
        confidence: 0.9,
      });
      yield* rsi.recordLesson({
        title: "Web CSS tokens rule",
        guidance: "Use existing Tailwind spacing helpers in apps/web.",
        scope: "glob",
        globs: ["apps/web/**"],
        confidence: 0.95,
      });
      yield* rsi.recordLesson({
        title: "Server Effect.fn rule",
        guidance: "Prefer Effect.fn for reusable server effects.",
        scope: "glob",
        globs: ["apps/server/src/**/*.ts"],
        confidence: 0.85,
      });

      const serverPrefix = yield* rsi.formatSessionPrefix({
        cwd: "/repo",
        activePaths: ["/repo/apps/server/src/orchestration-v2/RsiService.ts"],
        maxChars: 600,
      });
      expect(serverPrefix).toContain("[RSI Lessons]");
      expect(serverPrefix).toContain("Always run workspace vp.cmd");
      expect(serverPrefix).toContain("Server Effect.fn rule");
      expect(serverPrefix).not.toContain("Web CSS tokens rule");
      expect(serverPrefix.length).toBeLessThanOrEqual(600);

      const tightPrefix = yield* rsi.formatSessionPrefix({
        cwd: "/repo",
        activePaths: ["/repo/apps/server/src/orchestration-v2/RsiService.ts"],
        maxChars: 110,
      });
      expect(tightPrefix.length).toBeLessThanOrEqual(110);
      expect(tightPrefix).toContain("[RSI Lessons]");
    }).pipe(Effect.provide(RsiService.layer)),
  );

  it.effect("respects rsiAutoDistillEnabled = false while still recording telemetry", () =>
    Effect.gen(function* () {
      const disabledSettingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({
          rsiAutoDistillEnabled: false,
        } as unknown as Effect.Success<
          ServerSettings.ServerSettingsService["Service"]["getSettings"]
        >),
      } as unknown as ServerSettings.ServerSettingsService["Service"]);

      const layer = RsiService.layer.pipe(Layer.provide(disabledSettingsLayer));

      yield* Effect.gen(function* () {
        const rsi = yield* RsiService;
        yield* rsi.recordRunTelemetry({
          threadId: "t-disabled",
          runId: "r-disabled",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 100,
          cachedInputTokens: 0,
          toolErrorCount: 3,
          loopTripped: true,
          safetyBlockedCount: 1,
          wastedReads: 4,
          outcome: "failed",
          durationMs: 800,
          failureSignature: {
            tool: "Edit",
            errorSignature: "duplicate-read-loop",
          },
        });

        expect(yield* rsi.queryLessons()).toHaveLength(0);
        const summary = yield* rsi.getTelemetrySummary();
        expect(summary.totalRuns).toBe(1);
        expect(summary.loopTrips).toBe(1);
        expect(summary.safetyBlocks).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "records explicit compression savings and syncs live CCR store stats without double-counting",
    () =>
      Effect.gen(function* () {
        const store = createCcrStore();
        const rsi = yield* makeRsiService({ ccrStore: store });

        // 1. Live unsynced CCR savings show up immediately in getTelemetrySummary.
        store.recordCompression(5_000, 1_000); // 4_000 saved chars => 1_000 tokensSavedEst, 1 call
        const preRunSummary = yield* rsi.getTelemetrySummary();
        expect(preRunSummary.totalRuns).toBe(0);
        expect(preRunSummary.totalTokensSavedEst).toBe(1_000);
        expect(preRunSummary.totalCompressedCalls).toBe(1);

        // 2. recordRunTelemetry without explicit metrics flushes the CCR delta into the run record.
        const firstRun = yield* rsi.recordRunTelemetry({
          threadId: "t-ccr",
          runId: "r-ccr-1",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 2_000,
          cachedInputTokens: 1_000,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 1_200,
        });
        expect(firstRun.tokensSavedEst).toBe(1_000);
        expect(firstRun.compressedCallsCount).toBe(1);

        const afterFirstRun = yield* rsi.getTelemetrySummary();
        expect(afterFirstRun.totalTokensSavedEst).toBe(1_000);
        expect(afterFirstRun.totalCompressedCalls).toBe(1);

        // 3. Subsequent CCR compression only adds the new delta, and explicit overrides work too.
        store.recordCompression(2_400, 400); // +2_000 saved chars => +500 tokens, +1 call
        const midRunSummary = yield* rsi.getTelemetrySummary();
        expect(midRunSummary.totalTokensSavedEst).toBe(1_500);
        expect(midRunSummary.totalCompressedCalls).toBe(2);

        const explicitRun = yield* rsi.recordRunTelemetry({
          threadId: "t-other",
          runId: "r-explicit",
          provider: "antigravity",
          model: "gemini",
          usedTokens: 1_500,
          cachedInputTokens: 500,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 900,
          tokensSavedEst: 250,
          compressedCallsCount: 2,
        });
        expect(explicitRun.tokensSavedEst).toBe(250);
        expect(explicitRun.compressedCallsCount).toBe(2);

        // Filtered summary uses recorded run metrics only (does not mix global unsynced CCR stats).
        const filteredSummary = yield* rsi.getTelemetrySummary({ threadId: "t-other" });
        expect(filteredSummary.totalTokensSavedEst).toBe(250);
        expect(filteredSummary.totalCompressedCalls).toBe(2);

        // Global summary combines recorded runs (1000 + 250) + unsynced CCR delta (500), calls (1 + 2 + 1).
        const globalSummary = yield* rsi.getTelemetrySummary();
        expect(globalSummary.totalTokensSavedEst).toBe(1_750);
        expect(globalSummary.totalCompressedCalls).toBe(4);
      }),
  );

  it.effect(
    "attributes thread-scoped CCR savings per thread even when concurrent runs finalize out of order",
    () =>
      Effect.gen(function* () {
        const store = createCcrStore();
        const rsi = yield* makeRsiService({ ccrStore: store });

        store.recordCompression(5_000, 1_000, "thread-a"); // 4_000 saved chars => 1_000 tokens, 1 call
        store.recordCompression(9_000, 1_000, "thread-b"); // 8_000 saved chars => 2_000 tokens, 1 call

        const preThreadASummary = yield* rsi.getTelemetrySummary({ threadId: "thread-a" });
        expect(preThreadASummary.totalTokensSavedEst).toBe(1_000);
        expect(preThreadASummary.totalCompressedCalls).toBe(1);

        const runB = yield* rsi.recordRunTelemetry({
          threadId: "thread-b",
          runId: "run-b-1",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 3_000,
          cachedInputTokens: 1_500,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 1_000,
        });
        expect(runB.tokensSavedEst).toBe(2_000);
        expect(runB.compressedCallsCount).toBe(1);

        // thread-a still retains its own unsynced delta after thread-b finalized.
        const midThreadASummary = yield* rsi.getTelemetrySummary({ threadId: "thread-a" });
        expect(midThreadASummary.totalTokensSavedEst).toBe(1_000);
        expect(midThreadASummary.totalCompressedCalls).toBe(1);

        const runA = yield* rsi.recordRunTelemetry({
          threadId: "thread-a",
          runId: "run-a-1",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 2_000,
          cachedInputTokens: 1_000,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 900,
        });
        expect(runA.tokensSavedEst).toBe(1_000);
        expect(runA.compressedCallsCount).toBe(1);

        const globalSummary = yield* rsi.getTelemetrySummary();
        expect(globalSummary.totalTokensSavedEst).toBe(3_000);
        expect(globalSummary.totalCompressedCalls).toBe(2);
      }),
  );

  it.effect("reads defaultCcrStore.getStats() by default in RsiService.layer", () =>
    Effect.gen(function* () {
      defaultCcrStore.clear();
      yield* Effect.ensuring(
        Effect.gen(function* () {
          defaultCcrStore.recordCompression(4_000, 800); // 3_200 saved chars => 800 tokens
          const rsi = yield* RsiService;
          const summary = yield* rsi.getTelemetrySummary();
          expect(summary.totalTokensSavedEst).toBe(800);
          expect(summary.totalCompressedCalls).toBe(1);
        }).pipe(Effect.provide(RsiService.layer)),
        Effect.sync(() => defaultCcrStore.clear()),
      );
    }),
  );

  it.effect(
    "demoteLesson and deleteLesson update confidence, enforce floor, and remove entries",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();
        const first = yield* rsi.recordLesson({
          key: "manual:demote-target",
          title: "Demote Target",
          guidance: "Verify before running.",
          confidence: 0.35,
        });
        const second = yield* rsi.recordLesson({
          key: "manual:delete-target",
          title: "Delete Target",
          guidance: "Obsolete rule.",
          confidence: 0.8,
        });

        const missingDemote = yield* rsi.demoteLesson({ id: "nonexistent" });
        expect(missingDemote).toEqual({ demoted: false, removed: false, lesson: null });

        const stepped = yield* rsi.demoteLesson({ id: first.id, delta: 0.15 });
        expect(stepped.demoted).toBe(true);
        expect(stepped.removed).toBe(false);
        expect(stepped.lesson?.confidence).toBe(0.2);

        const dropped = yield* rsi.demoteLesson({ id: first.id });
        expect(dropped).toEqual({ demoted: true, removed: true, lesson: null });
        expect((yield* rsi.queryLessons()).some((lesson) => lesson.id === first.id)).toBe(false);

        const deletedByKey = yield* rsi.deleteLesson({ id: second.key });
        expect(deletedByKey).toEqual({ deleted: true });
        expect(yield* rsi.deleteLesson({ id: second.key })).toEqual({ deleted: false });
        expect(yield* rsi.queryLessons()).toHaveLength(0);
      }),
  );

  it.effect(
    "Evaluate->Retain boosts only related applied lessons on clean success and demotes/prunes on failures",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();
        const strong = yield* rsi.recordLesson({
          key: "manual:strong-lesson",
          title: "Check workspace types",
          guidance: "Run `vp typecheck` after editing.",
          confidence: 0.8,
        });
        const unrelated = yield* rsi.recordLesson({
          key: "manual:unrelated-lesson",
          title: "Keep PR diffs small",
          guidance: "Prefer small targeted diffs.",
          confidence: 0.7,
        });
        const fragile = yield* rsi.recordLesson({
          key: "manual:fragile-lesson",
          title: "Fragile rule",
          guidance: "Old assumption.",
          confidence: 0.2,
        });

        const formatted = yield* rsi.formatSessionPrefixWithMetadata({
          cwd: "/repo",
          threadId: "t-eval",
          runId: "r-eval-1",
          provider: "codex",
        });
        expect(formatted.prefix).toContain("Check workspace types");
        expect(formatted.lessonIds).toContain(strong.id);
        expect(formatted.lessonIds).toContain(unrelated.id);
        expect(formatted.lessonIds).not.toContain(fragile.id);

        // Clean success on r-eval-1 boosts only strong (matching verifiedCommands), leaving unrelated untouched.
        yield* rsi.recordRunTelemetry({
          threadId: "t-eval",
          runId: "r-eval-1",
          provider: "codex",
          model: "gpt-5",
          usedTokens: 1_000,
          cachedInputTokens: 600,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 500,
          verifiedCommands: ["vp typecheck"],
        });

        const afterSuccess = yield* rsi.queryLessons();
        const boosted = afterSuccess.find((lesson) => lesson.id === strong.id);
        const untouched = afterSuccess.find((lesson) => lesson.id === unrelated.id);
        expect(boosted?.confidence).toBe(0.85);
        expect(boosted?.hits).toBe(2);
        expect(untouched?.confidence).toBe(0.7);
        expect(untouched?.hits).toBe(1);

        // Failure with explicit appliedLessonIds demotes strong and auto-removes fragile (< 0.15).
        yield* rsi.recordRunTelemetry({
          threadId: "t-eval",
          runId: "r-eval-2",
          provider: "codex",
          model: "gpt-5",
          usedTokens: 900,
          cachedInputTokens: 100,
          toolErrorCount: 0,
          loopTripped: true,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "failed",
          durationMs: 700,
          appliedLessonIds: [strong.id, fragile.id],
        });

        const afterFailure = yield* rsi.queryLessons();
        expect(afterFailure.find((lesson) => lesson.id === strong.id)?.confidence).toBe(0.75);
        expect(afterFailure.some((lesson) => lesson.id === fragile.id)).toBe(false);
      }),
  );

  it.effect(
    "distills concise workspace checks & recovery lessons post-success without duplicating",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();

        yield* rsi.recordRunTelemetry({
          threadId: "t-distill",
          runId: "r-distill-1",
          provider: "codex",
          model: "gpt-5",
          usedTokens: 1_500,
          cachedInputTokens: 800,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 1_100,
          cwd: "/repo",
          editedFiles: ["apps/server/src/ws.ts"],
          verifiedCommands: ["pnpm test apps/server/src/ws.test.ts"],
        });

        // Repeating the same verified command merges instead of creating duplicates.
        yield* rsi.recordRunTelemetry({
          threadId: "t-distill",
          runId: "r-distill-2",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 1_200,
          cachedInputTokens: 600,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "success",
          durationMs: 900,
          cwd: "/repo",
          editedFiles: ["apps/server/src/auth/RpcAuthorization.ts"],
          verifiedCommands: ["pnpm test apps/server/src/ws.test.ts"],
        });

        // Recovery after toolErrorCount > 0 with verified check distills a recovery lesson.
        yield* rsi.recordRunTelemetry({
          threadId: "t-distill",
          runId: "r-distill-3",
          provider: "codex",
          model: "gpt-5",
          usedTokens: 1_300,
          cachedInputTokens: 500,
          toolErrorCount: 2,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 1_000,
          cwd: "/repo",
          editedFiles: ["apps/server/src/server.ts"],
          verifiedCommands: ["pnpm typecheck"],
        });

        const lessons = yield* rsi.queryLessons();
        const wsVerifyLessons = lessons.filter(
          (lesson) => lesson.title === "Verify edits with pnpm test",
        );
        expect(wsVerifyLessons).toHaveLength(1);
        expect(wsVerifyLessons[0]?.title.length).toBeLessThan(60);
        expect(wsVerifyLessons[0]?.hits).toBeGreaterThanOrEqual(2);
        expect(lessons.some((lesson) => lesson.key.includes("::recovery::"))).toBe(true);
      }),
  );

  it.effect("persists and restores CCR store snapshot when persistCcr is enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-ccr-" });
      const rsiDir = path.join(tempRoot, "rsi");
      const persistence = {
        fs,
        path,
        rsiDir,
        lessonsPath: path.join(rsiDir, "lessons.json"),
        telemetryPath: path.join(rsiDir, "telemetry.jsonl"),
      };

      const storeA = createCcrStore();
      yield* makeRsiService({ persistence, ccrStore: storeA, persistCcr: true });
      storeA.put({
        threadId: "t-ccr-persist",
        content: "line1\nline2\nline3\n",
        contentType: "command",
        sourceLabel: "test",
      });
      storeA.recordCompression(2_000, 400);
      storeA.flush();

      const ccrPath = path.join(rsiDir, "ccr-cache.json");
      expect(yield* fs.exists(ccrPath)).toBe(true);

      const storeB = createCcrStore();
      const rsiB = yield* makeRsiService({ persistence, ccrStore: storeB, persistCcr: true });
      const summary = yield* rsiB.getTelemetrySummary();
      expect(summary.totalTokensSavedEst).toBe(400);
      expect(summary.totalCompressedCalls).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "mirrors RSI lessons into Obsidian T3-Brain vault with MOC index and respects vault settings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-obsidian-" });
        const customVaultRoot = path.join(tempRoot, "my-obsidian-vault");
        const stateDir = path.join(tempRoot, "state");

        const configLayer = ServerConfig.layerTest(stateDir, stateDir);
        const enabledSettingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            rsiAutoDistillEnabled: true,
            obsidianMemorySyncEnabled: true,
            obsidianVaultPath: customVaultRoot,
          } as unknown as Effect.Success<
            ServerSettings.ServerSettingsService["Service"]["getSettings"]
          >),
        } as unknown as ServerSettings.ServerSettingsService["Service"]);

        const serviceLayer = RsiService.makeLayer({ persistCcr: false }).pipe(
          Layer.provide(configLayer),
          Layer.provide(enabledSettingsLayer),
          Layer.provide(NodeServices.layer),
        );

        let recordedId = "";
        yield* Effect.gen(function* () {
          const rsi = yield* RsiService;
          const globalLesson = yield* rsi.recordLesson({
            key: "manual:obsidian-global",
            title: "Use Base UI primitives",
            guidance: "Do not pass override classes via className to ui primitives.",
            triggerCondition: "touching apps/web/src/components/**",
            rationaleTrace: "Prevents shadcn/no-restyle oxlint failures.",
            scope: "global",
            confidence: 0.9,
          });
          const scopedLesson = yield* rsi.recordLesson({
            key: "manual:obsidian-scoped",
            title: "Use Effect.fn in server",
            guidance: "Wrap reusable Effect functions with Effect.fn.",
            scope: "glob",
            globs: ["apps/server/src/**/*.ts"],
            confidence: 0.8,
          });
          recordedId = globalLesson.id;

          const brainDir = path.join(customVaultRoot, "T3-Brain");
          const mocPath = path.join(brainDir, "00-MOC-Memory.md");
          const globalNotePath = path.join(brainDir, "Lessons", `${globalLesson.id}.md`);
          const scopedNotePath = path.join(brainDir, "Lessons", `${scopedLesson.id}.md`);

          expect(yield* fs.exists(mocPath)).toBe(true);
          expect(yield* fs.exists(globalNotePath)).toBe(true);
          expect(yield* fs.exists(scopedNotePath)).toBe(true);

          const mocContent = yield* fs.readFileString(mocPath);
          expect(mocContent).toContain("totalLessons: 2");
          expect(mocContent).toContain(`[[Lessons/${globalLesson.id}|Use Base UI primitives]]`);
          expect(mocContent).toContain(`[[Lessons/${scopedLesson.id}|Use Effect.fn in server]]`);
          expect(mocContent).toContain("## Global Lessons (1)");
          expect(mocContent).toContain("## Scoped (Glob) Lessons (1)");

          const noteContent = yield* fs.readFileString(globalNotePath);
          expect(noteContent).toContain("[[00-MOC-Memory]]");
          expect(noteContent).toContain("## Guidance");
          expect(noteContent).toContain("## Trigger Condition");
          expect(noteContent).toContain("## Rationale Trace");

          const deleted = yield* rsi.deleteLesson({ id: globalLesson.id });
          expect(deleted).toEqual({ deleted: true });
          expect(yield* fs.exists(globalNotePath)).toBe(false);
          expect(yield* fs.exists(scopedNotePath)).toBe(true);

          const updatedMoc = yield* fs.readFileString(mocPath);
          expect(updatedMoc).toContain("totalLessons: 1");
          expect(updatedMoc).not.toContain(`[[Lessons/${recordedId}|`);
        }).pipe(Effect.provide(serviceLayer));

        // Disabled obsidianMemorySyncEnabled skips syncing into a separate vault directory.
        const disabledVaultRoot = path.join(tempRoot, "disabled-vault");
        const disabledStateDir = path.join(tempRoot, "disabled-state");
        const disabledLayer = RsiService.makeLayer({ persistCcr: false }).pipe(
          Layer.provide(ServerConfig.layerTest(disabledStateDir, disabledStateDir)),
          Layer.provide(
            Layer.succeed(ServerSettings.ServerSettingsService, {
              getSettings: Effect.succeed({
                rsiAutoDistillEnabled: true,
                obsidianMemorySyncEnabled: false,
                obsidianVaultPath: disabledVaultRoot,
              } as unknown as Effect.Success<
                ServerSettings.ServerSettingsService["Service"]["getSettings"]
              >),
            } as unknown as ServerSettings.ServerSettingsService["Service"]),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const rsi = yield* RsiService;
          yield* rsi.recordLesson({
            title: "Should stay out of disabled vault",
            guidance: "Vault sync is disabled.",
          });
        }).pipe(Effect.provide(disabledLayer));

        expect(yield* fs.exists(path.join(disabledVaultRoot, "T3-Brain"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "imports user-created and user-edited Obsidian Lessons notes bidirectionally into lessons.json",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-bidi-" });
        const customVaultRoot = path.join(tempRoot, "vault");
        const brainLessonsDir = path.join(customVaultRoot, "T3-Brain", "Lessons");
        const stateDir = path.join(tempRoot, "state");

        yield* fs.makeDirectory(brainLessonsDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(brainLessonsDir, "custom-obsidian-rule.md"),
          [
            "---",
            'id: "obsidian_custom_rule"',
            'key: "obsidian::custom_rule"',
            'title: "Prefer bounded line reads"',
            "scope: glob",
            "confidence: 0.88",
            "hits: 2",
            'globs: ["apps/server/src/**/*.ts"]',
            'createdAt: "2026-11-14T10:00:00.000Z"',
            'updatedAt: "2026-11-14T10:00:00.000Z"',
            "---",
            "",
            "# Prefer bounded line reads",
            "",
            "## Guidance",
            "",
            "Search symbols first and read bounded StartLine/EndLine slices.",
            "",
            "## Trigger Condition",
            "",
            "Reading large TypeScript server modules",
            "",
          ].join("\n"),
        );

        const configLayer = ServerConfig.layerTest(stateDir, stateDir);
        const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            rsiAutoDistillEnabled: true,
            obsidianMemorySyncEnabled: true,
            obsidianVaultPath: customVaultRoot,
          } as unknown as Effect.Success<
            ServerSettings.ServerSettingsService["Service"]["getSettings"]
          >),
        } as unknown as ServerSettings.ServerSettingsService["Service"]);

        const serviceLayer = RsiService.makeLayer({ persistCcr: false }).pipe(
          Layer.provide(configLayer),
          Layer.provide(settingsLayer),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const rsi = yield* RsiService;
          const initialLessons = yield* rsi.queryLessons();
          expect(initialLessons).toHaveLength(1);
          expect(initialLessons[0]?.title).toBe("Prefer bounded line reads");
          expect(initialLessons[0]?.scope).toBe("glob");

          // Edit the canonical mirrored markdown note in Obsidian with a new guidance + later timestamp.
          yield* fs.writeFileString(
            path.join(brainLessonsDir, "obsidian_custom_rule.md"),
            [
              "---",
              'id: "obsidian_custom_rule"',
              'key: "obsidian::custom_rule"',
              'title: "Prefer bounded line reads"',
              "scope: glob",
              "confidence: 0.92",
              "hits: 3",
              'globs: ["apps/server/src/**/*.ts"]',
              'createdAt: "2026-11-14T10:00:00.000Z"',
              'updatedAt: "2026-11-14T12:00:00.000Z"',
              "---",
              "",
              "## Guidance",
              "",
              "Use PowerShell Select-String first and read under 150 lines per call.",
              "",
            ].join("\n"),
          );

          // In-session queryLessons does NOT re-import Obsidian markdown files.
          const midSessionLessons = yield* rsi.queryLessons();
          expect(midSessionLessons[0]?.guidance).toBe(
            "Search symbols first and read bounded StartLine/EndLine slices.",
          );
        }).pipe(Effect.provide(serviceLayer));

        // Fresh service startup/hydrate imports the edited Obsidian note into lessons.json.
        yield* Effect.gen(function* () {
          const rsi = yield* RsiService;
          const updatedLessons = yield* rsi.queryLessons();
          expect(updatedLessons[0]?.guidance).toBe(
            "Use PowerShell Select-String first and read under 150 lines per call.",
          );
          expect(updatedLessons[0]?.confidence).toBe(0.92);
        }).pipe(Effect.provide(serviceLayer));

        const resolvedStateDir = yield* Effect.gen(function* () {
          const cfg = yield* ServerConfig.ServerConfig;
          return cfg.stateDir;
        }).pipe(Effect.provide(configLayer));
        const lessonsJson = yield* fs.readFileString(
          path.join(resolvedStateDir, "rsi", "lessons.json"),
        );
        expect(lessonsJson).toContain(
          "Use PowerShell Select-String first and read under 150 lines per call.",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "auto-distills token-economy lesson when wastedReads >= 3 and injects Auto-Spec for Portuguese/broad userPrompt",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();

        // No cwd: telemetry is kept but no unscoped lesson is distilled.
        yield* rsi.recordRunTelemetry({
          threadId: "t-no-cwd",
          runId: "r-no-cwd",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 4_000,
          cachedInputTokens: 2_000,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 4,
          outcome: "completed",
          durationMs: 1_500,
        });
        expect(yield* rsi.queryLessons()).toHaveLength(0);
        expect((yield* rsi.getTelemetrySummary()).totalRuns).toBe(1);

        yield* rsi.recordRunTelemetry({
          threadId: "t-token",
          runId: "r-token-1",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 4_000,
          cachedInputTokens: 2_000,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 4,
          outcome: "completed",
          durationMs: 1_500,
          cwd: "/repo",
        });

        const lessons = yield* rsi.queryLessons();
        expect(lessons.some((l) => l.key === "auto::claudeagent::read_file::wasted_reads")).toBe(
          true,
        );

        const formatted = yield* rsi.formatSessionPrefixWithMetadata({
          cwd: "/repo",
          provider: "claudeAgent",
          userPrompt: "melhorar a economia de token e criar novo painel na tela",
          maxChars: 800,
        });
        expect(formatted.prefix).toContain("[RSI Lessons]");
        expect(formatted.prefix).toContain("Avoid repeated full-file reads");
        expect(formatted.prefix).toContain("[Auto-Spec]");
        expect(formatted.prefix).toContain("ask 1-3 brief clarifying questions");
      }),
  );

  it.effect(
    "scopes auto-distilled lessons to projectRoot case/separator-insensitively and drops legacy global auto lessons on load",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-project-scope-" });
        const rsiDir = path.join(tempRoot, "rsi");
        const lessonsPath = path.join(rsiDir, "lessons.json");
        yield* fs.makeDirectory(rsiDir, { recursive: true });
        yield* fs.writeFileString(
          lessonsPath,
          JSON.stringify({
            version: 1,
            maxLessons: MAX_LESSONS,
            lessons: [
              {
                id: "rsi_lesson_auto_legacy_global_1",
                key: "auto::global::verify::legacy",
                title: "Legacy unscoped auto lesson",
                guidance: "Should be dropped on load.",
                rationaleTrace: "Auto-distilled from run r-old (outcome=failed).",
                triggerCondition: "",
                scope: "global",
                globs: [],
                confidence: 0.9,
                hits: 12,
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
              },
              {
                // Manual lesson recorded with `tool` gets an auto:: key and id; it must survive.
                id: "rsi_lesson_auto_global_git_manual_1",
                key: "auto::global::git::manual_rule",
                title: "Manual git rule",
                guidance: "Keep manual git rules.",
                rationaleTrace: "",
                triggerCondition: "",
                scope: "global",
                globs: [],
                confidence: 0.9,
                hits: 1,
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
              },
              {
                id: "rsi_lesson_manual_posix_1",
                key: "manual::posix_scoped",
                title: "POSIX scoped rule",
                guidance: "Case-sensitive project root.",
                rationaleTrace: "",
                triggerCondition: "",
                scope: "global",
                globs: [],
                projectRoot: "/Srv/App",
                confidence: 0.9,
                hits: 1,
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
              },
              {
                id: "rsi_lesson_manual_global_1",
                key: "manual::keep_me",
                title: "Manual global rule",
                guidance: "Keep manual global rules.",
                rationaleTrace: "",
                triggerCondition: "",
                scope: "global",
                globs: [],
                confidence: 0.9,
                hits: 1,
                createdAt: "2026-11-01T00:00:00.000Z",
                updatedAt: "2026-11-01T00:00:00.000Z",
              },
            ],
          }),
        );

        const rsi = yield* makeRsiService({
          persistence: {
            fs,
            path,
            rsiDir,
            lessonsPath,
            telemetryPath: path.join(rsiDir, "telemetry.jsonl"),
          },
        });

        const loaded = yield* rsi.queryLessons();
        expect(loaded.some((l) => l.id === "rsi_lesson_auto_legacy_global_1")).toBe(false);
        expect(loaded.some((l) => l.id === "rsi_lesson_manual_global_1")).toBe(true);
        expect(loaded.some((l) => l.id === "rsi_lesson_auto_global_git_manual_1")).toBe(true);

        const idsFor = (cwd: string | null) =>
          rsi.queryLessons({ cwd }).pipe(Effect.map((rows) => rows.map((l) => l.id)));
        expect(yield* idsFor("/Srv/App/sub")).toContain("rsi_lesson_manual_posix_1");
        expect(yield* idsFor("/srv/app")).not.toContain("rsi_lesson_manual_posix_1");
        expect(yield* idsFor(null)).not.toContain("rsi_lesson_manual_posix_1");

        yield* rsi.recordRunTelemetry({
          threadId: "t-proj-a",
          runId: "r-proj-a",
          provider: "codex",
          model: "gpt-5",
          usedTokens: 500,
          cachedInputTokens: 200,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 500,
          cwd: "C:\\Users\\Arthur\\Documents\\ProjA",
          editedFiles: ["src/index.ts"],
          verifiedCommands: ["vp test run src/index.test.ts"],
        });

        const projAInside = yield* rsi.formatSessionPrefix({
          cwd: "c:/users/arthur/documents/proja/apps/server",
          provider: "codex",
        });
        expect(projAInside).toContain("Verify edits with vp test run");
        expect(projAInside).toContain("Manual global rule");

        const projB = yield* rsi.formatSessionPrefix({
          cwd: "C:\\Users\\Arthur\\Documents\\ProjA-Other",
          provider: "codex",
        });
        expect(projB).not.toContain("Verify edits with vp test run");
        expect(projB).toContain("Manual global rule");

        const verifyId = (yield* rsi.queryLessons()).find((l) =>
          l.title.startsWith("Verify edits"),
        )!.id;
        for (const cwd of [
          "/c/Users/Arthur/Documents/ProjA",
          "\\\\?\\C:\\Users\\Arthur\\Documents\\ProjA\\src",
          "c:/users/arthur/documents/proja/",
        ]) {
          expect(yield* idsFor(cwd)).toContain(verifyId);
        }
        expect(yield* idsFor("C:\\Users\\Arthur\\Documents\\ProjA-Other")).not.toContain(verifyId);
        expect(yield* idsFor(null)).not.toContain(verifyId);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "normalizes verified commands without mid-command truncation or duplicates and caps titles under 60 chars",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();
        yield* rsi.recordRunTelemetry({
          threadId: "t-cmd-norm",
          runId: "r-cmd-norm",
          provider: "claudeAgent",
          model: "sonnet",
          usedTokens: 500,
          cachedInputTokens: 200,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 400,
          cwd: "/repo",
          editedFiles: ["src/a.ts", "src/b.ts"],
          verifiedCommands: [
            "cd /c/Users/Arthur/Documents/t3code/apps/server; timeout 200 ../../node_modules/.bin/vp.cmd test run src/provider/CodeA.test.ts 2>&1 | tail -n 20",
            "cd /c/Users/Arthur/Documents/t3code/apps/server && timeout 200 ../../node_modules/.bin/vp.cmd test run src/provider/CodeB.test.ts",
            "cd /c/Users/Arthur/Documents/t3code; timeout 110 vp lint apps/web/src/components/LiquidGlassAsciiBackdrop.tsx",
            `vp run ${"very-long-subcommand-flag-".repeat(5)}check`,
          ],
        });

        const lessons = yield* rsi.queryLessons();
        expect(lessons).toHaveLength(1);
        const lesson = lessons[0]!;
        expect(lesson.title).toBe("Verify edits with vp test run");
        expect(lesson.title.length).toBeLessThan(60);
        expect(lesson.guidance).toBe(
          "Run `../../node_modules/.bin/vp.cmd test run` and `vp lint` to verify source edits before finishing.",
        );
        expect(lesson.guidance).not.toContain("timeout");
        expect(lesson.guidance).not.toContain("cd ");
        expect(lesson.guidance).not.toContain("very-long-subcommand");
      }),
  );

  it.effect("does not re-boost lessons on subsequent thread runs that had no injection", () =>
    Effect.gen(function* () {
      const rsi = yield* makeRsiService();
      const lesson = yield* rsi.recordLesson({
        title: "Run targeted tests",
        guidance: "Run `vp test run` after editing.",
        scope: "global",
        confidence: 0.7,
      });

      yield* rsi.formatSessionPrefixWithMetadata({
        cwd: "/repo",
        threadId: "t-no-fallback",
        runId: "r-injected",
        provider: "codex",
      });

      // Second run in same thread/provider had NO formatSessionPrefix call.
      const secondIds = yield* rsi.getAppliedLessonIds({
        threadId: "t-no-fallback",
        runId: "r-not-injected",
        provider: "codex",
      });
      expect(secondIds).toEqual([]);

      yield* rsi.recordRunTelemetry({
        threadId: "t-no-fallback",
        runId: "r-not-injected",
        provider: "codex",
        model: "gpt-5",
        usedTokens: 400,
        cachedInputTokens: 200,
        toolErrorCount: 0,
        loopTripped: false,
        safetyBlockedCount: 0,
        wastedReads: 0,
        outcome: "completed",
        durationMs: 300,
        editedFiles: ["src/a.ts"],
        verifiedCommands: ["vp test run src/a.test.ts"],
      });

      const unchanged = (yield* rsi.queryLessons()).find((l) => l.id === lesson.id);
      expect(unchanged?.hits).toBe(1);
      expect(unchanged?.confidence).toBe(0.7);
    }),
  );

  it.effect("takes both title and guidance from the newer lesson on merge", () =>
    Effect.gen(function* () {
      const rsi = yield* makeRsiService();
      yield* rsi.recordLesson({
        key: "manual::merge_pair",
        title: "Old very long title that used to win length comparison",
        guidance: "Old short guidance.",
        confidence: 0.7,
      });
      yield* TestClock.adjust("5 seconds");
      const merged = yield* rsi.recordLesson({
        key: "manual::merge_pair",
        title: "Concise new title",
        guidance: "Newer guidance that belongs with the concise new title.",
        confidence: 0.75,
      });
      expect(merged.title).toBe("Concise new title");
      expect(merged.guidance).toBe("Newer guidance that belongs with the concise new title.");
      expect(merged.hits).toBe(2);
    }),
  );

  it.effect(
    "decays stale lessons over time and evicts them before fresher equal-confidence lessons",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();
        const stale = yield* rsi.recordLesson({
          key: "auto::codex::stale::check",
          title: "Stale workspace rule",
          guidance: "Run `vp check` carefully.",
          confidence: 0.75,
          hits: 2,
          scope: "global",
        });

        yield* TestClock.adjust("31 days");

        const fresh = yield* rsi.recordLesson({
          key: "auto::codex::fresh::check",
          title: "Fresh workspace rule",
          guidance: "Run `vp test` carefully.",
          confidence: 0.75,
          hits: 2,
          scope: "global",
        });

        const ranked = yield* rsi.queryLessons();
        expect(ranked[0]?.id).toBe(fresh.id);
        expect(ranked[1]?.id).toBe(stale.id);

        for (let i = 0; i < 24; i += 1) {
          yield* rsi.recordLesson({
            key: `auto::codex::fill_${i}::sig_${i}`,
            title: `Fresh filler ${i}`,
            guidance: `Execute filler command ${i}.`,
            confidence: 0.75,
            hits: 2,
            scope: "global",
          });
        }

        const atCapacity = yield* rsi.queryLessons();
        expect(atCapacity.length).toBe(25);
        expect(atCapacity.some((lesson) => lesson.id === stale.id)).toBe(false);
        expect(atCapacity.some((lesson) => lesson.id === fresh.id)).toBe(true);
      }),
  );

  it.effect(
    "distills command recovery pair when a failed tool is replaced by a passing variant, never same-for-same",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();
        yield* rsi.recordRunTelemetry({
          threadId: "t-pair",
          runId: "r-pair-diff",
          provider: "codex",
          model: "gpt-5",
          cwd: "/repo/t3code",
          usedTokens: 500,
          cachedInputTokens: 100,
          toolErrorCount: 1,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 400,
          recoveredCommandPair: {
            failedCommand: "vp test run src/a.test.ts",
            succeededCommand: "../../node_modules/.bin/vp.cmd test run src/b.test.ts",
          },
        });

        yield* rsi.recordRunTelemetry({
          threadId: "t-pair",
          runId: "r-pair-same",
          provider: "codex",
          model: "gpt-5",
          cwd: "/repo/t3code",
          usedTokens: 500,
          cachedInputTokens: 100,
          toolErrorCount: 0,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "completed",
          durationMs: 300,
          recoveredCommandPair: {
            failedCommand: "vp test run src/a.test.ts",
            succeededCommand: "vp test run src/b.test.ts",
          },
        });

        const lessons = yield* rsi.queryLessons();
        const pairLesson = lessons.find((lesson) =>
          lesson.guidance.includes("instead of `vp test run`"),
        );
        expect(pairLesson).toBeDefined();
        expect(pairLesson?.guidance).toBe(
          "Use `../../node_modules/.bin/vp.cmd test run` instead of `vp test run`.",
        );
        expect(pairLesson?.projectRoot).toBe("/repo/t3code");
        expect(
          lessons.some((lesson) =>
            lesson.guidance.includes("Use `vp test run` instead of `vp test run`"),
          ),
        ).toBe(false);
      }),
  );

  it.effect("scrubs multi-line output and user paths from distilled failure lessons", () =>
    Effect.gen(function* () {
      const rsi = yield* makeRsiService();
      const noisyError = [
        String.raw`Error: module not found at C:\Users\Arthur\Documents\t3code\apps\server\src\foo.ts and /home/arthur/work/bar.ts while invoking command`,
        "Directory: C:\\Users\\Arthur",
        "Mode LastWriteTime Length Name",
      ].join("\n");

      for (const runId of ["r-scrub-1", "r-scrub-2"]) {
        yield* rsi.recordRunTelemetry({
          threadId: "t-scrub",
          runId,
          provider: "codex",
          model: "gpt-5",
          cwd: "/repo/t3code",
          usedTokens: 600,
          cachedInputTokens: 100,
          toolErrorCount: 1,
          loopTripped: false,
          safetyBlockedCount: 0,
          wastedReads: 0,
          outcome: "failed",
          durationMs: 300,
          failureSignature: {
            tool: "command_execution",
            errorSignature: noisyError,
            title: "Avoid command_execution failure",
            guidance: `Inspect error "${noisyError}" before retrying.`,
          },
        });
      }

      const distilled = (yield* rsi.queryLessons()).find(
        (lesson) => lesson.title === "Avoid command_execution failure",
      );
      expect(distilled).toBeDefined();
      expect(distilled?.guidance).not.toContain("\n");
      expect(distilled?.guidance).not.toContain("C:\\Users\\Arthur");
      expect(distilled?.guidance).not.toContain("/home/arthur");
      expect(distilled?.guidance).toContain("<path>");
      expect(distilled?.guidance.length).toBeLessThanOrEqual(160);
    }),
  );

  it.effect(
    "caps in-memory telemetry at 500 records and compacts telemetry.jsonl past 1000 lines",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-compact-" });
        const rsiDir = path.join(tempRoot, "rsi");
        const written: Array<string> = [];
        const persistence = {
          fs: {
            ...fs,
            writeFileString: (filePath, data, options) => {
              written.push(filePath.replaceAll("\\", "/"));
              return fs.writeFileString(filePath, data, options);
            },
          } satisfies FileSystem.FileSystem,
          path,
          rsiDir,
          lessonsPath: path.join(rsiDir, "lessons.json"),
          telemetryPath: path.join(rsiDir, "telemetry.jsonl"),
        };
        const rsi = yield* makeRsiService({
          persistence,
          isAutoDistillEnabled: () => Effect.succeed(false),
        });

        for (let i = 1; i <= 1005; i += 1) {
          yield* rsi.recordRunTelemetry({
            threadId: "t-compact",
            runId: `r-compact-${i}`,
            provider: "codex",
            model: "gpt-5",
            usedTokens: 100,
            cachedInputTokens: 50,
            toolErrorCount: 0,
            loopTripped: false,
            safetyBlockedCount: 0,
            wastedReads: 0,
            outcome: "completed",
            durationMs: 100,
          });
        }

        const summary = yield* rsi.getTelemetrySummary({ limit: 1_000 });
        expect(summary.totalRuns).toBe(500);
        expect(summary.recentRuns[0]?.runId).toBe("r-compact-1005");
        expect(summary.recentRuns.at(-1)?.runId).toBe("r-compact-506");

        const rawAfter = yield* fs.readFileString(persistence.telemetryPath);
        const linesAfter = rawAfter.split(/\r?\n/).filter((line) => line.trim() !== "");
        expect(linesAfter).toHaveLength(504);

        // Compaction goes through a temp file renamed over the original, never an in-place rewrite.
        const telemetryFile = persistence.telemetryPath.replaceAll("\\", "/");
        expect(written).toContain(`${telemetryFile}.tmp`);
        expect(written).not.toContain(telemetryFile);
        expect(yield* fs.exists(`${persistence.telemetryPath}.tmp`)).toBe(false);

        // Reloading a >1000-line file also compacts telemetry.jsonl down to 500 lines on hydrate.
        const padded = Array.from({ length: 1002 }, (_, idx) =>
          JSON.stringify({
            threadId: "t-reload",
            runId: `r-reload-${idx + 1}`,
            provider: "codex",
            model: "gpt-5",
            usedTokens: 100,
            cachedInputTokens: 50,
            cacheHitRate: 0.5,
            toolErrorCount: 0,
            loopTripped: false,
            safetyBlockedCount: 0,
            wastedReads: 0,
            outcome: "completed",
            durationMs: 100,
            timestamp: "2026-11-15T00:00:00.000Z",
          }),
        ).join("\n");
        yield* fs.writeFileString(persistence.telemetryPath, `${padded}\n`);

        const reloaded = yield* makeRsiService({ persistence });
        const reloadedSummary = yield* reloaded.getTelemetrySummary({ limit: 1_000 });
        expect(reloadedSummary.totalRuns).toBe(500);
        const compactedRaw = yield* fs.readFileString(persistence.telemetryPath);
        const compactedLines = compactedRaw.split(/\r?\n/).filter((line) => line.trim() !== "");
        expect(compactedLines).toHaveLength(500);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips rewriting unchanged Obsidian lesson markdown files during sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-rsi-sync-skip-" });
      const rsiDir = path.join(tempRoot, "rsi");
      const vaultRoot = path.join(tempRoot, "vault");
      const brainDir = path.join(vaultRoot, "T3-Brain");

      const writtenFiles: Array<string> = [];
      const spyFs: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (filePath, data, options) => {
          writtenFiles.push(filePath.replaceAll("\\", "/"));
          return fs.writeFileString(filePath, data, options);
        },
      };

      const rsi = yield* makeRsiService({
        persistence: {
          fs: spyFs,
          path,
          rsiDir,
          lessonsPath: path.join(rsiDir, "lessons.json"),
          telemetryPath: path.join(rsiDir, "telemetry.jsonl"),
          resolveObsidianBrainDir: () => Effect.succeed(brainDir),
        },
      });

      const first = yield* rsi.recordLesson({
        key: "manual::obsidian_first",
        title: "First synced rule",
        guidance: "Keep first rule unchanged.",
        scope: "global",
      });

      const writesAfterFirst = writtenFiles.filter((p) => p.endsWith(`${first.id}.md`)).length;
      expect(writesAfterFirst).toBe(1);

      writtenFiles.length = 0;
      yield* rsi.recordLesson({
        key: "manual::obsidian_second",
        title: "Second synced rule",
        guidance: "Different rule triggers persist.",
        scope: "global",
      });

      expect(writtenFiles.filter((p) => p.endsWith(`${first.id}.md`)).length).toBe(0);
      expect(
        writtenFiles.some((p) => p.includes("/Lessons/") && !p.endsWith(`${first.id}.md`)),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prioritizes prompt-relevant lessons in formatSessionPrefix within tight budgets", () =>
    Effect.gen(function* () {
      const rsi = yield* RsiService;

      yield* rsi.recordLesson({
        key: "manual::general_high",
        title: "Use strict TypeScript exports",
        guidance: "Avoid barrel re-exports in shared contracts.",
        scope: "global",
        confidence: 0.95,
        hits: 8,
      });
      yield* rsi.recordLesson({
        key: "manual::ccr_retrieval",
        title: "Use context_retrieve for CCR blocks",
        guidance: "Pass query and contextLines when inspecting large terminal logs.",
        triggerCondition: "When reading CCR compressed tool outputs",
        scope: "global",
        confidence: 0.72,
        hits: 1,
      });

      const defaultOrder = yield* rsi.formatSessionPrefix({
        cwd: "/repo",
        maxChars: 130,
      });
      expect(defaultOrder).toContain("Use strict TypeScript exports");
      expect(defaultOrder).not.toContain("context_retrieve");

      const promptBoosted = yield* rsi.formatSessionPrefix({
        cwd: "/repo",
        userPrompt: "Inspect the CCR compressed terminal logs with context_retrieve",
        maxChars: 130,
      });
      expect(promptBoosted).toContain("Use context_retrieve for CCR blocks");
    }).pipe(Effect.provide(RsiService.layer)),
  );

  it.effect(
    "applies -0.03 soft-failure demotion only to related applied lessons on tool errors",
    () =>
      Effect.gen(function* () {
        const rsi = yield* RsiService;

        const related = yield* rsi.recordLesson({
          key: "manual::related_verify_rule",
          title: "Run targeted vitest",
          guidance: "Run `vp.cmd test run` after editing server code.",
          scope: "global",
          confidence: 0.7,
        });
        const unrelated = yield* rsi.recordLesson({
          key: "manual::unrelated_ui_rule",
          title: "UI token spacing",
          guidance: "Use existing spacing tokens in web views.",
          scope: "glob",
          globs: ["apps/web/**"],
          confidence: 0.7,
        });

        yield* rsi.recordRunTelemetry({
          runId: "run-soft-fail-1",
          threadId: "thread-soft-fail",
          provider: "claudeAgent",
          model: "claude-sonnet-5-5",
          wastedReads: 0,
          cwd: "/repo",
          outcome: "completed",
          usedTokens: 1_000,
          cachedInputTokens: 600,
          durationMs: 1_500,
          toolErrorCount: 2,
          loopTripped: false,
          safetyBlockedCount: 0,
          appliedLessonIds: [related.id, unrelated.id],
          verifiedCommands: ["vp.cmd test run"],
        });

        const after = yield* rsi.queryLessons({ cwd: "/repo" });
        const relatedAfter = after.find((l) => l.id === related.id)!;
        const unrelatedAfter = after.find((l) => l.id === unrelated.id)!;
        expect(relatedAfter.confidence).toBeCloseTo(0.67, 5);
        expect(unrelatedAfter.confidence).toBeCloseTo(0.7, 5);
      }).pipe(Effect.provide(RsiService.layer)),
  );

  it.effect(
    "merges near-duplicate auto verify lessons while keeping distinct auto failure lessons separate",
    () =>
      Effect.gen(function* () {
        const rsi = yield* RsiService;

        yield* rsi.recordLesson({
          key: "auto::global::verify::vp_test_a",
          title: "Verify edits with vitest",
          guidance:
            "Run `vp.cmd test run` to verify workspace source edits cleanly before finishing.",
          triggerCondition: "After editing workspace source files",
          scope: "global",
          projectRoot: "/repo",
          confidence: 0.72,
        });
        yield* rsi.recordLesson({
          key: "auto::global::verify::vp_test_b",
          title: "Verify edits with vitest",
          guidance:
            "Run `vp.cmd test run --bail=1` to verify workspace source edits cleanly before finishing now.",
          triggerCondition: "After editing workspace source files",
          scope: "global",
          projectRoot: "/repo",
          confidence: 0.72,
        });
        yield* rsi.recordLesson({
          key: "auto::global::verify::vp_typecheck",
          title: "Verify edits with typecheck",
          guidance:
            "Run `vp.cmd run typecheck` to verify workspace source edits cleanly before finishing.",
          triggerCondition: "After editing workspace source files",
          scope: "global",
          projectRoot: "/repo",
          confidence: 0.72,
        });

        yield* rsi.recordLesson({
          key: "auto::claudeagent::bash::enoent_alpha",
          title: "Recurring bash failure",
          guidance: "Repeated bash failure: verify missing config path before re-running.",
          triggerCondition: "claudeAgent:bash:enoent_alpha",
          scope: "global",
          projectRoot: "/repo",
          confidence: 0.7,
        });
        yield* rsi.recordLesson({
          key: "auto::claudeagent::bash::eacces_beta",
          title: "Recurring bash failure",
          guidance: "Repeated bash failure: verify missing script path before re-running.",
          triggerCondition: "claudeAgent:bash:eacces_beta",
          scope: "global",
          projectRoot: "/repo",
          confidence: 0.7,
        });

        const lessons = yield* rsi.queryLessons({ cwd: "/repo" });
        const verifyLessons = lessons.filter((l) => l.key.startsWith("auto::global::verify::"));
        const vitestLesson = verifyLessons.find((l) => l.title === "Verify edits with vitest");
        const typecheckLesson = verifyLessons.find(
          (l) => l.title === "Verify edits with typecheck",
        );
        const bashFailureLessons = lessons.filter((l) =>
          l.key.startsWith("auto::claudeagent::bash::"),
        );
        expect(verifyLessons).toHaveLength(2);
        expect(vitestLesson?.hits).toBe(2);
        expect(typecheckLesson?.hits).toBe(1);
        expect(bashFailureLessons).toHaveLength(2);
      }).pipe(Effect.provide(RsiService.layer)),
  );
});

describe("RsiService Obsidian sync safety", () => {
  const setup = Effect.fn("setup")(function* (prefix: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix });
    const rsiDir = path.join(tempRoot, "rsi");
    const brainDir = path.join(tempRoot, "vault", "T3-Brain");
    const lessonsDir = path.join(brainDir, "Lessons");
    const persistence = {
      fs,
      path,
      rsiDir,
      lessonsPath: path.join(rsiDir, "lessons.json"),
      telemetryPath: path.join(rsiDir, "telemetry.jsonl"),
      resolveObsidianBrainDir: () => Effect.succeed(brainDir),
    };
    const make = () => makeRsiService({ persistence });
    return { fs, path, rsiDir, lessonsDir, persistence, make };
  });

  it.effect("never deletes user notes in the Lessons folder across writes and restarts", () =>
    Effect.gen(function* () {
      const { fs, path, lessonsDir, make } = yield* setup("t3-rsi-foreign-");
      yield* fs.makeDirectory(lessonsDir, { recursive: true });
      const foreignPath = path.join(lessonsDir, "my-own-note.md");
      yield* fs.writeFileString(foreignPath, "# Not a lesson\n\nJust my notes.\n");

      const rsi = yield* make();
      yield* rsi.recordLesson({ key: "manual::a", title: "Rule A", guidance: "Do A." });
      yield* rsi.recordLesson({ key: "manual::b", title: "Rule B", guidance: "Do B." });
      // Any note in Lessons/ is imported as a lesson by design; it must keep its file and text.
      expect(yield* fs.readFileString(foreignPath)).toContain("Just my notes.");

      // A fresh process cannot prove a stale lesson-looking note is its own, so it keeps it.
      const stalePath = path.join(lessonsDir, "rsi_lesson_from_old_session.md");
      yield* fs.writeFileString(stalePath, '---\nid: "x"\n---\n\nleftover\n');
      const restarted = yield* make();
      yield* restarted.recordLesson({ key: "manual::c", title: "Rule C", guidance: "Do C." });
      expect(yield* fs.exists(foreignPath)).toBe(true);
      expect(yield* fs.exists(stalePath)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the untouched note of a deleted lesson and does not resurrect it", () =>
    Effect.gen(function* () {
      const { fs, path, lessonsDir, make } = yield* setup("t3-rsi-delete-");
      const rsi = yield* make();
      const doomed = yield* rsi.recordLesson({
        key: "manual::doomed",
        title: "Doomed rule",
        guidance: "Delete me.",
      });
      const notePath = path.join(lessonsDir, `${doomed.id}.md`);
      expect(yield* fs.exists(notePath)).toBe(true);

      expect((yield* rsi.deleteLesson({ id: doomed.id })).deleted).toBe(true);
      expect(yield* fs.exists(notePath)).toBe(false);

      yield* rsi.recordLesson({ key: "manual::other", title: "Other rule", guidance: "Stay." });
      const lessons = yield* rsi.queryLessons();
      expect(lessons.map((lesson) => lesson.id)).not.toContain(doomed.id);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges a mid-session Obsidian edit on the next write instead of overwriting it", () =>
    Effect.gen(function* () {
      const { fs, path, lessonsDir, make } = yield* setup("t3-rsi-edit-");
      const rsi = yield* make();
      const edited = yield* rsi.recordLesson({
        key: "manual::edited",
        title: "Edited rule",
        guidance: "Original guidance.",
      });
      const notePath = path.join(lessonsDir, `${edited.id}.md`);
      const original = yield* fs.readFileString(notePath);
      yield* fs.writeFileString(
        notePath,
        original.replace("Original guidance.", "Guidance edited in Obsidian."),
      );

      yield* rsi.recordLesson({ key: "manual::trigger", title: "Trigger", guidance: "Write." });

      expect(yield* fs.readFileString(notePath)).toContain("Guidance edited in Obsidian.");
      const lessons = yield* rsi.queryLessons();
      expect(lessons.find((lesson) => lesson.id === edited.id)?.guidance).toBe(
        "Guidance edited in Obsidian.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves an unreadable lessons.json aside instead of overwriting it", () =>
    Effect.gen(function* () {
      const { fs, path, rsiDir, persistence, make } = yield* setup("t3-rsi-corrupt-");
      yield* fs.makeDirectory(rsiDir, { recursive: true });
      yield* fs.writeFileString(persistence.lessonsPath, '{"version":1,"lessons":[{"id":');

      const rsi = yield* make();
      yield* rsi.recordLesson({ key: "manual::fresh", title: "Fresh", guidance: "New." });

      const aside = (yield* fs.readDirectory(rsiDir)).filter((name) =>
        name.startsWith("lessons.json.corrupt-"),
      );
      expect(aside).toHaveLength(1);
      expect(yield* fs.readFileString(path.join(rsiDir, aside[0]!))).toBe(
        '{"version":1,"lessons":[{"id":',
      );
      expect(yield* fs.readFileString(persistence.lessonsPath)).toContain("manual::fresh");
      expect(yield* fs.exists(`${persistence.lessonsPath}.tmp`)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
