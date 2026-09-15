# NEXUS.md — Nexus Desktop Project Constitution

> This file is the **project constitution** for Nexus Desktop. It is loaded by
> the agent at every model step under the `[Project Constitution]` marker and
> MUST be treated as the highest-priority project instruction source (see
> `docs/dsh-plugin-adoption-plan.md` §3).
>
> Filename: `.nexus/rules/NEXUS.md` — the primary constitution file, under the
> single project `.nexus/` folder (rules, skills, temp). User-level session
> memory lives in the global `~/.nexus/`, never in a project folder. The generic
> fallbacks (`AGENTS.md`, `.clinerules`, legacy `.agents/`) apply only when this
> file is absent.

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
   approval gates **inside tool execution**. Security-sensitive operations are
   gated through the existing path-authorizer / permission system. User
   confirmation therefore comes from the conversation level (an explicit user
   message or a permission-system grant / auto-approve rule), never from a
   discretionary in-tool prompt — this is what "explicit user request" means
   downstream (see §3 Git discipline).
4. **Every model step carries the project constitution** under the
   `[Project Constitution]` marker; sub-agents inherit it from the Orchestrator.
5. **Security boundary**: constitution text is *system-level instruction input*;
   it is only honoured inside an authorized project root (worker cwd or
   path-authorizer grant), never for arbitrary directories.

## 3. Conventions

- **Tests**: `node --test` with `test/*.test.mjs` (vanilla, no framework).
  New feature code ships with unit tests in the same commit. Trivial changes
  (typo/doc/config edits, refactors with no behavior change) may omit tests.
- **No silent context bloat**: constitution files > 32 KB are refused; tool
  results are size-capped.
- **Borrowed patterns carry attribution** back to
  `docs/dsh-plugin-adoption-plan.md` and keep the license reference (§9.1).
- **Git discipline**: one coherent feature per commit; never auto-push without
  explicit user request (satisfied only by a conversation-level instruction or
  permission grant, per law §2.3); temp/scratch files go under `.nexus/trash/`,
  never into git.
- **Storage & retention discipline** (kept in sync with `src/shared/logger.ts`,
  `src/shared/bounded.ts`, `src/slash-log.ts`):
  - User-level memory/logs land **only** in the global `~/.nexus/`; a project
    `.nexus/` holds just rules, skills, and trash — never nested memory copies.
  - Runtime logs: per-day per-level files; a single file past 5 MB rolls over
    (≤ 3 shards) and logs older than 30 days are pruned.
  - Slash logs: retained 90 days, then pruned.
  - Secrets (API keys, Bearer tokens, authorization headers) are redacted
    before any log line hits disk.
  - Token-estimate caches are bounded (≤ 200 entries); in-memory caches must
    never grow without an eviction cap.