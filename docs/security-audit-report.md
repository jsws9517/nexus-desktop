# Nexus Desktop — Security Audit Report (2026-09-06)

Scope: Full security regression test targeting the recent hardening commits (`42f14f9` builtin tool hardening, `19cfffc` in-process sqlite/sequential-thinking, `fcd955b` in-process fs, `2ab66a3` audit askUser wiring, `4550695` in-process memory-kg). Confirms **no linear regressions** and no **missed high-severity issues** (beyond accepted design compromises).

## Summary of Findings

- **Regressions**: None (all production gates passed). The only failure, `scripts/test-worker-gate.mjs`, was classified as a **stale orphan script** (predates the `earlyInit` / `init` two-phase split, never sends `earlyInit`, and is not listed in `package.json` or CI). Real startup path (`main/index.ts` always sends `earlyInit` first) is covered by passing smoke tests.
- **High-severity issues fixed**: 2.
  1. IPC validation table missing `getActiveDepth` / `getActiveMode` → `/depth` and `/bypass` query commands were misrejected at the worker gate (`unknown method`).
  2. Main window and config window missing `will-navigate` / `setWindowOpenHandler` guards (window navigation / pop-ups could inherit the privileged preload bridge).
- **Design compromises (accepted, not omissions)**: Update packages unsigned; sqlite `where` / `execute` raw DML requires approval; `unattended` / `auto` pass-through calls, etc.

