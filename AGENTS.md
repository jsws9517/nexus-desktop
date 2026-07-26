# TTY / Multi-line Input Architecture

## Key files
- `src/cli/chat.ts` — all input handling, `_ttyWrite` overrides

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

### History (don't regress)
- **double-fire bug (fixed)**: `exitMultiLine` used `rl.emit('line', fullInput)` which was fine, but the CRLF `\n` without CR-tracker caused a second Enter submission. Fix: CR tracker eats CRLF `\n`.
- **submit-swallow bug (fixed)**: `exitMultiLine` changed to `rl.line = fullInput` (thought readline would pick it up), but our `_ttyWrite` override replaces readline's Enter processing — `rl.line` is never read. Fix: use `rl.emit('line', fullInput)` + clear `rl.line` for prompt echo.
- **LF-terminal false-positive (fixed)**: `s === '\n'` in `isNewLineKey` matched regular Enter on LF terminals. Fix: guarded by `_seenCR`.
