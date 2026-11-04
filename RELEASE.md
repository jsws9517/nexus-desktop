# Release Flow

Nexus is split into two repositories since the desktop was decoupled from the
CLI core:

| Repo | Host | Purpose |
| --- | --- | --- |
| `cict_1_0/nexus-coder` | Gitee | CLI + core library (`nexus-coder`) |
| `jsws9517/nexus-desktop` | GitHub | Electron desktop app (depends on the core npm package) |
| `cict_1_0/nexus-desktop` | Gitee | Read-only mirror of the desktop (synced by CI) |

The core is published to **npmjs.com** as `nexus-coder`. The desktop installs
that package — it does **not** vendor a copy of the core source anymore. The
desktop source (`main` + all tags) is auto-mirrored to the Gitee repo on every
push via `.github/workflows/gitee-sync.yml` (requires the `GITEE_TOKEN` secret).

---

## 1. Core package release (repo: `nexus-coder`)

Branches:

- `dev` — development; carries pre-release versions (`1.1.7-4`).
- `master` — stable; fast-forward-only merges from `dev` at release time.

### 1.1 Bump the version

`package.json` + `package-lock.json`:

- **Pre-release** on `dev`: `npm version 1.1.7-5 --no-git-tag-version`
- **Stable** at release: `npm version 1.1.7 --no-git-tag-version`

Commit and push:

```bash
git add package.json package-lock.json
git commit -m "chore: release 1.1.7"
git push gitee dev
```

### 1.2 Build + typecheck (quality gate)

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`dist/src/index.js` + `.d.ts` must exist (the `src/index.ts` entry is the
package `main`).

### 1.3 Publish to npm

Publish (token from the environment — never committed):

```powershell
$env:NODE_AUTH_TOKEN = $env:NPM_TOKEN     # or your npmjs token
npm publish --tag beta                    # pre-release (1.1.7-x)
npm publish --tag latest                  # stable
```

> npm refuses to publish a pre-release version without `--tag`. Use `beta` for
> `x.y.z-*`, `latest` only for stable.

Verify it is live:

```bash
npm view nexus-coder dist-tags
```

### 1.4 Tag + merge to master (stable only)

```bash
git tag v1.1.7
git push gitee v1.1.7
git checkout master
git merge --ff-only dev
git push gitee master
git checkout dev
```

Tag naming follows the existing convention: `v1.0.2`, `v1.1.0`, … `v1.1.6`.

---

## 2. Desktop release (repo: `nexus-desktop`)

### 2.1 Pin the core dependency (automated in CI)

Since the self-healing release pipeline, a desktop tag does not require a
manual dependency bump: `.github/workflows/release.yml` runs
`node scripts/set-core-version.mjs` before `npm ci`.

- Resolves the newest `nexus-coder` among the `latest` and `beta`
  dist-tags (`scripts/core-version-select.mjs` picks the larger; a missing
  `beta` falls back to `latest`).
- Refuses to proceed if the resolved core's `nexusDesktopProtocol`
  disagrees with the desktop's (exact-protocol gate, legacy = field
  absent).
- Writes the exact version into `package.json`
  (`dependencies["nexus-coder"]` + `nexusCoreVersion`) and the lockfile,
  so the `publish-core.mjs` baseline read of `node_modules` ships the same
  version it just pinned.

For local work (or to pin a version older than the newest dist-tag, which
the tag-based flow cannot express), pin manually:

```bash
npm install nexus-coder@1.1.7   # exact install
node scripts/set-core-version.mjs --version 1.1.7   # optional: align fields
```

Dry-run preview of the CI decision: `node scripts/set-core-version.mjs --dry-run`.

### 2.2 Build + smoke test

```bash
npm ci
npm run typecheck
npm run build
npm run test:smoke
```

`test:smoke` spawns the worker and verifies the packaged core boots over
JSON-RPC (no GUI / no LLM required).

### 2.3 Windows installer

```bash
npm run prepare:electron-native   # Electron-ABI better-sqlite3 (stamped/cached)
npm run dist:win                  # electron-builder NSIS -> release/nexus Setup X.Y.Z.exe
```

On CN networks set the mirrors documented in the desktop README.

### 2.4 npm tarball (optional)

```bash
npm run pack:npm    # moves electron into dependencies so `npm i -g <tgz>` works
```

### 2.5 Tag + push

