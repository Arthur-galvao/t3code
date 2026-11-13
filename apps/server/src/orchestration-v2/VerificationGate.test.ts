import { assert, it } from "@effect/vitest";

import {
  collectVerificationStateFromTurnItems,
  evaluateCompletionGate,
  evaluateVerificationTracker,
  isSourceCodeFile,
  isVerificationCommand,
} from "./VerificationGate.ts";

it("classifies source code vs docs/plans/markdown files accurately", () => {
  assert.isTrue(isSourceCodeFile("apps/server/src/index.ts"));
  assert.isTrue(isSourceCodeFile("src/components/Button.tsx"));
  assert.isFalse(isSourceCodeFile("README.md"));
  assert.isFalse(isSourceCodeFile("docs/RSI_ARCHITECTURE.md"));
  assert.isFalse(isSourceCodeFile("plans/migration.txt"));
  assert.isFalse(isSourceCodeFile(".agents/skills/sdd/SKILL.md"));
});

it("recognizes verification commands accurately", () => {
  assert.isTrue(isVerificationCommand("vp test run src/foo.test.ts"));
  assert.isTrue(isVerificationCommand("..\\..\\node_modules\\.bin\\vp.cmd test run foo.ts"));
  assert.isTrue(isVerificationCommand("pnpm run typecheck"));
  assert.isTrue(isVerificationCommand("cargo test --workspace"));
  assert.isTrue(isVerificationCommand("python -m unittest discover"));
  assert.isTrue(isVerificationCommand("python evals/golden_suite.py"));
  assert.isFalse(isVerificationCommand("git status"));
  assert.isFalse(isVerificationCommand("ls -la src"));
});

it("bypasses read-only runs and off mode, and enforces retryCount < 2 cap", () => {
  assert.isFalse(
    evaluateCompletionGate({
      hasGoal: true,
      mode: "auto",
      editsSinceLastVerify: 0,
      lastVerifyPassed: false,
      retryCount: 0,
    }).shouldContinue,
  );

  assert.isFalse(
    evaluateCompletionGate({
      hasGoal: true,
      mode: "off",
      editsSinceLastVerify: 3,
      lastVerifyPassed: false,
      retryCount: 0,
    }).shouldContinue,
  );

  const shouldRetry = evaluateCompletionGate({
    hasGoal: false,
    mode: "auto",
    editsSinceLastVerify: 2,
    lastVerifyPassed: false,
    retryCount: 1,
    modifiedFiles: ["src/foo.ts", "src/bar.ts"],
  });
  assert.isTrue(shouldRetry.shouldContinue);
  assert.include(shouldRetry.reason ?? "", "src/foo.ts");

  assert.isFalse(
    evaluateCompletionGate({
      hasGoal: true,
      mode: "always",
      editsSinceLastVerify: 2,
      lastVerifyPassed: false,
      retryCount: 2,
      modifiedFiles: ["src/foo.ts"],
    }).shouldContinue,
  );
});

it("respects goal mode only when hasGoal is true", () => {
  assert.isFalse(
    evaluateCompletionGate({
      hasGoal: false,
      mode: "goal",
      editsSinceLastVerify: 1,
      lastVerifyPassed: false,
      retryCount: 0,
    }).shouldContinue,
  );
  assert.isTrue(
    evaluateCompletionGate({
      hasGoal: true,
      mode: "goal",
      editsSinceLastVerify: 1,
      lastVerifyPassed: false,
      retryCount: 0,
    }).shouldContinue,
  );
});

it("requires verification AFTER the last source edit and ignores docs-only edits", () => {
  const docsOnly = collectVerificationStateFromTurnItems([
    { id: "f1", type: "file_change", status: "completed", fileName: "docs/notes.md" },
  ]);
  assert.strictEqual(docsOnly.editsSinceLastVerify, 0);

  const editThenVerify = collectVerificationStateFromTurnItems([
    { id: "f2", type: "file_change", status: "completed", fileName: "src/service.ts" },
    {
      id: "c1",
      type: "command_execution",
      status: "completed",
      input: "vp lint src/service.ts",
      exitCode: 0,
    },
  ]);
  assert.isFalse(
    evaluateVerificationTracker(editThenVerify, {
      hasGoal: false,
      mode: "auto",
      retryCount: 0,
    }).shouldContinue,
  );

  const verifyThenEdit = collectVerificationStateFromTurnItems([
    { id: "c1", type: "command_execution", status: "completed", input: "vp test run", exitCode: 0 },
    { id: "f3", type: "file_change", status: "completed", fileName: "src/service.ts" },
  ]);
  const decision = evaluateVerificationTracker(verifyThenEdit, {
    hasGoal: false,
    mode: "auto",
    retryCount: 0,
  });
  assert.isTrue(decision.shouldContinue);
  assert.include(decision.reason ?? "", "src/service.ts");
});

it("keeps gate open when verification command fails", () => {
  const failedVerify = collectVerificationStateFromTurnItems([
    { id: "f1", type: "file_change", status: "completed", fileName: "src/a.ts" },
    {
      id: "c1",
      type: "command_execution",
      status: "failed",
      input: "vp test run src/a.test.ts",
      exitCode: 1,
    },
  ]);
  const decision = evaluateVerificationTracker(failedVerify, {
    hasGoal: false,
    mode: "auto",
    retryCount: 0,
  });
  assert.isTrue(decision.shouldContinue);
  assert.include(decision.reason ?? "", "vp test run src/a.test.ts");
});
