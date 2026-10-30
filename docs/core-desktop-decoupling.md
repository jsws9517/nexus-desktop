# Core / Desktop Decoupling

How `nexus-desktop` upgrades without repacking the whole Electron app on every
`nexus-coder` change, and how each side is updated and versioned.

## Two artifacts, two upgrade paths

| | Desktop (full) | Core (overlay) |
|---|---|---|
| Artifact | `nexus-Setup-<ver>.exe` | `core-<ver>.tar.gz` |
| Manifest | `latest.yml` | `latest-core.yml` (+ `.sig`) |
| Size | ~112 MB | ~1 MB |
| Contains | Electron, native modules, desktop code, **and** a baseline `nexus-coder` | `nexus-coder/dist` only |
| Installer | electron-builder NSIS | extracted into an overlay dir |
| Applied | reinstall + app restart | next worker start |
| Surfaces | Settings → App Updates (manual) | auto-check at startup + Settings → Core Updates (manual) |

The base installer still ships a full `nexus-coder` (see `dependencies.nexus-coder`)
so a clean install works offline. The overlay is an **upgrade** channel on top of
that baseline, never a replacement for it.

## Where the overlay lives

```
<userData>/overlay/
  state.json                     boot state machine (active/previous/disabled)
  staged/core-<ver>.zip          downloaded, verified, not yet activated
  staged/core-<ver>.sha512       metadata sidecar
  core/<ver>/                    activated copy (dist + package.json)
```

`<userData>` is `%APPDATA%/nexus` on Windows (`app.getPath('userData')`).

## How a worker resolves the core

1. `src/agent-worker.ts` statically imports `./bootstrap/register.js` **first**.
2. `register.js` is a no-op unless `NEXUS_OVERLAY_CORE_DIR` is set.
3. `src/bootstrap/resolve-hook.ts` (an ESM `module.register` resolve hook) maps:
   - `nexus-coder/<rel>` → `<overlay>/<rel>` when that file exists, else the base
     copy inside `app.asar`.
   - bare specifiers imported from overlay files → resolved from the base app
     (the overlay has no `node_modules`).

Every core process — the global worker and each per-session tab worker — gets the
same overlay env (`src/main/index.ts` → `sessionWorkers.launch`).

## Boot state machine (`src/bootstrap/overlay.ts`)

`state.json` fields: `activeCore`, `previousCore`, `disabledCores`, `bootPending`,
`consecutiveFailures`.

- `decideBoot()`: a boot that was left pending counts as a failure. After
  `MAX_BOOT_FAILURES` (2) consecutive failures the active core is disabled and the
  service falls back to `previousCore` (or the base copy).
- `markHealthy()`: clears the pending flag once the core proves it works.
- `disableActiveCore()`: immediate revert (used on crashes / init failure).

## Rollback triggers

| Trigger | Where |
|---|---|
| Worker process exits before proving itself | `worker.onExit` |
| `earlyInit` fails (bad overlay breaks Agent construction) | `earlyInit.catch` |
| Protocol mismatch at boot | `startWorker` boot gate |

A bad overlay that merely answers RPCs but cannot construct the Agent is caught by
the `earlyInit` result, not by a process exit — see `src/main/index.ts`
`settleOverlay()`.

## Protocol gate (`src/core-overlay/protocol.ts`)

The desktop owns the IPC / tool contract. `package.json.nexusDesktopProtocol`
(integer) is the single source of truth — **bump it whenever the desktop↔core
contract changes.**

`scripts/publish-core.mjs` stamps a `protocol: N` line into `latest-core.yml`.
The value is:

1. the core's own `package.json.nexusDesktopProtocol`, when present (a core
   released independently of this CI — authoritative), else
2. this repo's own `nexusDesktopProtocol` — the companion assumption, since this
   CI publishes the core artifact alongside the desktop release, else
3. `NEXUS_CORE_PROTOCOL` (tests only).

Consequence: a user on an older desktop (protocol 1) that fetches the latest
manifest published by a newer desktop (protocol 2) gets a protocol mismatch and
is steered to the desktop updater instead of installing an incompatible core.
No change in the `nexus-coder` repo is required for the gate to be effective.

A client-side core with no `protocol` in the manifest is treated as
legacy-compatible.

Enforcement points:

- `check()` → status `incompatible`, the overlay is not offered. The UI points the
  user at the desktop updater instead.
