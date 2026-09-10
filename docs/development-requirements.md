# Nexus Desktop Development Requirements

> Source: Desktop architecture review (2026-08-19). Each item: ID / Priority / Status / Problem / Solution / Acceptance.
> Status: 🟡 Pending · 🔵 In Progress · 🟢 Done

## Priority Legend

- **P0** Release Quality: affects user-facing usability or release polish; ship first
- **P1** Performance / Security / Robustness: medium scope; advance with each iteration
- **P2** Architecture / Engineering / UX: continuous evolution; land incrementally

---

## A. Correctness & Release Quality

### A1. Hardcoded Log Path Cleanup · [P0] 🟢

**Problem**
- `src/main/index.ts`, `src/main/worker-host.ts`, `src/agent-worker.ts` hardcode `C:/Users/pgw/AppData/Local/Temp/opencode/` (the author's Windows temp directory).
- The string compiles into `dist/**/*` and ships inside `app.asar` (`package.json` `build.files`); on other users/CI machines the directory does not exist → swallowed by `try{}catch{}` → logs silently lost.
- The hardcoded username leaks into open-source source code; absolute Windows path is invalid on macOS/Linux.

**Solution**
1. New `src/shared/logger.ts`: `logsDir = join(homedir(), '.nexus', 'logs')`, `mkdirSync(recursive)`, date/level-based append; provides `debug/info/warn/error` levels, `NEXUS_DEBUG=1` enables debug.
2. All 4 call sites (`logf`, `DIAG`, `writeDiag`, `tracePerm`) routed through the new module.

**Acceptance** ✅ Done
- `npm run typecheck && npm run test:smoke` pass.
- `rg "C:/Users" src/ dist/` returns zero hits.
- Log directory consistent with `~/.nexus` data directory; cross-platform writable.

### A2. Incomplete Attachment Support · [P0] 🟢

**Problem**
- `nexus:openFile` declares `multiSelections` but only returns the first path; multi-select broken.
- `file_ready` click is a no-op; no open/reveal capability.
- Attachments limited to file dialog; no drag-and-drop/paste, no image preview.

**Solution** ✅
1. `nexus:openFile` returns `{ canceled, paths: string[] }`; preload/renderer sync the array.
2. New IPC: `nexus:revealFile` (`shell.showItemInFolder`) and `nexus:getFileInfos` (size + ≤2 MiB image dataURL preview).
3. Attachment area renders thumbnails + size; click reveals in Explorer; `file_ready` click reveals.
4. Drag-and-drop/paste files enter attachments via `webUtils.getPathForFile` (see E3).

**Acceptance** ✅
- Multi-file selection all enters attachment area; images show thumbnails.
- `file_ready` chip click reveals in Explorer.

### A3. Auto-Restart on Worker Crash · [P0] 🟢

**Problem**
- `onExit` only emits a log line; after a core crash all IPC hangs permanently with no UI recovery path.

**Solution** ✅
1. `startWorker()` rebuilt as restorable; `onExit` triggers exponential backoff (1s/2s/4s… cap 30s, max 3 attempts) to restart the worker and re-run `earlyInit` + `init`.
2. New standalone `initOkPromise` distinguishes init success/failure/timeout to avoid infinite wait on restart.
3. Restart success emits `nexus:workerRestarted`; renderer shows a notice and auto-reconnects the recent session.
4. `before-quit` sets `intentionallyStopped` to prevent restart during shutdown.

**Acceptance** ✅
- Kill the worker process → app auto-restarts and recovers the session; requests uniformly reject during restart instead of hanging.

---

## B. Performance

### B1. SQL Windowing for Messages & Sessions · [P1] 🟢

**Problem**
- `getMessages` loads the full `session.getMessages` then slices in JS; `getSessionStats` fetches all rows to estimate. Long sessions = O(n).

**Solution** ✅
1. Original `session-truncate.ts` refactored into `src/session-db.ts`: new `getMessageWindow`/`getMessageLast`/`getMessageCount`/`estimateSessionTokens` (500-row batch estimation), all SQL-paginated.
2. `AgentService.getMessages` / `getSessionStats` use windowed queries; `userBefore` uses SQL COUNT + worker-marker `substr+LIKE` exclusion.
3. `regenerate/withdraw` continue using `getMessageRows` + `deleteMessagesFrom` (unchanged semantics).

**Acceptance** ✅
- Response time proportional to window size, not total size; `regenerate/withdraw` userIndex semantics unchanged.
- `npm run test:smoke` covers getMessages / getMessages last.

### B2. Renderer Split & Constant Dedup · [P1] 🔵

**Problem**
- `renderer.ts` is a 2200+ line monolith; `WORKER_MARKERS`/`KEY_MASK`/`EARLY_METHODS` duplicated across multiple locations, drift already observed.

**Solution** 🔵 (Phase 1 done, Phase 2 deferred)
- ✅ Phase 1: new `src/shared/constants.ts` (`EARLY_METHODS`/`WORKER_MARKERS`/`isWorkerPrompt`/`isWorkerBlockText`/`KEY_MASK`), main / worker / agent-service / renderer all import from a single source (renderer directly uses ESM `../shared/constants.js`, no preload injection needed).
- ✅ Phase 1: extracted `src/renderer/i18n.ts` (STR dictionary + `t/fmtNum/applyI18n/loadLanguage`) and `src/renderer/markdown.ts` (`renderBlocks/attachCodeCopy/hydrateImages`), both as pure-function modules testable in isolation.
- ⏳ Phase 2 (deferred): extract `sessions.ts` / `mcp.ts` / `settings.ts` components from renderer.ts — blocked on shared mutable state and lack of DOM test infrastructure; advance after D3 test framework is stable.

**Acceptance** ✅ Phase 1 done
- `npm run typecheck` pass; `WORKER_MARKERS` etc. single-point definitions.
- Smoke + session restore/regenerate/withdraw manual regression pass.

---

## C. Security & Robustness

### C1. IPC Parameter Validation · [P1] 🟢

**Problem**
- `main/index.ts` `call()` forwards arbitrary `params` to worker; `chat`/`setCwd` have no type/length constraints; `resolvePermission` answer unconstrained; A/B/E introduced 7 additional pass-through IPCs (revealFile/getFileInfos/readImagePreview/pin/tray/logs) also without validation.

**Solution** ✅
1. New `src/shared/ipc-validation.ts` single validation table (same-origin pattern as `EARLY_METHODS`): each worker method declares field types/enums/upper bounds (`chat.input` ≤64 KB, `answer ∈ {y,a,n}`, `setCwd.cwd` ≤4096, etc.).
2. `agent-worker.handleRequest` validates uniformly before dispatch; invalid → `respondError('invalid request: …')`.
3. Main-side pass-through IPCs guarded with `isString/isBoolean/isFiniteNumber/isValidPathList` (paths ≤50, single path ≤4096).

**Acceptance** ✅
- Invalid parameters return structured errors instead of forwarding exceptions; `npm run test:smoke` pass.

### C2. Always Allow in Permission Modal · [P1] 🟢

**Problem**
- Core `path-authorizer` already supports `'a'` (persistent global allowlist), but `askPermission` only returned `'y'|''`; UI only had Allow/Deny.

**Solution** ✅
1. `static/index.html` permission modal adds a third button "Always Allow" (i18n `allowAlways`/`allowAlwaysHint` already ready from B2) → renderer calls `answerPermission('a')`.
2. `agent-service.onPermissionRequest` treats both `'y'|'a'` as allow (tool-path semantics lack "always" meaning, equivalent to once).
3. Worker validates allowlist `['y','a','n']`; `cleanQuestion` preserved.

**Acceptance** ✅
- Path authorization "Always" persists per core GLOBAL_SCOPE semantics; tool-call "Always" is equivalent to once.

### C3. Main-Window Sandbox Evaluation · [P2] 🟡

**Solution** ⚠️ Rolled back
- Enabling `sandbox: true` in `createWindow` conflicts with ESM preload: `"type": "module"` makes `dist/preload.js` an ESM file (containing `import`), while sandboxed preload only supports CommonJS, causing preload load failure (`SyntaxError: Cannot use import statement outside a module`), `window.nexusDesktop` injection failure, and session list render failure.
- Rolled back main window to `sandbox: false` (config window has no preload, remains `sandbox: true`). To retain the hardening, preload must be compiled separately as CJS before re-enabling.

**Acceptance** ⚠️ Pending
- [ ] Compile preload to CommonJS (`dist/preload.cjs` + update references), re-enable `sandbox: true`, re-run `npm run build && npm run test:smoke` and manually verify session list / A2 drag-and-drop / E3 paste.

### C4. Config WebUI Security Review · [P3] 🟡

**Solution**
- Review core `config/web.js` loopback binding + token protection; supplement documentation.

**Acceptance**
- Review notes recorded in this item's status; no loopback/auth gaps.

---

## D. Architecture & Engineering

### D1. Schema-Coupling Hardening · [P1] 🟢

**Problem**
- Original `session-truncate.ts` had self-authored TODO "core column/path change requires sync"; directly copied core `messages` table structure.

**Solution** ✅ (completed alongside B1)
1. After opening DB, `PRAGMA table_info(messages)` validates required columns; missing columns trigger soft-fail (empty result + log), no crash.
2. Consolidated into `src/session-db.ts`, exposing only semantic APIs (`getMessageWindow/getMessageLast/getMessageRows/deleteMessagesFrom/getNonEmptySessionIds/estimateSessionTokens`).
3. Path derivation logic consistent with core plus anchor comments.

**Acceptance** ✅
- Desktop does not crash on core schema changes (degraded logs observable); `test:smoke` pass.

### D2. Type the Agent Surface · [P2] 🟢

**Solution** ✅
- Core dependencies already carry official types: `agent-service.ts` uses `Agent` (`nexus-coder/dist/src/agent.js`), `Config`/`ProviderConfig` (`config/types.js`), `Session` (`session/types.js`), `private agent: Agent | null`.
- Replaced 3 occurrences of `agent.currentSessionId` (private) with public `getCurrentSessionId()`; `getSessionStats` removed `as { countTokens }` cast, using `LLMProvider.countTokens` directly.
- `redactConfig`/`saveProvider`/`saveSpeechProvider`/`saveVisionProvider` consolidated to typed casts (`Parameters<typeof cfg.setProvider>[1]` etc.).

**Acceptance** ✅
- `npm run typecheck` pass; `agent-service.ts` has no bare `any`/`as any` (grep clean).

### D3. Test Infrastructure · [P2] 🟢

**Solution** ✅ (landed after B2/D1 pure functions were ready)
- `test/` directory + Node `node:test` (zero new dependencies):
  - `constants.test.mjs`: `isWorkerPrompt`/markers/`EARLY_METHODS`.
  - `markdown.test.mjs`: escaping / fenced / diff / tables / task lists / images (also fixed `renderInline` escaping and table `<th>` first-column issue).
  - `session-db.test.mjs`: temp DB (`LLMA_DATA_DIR`) + mirrored messages schema, validates windowing / deletion / userBefore / estimation.
  - `i18n.test.mjs`: 132 keys bilingual completeness + new-key assertions.
- `package.json` adds `test:unit` (`npm run build && node --test "test/*.test.mjs"`); CI adds Unit tests step.

**Acceptance** ✅
- `npm run test:unit` 30/30 pass; CI includes this step.

### D4. i18n Extraction & Error Localization · [P2] 🟢

**Solution** ✅
- STR dictionary extracted to `i18n.ts` (✅ alongside B2).
- New `scripts/check-i18n.mjs`: asserts every key is non-empty in both languages + all `data-i18n*` attributes in `index.html` resolve → `npm run check:i18n` (132 keys / 40 used OK), CI added.
- New `localizeError()` maps common core/network errors (401/429/timeout/network/provider etc.); renderer error display path (`errText`) unified.

**Acceptance** ✅
- `npm run check:i18n` pass; new copy missing either language triggers CI error; common errors display localized messages.

---

## E. UX (Incrimental Delivery)

### E1. Persistence: Window, CWD, Draft · [P2] 🟢

**Solution** ✅
1. Window bounds: `main` listens to move/resize (500 ms debounce), writes to `~/.nexus/desktop.json`; `createWindow` restores.
2. Last cwd: `setCwd` success recorded in main process; `earlyInit` applies on startup (silently ignored if directory no longer exists).
3. Input draft: `localStorage('nexus.draft.<sessionId>')` debounce-saved, restored on session switch / restart, cleared on send.

**Acceptance** ✅
- After restart, window position, project directory, and current session draft all restore.

### E2. Markdown Rendering Upgrade · [P2] 🟢

**Solution** ✅
1. Extracted standalone `markdown.ts`: tables, task lists (`- [ ]`), code block language badge + copy button, images (data:/blob:/local-path dataURL hydration).
2. Streaming mode: 300 ms debounce incremental render (≤12 K chars), `turn_end` final render.
3. `renderAssistantStream` unified post-render attachment of copy buttons + image hydration.

**Acceptance** ✅
- Tables / task lists / images / code copy all functional; streaming preview smooth (long output falls back to plain-text streaming).

### E3. Search, Pin, Tray, Drag & Paste · [P3] 🟢

**Solution** ✅
1. Search: sidebar input → `listSessions({ search })` (name/ID contains match, 250 ms debounce).
2. Pin: `~/.nexus/desktop.json` stores `pinnedIds`; sidebar pinned group + per-row 📌 button.
3. Tray: `Tray` (inline 16×16 icon, no file dependency) + menu (Open / Quit); settings toggle "Minimize to tray on close" (default off).
4. Drag-and-drop / paste: composer `drop` + textarea `paste` → `webUtils.getPathForFile` enters attachments, linked with A2 thumbnails.

**Acceptance** ✅
- Search hits, pin effective, tray functional, drag-and-drop / paste images attachable.

### E4. In-App Log Viewer · [P3] 🟢

**Solution** ✅
- Settings modal "Logs" section: reads `~/.nexus/logs/` last 300 lines (`recentLogLines`), renders `<pre>`, refreshable.

**Acceptance** ✅
- View / export recent logs without external tools for troubleshooting.

---

## Implementation Order

| Phase | Scope | Dependencies | Status |
|---|---|---|---|
| ① Release Quality | A1 · A2 · A3 | — | ✅ Done |
| ② Performance + Engineering | B1 + D1 (session-db) · B2 | D1 | ✅ Done (B2 Phase 1) |
| ③ Security | C1 · C2 · C3 | — | ✅ Done (C3 rolled back pending CJS preload) |
| ④ Testing / Engineering | D2 · D3 · D4 | ② | ✅ Done |
| ⑤ UX | E1 → E2 → E3 → E4 | ② | ✅ Done |

> Current iteration scope: **All A/B/C/E groups completed; D1–D4 completed** (D1 alongside B1, D4 partly alongside B2). Remaining items: C4 (Config WebUI low-priority review), C3 rolled back pending CJS preload, B2 Phase 2 (renderer component split, awaiting D3 test infrastructure stability).
> Update the corresponding status marker after each item is completed; `docs/development-requirements.md` is the single source of truth.
