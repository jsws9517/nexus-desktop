# Release Flow

Nexus is split into two repositories since the desktop was decoupled from the
CLI core:

| Repo | Host | Purpose |
| --- | --- | --- |
| `cict_1_0/nexus-coder` | Gitee | CLI + core library (`nexus-coder`) |
| `jsws9517/nexus-desktop` | GitHub | Electron desktop app (depends on the core npm package) |

The core is published to **npmjs.com** as `nexus-coder`. The desktop installs
that package — it does **not** vendor a copy of the core source anymore.

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

### 2.1 Bump the core dependency

After a core publish, point the desktop at the new version:

```bash
npm install nexus-coder@1.1.7
```

Commit `package.json` + `package-lock.json`.

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

---

## 3. Checklist before a stable release

- [ ] `npm run typecheck && npm run build && npm test` green on `dev`
- [ ] Core published to npm (tag `beta` → then `latest`)
- [ ] `npm view nexus-coder dist-tags` shows the new version
- [ ] Desktop `npm install nexus-coder` + smoke test green
- [ ] `vX.Y.Z` tag pushed to `nexus-coder` (and `nexus-desktop`)
- [ ] `master` fast-forwarded on `nexus-coder` (stable only)
