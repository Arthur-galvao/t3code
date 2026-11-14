// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  computeIdentityDigest,
  loadWorkflowCheckpoint,
  planResumableStages,
  recordStageCompleted,
} from "./workflowCheckpoint.ts";

describe("workflowCheckpoint", () => {
  it("computes deterministic identity digests across key ordering and input file changes", async () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wf-ckpt-"));
    try {
      const inputA = NodePath.join(tempDir, "a.txt");
      const inputB = NodePath.join(tempDir, "sub", "b.txt");
      NodeFS.mkdirSync(NodePath.dirname(inputB), { recursive: true });
      NodeFS.writeFileSync(inputA, "alpha", "utf8");
      NodeFS.writeFileSync(inputB, "beta", "utf8");

      const digest1 = await computeIdentityDigest({
        workflowId: "wf-1",
        config: { b: 2, a: { y: true, x: 1 } },
        inputFiles: [inputA, inputB],
      });
      const digest2 = await computeIdentityDigest({
        workflowId: "wf-1",
        config: { a: { x: 1, y: true }, b: 2 },
        inputFiles: [inputB, inputA],
      });
      assert.equal(digest1, digest2);

      NodeFS.writeFileSync(inputB, "beta-modified", "utf8");
      const digestChangedFile = await computeIdentityDigest({
        workflowId: "wf-1",
        config: { a: { x: 1, y: true }, b: 2 },
        inputFiles: [inputA, inputB],
      });
      assert.notEqual(digestChangedFile, digest1);

      const digestChangedConfig = await computeIdentityDigest({
        workflowId: "wf-1",
        config: { a: { x: 2, y: true }, b: 2 },
        inputFiles: [inputA, inputB],
      });
      assert.notEqual(digestChangedConfig, digestChangedFile);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("plans resumable stages and detects not_completed, missing_artifact, artifact_hash_mismatch, and config_changed", async () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wf-plan-"));
    try {
      const statePath = NodePath.join(tempDir, "state", "checkpoint.json");
      const artifact1 = NodePath.join(tempDir, "out", "stage1.json");
      const artifact2 = NodePath.join(tempDir, "out", "stage2.json");
      NodeFS.mkdirSync(NodePath.dirname(artifact1), { recursive: true });
      NodeFS.writeFileSync(artifact1, '{"ok":1}', "utf8");
      NodeFS.writeFileSync(artifact2, '{"ok":2}', "utf8");

      const digest = await computeIdentityDigest({
        workflowId: "wf-2",
        config: { mode: "strict" },
      });

      const initialPlan = await planResumableStages(
        [{ stageId: "explore" }, { stageId: "build", expectedArtifacts: [artifact1] }, "verify"],
        statePath,
        digest,
      );
      assert.equal(initialPlan.checkpointExists, false);
      assert.deepEqual(initialPlan.validStageIds, []);
      assert.deepEqual(initialPlan.invalidatedStageIds, ["explore", "build", "verify"]);
      assert.deepEqual(
        initialPlan.stages.map((s) => (s.valid ? "valid" : s.reason)),
        ["not_completed", "not_completed", "not_completed"],
      );

      await recordStageCompleted(statePath, digest, {
        stageId: "explore",
        completedAt: "2026-11-14T00:00:00.000Z",
      });
      await recordStageCompleted(statePath, digest, {
        stageId: "build",
        completedAt: "2026-11-14T00:01:00.000Z",
        artifactPaths: [artifact1],
      });

      const loaded = await loadWorkflowCheckpoint(statePath);
      assert.isNotNull(loaded);
      assert.equal(loaded?.identityDigest, digest);

      const resumePlan = await planResumableStages(
        [
          { stageId: "explore" },
          { stageId: "build", expectedArtifacts: [artifact1] },
          { stageId: "verify", expectedArtifacts: [artifact2] },
        ],
        statePath,
        digest,
      );
      assert.equal(resumePlan.checkpointExists, true);
      assert.equal(resumePlan.configChanged, false);
      assert.deepEqual(resumePlan.validStageIds, ["explore", "build"]);
      assert.deepEqual(resumePlan.invalidatedStageIds, ["verify"]);
      assert.equal(resumePlan.stages[2]?.valid, false);
      if (resumePlan.stages[2] && !resumePlan.stages[2].valid) {
        assert.equal(resumePlan.stages[2].reason, "not_completed");
      }

      // Tamper with artifact1 -> artifact_hash_mismatch
      NodeFS.writeFileSync(artifact1, '{"ok":999}', "utf8");
      const tamperedPlan = await planResumableStages(
        [{ stageId: "explore" }, { stageId: "build", expectedArtifacts: [artifact1] }],
        statePath,
        digest,
      );
      assert.deepEqual(tamperedPlan.validStageIds, ["explore"]);
      assert.equal(tamperedPlan.stages[1]?.valid, false);
      if (tamperedPlan.stages[1] && !tamperedPlan.stages[1].valid) {
        assert.equal(tamperedPlan.stages[1].reason, "artifact_hash_mismatch");
      }

      // Delete artifact1 -> missing_artifact
      NodeFS.rmSync(artifact1);
      const missingPlan = await planResumableStages(
        [{ stageId: "explore" }, { stageId: "build", expectedArtifacts: [artifact1] }],
        statePath,
        digest,
      );
      assert.equal(missingPlan.stages[1]?.valid, false);
      if (missingPlan.stages[1] && !missingPlan.stages[1].valid) {
        assert.equal(missingPlan.stages[1].reason, "missing_artifact");
      }

      // Change identity digest -> config_changed across all stages
      const nextDigest = await computeIdentityDigest({
        workflowId: "wf-2",
        config: { mode: "relaxed" },
      });
      const configChangedPlan = await planResumableStages(
        ["explore", "build"],
        statePath,
        nextDigest,
      );
      assert.equal(configChangedPlan.configChanged, true);
      assert.deepEqual(configChangedPlan.validStageIds, []);
      assert.deepEqual(
        configChangedPlan.stages.map((s) => (s.valid ? "valid" : s.reason)),
        ["config_changed", "config_changed"],
      );
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles corrupt checkpoint files gracefully without throwing", async () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wf-corrupt-"));
    try {
      const statePath = NodePath.join(tempDir, "checkpoint.json");
      NodeFS.writeFileSync(statePath, "{not valid json", "utf8");

      assert.isNull(await loadWorkflowCheckpoint(statePath));
      const plan = await planResumableStages(["a"], statePath, "digest-1");
      assert.equal(plan.checkpointExists, false);
      assert.deepEqual(plan.invalidatedStageIds, ["a"]);
    } finally {
      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
