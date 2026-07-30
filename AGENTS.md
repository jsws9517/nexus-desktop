# TTY / Multi-line Input Architecture

## Key files
- `src/cli/chat.ts` — all input handling, `_ttyWrite` overrides

# Marketplace System

**File:** `src/config/native.ts` — `CATALOG` (MCP servers only), `DEFAULT_MARKETPLACES`, `NativeManager`

All plugins (skills) come from **registered marketplaces**, not inline code. Two defaults auto-register on first use:
- `claude-code-plugins` (`anthropics/claude-plugins-official`) — 4 official plugins
- `mattpocock` (`mattpocock/skills`) — community skills (meta-plugin, sub-skills unpacked at install)

## CLI commands
```
nexus config native marketplace add <owner/repo>   # register a marketplace source
nexus config native marketplace list                 # show registered marketplaces + their plugins
nexus config native marketplace remove <name>        # remove a marketplace
nexus config native marketplace update <name>        # re-fetch marketplace.json

nexus config native install <name>                    # CATALOG → marketplace fallback
nexus config native install <name>@<marketplace>      # exact marketplace plugin
```

## How install resolution works
1. `install <name>` — checks CATALOG first (MCP/LSP servers). Not found? Searches all registered marketplaces for the plugin name (exact match), then sub-skill patterns (`plugins/<name>/SKILL.md`, `skills/<name>/SKILL.md`, etc.), then broad tree scan via GitHub API.
2. `install <name>@<marketplace>` — looks up the exact marketplace, finds the plugin, fetches its SKILL.md.
3. For meta-plugins (like `mattpocock-skills@mattpocock` which has no root SKILL.md): uses Git Trees API to discover `skills/*/*/SKILL.md` recursively and unpacks each as an individual plugin directory.

## Key design decisions
- `CATALOG` only contains MCP servers (require npm install) and LSP packages (need generated scripts). No SKILL.md strings are shipped inline.
- `fetchMarketplaceFromRepo()` fetches `.claude-plugin/marketplace.json` from the remote repo (Claude Code format).
- Plugin `source` can be a simple relative path (`./plugins/code-review`) or a complex object (`{ source: 'url', url: '...', sha: '...' }`). Only simple paths are auto-installed.
- `KNOWN_PLUGIN_REPOS` and `searchPluginRepos`/`fetchRepoPlugins` were removed — replaced by marketplace discovery.
- `install-community-skills.mjs` was removed — marketplace handles this at runtime via `install <name>@<marketplace>`.

# Loop Engineering — Debugging Discipline

## Three-layer architecture

### Layer 1: Static system prompt (always on)
**File:** `src/agent.ts:608-625` — `[Debugging Discipline]` injected early, before vision/project sections.
- 3 imperatives: RULE 1 (reproduction first), RULE 2 (3+ hypotheses), RULE 3 (completion criteria)
- Explicit: "Reading source code is NOT reproduction. Even after the user tells you the project path..."

### Layer 2: Dynamic keyword-triggered injection (preLlmCall hook)
**File:** `src/agent.ts:763-786` — detected by regex `debugRE` (bug, crash, OOM, leak, 崩溃, 异常, etc.)
- Injects full 6-step diagnosing-bugs workflow into system prompt before LLM sees the user message
- Sets `this._debugBlockFileRead = true`

### Layer 3: File-read enforcement (preToolUse hook)
**File:** `src/agent.ts:795-804` — physically blocks `read_text_file`, `directory_tree`, `list_directory`, `get_file_info`, `glob`, `grep` when `_debugBlockFileRead` is true.
- Returns `{ verdict: 'deny', reason: '...' }` — forces agent to ask user about reproduction instead of reading source
- Flag cleared at `chat()` start on next user input

## Do NOT regress
- The 3 layers are intentional redundancy: prompt + hook + enforcement. Removing any layer weakens the gate.
- `_debugBlockFileRead` is set in preLlmCall (if debugRE matches), cleared AFTER `runLlmTurn()` returns — i.e., only after the LLM has completed a full response (text without tool calls). The block persists across ALL recursive turns within one user message, and across subsequent user messages that don't contain debug keywords. This prevents the agent from reading files even after the user gives the project path.
- `debugRE` regex must stay aligned with Chinese and English debug keywords.
- When adding new file-reading tools, add them to `fileTools` Set in preToolUse.

## Rules (do not break)

### Enter/Ctrl+Enter behavior
- **Enter** = submit everywhere (main mode + multi-line mode)
- **Ctrl+Enter** = newline everywhere (enters multi-line mode from main, appends line in multi-line)
- **Shift+Enter** is intentionally disabled (Windows cannot reliably detect `key.shift`)

### Multi-line mode (`_ttyWrite` handler swap)
- `enterMultiLine()` copies `rl.line` into `multiLineBuffer[0]` but does NOT clear `rl.line`
- `exitMultiLine()` MUST clear `(rl as any).line = ''` before `rl.emit('line', fullInput)`
  otherwise `rl.prompt()` re-echoes the stale first line
