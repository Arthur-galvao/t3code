export type ToolSafetyDecision = "allow" | "ask" | "deny";

export type ToolSafetyCategory = "destructive_command" | "secret_access" | "test_tampering";

export interface ToolSafetyEvaluation {
  readonly decision: ToolSafetyDecision;
  readonly category?: ToolSafetyCategory;
  readonly reason?: string;
}

export interface EvaluateToolSafetyInput {
  readonly toolName: string;
  readonly rawInput: unknown;
  readonly lockTests?: boolean;
  readonly enabled?: boolean;
}

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "execute",
  "exec",
  "shell",
  "terminal",
  "run_command",
  "command_execution",
  "sh",
  "zsh",
  "powershell",
  "pwsh",
  "cmd",
]);

const WRITE_OR_DELETE_TOOL_NAMES = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "create_file",
  "update_file",
  "patch",
  "apply_patch",
  "str_replace_editor",
  "delete",
  "move",
  "delete_file",
  "remove_file",
]);

const READ_OR_SEARCH_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "cat",
  "glob",
  "grep",
  "search",
  "find_by_name",
  "grep_search",
  "list_dir",
]);

const COMMAND_KEYS = new Set([
  "command",
  "commandline",
  "command_line",
  "cmd",
  "script",
  "shell_command",
]);

const PATH_KEYS = new Set([
  "file_path",
  "filepath",
  "path",
  "targetfile",
  "target_file",
  "absolutepath",
  "absolute_path",
  "notebook_path",
  "notebookpath",
  "target",
  "filename",
  "file",
  "old_path",
  "new_path",
  "source",
  "destination",
  "dest",
]);

const PATH_ARRAY_KEYS = new Set(["paths", "files", "targets"]);

const SAFE_ENV_TEMPLATE_BASENAMES = new Set([".env.example", ".env.sample", ".env.template"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquoteToken(token: string): string {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function basenameOf(rawPath: string): string {
  const cleaned = unquoteToken(rawPath).replace(/[\\/]+$/, "");
  if (cleaned === "") return "";
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function stripTrailingPunctuation(token: string): string {
  return unquoteToken(token).replace(/[;,)}\]]+$/, "");
}

function extractGuardInputs(rawInput: unknown): {
  readonly commands: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
  readonly kindHint: string | undefined;
} {
  const commands: Array<string> = [];
  const paths: Array<string> = [];
  let kindHint: string | undefined;

  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (trimmed !== "") {
      commands.push(trimmed);
    }
    return { commands, paths, kindHint };
  }

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (!isRecord(node)) return;

    if (depth === 0 && typeof node.kind === "string") {
      kindHint = node.kind.toLowerCase();
    }

    for (const [key, value] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      if (COMMAND_KEYS.has(normalizedKey) && typeof value === "string" && value.trim() !== "") {
        commands.push(value.trim());
        continue;
      }
      if (PATH_KEYS.has(normalizedKey) && typeof value === "string" && value.trim() !== "") {
        paths.push(unquoteToken(value));
        continue;
      }
      if (PATH_ARRAY_KEYS.has(normalizedKey) && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string" && item.trim() !== "") {
            paths.push(unquoteToken(item));
          }
        }
        continue;
      }
      if (normalizedKey === "locations" && Array.isArray(value)) {
        for (const loc of value) {
          if (isRecord(loc) && typeof loc.path === "string" && loc.path.trim() !== "") {
            paths.push(unquoteToken(loc.path));
          }
        }
        continue;
      }
      if (
        (normalizedKey === "edits" ||
          normalizedKey === "changes" ||
          normalizedKey === "rawinput") &&
        (isRecord(value) || Array.isArray(value))
      ) {
        visit(value, depth + 1);
      }
    }
  };

  visit(rawInput, 0);
  return { commands, paths, kindHint };
}

function splitShellSegments(command: string): ReadonlyArray<string> {
  return command
    .split(/(?:&&|\|\||;|\||\r?\n)+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function tokenizeSegment(segment: string): ReadonlyArray<string> {
  const matches = segment.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g);
  return matches === null ? [] : matches;
}

function isDangerousRemovalTarget(rawTarget: string): boolean {
  const target = stripTrailingPunctuation(rawTarget);
  if (target === "" || target.startsWith("-")) return false;
  const lower = target.toLowerCase();

  // Root paths: /, /*, \, \*, C:\, C:/, C:\*
  if (
    lower === "/" ||
    lower === "/*" ||
    lower === "\\" ||
    lower === "\\*" ||
    /^[a-z]:[\\/]\*?$/.test(lower)
  ) {
    return true;
  }

  // Home directory targets: ~, ~/, ~\, ~/*, $HOME, ${HOME}, %USERPROFILE%, $env:USERPROFILE
  if (
    lower === "~" ||
    /^~[\\/](\*)?$/.test(lower) ||
    /^\$\{?home\}?([\\/]\*?)?$/.test(lower) ||
    /^%userprofile%([\\/]\*?)?$/.test(lower) ||
    /^\$env:userprofile([\\/]\*?)?$/.test(lower)
  ) {
    return true;
  }

  // Parent directory traversal: .., ../, ..\, foo/../bar
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(lower)) {
    return true;
  }

  return false;
}

