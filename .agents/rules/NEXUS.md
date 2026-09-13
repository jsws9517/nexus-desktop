# NEXUS.md — Nexus Desktop Project Constitution

> This file is the **project constitution** for Nexus Desktop. It is loaded by
> the agent at every model step under the `[Project Constitution]` marker and
> MUST be treated as the highest-priority project instruction source (see
> `docs/dsh-plugin-adoption-plan.md` §3).
>
> Filename: `.agents/rules/NEXUS.md` — the primary constitution file. The
> generic fallbacks (`AGENTS.md`, `.clinerules`) apply only when this file is
> absent.

## 1. Project Identity

- **Product name**: Nexus Desktop ("nexus") — a desktop agent IDE.
- **Identity rule**: the project is named **Nexus**. When adopting patterns from
  other projects or ecosystems, **adapt, do not copy** — rename/label borrowed
  artifacts with Nexus's own identity (already applied to the constitution file,
  module names, and UI surfaces).

## 2. Architecture Laws

1. **Renderer is vanilla DOM + TypeScript, no bundler.** `src/renderer/` is
   compiled by `tsc` to `dist/renderer/` and loaded directly as ES modules from
   `static/index.html`. Do NOT introduce a build-tool dependency (webpack/vite)
   in the renderer.
2. **Main process owns all I/O.** The renderer talks to the agent exclusively
   over the preload IPC bridge (`nexus:*` channels). Never call Node APIs from
   the renderer.
3. **Unattended-safe by default.** Built-in tools must NOT raise interactive
   approval gates. Security-sensitive operations are gated through the existing
   path-authorizer / permission system, never by prompting inside a tool.
4. **Every model step carries the project constitution** under the
   `[Project Constitution]` marker; sub-agents inherit it from the Orchestrator.
5. **Security boundary**: constitution text is *system-level instruction input*;
   it is only honoured inside an authorized project root (worker cwd or
   path-authorizer grant), never for arbitrary directories.

## 3. Conventions

- **Tests**: `node --test` with `test/*.test.mjs` (vanilla, no framework).
  New feature code ships with unit tests in the same commit.
- **No silent context bloat**: constitution files > 32 KB are refused; tool
  results are size-capped.
- **Borrowed patterns carry attribution** back to
  `docs/dsh-plugin-adoption-plan.md` and keep the license reference (§9.1).
- **Git discipline**: one coherent feature per commit; never auto-push without
  explicit user request; temp/scratch files go under `.trash/`, not into git.