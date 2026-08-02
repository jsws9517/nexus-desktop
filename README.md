# Nexus Desktop

An Electron desktop front-end for the **Nexus** agent core. It reuses the CLI's
compiled core (`vendor/core/src`) so chat, sessions, tools, MCP, skills, vision,
and permissions behave identically to the CLI — the desktop only replaces the
terminal UI layer.

## Features

- Multi-turn chat with streaming responses, thinking blocks, and tool cards.
- Session history: create, resume, rename, and delete SQLite-backed sessions
  (shared with the CLI's `~/.nexus` data).
- MCP tool support: permission prompts are routed to an in-app modal
  (Allow / Deny), and MCP servers connect in the background so the UI never
  blocks on startup.
- Full provider / vision / OCR / MCP / skills configuration via an embedded
  copy of the core's configuration Web UI.
- Message queueing: messages sent while the agent is busy are shown immediately
  and auto-submitted one-by-one after the current turn completes.
- Windows installer with a branded icon.

## Architecture

```
renderer (webview) ──IPC──▶ main (Electron) ──stdio NDJSON / utilityProcess──▶ worker (Node AgentService)
   preload.ts                    index.ts / worker-host.ts                 agent-worker.ts + core dist/src
```

- The core **Agent** always runs in a separate Node child process — never inside
  Electron's main process — keeping native modules (`better-sqlite3`) on a stable
  ABI and isolating core crashes from the UI.
- **Dev / npm-install** transport: worker is spawned as a system `node` child,
  JSON-RPC over stdio.
- **Packaged exe** transport: worker is an Electron `utilityProcess` using
  `parentPort`, line-based JSON-RPC.
- The app shares `~/.nexus` (sessions DB + session config) with the CLI; it does
  **not** depend on the CLI binary.

## Getting started

```bash
cd desktop
npm install          # on CN networks: ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm start            # build + launch in dev mode
```

`npm start` requires an API key configured (see the Settings window).

## Scripts

| Command             | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `npm run build`     | copy core → vendor, compile TS, copy static assets   |
| `npm start`         | build + run Electron in dev                          |
| `npm run typecheck` | type-check                                           |
| `npm run test:smoke`| headless RPC smoke test (no GUI, no LLM)             |
| `npm run test:chat` | headless end-to-end chat through the worker          |
| `npm run dist:win`  | build the Windows `.exe` installer                 |

## Packaging

- `npm run dist:win` → `desktop/release/nexus Setup X.Y.Z.exe` (electron-builder
  NSIS). On CN networks set:
  - `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
  - `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- `npm run pack:npm` → a global-install tarball (`npm install -g <tarball>`),
  which launches the GUI under the system Node ABI.
- `better-sqlite3` must be rebuilt to the correct ABI for the target runtime:
  - Dev / system node: `npm rebuild better-sqlite3`
  - Electron / packaged: `npx @electron/rebuild -f -w better-sqlite3`

## Troubleshooting

- **Permission popup hangs / Allow does nothing** — ensure the worker's
  `permission` message id is forwarded correctly (`worker-host.ts` maps the
  `id` field); the id is how the renderer answers back.
- **Packaged app can't `dlopen better-sqlite3`** means the ABI is wrong — rebuild
  with `@electron/rebuild` and re-couple the package.
- **Menu bar on top.** The default Electron menu is removed via
  `Menu.setApplicationMenu(null)`.