function checkRmOrRemoveItemDeny(segment: string): string | undefined {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return undefined;

  const first = unquoteToken(tokens[0] ?? "").toLowerCase();
  const cmdName = basenameOf(first).toLowerCase();

  if (cmdName === "rm") {
    let hasRecursive = false;
    let hasForce = false;
    let afterDoubleDash = false;
    const targets: Array<string> = [];

    for (let i = 1; i < tokens.length; i += 1) {
      const token = unquoteToken(tokens[i] ?? "");
      if (!afterDoubleDash && token === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && token.startsWith("--")) {
        if (token === "--recursive") hasRecursive = true;
        else if (token === "--force") hasForce = true;
        continue;
      }
      if (!afterDoubleDash && token.startsWith("-") && token.length > 1) {
        const flags = token.slice(1).toLowerCase();
        if (flags.includes("r")) hasRecursive = true;
        if (flags.includes("f")) hasForce = true;
        continue;
      }
      targets.push(token);
    }

    if (hasRecursive && hasForce) {
      const badTarget = targets.find(isDangerousRemovalTarget);
      if (badTarget !== undefined) {
        return `Blocked destructive recursive removal targeting '${badTarget}'.`;
      }
    }
    return undefined;
  }

  if (cmdName === "remove-item" || cmdName === "ri") {
    let hasRecurse = false;
    const targets: Array<string> = [];

    for (let i = 1; i < tokens.length; i += 1) {
      const token = unquoteToken(tokens[i] ?? "");
      if (/^-(?:r|recurse)$/i.test(token)) {
        hasRecurse = true;
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }
      targets.push(token);
    }

    if (hasRecurse) {
      const badTarget = targets.find(isDangerousRemovalTarget);
      if (badTarget !== undefined) {
        return `Blocked destructive Remove-Item -Recurse targeting '${badTarget}'.`;
      }
    }
  }

  return undefined;
}

function evaluateDestructiveCommand(command: string): ToolSafetyEvaluation | undefined {
  const segments = splitShellSegments(command);
  let pendingAsk: ToolSafetyEvaluation | undefined;

  for (const segment of segments) {
    const removalDeny = checkRmOrRemoveItemDeny(segment);
    if (removalDeny !== undefined) {
      return {
        decision: "deny",
        category: "destructive_command",
        reason: removalDeny,
      };
    }

    if (/\bmkfs(?:\.[a-z0-9_-]+)?\b/i.test(segment)) {
      return {
        decision: "deny",
        category: "destructive_command",
        reason: "Blocked filesystem formatting command (mkfs).",
      };
    }

    if (/^(?:sudo\s+)?format(?:\.com|\.exe)?\s+(?:[a-z]:|\/dev\/|\\device\\)/i.test(segment)) {
      return {
        decision: "deny",
        category: "destructive_command",
        reason: "Blocked disk format command.",
      };
    }

    if (/\bdd\b[^\n]*\bif=/i.test(segment)) {
      return {
        decision: "deny",
        category: "destructive_command",
        reason: "Blocked raw disk write command (dd if=).",
      };
    }

    if (/\bdrop\s+(?:database|table)\b/i.test(segment)) {
      return {
        decision: "deny",
        category: "destructive_command",
        reason: "Blocked destructive SQL command (DROP DATABASE / DROP TABLE).",
      };
    }

    if (pendingAsk === undefined) {
      if (/\bgit\b[^\n]*\breset\b[^\n]*--hard\b/i.test(segment)) {
        pendingAsk = {
          decision: "ask",
          category: "destructive_command",
          reason: "git reset --hard discards uncommitted work and requires confirmation.",
        };
      } else if (/\bgit\b[^\n]*\bpush\b/i.test(segment)) {
        const tokens = tokenizeSegment(segment).map((t) => unquoteToken(t));
        const hasForceWithLease = tokens.some(
          (t) => t === "--force-with-lease" || t.startsWith("--force-with-lease="),
        );
        const hasUnsafeForce = tokens.some(
          (t) => t === "--force" || (t.startsWith("-") && !t.startsWith("--") && /f/.test(t)),
        );
        if (hasUnsafeForce || (!hasForceWithLease && /\s--force(?:\s|$)/i.test(segment))) {
          pendingAsk = {
            decision: "ask",
            category: "destructive_command",
            reason: "Force-pushing without --force-with-lease requires confirmation.",
          };
        }
      }
    }
  }

  return pendingAsk;
}

function isSecretFilePath(filePath: string): boolean {
  const base = basenameOf(filePath).toLowerCase();
  if (base === "") return false;

  if (base === ".env") return true;
  if (base.startsWith(".env.")) {
    return !SAFE_ENV_TEMPLATE_BASENAMES.has(base);
  }
  if (base.includes("credentials")) return true;
  if (/\.(?:pem|key|p12)$/.test(base)) return true;
  if (/^id_(?:rsa|ed25519)(?:\.(?!pub$).+)?$/.test(base)) return true;
  if (base === ".npmrc" || base === ".pypirc") return true;

  return false;
}