- `download()` / `activate()` → refuse; `activate()` re-reads the extracted
  `package.json` (defense in depth).
- `startWorker()` boot gate → an overlay left active by a previous run is disabled
  before any worker starts when its protocol mismatches.

## update manifest signing

`latest-core.yml` is signed with ed25519 by `scripts/publish-core.mjs`
(`latest-core.yml.sig`). The client verifies it in
`src/core-overlay/download.ts` against a public key embedded as
`BUNDLED_PUB_KEY_B64` (override for tests with `NEXUS_CORE_SIGNING_PUBKEY_HEX`).
SHA-512 of the tarball is verified separately.

Key rotation: regenerate with `node scripts/generate-core-keys.mjs`, update
`BUNDLED_PUB_KEY_B64`, and ship the new value via a full desktop release.

## Publishing a core update

```
npm run sync:core            # node_modules/nexus-coder/dist + nexusCoreVersion field
node scripts/publish-core.mjs
  -> release/core-<ver>.tar.gz
  -> release/latest-core.yml
  -> release/latest-core.yml.sig   (manifest carries `protocol: <desktop protocol>`)
```

CI (`.github/workflows/release.yml`) first pins the newest core —
`node scripts/set-core-version.mjs` picks the larger of the `latest` /
`beta` dist-tags (exact version, `nexusCoreVersion` kept in lockstep, and
a hard gate when the resolved core's `nexusDesktopProtocol` differs from
the desktop's), then runs `publish-core.mjs` after the installer build and
uploads the artifacts to GitHub Releases (and mirrors to Gitee via
`scripts/gitee-publish.mjs`). The manifest URL is pinned to the **desktop**
release tag (`v<desktop version>`) because that is the release the asset is
attached to, not the core version.

Signing key: locally the gitignored `keys/core-signing-private.pem` is used; CI
uses the `CORE_SIGNING_KEY` repository secret (the same PEM contents). A release
fails before building when that secret is missing, and `publish-core.mjs` fails
in CI instead of silently shipping an unsigned manifest.

Gitee mirror notes: the Gitee release for a desktop tag is re-published by
`publish-core-only.yml` with `GITEE_PRESERVE_ASSETS=1` — the existing release
(and its desktop assets: `latest.yml`, installer, `.blockmap`) is kept, only
missing core files are attached, and the Gitee copy of `latest-core.yml` is
rewritten to a Gitee download URL and re-signed. Gitee does not implement
GitHub's `releases/latest/download` alias, so the client's Gitee core feed is
tag-based (`releases/download/v<app version>`, wired in `src/main/index.ts`
as `extraFeeds`): a running app resolves core updates on the release that
matches its own desktop version, which is exactly where the core-only flow
attaches the new artifacts.


## Environment switches

| Var | Effect |
|---|---|
| `NEXUS_DISABLE_CORE_OVERLAY=1` | ignore any overlay, always use the base copy |
| `NEXUS_DISABLE_CORE_UPDATE=1` | disable core update checks |
| `NEXUS_CORE_UPDATE_MIRROR` | override the core feed URL |
| `NEXUS_CORE_SIGNING_PUBKEY_HEX` | override the trusted signing key (tests) |
| `NEXUS_DESKTOP_PROTOCOL` | override the desktop protocol (tests) |
| `NEXUS_CORE_PROTOCOL` | stamp a protocol into a manifest in `publish-core.mjs` (tests) |
| `NEXUS_SKIP_CORE_BUILD=1` | `sync-core.mjs --build` (and thus `npm start`) skips rebuilding the sibling core |
| `NEXUS_CODER_SRC` | override the core source root (default `../nexus-coder`) |

## Tests

| Suite | Scope |
|---|---|
| `test/core-overlay.test.mjs` | boot state machine + ESM hook |
| `test/core-download.test.mjs` | manifest parsing |
| `test/core-signature.test.mjs` | ed25519 verification |
| `test/core-manager.test.mjs` | check() state transitions (mocked feed) |
| `test/core-protocol.test.mjs` | protocol gate + field invariants |
| `test/core-version-select.test.mjs` | latest/beta dist-tag selection + CI-safe `--build` skip |
| `scripts/smoke-e2e.mjs` | dev-mode S1–S4 |
| `scripts/smoke-asar.mjs` | packed asar contains the bootstrap + import order |
| `scripts/smoke-packaged.mjs` | real win-unpacked app: P1 base / P2 overlay / P3 rollback / P4 protocol gate |