```bash
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

Pushing the `v*` tag triggers the Release workflow: it builds the installer,
creates the GitHub Release, mirrors the tag to Gitee, and publishes a matching
Gitee Release on `cict_1_0/nexus-desktop` (body from the same changelog, via
`scripts/gitee-publish.mjs`). Every `main` push is also auto-mirrored to Gitee
by `gitee-sync.yml`; both workflows need the `GITEE_TOKEN` secret.

The same run publishes the core overlay artifacts (`core-<nexus-coder
version>.tar.gz`, `latest-core.yml`, `latest-core.yml.sig`) so clients can take
core updates without a full installer. This requires the `CORE_SIGNING_KEY`
repository secret (PEM contents of `keys/core-signing-private.pem`); without it
the workflow fails at the preflight step on purpose.


> Gitee caps release attachments at **100 MiB** — and ~98 MiB installer
> uploads are exactly the range where Gitee's `attach_files` API stalls
> (the upload completes but the server-side processing outlasts any sane
> timeout, leaving a half-built release and a broken feed that aborts the
> whole publish). So by default `gitee-publish.mjs` does **not** mirror the
> installer: it attaches the small feed files (`latest.yml`, blockmap, core
> tarball, manifest + sig) and pins the Gitee copy of `latest.yml` at the
> GitHub download URL, keeping the fast manifest + self-contained core
> channel on Gitee for CN clients. A Gitee-hosted manifest never points at a
> file that is missing on Gitee. Set `GITEE_UPLOAD_INSTALLER=1` to mirror
> the installer anyway (then the relative url is kept when the upload
> succeeds; a failed upload degrades to the GitHub-pinned url instead of
> aborting the run).
>
> Two Gitee-specific facts the client code relies on:
>
> - Gitee has **no** `releases/latest/download` alias (GitHub's). The app
>   updater therefore resolves the Gitee feed at check time: newest
>   non-prerelease release via Gitee's public releases API, then
>   `releases/download/<tag>`, trusted only after probing that `latest.yml`
>   is attached (`src/main/updater.ts`).
> - A **core-only re-publish** mirrors with `GITEE_PRESERVE_ASSETS=1`: the
>   existing Gitee release and its desktop assets are kept; only missing
>   files are attached. A full desktop tag publish keeps the historical
>   delete + recreate semantics.

---

## 2.6 macOS (arm64) — beta stage

macOS packaging is wired into two workflows:

1. **Dry run — `.github/workflows/mac-package-test.yml`** (manual dispatch,
   artifacts only, no Release / Gitee). Run it from
   **Actions → macOS Package Test → Run workflow**; the `mac-arm64`
   artifact contains the `.dmg`, `.zip` and `latest-mac.yml` for a real
   Mac to test before a tag is cut.
2. **Real release — the `build-mac` job in `release.yml`**. Runs on
   every `v*` tag push, in parallel with `build-linux` (both only depend
   on the Windows job). It mirrors the dry run step-for-step, then
   `gh release upload --clobber` appends the three mac assets to the
   GitHub Release the Windows job already created. **mac assets are not
   mirrored to Gitee** at the beta stage (dmg is large and the
   cross-continent link is slow — see the `v0.3.1` Windows incident);
   they live on GitHub only.

Current stage decisions:

- **ad-hoc signed, not notarized** (`mac.identity: "-"`). Users must
  right-click → Open, or run `xattr -dr com.apple.quarantine
  /Applications/nexus.app`. Gatekeeper's "developer cannot be verified"
  is expected at this stage.
- **arm64 only.** `mac.target` in `package.json` is pinned to `arm64`;
  Intel Macs are not covered yet.
- **Self-update is off.** `src/main/updater.ts` reports `unsupported`
  on darwin, so the settings panel shows "updates not supported" and
  nothing more. The `zip` target + `latest-mac.yml` are still shipped so
  a future Developer ID + notarized build can enable `MacUpdater` without
  re-architecting.
- **`better-sqlite3` ships its `darwin-arm64` prebuild into the asar**
  (`build.files` excludes only `darwin-x64` + `win32-arm64`), and
  `after-pack.mjs` swaps the Electron-ABI build from `.native/electron/`
  in place — same mechanism as win/linux.
- **Minimal macOS menu bar** (app / Edit / Window with system roles).
  `Menu.setApplicationMenu(null)` remains on Windows/Linux; on macOS a
  null menu would kill Cmd+Q/Cmd+C/Cmd+V.
- **First mac-bearing tag should be a prerelease** (e.g. `v0.3.4-beta.1`).
  `release.yml` sets `prerelease: contains(github.ref_name, '-')` on the
  GitHub Release, so electron-updater (which ignores prereleases by
  default) will not push it to stable users.

## 3. Checklist before a stable release

- [ ] `npm run typecheck && npm run build && npm test` green on `dev`
- [ ] Core published to npm (tag `beta` → then `latest`)
- [ ] `npm view nexus-coder dist-tags` shows the new version (newest of `latest`/`beta` is auto-pinned into the desktop by `release.yml`; no manual bump needed)
- [ ] `vX.Y.Z` tag pushed to `nexus-coder` (and `nexus-desktop`)
- [ ] `master` fast-forwarded on `nexus-coder` (stable only)
- [ ] macOS (arm64): `mac-package-test.yml` green, `mac-arm64` artifact passes
      `verify-mac-release.mjs` + `smoke-launch-mac.mjs` on a real Mac
      (right-click → Open or `xattr -dr com.apple.quarantine`), menu bar
      Cmd+C/V/Q works, settings panel + session list render, one agent turn
      completes, `~/.nexus/` and `~/Library/Application Support/nexus/`
      get populated.
- [ ] For the first mac-bearing tag use a prerelease version
      (`vX.Y.Z-beta.N`); `release.yml` marks the GitHub Release as
      prerelease so stable users are not auto-updated.
