---
name: sdd
description: Spec-Driven Development workflow (Explore -> Specify -> Plan -> Implement -> Verify -> Learn) tailored for T3 Code's Effect v4, oxlint-plugin-t3code, and multi-surface architecture.
---

# Spec-Driven Development (T3 Code)

Follow these six phases for multi-file features, orchestration changes, provider adapters, and UI work in `t3code`.

## 1. Explore

- Read `AGENTS.md` and relevant `docs/internals/` pages (`overview.md`, `effect-services.md`, `testing.md`, `web-ui.md`).
- Inspect the owning layers before editing:
  - Wire contracts & defaults: `packages/contracts/src/` (`orchestrationV2.ts`, `settings.ts`, `providerPolicy.ts`, `rpc.ts`)
  - Pure orchestration & services: `apps/server/src/orchestration-v2/`
  - Provider runtime helpers & adapters: `packages/provider-core/`, `packages/provider-acp/`, `apps/server/src/orchestration-v2/Adapters/`
  - MCP toolkits & transport: `apps/server/src/mcp/`
  - Shared client runtime & Web UI: `packages/client-runtime/src/`, `apps/web/src/`
- Walk the **Hit every surface** checklist: Entry points (Chat, Settings, Command Palette, Keybindings), Clients (web/desktop/mobile via `client-runtime`), Providers (all adapters), Agents/MCP (`OrchestratorMcpService` + scheduled tasks), Contracts, Reverse states (every toggle/state has an undo/unset path), and Connection modes (local/remote/tunnel).

## 2. Specify

- Define exact `effect/Schema` changes in `packages/contracts/src/` first (backwards-compatible decoding defaults via `Schema.withDecodingDefault`, forward-compatible optionals where older clients/servers interact).
- Specify service shapes (`Context.Service` tag + methods + typed `Schema.TaggedError` failures), adapter hooks, and pure helper boundaries.
- Keep `Orchestrator` pure (no I/O); isolate subprocess, filesystem, and network I/O in Effect services and `OrchestrationEffectWorkerV2`.

## 3. Plan

- Split changes into minimal, non-overlapping file slices per layer (`contracts` -> `provider-core` / `server` -> `client-runtime` / `web`).
- Decide verification scope upfront: which package `typecheck`s, unit/logic tests (`*.test.ts` / `*.logic.test.ts`), browser tests (`*.browser.test.tsx`), and `evals/` cases (if changing model-facing instructions or MCP tool schemas) are required.
- Do not commit scratch plans or working notes inside the repo (`AGENTS.md` § Plans and work artifacts).

## 4. Implement

### Effect v4 & Server Conventions (`docs/internals/effect-services.md`)

- Use Effect subpath namespace imports (`import * as Effect from "effect/Effect"`, never `import { Effect } from "effect"`).
- Service module layout: imports -> errors & schemas -> `Context.Service` tag (`"t3/<area>/<Name>"`, inline interface using `Service["Service"]`) -> private `make` -> `export const layer = Layer.effect(...)`.
- Use `Effect.fn("Service.operation")` for reusable Effect functions; reserve `Effect.fnUntraced` for hot loops/stream chunks with a brief comment explaining why (`t3code/prefer-effect-fn`).
- Keep transports (`ws.ts`, HTTP routes, MCP handlers) thin: decode input, call one service method, map errors.
- MCP tools MUST go through `McpToolAccess` (`Declaration` / `toLayer`) and `McpHttpServer`'s `toolkitRegistration` (`t3code/no-raw-mcp-registration`).
- Protected client RPC commands MUST use `createEnvironmentRpcCommand` + `CLIENT_GUARDED_RPC_SCOPES` (`t3code/no-rpc-permission-bypass`).

### Web UI & React Compiler Conventions (`docs/internals/web-ui.md`)

- Use primitives from `apps/web/src/components/ui`; select `variant`/`size` instead of restyling via `className` (`shadcn/no-restyle`). Put layout classes on the parent container.
- Keep components React Compiler clean: no `useMemo`, `useCallback`, or `"use memo"` (`t3code/no-manual-memo`); no hookless `use*` helpers (`t3code/no-hookless-use-function`); omit `useEffect` unless synchronizing external state with `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- Avoid unused exports (`knip` fails CI).

### Testing Rules (`docs/internals/testing.md`)

- Extend existing test files/tables before adding new files; keep tests at the lowest layer that fails on `main`.
- Never use `Date.now()`, `performance.now()`, `setTimeout`, or polling loops in tests (`t3code/no-wall-clock-in-tests`, `t3code/no-polling-loop-in-tests`, `t3code/no-real-time-wait-in-tests`). Use `it.effect` + `TestClock`, `Deferred`, `Queue.take`, or `drain()`.
- Browser tests (`*.browser.test.tsx`) MUST use `await using screen = await render(...)` (`t3code/require-disposable-render`).

## 5. Verify

- Run the **verify-t3** skill (`.\node_modules\.bin\vp.cmd` scoped `typecheck`, `test run`, `lint`, `check:changed`).
- Do not report checks as passing unless observed with zero failures after the final edit.

## 6. Learn

- If a recurring failure pattern, workspace quirk, or architectural invariant was discovered:
  - Record an ACE-curated lesson via the `rsi_record_lesson` MCP tool (when `RsiService` is enabled) so future sessions inherit it in `[RSI Lessons]`.
  - Update `docs/internals/` only if an architectural boundary or hidden constraint changed across modules.