function isTestFilePath(filePath: string): boolean {
  const base = basenameOf(filePath).toLowerCase();
  if (base === "") return false;
  return (
    /\.test\.[^/\\]+$/.test(base) ||
    /\.spec\.[^/\\]+$/.test(base) ||
    /^test_[^/\\]*\.py$/.test(base) ||
    /^[^/\\]+_test\.py$/.test(base)
  );
}

function shellTokensForPathInspection(command: string): ReadonlyArray<string> {
  const tokens: Array<string> = [];
  for (const raw of tokenizeSegment(command)) {
    const cleaned = stripTrailingPunctuation(raw);
    if (cleaned === "") continue;
    // Handle redirections like `>.env`, `>>.env.local`, `<.env`, `2>.env`
    const withoutRedirect = cleaned.replace(/^(?:\d*[<>]+)+/, "");
    if (withoutRedirect !== "") {
      tokens.push(withoutRedirect);
    }
    // Handle key=value or --file=.env flags
    const eqIndex = withoutRedirect.indexOf("=");
    if (eqIndex > 0 && eqIndex < withoutRedirect.length - 1) {
      tokens.push(withoutRedirect.slice(eqIndex + 1));
    }
  }
  return tokens;
}

function commandModifiesFiles(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (/[<>]{1,2}/.test(segment) && !/\s*<\s*/.test(segment)) {
    return true;
  }
  return /^(?:sudo\s+)?(?:rm|rmdir|del|erase|remove-item|ri|mv|move|move-item|cp|copy|copy-item|touch|truncate|tee|sed\s+-i|perl\s+-[a-z]*i|python\s+-c)\b/.test(
    lower,
  );
}

function checkSecretCommand(command: string): string | undefined {
  for (const segment of splitShellSegments(command)) {
    for (const token of shellTokensForPathInspection(segment)) {
      if (isSecretFilePath(token)) {
        return `Blocked shell access to secret file '${token}'.`;
      }
    }
  }
  return undefined;
}

function checkTestTamperingCommand(command: string): string | undefined {
  for (const segment of splitShellSegments(command)) {
    if (!commandModifiesFiles(segment)) continue;
    for (const token of shellTokensForPathInspection(segment)) {
      if (isTestFilePath(token)) {
        return `Blocked test-tampering command targeting '${token}' while test lock is active.`;
      }
    }
  }
  return undefined;
}

export function evaluateToolSafety(input: EvaluateToolSafetyInput): ToolSafetyEvaluation {
  if (input.enabled === false) {
    return { decision: "allow" };
  }

  const normalizedToolName = input.toolName.trim().toLowerCase();
  const { commands, paths, kindHint } = extractGuardInputs(input.rawInput);
  const effectiveKind = kindHint ?? normalizedToolName;

  const isShellTool = SHELL_TOOL_NAMES.has(normalizedToolName) || effectiveKind === "execute";
  const isWriteOrDeleteTool =
    WRITE_OR_DELETE_TOOL_NAMES.has(normalizedToolName) ||
    effectiveKind === "edit" ||
    effectiveKind === "delete" ||
    effectiveKind === "move";
  const isReadOrSearchTool =
    READ_OR_SEARCH_TOOL_NAMES.has(normalizedToolName) ||
    effectiveKind === "read" ||
    effectiveKind === "search" ||
    effectiveKind === "think";

  let pendingAsk: ToolSafetyEvaluation | undefined;

  if (isShellTool || commands.length > 0) {
    for (const command of commands) {
      const cmdEval = evaluateDestructiveCommand(command);
      if (cmdEval?.decision === "deny") {
        return cmdEval;
      }
      if (cmdEval?.decision === "ask" && pendingAsk === undefined) {
        pendingAsk = cmdEval;
      }

      const secretCmdReason = checkSecretCommand(command);
      if (secretCmdReason !== undefined) {
        return {
          decision: "deny",
          category: "secret_access",
          reason: secretCmdReason,
        };
      }
    }
  }

  for (const filePath of paths) {
    if (isSecretFilePath(filePath)) {
      return {
        decision: "deny",
        category: "secret_access",
        reason: `Blocked access to secret file '${filePath}'.`,
      };
    }
  }

  const testsLocked =
    input.lockTests === true ||
    (input.lockTests !== false && process.env.T3CODE_LOCK_TESTS === "1");

  if (testsLocked) {
    if (isWriteOrDeleteTool && !isReadOrSearchTool) {
      for (const filePath of paths) {
        if (isTestFilePath(filePath)) {
          return {
            decision: "deny",
            category: "test_tampering",
            reason: `Blocked modification of test file '${filePath}' while test lock is active.`,
          };
        }
      }
    }

    if (isShellTool || commands.length > 0) {
      for (const command of commands) {
        const tamperingReason = checkTestTamperingCommand(command);
        if (tamperingReason !== undefined) {
          return {
            decision: "deny",
            category: "test_tampering",
            reason: tamperingReason,
          };
        }
      }
    }
  }

  return pendingAsk ?? { decision: "allow" };
}
