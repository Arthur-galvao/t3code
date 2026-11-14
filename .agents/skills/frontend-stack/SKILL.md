---
name: frontend-stack
description: Curated T3 Code Frontend Stack workflow (Base UI + Tailwind v4 + Coss/Spell/MagicUI/ReactBits registries, 21st.dev surgical blocks, Mobbin/Designeer/Inspora references, and EGM UI quality gates).
---

# T3 Code Frontend Stack (`frontend-stack`)

Use this stack discipline for all Web UI (`apps/web`) features, settings panels, dialogs, onboarding flows, and showcase surfaces in `t3code`.

## 1. Core Application Primitives (`apps/web/src/components/ui`)

- **Foundation**: `@base-ui/react` (`^1.9.0`) + Tailwind CSS v4 (`@tailwindcss/vite`) + `class-variance-authority` (`base-mira` style in `apps/web/components.json`) + `lucide-react` icons.
- **No Primitive Restyling (`shadcn/no-restyle`)**: Never pass structural or visual override classes via `className` to primitives imported from `~/components/ui/*` (`Button`, `Switch`, `SelectTrigger`, `Input`, `DraftInput`, etc.). Put layout/spacing classes on wrapper `<div>` elements or extend named variants (`variant` / `size`) inside `apps/web/src/components/ui/`.
- **State & Memoization Discipline**: Keep components React Compiler clean:
  - Never use manual `useMemo`, `useCallback`, or `"use memo"` (`t3code/no-manual-memo`).
  - Never create hookless `use*` helpers (`t3code/no-hookless-use-function`).
  - Avoid `useEffect` state syncing (`t3code/no-unreasoned-state-sync`); derive values inline or reset via React `key`.

## 2. Registry & Component Sourcing Rules (`apps/web/components.json`)

| Source        | Role in `t3code`                                   | Rules & Constraints                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@coss`       | Primary `@base-ui/react` primitives & app patterns | Default source for core controls, popovers, dialogs, forms, settings rows.                                                                                                                                               |
| `@spell`      | Subtle app micro-interactions & feedback           | Use for lightweight, keyboard-safe stateful polish inside app chrome.                                                                                                                                                    |
| `@magicui`    | High-craft SaaS/AI surfaces                        | Use selectively for bento grids, marquees, terminal/code beams, animated lists, number tickers. Check CSS bundle impact.                                                                                                 |
| `@react-bits` | **Strict showcase isolation**                      | Use **only** in hero, onboarding, or empty-state showcase surfaces. Always wrap heavy WebGL/Canvas effects in `React.lazy` + `<Suspense>` and honor `prefers-reduced-motion`.                                            |
| `21st.dev`    | Surgical block installation                        | Install individual blocks via `npx shadcn@latest add ...`, then immediately rewrite primitives/imports to `@base-ui/react` (`~/components/ui/*`) so `@radix-ui/*` duplicates are never added to `apps/web/package.json`. |
| `uiverse.io`  | Micro CSS extraction only                          | **Never** import HTML/JSX as a component base; extract only pure CSS `@keyframes` or gradient tokens into Tailwind utilities when needed.                                                                                |

## 3. Visual Reference & UX Benchmark Layer

Before writing components for multi-step flows, settings, command palettes, or onboarding:

1. **Flow & Information Architecture**: Check **Mobbin** (`mobbin.com`) to benchmark navigation hierarchy, empty states, and progressive disclosure patterns.
2. **Aesthetic Direction**: Reference **Designeer** (`designeer.xyz`) and **Inspora** (`inspora.design`) during the SDD Specify phase for typography hierarchy, surface contrast, and spatial rhythm—without importing arbitrary design systems over `apps/web` tokens.

## 4. EGM Quality Gate (Before Finishing UI Edits)

Apply these `egm-review` lenses before marking UI work complete:

- **`egm-zoom-out`**: Did we reuse existing `~/components/ui/*`, `settingsLayout.tsx`, and Tailwind tokens instead of introducing a parallel UI abstraction or extra dependency?
- **`egm-codebase-details`**: Are imports Base UI compatible, free of `@radix-ui/*`, and free of manual `useMemo`/`useCallback`?
- **`egm-structural`**: Does `settingsSearch.ts`, `SettingsPanels.tsx`, `useSettingsRestore`, and project scoping stay symmetric across all surfaces?
- **Verification**: Run `.\node_modules\.bin\vp.cmd run --filter @t3tools/web typecheck` and `.\node_modules\.bin\vp.cmd lint <touched files>`.
