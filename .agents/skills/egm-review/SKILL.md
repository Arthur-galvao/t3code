---
name: egm-review
description: Epistemic Goldfish Memory (EGM) multi-lens audit protocol for zero-context verification of specs, plans, and code changes in T3 Code.
---

# Epistemic Goldfish Memory Audit (`egm-review`)

Apply the Epistemic Goldfish Memory (EGM) protocol when exploring, specifying, reviewing plans, or auditing code changes in `t3code`. Each lens operates with **zero assumed tribal knowledge**—every claim must be verified directly against files on disk and executable checks.

## The 7 EGM Lenses

| Lens                                                             | Core Question                                                 | `t3code` Checks                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Zoom-Out** (`egm-zoom-out`)                                 | Is this the simplest design that solves the problem (YAGNI)?  | Reuse `RsiService`, `ServerSettings`, `SettingsPanels`, and `~/components/ui/*`; do not add parallel stores, extra packages, or unrequested MCP tools that expand `agentContextBudget.json`.                                 |
| **2. Design** (`egm-design`)                                     | Are service boundaries, failure modes, and concurrency sound? | Effect v4 `Context.Service` + `Layer.effect`, mutex (`Semaphore`), typed errors, non-blocking vault/side-effect fallbacks (`Effect.catch`), deterministic timestamps (no wall-clock in tests).                               |
| **3. Codebase Details** (`egm-codebase-details`)                 | Does the implementation match real symbols and lint rules?    | Effect v4 subpath imports (`import * as Effect from "effect/Effect"`), `Effect.fn`, `Schema.withDecodingDefault`, `shadcn/no-restyle`, `t3code/no-manual-memo`, `t3code/no-wall-clock-in-tests`, no unused exports (`knip`). |
| **4. Implementation Readiness** (`egm-implementation-readiness`) | Are paths, symbols, defaults, and checks unambiguous?         | Every task specifies exact file paths, schema field defaults, reverse/reset states, and workspace-local `.\node_modules\.bin\vp.cmd` commands.                                                                               |
| **5. Comprehension** (`egm-comprehension`)                       | Can an unfamiliar reader understand every term?               | Define acronyms (`RSI`, `CCR`, `MOC`, `EGM`, `SDD`) cleanly in skills, settings descriptions, and Obsidian notes.                                                                                                            |
| **6. Structural** (`egm-structural`)                             | Are layers and documents symmetric?                           | Contracts (`packages/contracts`) -> Server (`apps/server`) -> Web (`apps/web`: `settingsSearch.ts`, `SettingsPanels.tsx`, `SettingsPanels.logic.test.ts`). Clean Markdown heading hierarchy.                                 |
| **7. Style** (`egm-style`)                                       | Is prose crisp, objective, and free of fluff?                 | Remove filler; state constraints, file paths, and invariants concisely.                                                                                                                                                      |

## Execution Cadence

1. **Before Coding (Specify / Plan)**: Run **Zoom-Out**, **Design**, and **Implementation Readiness**.
2. **During UI Work**: Pair with **`frontend-stack`** and check **Codebase Details** + **Structural**.
3. **Before Claiming Done (Verify)**: Run **Codebase Details**, **`verify-t3`**, and capture durable lessons via **`obsidian-brain`**.
