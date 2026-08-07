# Release Flow

Nexus is split into two repositories since the desktop was decoupled from the
CLI core:

| Repo | Host | Purpose |
| --- | --- | --- |
| `cict_1_0/llm-agent` | Gitee | CLI + core library (`@jsws9517/nexus-core`) |
| `jsws9517/nexus-desktop` | GitHub | Electron desktop app (depends on the core npm package) |

The core is published to **GitHub Packages** (`npm.pkg.github.com`), scoped as
`@jsws9517/nexus-core`. The desktop installs that package — it does **not**
vendor a copy of the core source anymore.

---

## 1. Core package release (repo: `llm-agent`)

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

### 1.3 Publish to GitHub Packages

Requires a GitHub token with `write:packages` + `repo` scopes. The registry is
mapped in the repo `.npmrc`:

```
@jsws9517:registry=https://npm.pkg.github.com/
```

Publish (token from the environment — never committed):

```powershell
$env:NODE_AUTH_TOKEN = $env:GITHUB_TOKEN   # or your PAT
npm publish --tag next                     # pre-release (1.1.7-x)
npm publish --tag latest                   # stable
```

> npm refuses to publish a pre-release version without `--tag`. Use `next` for
> `x.y.z-*`, `latest` only for stable.

Verify it is live:

```bash
npm view @jsws9517/nexus-core versions --registry=https://npm.pkg.github.com/
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
npm update @jsws9517/nexus-core
# or pin explicitly:
npm install @jsws9517/nexus-core@1.1.7
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

## 3. Private registry auth (consumers + CI)

Anyone installing `@jsws9517/nexus-core` needs:

- `.npmrc` mapping the scope to `npm.pkg.github.com` (committed in both repos).
- A GitHub token with **read:packages** — either in `~/.npmrc`
  (`//npm.pkg.github.com/:_authToken=...`) or as `NODE_AUTH_TOKEN` in CI.

CI on the desktop repo (GitHub Actions) uses `actions/setup-node` with the
registry URL + `NODE_AUTH_TOKEN` (see `.github/workflows/ci.yml`); the token is
supplied by the repository secret `GH_PACKAGES_READ_TOKEN` (a PAT with
`read:packages`). The smoke test step sets a placeholder `ANTHROPIC_API_KEY` so
the worker can initialize without a real config on the clean runner.

---

## Checklist before a stable release

- [ ] `npm run typecheck && npm run build && npm test` green on `dev`
- [ ] Core published to GitHub Packages (tag `next` → then `latest`)
- [ ] `npm view @jsws9517/nexus-core` shows the new version
- [ ] Desktop `npm update @jsws9517/nexus-core` + smoke test green
- [ ] `vX.Y.Z` tag pushed to `llm-agent` (and `nexus-desktop`)
- [ ] `master` fast-forwarded on `llm-agent` (stable only)
