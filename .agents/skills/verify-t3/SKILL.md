---
name: verify-t3
sync-global: false
description: Scoped Windows-safe verification workflow for T3 Code using workspace-local vp.cmd (effect-tsgo typecheck, Vitest unit/browser tests, oxlint-plugin-t3code lint, knip, and check:changed).
---

# Verify T3 Code (`verify-t3`)

Always use T3 Code's **workspace-local** Vite+ binary (`.\node_modules\.bin\vp.cmd` from repo root, or `..\..\node_modules\.bin\vp.cmd` from inside `apps/*` / `packages/*`).

> **Windows Runner Rule**: Do **NOT** invoke global `vp.cmd` for `test` runs. Global `vp.cmd` resolves the global `vite-plus` package instead of workspace `node_modules`, causing `Vitest failed to find the current suite` / missing config errors.

> **Scope Rule**: Do **NOT** run repo-wide `vp check`, `vp run -r test`, or `vp run -r typecheck` unless explicitly requested (`AGENTS.md`). Run only the affected package typechecks, targeted tests, lint, and `check:changed`.

## 1. Typecheck (`effect-tsgo`)

Run per affected workspace package from repository root:

```powershell
.\node_modules\.bin\vp.cmd run --filter @t3tools/contracts typecheck
.\node_modules\.bin\vp.cmd run --filter @t3tools/provider-core typecheck
.\node_modules\.bin\vp.cmd run --filter t3 typecheck
.\node_modules\.bin\vp.cmd run --filter @t3tools/web typecheck
```

Combine filters when needed (e.g. `--filter @t3tools/provider-core --filter @t3tools/provider-acp typecheck`).

## 2. Targeted Tests (Vitest)

Run focused test files directly (use `-t "<name>"` to narrow large suites):

```powershell
# Package-level tests for small packages
.\node_modules\.bin\vp.cmd run --filter @t3tools/contracts test
.\node_modules\.bin\vp.cmd run --filter @t3tools/provider-core test

# Specific test files from repo root or package directory
.\node_modules\.bin\vp.cmd test run apps/web/src/components/settings/SettingsPanels.logic.test.ts
```

For `apps/server` tests, run from `apps/server`:

```powershell
Push-Location apps/server
..\..\node_modules\.bin\vp.cmd test run src/orchestration-v2/CommandPolicy.test.ts
Pop-Location
```

Note: Inline `node -e` debugging scripts that import `effect` must also run from `apps/server` or the owning package directory (`effect` does not resolve from the repo root).

## 3. Lint (`oxlint-plugin-t3code` + React Compiler + `@shadcn/lint`)

Lint all modified/added `.ts` and `.tsx` files:

```powershell
.\node_modules\.bin\vp.cmd lint <path1> <path2>
.\node_modules\.bin\vp.cmd fmt --check <path1> <path2>
```

Verify zero errors and zero warnings (check specifically for `t3code/prefer-effect-fn`, `t3code/no-raw-mcp-registration`, `t3code/no-rpc-permission-bypass`, `t3code/no-wall-clock-in-tests`, `t3code/no-polling-loop-in-tests`, `t3code/no-manual-memo`, `t3code/no-unreasoned-state-sync`, and `shadcn/no-restyle`).

## 4. Changed-Files CI Gate

Run before finishing multi-file changes to cover formatting, lint, `knip` (unused exports/files), affected typechecks, and related tests:

```powershell
.\node_modules\.bin\vp.cmd run check:changed
```

## 5. UI & Evals (When Applicable)

- **Web UI flows**: Use the `test-t3-app` skill with `Replay (dev)` (`window.t3dev.replay("showcase")`) rather than spending paid model quota.
- **Model-facing prompts / MCP schemas**: Follow `evals/README.md` before finishing.