- `exitMultiLine()` uses `rl.emit('line', fullInput)` to submit (not `rl.line =` — that silently drops the content because our `_ttyWrite` override replaces readline's Enter processing)

### CRLF tracking (Windows CRLF vs LF terminals)
- `_charBeforeWasCR`: tracks whether the previous character was `\r`. When `\n` follows `\r`, it's CRLF tail — silently eaten (return early). This prevents the `\n` from being mistakenly treated as Ctrl+Enter.
- `_seenCR`: set to true on first `\r`. Only when `_seenCR` is true does `isNewLineKey` fallback to `s === '\n'` detection (standalone LF = Ctrl+Enter on CRLF terminals). On LF terminals (Git Bash, WSL, Unix), `_seenCR` stays false so regular Enter (`\n` alone) is NOT mistaken for Ctrl+Enter.
- Both trackers are in both `_ttyWrite` handlers (main-mode and multi-line), sharing the same outer-scope variables.

### `isNewLineKey()` detection order
1. `key.ctrl || key.alt` — standard modifier detection (works on most terminals)
2. `s === '\n' && _seenCR` — fallback for CRLF terminals where Ctrl+Enter sends standalone `\n` without `key.ctrl` (e.g. legacy Windows conhost)

### `_ttyWrite` design constraints
- `_ttyWrite` is fully replaced (not wrapped). `originalTtyWrite` is only called for keys we intentionally pass through (plain Enter in main mode, question-mode keys, etc.).
- There are TWO `_ttyWrite` implementations swapped via `setTtyWrite()`:
  - **Main handler** (`makeMainTtyWrite()`): normal editing + paste detection + Ctrl+Enter → enter multi-line
  - **Multi-line handler** (`enterMultiLine()` callback): custom line editing (no readline echo), Enter → submit, Ctrl+Enter → append line
- The swap MUST cover CRLF tracking at the top of BOTH handlers.

### Known limitations
- Legacy Windows conhost: Ctrl+Enter is indistinguishable from Enter (same `\r\n`). `_seenCR` + `\n` fallback covers Windows Terminal and most modern terminals, but conhost mode is a best-effort.
- Shift+Enter: terminal-specific, not portable across Windows terminals. Disabled.
- CJK long-line redraw: `visualWidth()` + `lineWraps()` in `up`/`down` pass-through; cosmetic only, no functional impact.

# Config Web UI (`src/config/web.ts`)

## SPA pitfalls (template literal code-gen)
The SPA is embedded as a **template literal** inside `buildSpaHtml()`. TypeScript/tsc does NOT syntax-check the
JavaScript inside template literals. The only validation is at browser runtime.

## Known SPA bugs (fixed)
1. **Hardcoded OCR type selector** — `renderDynamicCategory` "Add New" form at line ~769 used
   `enumValues: ['openai-compatible', 'paddleocr']` for ALL dynamic categories (LLM providers, vision providers).
   Fix: look up `cat.fields.find(f => f.key === 'type')` and use its `enumValues`.
2. **Orphaned catch block** — leftover corrupted duplicate of `saveDynamicItem()` with no `try` before `catch`.
3. **`})));` → `}));`** — `saveConfig()` had 1 brace + 3 parens closing the `JSON.stringify(...)` call; correct is
   2 braces + 2 parens for the API options + stringify.

## Provider CRUD endpoints (server-side, `handleApi` in web.ts)
- `GET /api/schema` — returns `buildSchema()` categories
- `PUT /api/config` — saves top-level config fields (skips providers/visionProviders/ocrProviders/mcpServers)
- `POST /api/config/provider` — validates with `ProviderConfigSchema` (requires type, apiKey, model)
- `POST /api/config/vision-provider` — validates with `VisionProviderConfigSchema` (requires apiKey, baseUrl, model)
- `POST /api/config/ocr-provider` — validates with `OcrProviderConfigSchema` (type + conditional fields)
- `POST /api/config/mcp` — validates with `ServerConfigSchema`
- `DELETE /api/config/{ep}/{name}` — removes a dynamic item
- `GET /api/native/skills` — lists filesystem skills + native installed plugins

## Dynamic item mapping (SPA side, `getDynamicItems`)
- `providers` → `cfg.providers`
- `vision` → `cfg.visionProviders`
- `ocr` → `cfg.ocrProviders` + flattens arrays (args, languages) to comma-separated strings
- `mcp` → `cfg.mcpServers`

### History (don't regress)
- **double-fire bug (fixed)**: `exitMultiLine` used `rl.emit('line', fullInput)` which was fine, but the CRLF `\n` without CR-tracker caused a second Enter submission. Fix: CR tracker eats CRLF `\n`.
- **submit-swallow bug (fixed)**: `exitMultiLine` changed to `rl.line = fullInput` (thought readline would pick it up), but our `_ttyWrite` override replaces readline's Enter processing — `rl.line` is never read. Fix: use `rl.emit('line', fullInput)` + clear `rl.line` for prompt echo.
- **LF-terminal false-positive (fixed)**: `s === '\n'` in `isNewLineKey` matched regular Enter on LF terminals. Fix: guarded by `_seenCR`.

# Security Audit — Design Compromises (remind on each security pass)

The following findings were identified as intentional design trade-offs.
Do NOT fix without explicit user confirmation — each would alter observable behavior.

| ID | Risk | Issue | Why it's a compromise |
|---|---|---|---|
| M4 | Medium | ACP `tool/call` doesn't require a session | Protocol may be designed for stateless tool invocation; forcing session breaks existing clients |
| M5 | Medium | Web UI prints API token to stderr on startup | Convenience for user copy-paste; could be masked or shown only once as alternative |
| M6 | Medium | ACP `/authenticate` has no rate limiting | Adding rate limiting may cause legitimate retries to fail; requires careful window/threshold tuning |
| M7 | Medium | `read_multiple_files` accepts unbounded `paths` array | Truncation would break legitimate bulk reads; need a reasonable upper bound (e.g. 100) |
| L1 | Low | Error messages distinguish "not found" from "access denied" | Attackers can probe file existence; unification would break scripts/tools depending on the distinction |
| L5 | Low | API token embedded in served HTML SPA source | Required for SPA to authenticate API calls; cannot remove |
