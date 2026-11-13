import { assert, describe, it } from "@effect/vitest";

import { evaluateToolSafety } from "./toolSafetyGuard.ts";

describe("evaluateToolSafety", () => {
  it("defaults enabled to true and bypasses all checks when enabled is false", () => {
    const blocked = evaluateToolSafety({
      toolName: "Bash",
      rawInput: { command: "rm -rf /" },
    });
    assert.equal(blocked.decision, "deny");
    assert.equal(blocked.category, "destructive_command");

    const bypassed = evaluateToolSafety({
      toolName: "Bash",
      rawInput: { command: "rm -rf /" },
      enabled: false,
      lockTests: true,
    });
    assert.deepEqual(bypassed, { decision: "allow" });
  });

  describe("destructive commands", () => {
    it("denies rm -rf and Remove-Item -Recurse targeting root, home, or parent", () => {
      for (const command of [
        "rm -rf /",
        "rm -rf /*",
        "rm -fr ~",
        "rm -rf ~/",
        "rm -rf $HOME",
        "rm -rf %USERPROFILE%",
        "rm -rf ..",
        "rm -rf ../workspace",
        "rm -r -f /",
        "Remove-Item -Recurse -Force /",
        "Remove-Item -Recurse ~",
        "Remove-Item -Recurse $env:USERPROFILE",
        "Remove-Item -Recurse ..",
      ]) {
        const result = evaluateToolSafety({
          toolName: "Bash",
          rawInput: { command },
        });
        assert.equal(result.decision, "deny", `expected deny for: ${command}`);
        assert.equal(result.category, "destructive_command");
      }
    });

    it("allows scoped local rm -rf on build/temp directories", () => {
      for (const command of ["rm -rf ./dist", "rm -rf node_modules", "rm -rf /tmp/build-cache"]) {
        const result = evaluateToolSafety({
          toolName: "Bash",
          rawInput: { command },
        });
        assert.equal(result.decision, "allow", `expected allow for: ${command}`);
      }
    });

    it("denies mkfs, disk format, dd if=, and SQL DROP DATABASE / DROP TABLE", () => {
      for (const command of [
        "mkfs.ext4 /dev/sda1",
        "format C: /fs:NTFS",
        "dd if=/dev/zero of=/dev/sda bs=1M",
        "psql -c 'DROP DATABASE production;'",
        "sqlite3 app.db 'drop table users;'",
      ]) {
        const result = evaluateToolSafety({
          toolName: "execute",
          rawInput: { CommandLine: command },
        });
        assert.equal(result.decision, "deny", `expected deny for: ${command}`);
        assert.equal(result.category, "destructive_command");
      }

      assert.equal(
        evaluateToolSafety({ toolName: "Bash", rawInput: { command: "npm run format" } }).decision,
        "allow",
      );
    });

    it("asks for git reset --hard and unsafe git push --force/-f while allowing --force-with-lease", () => {
      for (const command of [
        "git reset --hard",
        "git reset --hard HEAD~1",
        "git push --force origin main",
        "git push -f",
        "git push origin feat -fu",
      ]) {
        const result = evaluateToolSafety({
          toolName: "run_command",
          rawInput: { command },
        });
        assert.equal(result.decision, "ask", `expected ask for: ${command}`);
        assert.equal(result.category, "destructive_command");
      }

      for (const command of [
        "git push --force-with-lease",
        "git push origin main --force-with-lease",
      ]) {
        const result = evaluateToolSafety({
          toolName: "Bash",
          rawInput: { command },
        });
        assert.equal(result.decision, "allow", `expected allow for: ${command}`);
      }
    });

    it("prefers deny over ask when a compound command includes both", () => {
      const result = evaluateToolSafety({
        toolName: "Bash",
        rawInput: { command: "git push --force && rm -rf /" },
      });
      assert.equal(result.decision, "deny");
      assert.equal(result.category, "destructive_command");
    });
  });

  describe("secret access", () => {
    it("denies reads, writes, ACP locations, and shell commands accessing secrets", () => {
      for (const [toolName, rawInput] of [
        ["Read", { file_path: ".env" }],
        ["Edit", { file_path: "apps/server/.env.local" }],
        ["Write", { file_path: ".env.production" }],
        ["MultiEdit", { edits: [{ file_path: "config/credentials.json" }] }],
        ["read", { locations: [{ path: "C:\\Users\\alice\\.ssh\\id_rsa" }] }],
        ["edit", { TargetFile: "keys/id_ed25519" }],
        ["Write", { path: "certs/server.pem" }],
        ["Read", { file_path: "certs/private.key" }],
        ["Read", { file_path: "certs/keystore.p12" }],
        ["Read", { file_path: ".npmrc" }],
        ["Write", { file_path: ".pypirc" }],
        ["Bash", { command: "cat .env" }],
        ["Bash", { command: "echo SECRET=1 >> .env.staging" }],
      ] as const) {
        const result = evaluateToolSafety({ toolName, rawInput });
        assert.equal(
          result.decision,
          "deny",
          `expected deny for ${toolName}: ${JSON.stringify(rawInput)}`,
        );
        assert.equal(result.category, "secret_access");
      }
    });

    it("allows .env.example, .env.sample, .env.template and public SSH keys", () => {
      for (const [toolName, rawInput] of [
        ["Read", { file_path: ".env.example" }],
        ["Write", { file_path: "apps/web/.env.sample" }],
        ["Edit", { file_path: ".env.template" }],
        ["Read", { file_path: "~/.ssh/id_rsa.pub" }],
        ["Bash", { command: "cp .env.example .env.template" }],
      ] as const) {
        const result = evaluateToolSafety({ toolName, rawInput });
        assert.equal(
          result.decision,
          "allow",
          `expected allow for ${toolName}: ${JSON.stringify(rawInput)}`,
        );
      }
    });
  });

  describe("test tampering lock", () => {
    it("denies editing or deleting test files when lockTests is true", () => {
      for (const [toolName, rawInput] of [
        ["Edit", { file_path: "src/auth.test.ts" }],
        ["Write", { file_path: "src/app.spec.tsx" }],
        ["MultiEdit", { edits: [{ file_path: "tests/test_login.py" }] }],
        ["replace_file_content", { TargetFile: "tests/login_test.py" }],
        ["delete", { locations: [{ path: "src/foo.test.js" }] }],
        ["Bash", { command: "rm src/auth.test.ts" }],
        ["Bash", { command: "echo '' > tests/test_auth.py" }],
      ] as const) {
        const locked = evaluateToolSafety({ toolName, rawInput, lockTests: true });
        assert.equal(
          locked.decision,
          "deny",
          `expected deny for ${toolName}: ${JSON.stringify(rawInput)}`,
        );
        assert.equal(locked.category, "test_tampering");

        const unlocked = evaluateToolSafety({ toolName, rawInput, lockTests: false });
        assert.equal(unlocked.decision, "allow");
      }
    });

    it("still allows reading and running test files when lockTests is true", () => {
      for (const [toolName, rawInput] of [
        ["Read", { file_path: "src/auth.test.ts" }],
        ["view_file", { AbsolutePath: "tests/test_login.py" }],
        ["Bash", { command: "vp test run src/auth.test.ts" }],
        ["Bash", { command: "python -m pytest tests/test_login.py" }],
      ] as const) {
        const result = evaluateToolSafety({ toolName, rawInput, lockTests: true });
        assert.equal(result.decision, "allow", `expected allow for ${toolName}`);
      }
    });

    it("respects process.env.T3CODE_LOCK_TESTS === '1' when lockTests is omitted", () => {
      const previous = process.env.T3CODE_LOCK_TESTS;
      process.env.T3CODE_LOCK_TESTS = "1";
      try {
        const denied = evaluateToolSafety({
          toolName: "Edit",
          rawInput: { file_path: "src/guard.test.ts" },
        });
        assert.equal(denied.decision, "deny");
        assert.equal(denied.category, "test_tampering");

        const overridden = evaluateToolSafety({
          toolName: "Edit",
          rawInput: { file_path: "src/guard.test.ts" },
          lockTests: false,
        });
        assert.equal(overridden.decision, "allow");
      } finally {
        if (previous === undefined) delete process.env.T3CODE_LOCK_TESTS;
        else process.env.T3CODE_LOCK_TESTS = previous;
      }
    });
  });
});
