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
    "Evaluate->Retain boosts applied lessons on clean success and demotes/prunes on failures",
    () =>
      Effect.gen(function* () {
        const rsi = yield* makeRsiService();
        const strong = yield* rsi.recordLesson({
          key: "manual:strong-lesson",
          title: "Check workspace types",
          guidance: "Run typecheck after editing.",
          confidence: 0.8,
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
        expect(formatted.lessonIds).not.toContain(fragile.id);

        // Clean success on r-eval-1 boosts tracked lesson confidence (+0.05) and hits (+1).
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
        });

        const boosted = (yield* rsi.queryLessons()).find((lesson) => lesson.id === strong.id);
        expect(boosted?.confidence).toBe(0.85);
        expect(boosted?.hits).toBe(2);

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
          editedFiles: ["apps/server/src/server.ts"],
          verifiedCommands: ["pnpm typecheck"],
        });

        const lessons = yield* rsi.queryLessons();
        const wsVerifyLessons = lessons.filter((lesson) =>
          lesson.title.includes("pnpm test apps/server/src/ws.test.ts"),
        );
        expect(wsVerifyLessons).toHaveLength(1);
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
});
