# Nexus Desktop — Linux Runbook (Debian)

Packaging + runtime reference for the Debian Linux build. Companion to
`docs/development-requirements.md` (the requirements register).

Status: Linux target (AppImage + deb) added in commit `d8caa38`;
native-module asar-ship fix in `aca4eea`; deleted-provider status crash
fix in `f767d0b`.

---

## 1. Build (on the Debian host)

```bash
cd ~/nexus-desktop
git pull                       # pull the latest main
npm ci                         # install deps (installs better-sqlite3, etc.)
npm run prepare:electron-native # compiles the Electron-ABI better-sqlite3 into .native/electron/.../linux-x64.node
npm run dist:linux             # electron-builder --linux AppImage deb
```

Output:

```
release/nexus-<version>-x86_64.AppImage   # AppImage (needs libfuse, see §4)
release/nexus-<version>-amd64.deb         # Debian package (recommended)
release/linux-unpacked/...                # unpacked tree (resources/app.asar)
```

On CN networks set the binaries mirror so electron-builder can fetch
appimage / 7zip / fpm:

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

### Why `prepare:electron-native` is required

better-sqlite3 ships its npm prebuilds built against the **system-Node ABI**
(141). The packaged app runs under **Electron 43 (ABI 148)** — the same
`.node` binary cannot serve both. `prepare-electron-native.mjs` compiles a
dedicated copy into `.native/electron/node_modules/better-sqlite3/prebuilds/
<plat>-<arch>.node`; `scripts/after-pack.mjs` (the electron-builder `afterPack`
hook) swaps that Electron-ABI binary into the asar's unpacked output in place.
Dev's `node_modules` is never touched.

The `.native/electron` tree is gitignored and regenerated per host — it does
**not** travel with git. Re-run `prepare:electron-native` on each machine.

---

## 2. Install (deb — recommended on Debian)

```bash
sudo dpkg -i release/nexus-<version>-amd64.deb
# or, resolving any deps:
sudo apt install ./release/nexus-<version>-amd64.deb
```

Launch:

```bash
nexus-desktop
# (or the .desktop entry, e.g. "Nexus")
```

### Verify the native module actually loaded

The historical failure mode was:

```
Core init failed: Cannot find module
/opt/nexus/resources/app.asar/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

This happened when the current-platform prebuild was excluded from the asar, so
`binding.js` fell through to the (also excluded) `build/Release` path. Since
`aca4eea`, the linux prebuilds **ship into the asar** (the top-level
`build.files` exclude set is now only
`!...prebuilds/{darwin-x64,darwin-arm64,win32-arm64}.node`), so
`asarUnpack` maps `linux-x64.node` and the asar loader redirects reads to
`app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node`.

Post-build sanity checks:

```bash
# 1. The current-platform prebuild must be listed inside the asar:
npx asar list release/linux-unpacked/resources/app.asar | grep "prebuilds/"
#   expected to include:
#     /node_modules/better-sqlite3/prebuilds/linux-x64.node

# 2. The unpacked binary must be the Electron-ABI build (~2.2 MB), not the
#    Node-ABI npm prebuild:
ls -l release/linux-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node

