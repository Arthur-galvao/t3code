---
name: obsidian-brain
description: Obsidian Second-Brain memory integration for T3 Code RSI lessons, MOC indexing, and atomic Markdown knowledge graph notes.
---

# Obsidian Second-Brain Memory (`obsidian-brain`)

`t3code` integrates its Recursive Self-Improvement (`RsiService`) playbook directly with an Obsidian-compatible Markdown folder (`T3-Brain/`) so distilled engineering memory stays browsable, linkable, and auditable by both humans and agents.

## 1. Architecture & Vault Layout

When `obsidianMemorySyncEnabled` is `true` (default), `RsiService` automatically mirrors persisted lessons (`lessons.json`) to `<vaultRoot>/T3-Brain/`:

- **Custom vault path**: Configured via `obsidianVaultPath` in `ServerSettings` (or Thread Settings -> **Workflow safeguards**).
- **Default fallback path**: When `obsidianVaultPath` is empty (`""`), defaults to `<stateDir>/obsidian-vault/T3-Brain/`.

Generated structure:

```text
<vaultRoot>/
└── T3-Brain/
    ├── 00-MOC-Memory.md        # Auto-maintained Map of Content index
    └── Lessons/
        └── <lesson.id>.md      # Atomic note per curated RSI lesson
```

## 2. Note Conventions & Knowledge Graph Format

- **Index (`00-MOC-Memory.md`)**:
  - YAML frontmatter with `title`, `updatedAt`, `totalLessons`, and `tags: [t3-memory, moc]`.
  - Groups lessons deterministically into **Global Lessons** (`scope: global`) and **Scoped (Glob) Lessons** (`scope: glob`) using `[[Lessons/<id>|<title>]]` Obsidian wikilinks, showing `key`, `confidence`, `hits`, and file globs.
- **Atomic Lesson Notes (`Lessons/<id>.md`)**:
  - YAML frontmatter (`id`, `key`, `title`, `scope`, `confidence`, `hits`, `globs`, `createdAt`, `updatedAt`, `tags: [t3-memory, rsi-lesson, <scope>]`).
  - Backlink header `[[00-MOC-Memory]]`.
  - Structured sections: `## Guidance`, `## Trigger Condition`, and `## Rationale Trace`.

## 3. Synchronization Triggers & Fault Tolerance

`RsiService` updates `T3-Brain/` automatically during:

1. Initial layer hydration (`hydrateLocked`) when existing `lessons.json` entries exist.
2. Any playbook mutation (`recordLesson`, `demoteLesson`, `boostLessonsLocked`, `deleteLesson`, and post-run auto-distillation in `recordRunTelemetry`).
3. Pruned/deleted lessons are automatically removed from `Lessons/*.md` so the graph stays free of stale notes.
4. Filesystem sync errors log a warning and never block orchestration turns or corrupt `lessons.json`.

## 4. Agent Usage Rules

- **Do not duplicate MCP schemas**: Read and write structured lessons through existing `rsi_query_lessons` and `rsi_record_lesson` tools (which keep `agentContextBudget.json` exact and sync `T3-Brain/` automatically).
- Keep lesson `title` and `guidance` atomic, falsifiable, and tied to concrete `globs` when path-specific so `[RSI Lessons]` session injection remains within its 600-character budget.