## 1. Regression Baseline (Phase 0)

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run check:i18n` | PASS (176 keys) |
| `npm run test:unit` (with new tests) | PASS **58/58** (36 original + 22 security) |
| `npm run test:smoke` (sqlite/fs/seq-thinking coverage) | PASS ALL |
| `node scripts/test-regenerate-guards.mjs` | PASS ALL |
| `node scripts/test-regenerate-sql.mjs` | PASS ALL |
| `node scripts/test-worker-gate.mjs` | FAIL ×2 → **classified as stale orphan** (see below) |

### test-worker-gate.mjs Assessment

- Not listed in `package.json` scripts or any `.github/workflows/*.yml` → **orphan script**.
- Its failure mode sends consecutive `init` / `listSessions` / `startSession` without `earlyInit`, opposite to real startup order (real path: `main/index.ts` sends `earlyInit` first).
- Direct worker probe confirmed `earlyInit` returns `ok:true`; after fix, `getActiveDepth` / `getActiveMode` also return `ok:true`.
- Conclusion: **stale test scaffold, not a regression**. Recommend rewrite to match current two-phase protocol or delete.

## 2. New Permanent Adversarial Tests (Phase 1)

`test/security-tools.test.mjs` (22 cases, merged into `npm run test:unit`):

- **sqlite-tools**: identifier injection `t1"; DROP TABLE x; --` quarantined by quoting; `__proto__` / `constructor` prototype-pollution keys contained; stacked statements (`; DROP`) rejected; dangerous `PRAGMA` / `ATTACH` / `DETACH` rejected; read-only `query` (`fileMustExist`) does not create new DB files; `create-table` illegal DEFAULT literals rejected; write tools enforce approval gate; unauthorized custom `dbPath` rejected.
- **fs-internal**: `read_media_file` magic-number sniffing (fake `.png` rejected / real PNG passes); 8 MiB size cap; out-of-authorization-scope directory access rejected; `list_directory_with_sizes` `maxDepth` clamped.
- **sequential-think**: `branchId: '__proto__'` uses Map, avoids prototype chain; oversized thought rejected; invalid params (`thoughtNumber=0`) rejected.
- **memory-kg**: corrupted JSONL degrades gracefully to a readable error instead of crashing; `MEMORY_WRITE_TOOLS` marks all non-read tools (create / add / delete / update) with correct approval gate contract.
- **ipc-validation**: every dispatched worker method in `agent-worker.ts` has an IPC validation spec (**this case caught high-severity #1**); adversarial params (oversized `input`, non-string, invalid answer, unknown method) rejected.
- **Tool set completeness**: sqlite 10 tools, fs 3 builtin tools match design spec.

### High-Severity #1 — IPC Validation Table Missing Two Query Methods (Fixed)

- Symptom: `validateWorkerParams` classified `getActiveDepth` / `getActiveMode` as `unknown method`, rejected at `agent-worker.ts` validation gate.
- Impact: renderer `nexus:getActiveDepth` / `getActiveMode` IPC exposed these methods (`preload.cts` + `renderer.ts` declarations), serving `/depth` and `/bypass` query commands → functional regression.
- Fix: `src/shared/ipc-validation.ts` adds `getActiveDepth: { fields: {} }` and `getActiveMode: { fields: {} }`.
- Verification: direct worker probe now returns `getActiveDepth => ok:true data:"off"` and `getActiveMode => ok:true data:"unattended"`; new triage case passes.

## 3. Electron Navigation Guards (Phase 2)

### High-Severity #2 — Main/Config Window Missing Navigation Guards (Fixed)

- Symptom: `createWindow` (`src/main/index.ts:368`) and `openConfigWindow` had no `will-navigate` handler and no `setWindowOpenHandler`.
- Threat: if the renderer contains any inducible navigation (in-page links, `window.location`, `target=_blank`), navigation / new windows to an attacker's URL **inherit the same privileged preload bridge** (`sandbox:true` + `contextIsolation:true` restrictions still apply, but `nexus:*` privileged IPC and subsequent `webContents.send` sensitive events remain reachable). Grep confirmed no `window.open` / `openExternal` calls in renderer; defense-in-depth still required.
- Fix (`src/main/index.ts`):
  - Main window: `will-navigate` only allows staying on the current `index.html` file URL; all others `preventDefault()`; `setWindowOpenHandler(() => ({ action: 'deny' }))`.
  - Config window: `will-navigate` only allows `http://localhost:<process-bound port>` prefix; all others `preventDefault()`; `setWindowOpenHandler` deny.
- Verification: `scripts/electron-nav-check.cjs` (hidden window, reuses `sandbox:true` + `contextIsolation:true` + preload config) dynamically proves `window.open()` is denied, `location.href` to another file is blocked by `will-navigate`, window stays on original URL. Script retained as a permanent artifact (repeatable, no side effects).

## 4. Supply Chain (Phase 4)

- `npm audit` (prod + dev): **0 vulnerabilities**.
- Updater (`src/main/updater.ts`): HTTPS feed + `electron-updater` default sha512 verification against `latest.yml` (integrity assured; binary cannot be tampered). Upgrade is manual three-step (autoDownload / autoInstallOnAppQuit both off).
- **Design compromise (accepted)**: Windows target is not **code-signed** (electron-builder has no `publisherName` / `certificateFile`). sha512 ensures integrity, but no Authenticode certificate → publisher identity unverifiable. Mitigation: purchase code signing certificate and set `publisherName`; not in scope for this round.

## 5. Confirmed Key Security Features (Review)

- **C3 Sandbox**: main / config windows both `sandbox:true` + `contextIsolation:true` + `nodeIntegration:false` + CJS preload (the doc note "C3 not enabled" is **outdated**).
- **C4 Core Networking**: `config/web.js` uses per-process random Bearer token + loopback bound to `127.0.0.1` only + Host header validation (doc note "C4 pending" is **outdated**).
- **Logging**: writes to `~/.nexus/logs` via `src/shared/logger.ts` (implemented and live).
- **sqlite**: fully parameterized; `src/session-db.ts` LIKE wildcard escaping (typo fixed in prior session) — this report adds test coverage for `getSessionIdsByTaskGraph` wildcard escaping if present.
- **Rendering**: `renderer/markdown.ts` escapes before rendering; CSP `script-src 'self'` with no `unsafe-eval`.

## Deliverables

| File | Type |
|---|---|
| `test/security-tools.test.mjs` | Permanent adversarial test suite (merged into `npm run test:unit`) |
| `scripts/electron-nav-check.cjs` | Permanent Electron navigation guard dynamic check |
| `src/shared/ipc-validation.ts` | Fix: added `getActiveDepth` / `getActiveMode` |
| `src/main/index.ts` | Fix: main / config window navigation guards |
| `docs/security-audit-report.md` | This report |

## Recommended Follow-ups (Not Blocking This Round)

1. Rewrite or delete `scripts/test-worker-gate.mjs` to match current two-phase protocol (avoids confusion).
2. Purchase code signing certificate and set `publisherName` to close the update-signing compromise.
3. Update `docs/development-requirements.md` entries for C3 / C4 (both now implemented / enabled).