# 3. The dist:linux build log must contain the swap line:
#     [afterPack] swapped in Electron-ABI better-sqlite3 (linux-x64.node)
```

Then confirm the app renders the **settings panel (Models/Speech/Vision rows)**
and the **session list** from `~/.nexus` (provider config + `sessions.db`).

The old error must be gone from fresh logs:

```bash
grep -r "build/Release/better_sqlite3" ~/.nexus/logs/   # should be empty
```

---

## 3. AppImage (alternative)

The AppImage needs `libfuse` at runtime:

```bash
sudo apt install libfuse2t64     # Debian 13 / Ubuntu 24.04
# or, on older distros:
sudo apt install libfuse2
```

Run:

```bash
./nexus-<version>-x86_64.AppImage
# or, without installing libfuse:
./nexus-<version>-x86_64.AppImage --appimage-extract-and-run
```

The deb is the cleanest path on Debian — `dpkg`/`apt` handles runtime deps.
Use the AppImage only if you want a self-contained portable binary.

---

## 4. Known non-fatal log lines (safe to ignore)

### 4.1 `GLib-GObject: gsignal.c: instance ... has no handler with id 'NNNN'`

Example:

```
[7630:1103/071440.737441:ERROR:content/browser/browser_main_loop.cc:276]
GLib-GObject: ../../../gobject/gsignal.c:2699: instance '0x134c0268ddc0'
has no handler with id '8452'
```

**What it is:** an internal **GLib/Chromium** notice on Linux (Electron depends
on GLib for the browser main loop). It means a GObject instance emitted a
signal whose handler id was already unregistered. The `id` (7799, 8038, 8452…)
varies per run because Electron dynamically registers/unregisters GLib
callbacks as UI activity happens.

**Severity:** *non-fatal runtime noise.* It:

- does **not** pass through any `src/**` module — it is printed by Chromium's
  `browser_main_loop.cc`, not by nexus-desktop code;
- does **not** write to `~/.nexus/logs/` (it goes to the process stderr only);
- does **not** crash the app or interrupt the worker; the session list,
  settings panel, and chat all keep working alongside it.

**Action:** none required. It is a known Electron-on-Linux artifact. If it
bothers you in logs, it can be filtered out of stderr, but there is nothing in
the application to fix.

### 4.2 `ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer`

Example:

```
[PID:TID:HHMMSS.micro:ERROR:gpu/ipc/client/command_buffer_proxy_impl.cc:285]
ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.
```

**What it is:** a transient GPU/IPC failure in Chromium's GPU process. Common
on headless or software-GL environments (VMs, remote desktops, docker,
CI runners). The GPU context briefly failed to create the command buffer and
Chromium falls back.

**Severity:** *non-fatal; transient.* It resolves on its own; rendering
continues (usually on the software rasterizer). Not a nexus-desktop bug.

**Action:** none required. If it repeats constantly in a headless VM, you can
force software GL:

```bash
nexus-desktop --disable-gpu
# or
nexus-desktop --use-gl=swiftshader
```

### 4.3 `Core init failed: Cannot find module .../build/Release/better_sqlite3.node`

**This one IS a real failure** (unlike 4.1/4.2) — it means the better-sqlite3
native binary did not land in the asar. See §2 "Verify the native module
actually loaded". Since `aca4eea` this should not recur on a fresh
`npm run dist:linux`. If it does, the build skipped
`prepare:electron-native` or the asar-ship config regressed.

---

## 5. Where things live on the installed system

| Item | Path |
|---|---|
| Installed app (deb) | `/opt/nexus/` (binary `/opt/nexus/nexus`, `resources/app.asar`) |
| AppImage (extracted) | wherever the user places it; run directly |
| Config + sessions | `~/.nexus/config.json`, `~/.nexus/sessions.db` |
| App logs (incl. errors) | `~/.nexus/logs/YYYY-MM-DD.{info,error,warn}.log` |
| Desktop window state | `~/.nexus/desktop.json` |

---

## 6. The deleted-provider status crash (and why it is fixed)

Deleting a provider from the Config Web UI that a **session** is still bound
to used to crash the next `nexus:getStatus` poll:

```
Error occurred in handler for 'nexus:getStatus':
Error: Provider "zhipu" not configured
    at ConfigManager.getProvider (…/nexus-coder/dist/src/config/index.js)
    at AgentService.getRateLimitStatus (…/dist/agent/service.js)
```

**Root cause:** each session keeps a per-tab provider binding
(`AgentService.overrideName`, persisted to `sessions.db`). Removing provider X
from the global `config.json` does **not** clear open sessions' overrides, so
the bound provider name outlives the global entry. `getRateLimitStatus` called
`config.getProvider(name)` unguarded and threw, taking down the whole
`nexus:getStatus` handler.

**Fix (commit `f767d0b`):** `getRateLimitStatus` wraps `getProvider` in
try/catch and degrades to an `unknown`-family rate-limit status — same pattern
`getModels` already uses. The session-restore path
(`src/main/session-workers.ts` `applySessionBinding`) already logs a warning
when a binding points at a missing provider, so this closes the same gap on
the status-poll path. After the fix, deleting a provider no longer breaks the
status poll; the affected tab simply falls back to the global default on its
next restore.

---

## 7. Quick diagnostic checklist

When a Linux build misbehaves, work through in order:

1. **Does the asar carry the current-platform prebuild?**
   `npx asar list release/linux-unpacked/resources/app.asar | grep prebuilds`
   — must include `linux-x64.node` (or `linux-arm64.node` on arm).
2. **Is the unpacked binary the Electron-ABI build?**
   `ls -l …/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node`
   — ~2.2 MB. Check the build log for `[afterPack] swapped in …`.
3. **Did `prepare:electron-native` actually run on this host?**
   `ls .native/electron/node_modules/better-sqlite3/prebuilds/linux-x64.node`
   — if missing, re-run `npm run prepare:electron-native`.
4. **App launches and the settings/session list render?**
   Open the app; both must come up from `~/.nexus`.
5. **What's in the error log?**
   `cat ~/.nexus/logs/$(date +%F).error.log` — filter out the
   non-fatal lines from §4.1/§4.2 before reading.
6. **AppImage specific:** if it won't start, install `libfuse2t64`
   (Debian 13 / Ubuntu 24.04) or use `--appimage-extract-and-run`.
