# NexusAgent

A powerful TypeScript CLI agent connecting multiple LLM providers, MCP tools, filesystem automation, skills/plugins, and ACP protocol — the intelligent hub for your development workflow.

## Features

- **Multi-Provider LLM Support**: Anthropic (Claude) and OpenAI (GPT) with easy switching, configurable via CLI
- **OpenCode Zen Integration**: One-command auth flow for the curated OpenCode Zen gateway (`nexus config opencode-zen login`)
- **Session Management**: Persistent chat sessions with SQLite storage, cross-process recovery, `/resume` browsing
- **Long Context Handling**: Sliding window + automatic summarization + context compaction
- **Per-Session Persistent Memory**: Automatic memory summaries persisted per session, `/memory` view, cross-session `/insight` analysis
- **Rich Interactive Chat**: Streaming output with gradient separator, session report, `/history` browsing, PageUp traversal
- **Built-in Filesystem Tools**: Full file read/write/edit/move/copy/delete/directory-tree — no external MCP server needed
- **MCP Tools**: Connect to external MCP servers for specialized capabilities; builtin tools take priority over MCP for deduplication; 30s timeout with auto-reconnect on hung servers
- **Path Authorization**: Prompt/Allow/Deny with per-session (`y`) and persistent (`a`) grants, cached in `path-auth.json`; early `existsSync` checks avoid unnecessary auth prompts for missing files
- **Slash Commands**: `/model`, `/provider`, `/session`, `/resume`, `/memory`, `/insight`, `/tools`, `/skills`, `/config`, `/clear`, `/exit`, `/plan`, `/tasks`, `/btw`, `/theme`
- **Skills/Plugins**: Dynamic loading from `~/.nexus/skills/` with auto-generated fallback for invalid skill directories
- **ACP Protocol**: Agent-to-agent communication via WebSocket
- **Diff Renderer**: Colorized inline diff output for LLM responses
- **Vision / Multi-Modal**: `analyze_image` tool with local (Florence-2) and cloud vision providers (GLM-4V, Agnes-2V, etc.), configurable fallback modes
- **Task DAG Engine**: Decompose requests into 3-5 sub-tasks, execute with dependency resolution, support `new` (greenfield) and `modify` (edit existing) modes with automatic git snapshot & rollback safety
- **Temp File Cleanup**: Post-task finalization removes probe/scratch/cache files and collects deliverables into a sandboxed output directory
- **Permission Whitelist**: Pre-approve tools (`/bypass`), path-scoped exec auto-approval (`safePaths`), and an `edit` preset so vibe-coding sessions run without per-tool prompts. `/go` temporarily enables the whitelist during plan execution and restores it afterward
- **Data Redaction**: Built-in sanitization on file reads — geographic coordinates fuzzed with a random offset (preserving numeric shape for downstream processing), credential fields (passwords/tokens/keys/账号) masked, sensitive paths hidden in errors; API keys encrypted at rest with AES-256-GCM or resolved via `$VAR`/`env:VAR` references so no plaintext secrets land in context or disk

## Installation

```bash
npm install
npm run build
npm link  # or npm install -g
```

## Configuration

Config file is auto-created at `~/.nexus/config.json`:

```bash
# List configuration
nexus config list

# Set API key
nexus config set provider.anthropic.apiKey YOUR_KEY

# Switch provider
nexus config switch openai

# Add MCP server (filesystem tools are built-in; external MCP for custom services)
nexus config mcp add my-service --command node --args path/to/server.mjs
```

## Usage

```bash
# Interactive chat
nexus
nexus chat

# Resume a session
nexus chat --session <id>

# Single prompt
nexus run "Explain quantum computing"

# Session management
nexus session list
nexus session resume <id>
nexus session rename <id> <name>
nexus session delete <id>
```

## Interactive Commands

During chat, type:
- `/help` - Show commands
- `/session` - Show current session info
- `/resume <id>` - Resume a past session
- `/view [id|#]` - Browse raw messages for a session
- `/delete` - Delete sessions
- `/rename <name>` - Rename the current session
- `/memory` - View this session's persistent memory
- `/insight` - Cross-session memory analysis
- `/model` - Show/switch LLM model
- `/provider` - Show/switch LLM provider
- `/compact` - Compress current session context
- `/new` - Compress history and start a fresh session
- `/clear` - Clear context (starts fresh)
- `/plan <request>` - Decompose a request into a DAG of sub-tasks (supports `@path` resolution)
- `/go` - Execute the current plan
- `/tasks [id]` - Show task graph or detailed step info (implicit `-step`)
- `/tools` - List available tools
- `/mcp` - List MCP server connections
- `/skills` - Manage skill plugins (list, reload, create, validate, fix, fix-smart)
- `/plugins` - List loaded plugins
- `/btw <info>` - Inject context before the next LLM turn
- `/pasteimage` - Paste clipboard image and send to agent (alias: `/clipimage`, `/pasteimg`)
- `/theme` - Show/switch color theme
- `/flush` - Clear the screen
- `/bypass [auto|off|status]` - Toggle the permission whitelist (auto = no-prompt edit mode, off = ask before each tool)
- `/config` - View/edit configuration
- `/exit`, `/quit` - Quit

## Development Workflow (Quality Gate)

Nexus ships two built-in coding sub-agents — **Tester** and **Committer** — that can be chained automatically or on demand to form an `implement → test → commit` pipeline.

Sub-agent capabilities:
- **Tester**: Read-only. Auto-detects and runs project tests / lint / typecheck, outputs `VERDICT: PASS` or `VERDICT: FAIL`. Never modifies source code or commits.
- **Committer**: Reviews `git diff`, runs tests/build, then creates a **local** atomic commit using Conventional Commits style. **Never `git push`**.

### Enabling the Quality Gate

**1. Global config toggle — automatic pipeline**

Configure in `config.json` (or the Web panel General section):

```json
{
  "qualityGate": {
    "autoTest": true,    // default true: auto-run Tester after implementation tasks
    "autoCommit": false  // default false: don't auto-commit, requires manual confirmation
  }
}
```

- `autoTest=true`: Every `file_write`/`file_edit` triggers `npm run test` (when a `test` script exists). After implementation tasks (DAG nodes with `agentHint=general` or `spawn_subagent` general role), a Tester sub-agent is automatically spawned.
- `autoCommit=true`: Only when Tester outputs `VERDICT: PASS`, a Committer sub-agent is spawned to create a local commit. **Off by default** to avoid unintended commits.

Web panel toggles: `Quality Gate: Auto-Test` / `Quality Gate: Auto-Commit`.  
CLI: `nexus config` interactive editing (or `nexus config web`).

**2. Per-task on-demand — bypasses global config**

- **Explicit tool calls**: Call `spawn_tester` (read-only test) or `spawn_committer` (review + commit) anytime without modifying config.
- **Planned task role annotation**: After `/plan` decomposes a request into a DAG, annotate any node with `agentHint: tester` or `agentHint: committer`. The DAG scheduler executes it with the corresponding role, regardless of `autoTest`/`autoCommit` settings.
- `spawn_subagent` supports `agent_type: general | tester | committer` to select the role.

### Recommended Usage

| Scenario | Config | Behavior |
| --- | --- | --- |
| Default (regression protection) | `autoTest:true, autoCommit:false` | Auto-test during coding; you confirm commits |
| Fully automatic | `autoTest:true, autoCommit:true` | Auto-commit after tests pass |
| One-off fine control | Don't change config | Use `spawn_tester` / `spawn_committer` directly or annotate DAG nodes |

### Task DAG Modes

`/plan` decomposes requests into 3-5 sub-tasks with two modes:

| Mode | Trigger | Behavior |
| --- | --- | --- |
| `new` | No `@path` reference | All files written to `~/.nexus/tasks/outputs/<project>/` sandbox |
| `modify` | Request contains `@path` file references | Edit existing files in-place; auto-creates git snapshot (`git add -A && git commit`) for rollback |

After DAG execution, **finalize** runs automatically: cleans up temp files (`_probe`, `__pycache__`, `.pytest_cache`, `dist`, `build`, etc.), collects deliverables, and generates a `.task-complete.json` report.

### Performance Optimizations

- Sub-agent `maxTurns` reduced: General 10→6, Tester 8→4, Committer 6→4 — fewer wasted rounds
- Max retries per task reduced from 2 to 1
- `src/mcp/client-manager.ts`: tool name dedup — builtin tools take priority over MCP tools with the same name
- MCP tools call `existsSync` before prompting for authorization — avoids prompts for nonexistent files

### Permission Whitelist

The permission system has three levels: `Allow` (never prompt), `Prompt` (ask the user), and `Deny` (always refuse). By default every mutating tool is `Prompt`, so the agent asks before each action. The whitelist lets you pre-approve tools so vibe-coding sessions run uninterrupted.

**Session-level caching:** In `auto` mode (whitelist enabled), once you approve a tool during a session, subsequent calls to the same tool are auto-approved without re-prompting. This cache is cleared when nexus restarts.

**Three independent mechanisms:**

1. **Tool-name whitelist (`/bypass`)** — controls *whether a tool is asked*.
   ```bash
   /bypass on        # enable whitelist (auto mode); applies the "edit" preset if none set
   /bypass off       # revert to prompt mode (each tool asks)
   /bypass status    # show current mode + allowlist
   ```
   Manage it persistently via CLI:
   ```bash
   nexus config permissions preset edit   # fill allowlist with read+write file tools
   nexus config permissions enable         # switch to auto mode
   nexus config permissions disable        # back to prompt mode
   nexus config permissions add <tool...>  # add specific tools
   nexus config permissions remove <tool...>
   nexus config permissions list
   ```

2. **Path whitelist for exec (`safePaths`)** — controls *whether `exec_command` is asked*, based on the command's working directory. Commands run inside a safe path are auto-approved (unless dangerous). Default safe paths: `~/.nexus/tasks` and `.` (the agent's start directory / pwd). `~` expands to the user home.
   ```bash
   nexus config permissions path list
   nexus config permissions path add <path...>
   nexus config permissions path remove <path...>
   ```

3. **Path authorization (`path-authorizer`)** — a separate security layer that controls *whether a directory can be accessed at all*. It always prompts on first access to a new directory and remembers the grant (`y` once / `a` always). This is independent of the whitelist and is never bypassed.

**`/go` integration:** when you run `/go` to execute a plan, the whitelist is temporarily switched to auto (applying the `edit` preset if no allowlist is configured) for the duration of execution, then restored to your persisted setting afterward — the change is never written to disk.

> Dangerous commands (`rm -rf /`, `mkfs`, etc.) and destructive tools (`delete_file`, `remove_file`) are always blocked regardless of whitelist state.

## Security Constraints

- If tests fail or Tester errors, the auto-commit chain **aborts** — no unverified code is committed.
- Tester is read-only (only `exec_command` for tests); Committer only does local `add`+`commit`, never pushes.
- `modify` mode git snapshots are local-only, never pushed.
- Related source: `src/config/index.ts` (`getQualityGate`/`setQualityGate`), `src/task/task-tools.ts` (`runQualityGate`), `src/task/sub-agent-roles.ts` (role definitions), `src/hooks/auto-validate.ts` (auto-test on file write), `src/task/dag-scheduler.ts` (finalize / snapshot).

## Skills

Place skill modules in `~/.nexus/skills/`. Each skill is either a **JS module** or a **markdown prompt** (`SKILL.md`).

### SKILL.md (Prompt-Based Skills)

```
~/.nexus/skills/<skill-name>/
├── SKILL.md             # Skill prompt with YAML frontmatter
├── evals/evals.json     # Optional test cases
└── ...                  # Supporting files
```

Frontmatter format:

```yaml
---
name: my-skill
version: 1.0.0
description: One-line description of what the skill does
---
```

The body contains detailed markdown instructions with tool usage examples. Skills are loaded at startup and on `/skills reload`.

### JS Module Skills

```javascript
// ~/.nexus/skills/my-skill.js
export default {
  name: 'my-skill',
  version: '1.0.0',
  tools: [
    {
      name: 'my_tool',
      description: 'Does something',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
    }
  ],
  async handleCommand(cmd, args) {
    return `Handled: ${cmd}`;
  }
};
```

### Skill Management Commands

Within chat, use `/skills` to manage skills:

| Command | Description |
|---------|-------------|
| `/skills list` | List all loaded skills |
| `/skills reload` | Reload all skills from disk |
| `/skills create <name>` | Interactively create a new skill — prompts for a description and multi-line instructions (end input with `---` or Ctrl+Z) |
| `/skills validate <name>` | Validate skill structure (frontmatter, body length, tool refs, semver, etc.) |
| `/skills fix <name>` | Auto-fix common issues (missing fields, old paths, missing README/CHANGELOG/evals) |
| `/skills fix-smart <name>` | Spawn a Skill Fixer sub-agent to intelligently repair complex issues |

The **Skill Fixer sub-agent** (`fix-smart`) uses an LLM to:
- Convert YAML block scalars to inline descriptions
- Add `call`/`invoke`-prefixed tool usage examples
- Update `~/.claude/skills/` paths to `~/.nexus/skills/`
- Expand short body content with meaningful instructions
- Create or populate `evals/evals.json` with placeholder test cases

## Development

```bash
npm run dev        # Run with tsx
npm run build      # Compile TypeScript
npm run typecheck  # Check types (tsc --noEmit)
npm test           # Run all unit tests
```

## Vision / Multi-Modal

The agent can analyze images using either a **local model** (Florence-2) or **cloud vision APIs** (GLM-4V, Agnes-2V, etc.). The fallback behavior is controlled by the `visionMode` setting.

### Vision Modes

| Mode | Behavior |
|------|----------|
| `local-first` (default) | Try local Florence-2 first; fall back to cloud on failure |
| `cloud-first` | Try active cloud provider first; fall back to local |
| `local-only` | Use local Florence-2 only (no cloud calls) |
| `cloud-only` | Use active cloud provider only (no local calls) |

```bash
# Show current mode
nexus config vision-mode list

# Change mode
nexus config vision-mode set local-only
nexus config vision-mode set cloud-first
```

## OpenCode Zen

OpenCode Zen is a curated **Anthropic-compatible** model gateway run by the
OpenCode team. Once authenticated, Nexus uses it just like any other
Anthropic provider (`claude-opus-4-6`, `claude-sonnet-4-6`, `big-pickle`,
`minimax-m2.5-free`, ...). Visit <https://opencode.ai/docs/zen/> for the
current model list and pricing.

```bash
# Interactive login — opens https://opencode.ai/auth and saves the API key
nexus config opencode-zen login

# Or non-interactive (for CI / scripts):
nexus config opencode-zen login --key sk-... --use

# Show where the key comes from (stored key vs $OPENCODE_API_KEY)
nexus config opencode-zen status

# Activate Zen (the stored key is used by default)
nexus config opencode-zen use

# Switch to a specific model (and activate)
nexus config opencode-zen use claude-sonnet-4-6
nexus config opencode-zen use big-pickle

# Just change the model, keep current provider
nexus config opencode-zen use claude-opus-4-6 --no-switch

# List curated models
nexus config opencode-zen models

# Remove the stored key
nexus config opencode-zen logout
```

Behind the scenes this writes a provider entry into `~/.nexus/config.json`:

```json
{
  "providers": {
    "opencode-zen": {
      "type": "anthropic",
      "apiKey": "<encrypted>",
      "baseUrl": "https://opencode.ai/zen",
      "model": "claude-sonnet-4-6"
    }
  }
}
```

`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY` are honored at runtime if set,
without needing to log in again. Prefer the env var in shared / CI environments.

### Local Vision Setup

Requires **Python 3.10+** with PyTorch and Transformers.

Run the setup script to create a `.venv`, install dependencies, and pre-download the Florence-2 model:

```powershell
# Default (direct HuggingFace)
.\scripts\setup-vision.ps1

# HF mirror for China users
.\scripts\setup-vision.ps1 -Mirror hf-mirror.com -PypiMirror https://pypi.mirrors.ustc.edu.cn/simple
```

The agent auto-detects Python in the project `.venv`. To use a custom Python path, set:

```bash
set LLMA_VISION_PYTHON=C:\path\to\python.exe
```

### Cloud Vision Providers

Configure a cloud vision provider (e.g., Zhipu GLM-4V, Agnes-AI Agnes-2V):

```bash
# Add a provider (API key can reference an env var)
nexus config vision set glm-4v ^
  -k $ZHIPU_KEY ^
  -u https://open.bigmodel.cn/api/paas/v4/chat/completions ^
  -m glm-4v-flash

# List configured providers
nexus config vision list

# Switch active provider
nexus config vision use glm-4v

# Remove a provider
nexus config vision remove glm-4v
```

### Cloudinary Image Upload

Cloud vision providers typically require a publicly accessible image URL. The agent uploads local images to Cloudinary before sending to the cloud API. Set these environment variables:

```bash
set CLOUDINARY_CLOUD_NAME=your_cloud
set CLOUDINARY_API_KEY=your_key
set CLOUDINARY_API_SECRET=your_secret
```

Images are automatically cleaned up from Cloudinary after analysis.

## OCR (Text Extraction)

The `ocr_extract` tool extracts text from images (screenshots, documents, terminal output, forms, slides). Supports both cloud API and local OCR providers.

### Cloud OCR Providers

```bash
# Configure a cloud OCR provider (e.g. DeepSeek OCR via ModelVerse)
nexus config ocr set ds-ocr2 -t openai-compatible \
  -k $API_KEY_DSOCR \
  -u https://api.modelverse.cn/v1/chat/completions \
  -m deepseek-ai/DeepSeek-OCR

# List providers
nexus config ocr list

# Switch active provider
nexus config ocr switch ds-ocr2
```

### Local OCR (PaddleOCR Portable)

A standalone **PaddleOCR** executable (`paddle-ocr.exe`, ~90MB) is available for offline OCR without API keys. Powered by RapidOCR + ONNX Runtime with PP-OCRv6 models.

**Download:** [paddle-ocr.exe — nexus-extensions](https://github.com/jsws9517/nexus-extensions)

```bash
# Configure nexus to use the local portable OCR
nexus config ocr set paddle-local -t paddleocr \
  --command "C:\path\to\paddle-ocr.exe"

# Set as active (local first, API as fallback)
nexus config ocr switch paddle-local
```

**Standalone usage:**

```bash
paddle-ocr.exe --image screenshot.png                    # JSON output
paddle-ocr.exe --image photo.jpg --lang en --output text # Plain text
paddle-ocr.exe --image doc.png --show-boxes              # With confidence
paddle-ocr.exe --version                                 # Version info
```

## Speech / Audio

The agent supports both **Speech-to-Text (STT)** and **Text-to-Speech (TTS)** through a unified `speechProviders` configuration. Each provider has a `category` field (`stt` or `tts`) that selects the role.

### STT — Speech-to-Text (transcribe_audio)

Transcribe audio files (meeting recordings, voice messages, lectures) into text using the `transcribe_audio` tool.

```bash
# Configure an STT provider (Aliyun DashScope ASR)
nexus config speech set asr-qwen \
  -k $API_KEY_ALIYUN \
  -u https://dashscope.aliyuncs.com/compatible-mode/v1 \
  -m qwen3-asr-flash \
  -c stt

# Or using SiliconFlow (TeleSpeechASR)
nexus config speech set asr-tel \
  -k $API_KEY_SILICON \
  -u https://api.siliconflow.cn/v1 \
  -m TeleAI/TeleSpeechASR \
  -c stt

# List configured providers
nexus config speech list

# Set active STT provider
nexus config speech switch asr-qwen
```

### TTS — Text-to-Speech (synthesize_speech)

Generate spoken audio from text using the `synthesize_speech` tool. Supports OpenAI-compatible TTS APIs and local providers.

```bash
# Configure a cloud TTS provider (OpenAI-compatible)
nexus config speech set openai-tts \
  -k $API_KEY_OPENAI \
  -u https://api.openai.com/v1 \
  -m tts-1 \
  -c tts \
  --voice alloy

# Configure local Kokoro TTS (no API key required)
nexus config speech set kokoro \
  -k dummy \
  -u http://localhost:8181/v1 \
  -m kokoro \
  -c tts \
  --voice af_sky

# Set active TTS provider
nexus config speech switch-tts kokoro
```

### Supported Audio Formats

`transcribe_audio` accepts: `wav`, `mp3`, `m4a`, `ogg`, `flac`, `webm`, `aac`, `wma`.

## ACP Protocol

Nexus implements the **Agent-to-Agent Communication Protocol (ACP)** — a JSON-RPC 2.0 transport over stdin/stdout. It is used by cc-connect (a relay bridge for Feishu, WeChat, Telegram, etc.) to forward user messages to the agent and stream responses back.

### ACP Timeouts

Long-running tasks (MCP tool calls, slow model responses) can stall the transport. Three configurable parameters protect session liveness:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `chunkIdleMs` | 60000 | Per-chunk stall guard — aborts the LLM stream if no chunk arrives within this window |
| `watchdogRemoteMs` | 90000 | Turn deadline — process exits if the entire turn exceeds this time (nuclear fallback) |
| `heartbeatMs` | 30000 | Alive-ping interval — sends a `session/update { heartbeat }` notification to cc-connect so the transport knows the agent is still working during long tool calls |

**Keep `watchdogRemoteMs ≥ 3× heartbeatMs`** so the deadline allows multiple heartbeats before firing.

```bash
# List current values (with source: config / env / default)
nexus config acp timeout list

# Set a custom value
nexus config acp timeout set heartbeatMs 10000
nexus config acp timeout set watchdogRemoteMs 60000

# Reset to default
nexus config acp timeout reset chunkIdleMs

# Env overrides (highest priority):
#   NEXUS_CHUNK_IDLE_TIMEOUT_MS
#   NEXUS_WATCHDOG_REMOTE_MS
#   NEXUS_HEARTBEAT_INTERVAL_MS
```

The ACP server emits a **heartbeat** every `heartbeatMs` during a turn. If cc-connect receives no data at all within its own connection timeout, it drops the session; the heartbeat fills that gap. If the turn stalls past `watchdogRemoteMs`, the agent process exits cleanly and cc-connect spawns a fresh instance for the next message.

## Recent Changes (v1.1.7+)

### Features

- **Session-Level Tool Approval Cache**: When permission mode is `auto`, once a user approves a tool (e.g. `file_write`) during a session, subsequent calls to the same tool are auto-approved without re-prompting. Cache is cleared on nexus restart. Eliminates repetitive `Allow tool "..."?` prompts during vibe-coding sessions
- **MCP Tool Timeout & Auto-Reconnect**: All MCP tool calls have a 30-second timeout. If a server hangs, the call fails gracefully and the stuck server is automatically disconnected — the next call triggers a fresh restart. Prevents indefinite hangs from unresponsive MCP servers
- **Memory Server Timeout Handling**: Knowledge graph operations (`remember`, `saveUserInfoIfNeeded`) now detect server timeouts and return actionable error messages (e.g. `taskkill /f /im uv.exe`) instead of hanging indefinitely
- **Memory Tool Permission Defaults**: `recall` is now always-allowed (read-only); `remember` and `remember_project` default to `Prompt` — consistent with other write operations
- **cc-connect Native File Push**: Automatically detect generated files (images, PDFs, etc.) and push them natively to IM platforms (Telegram, Feishu, WeChat) via `cc-connect send --image` CLI, with Cloudinary URL fallback for text rendering
- **ACP Typing Indicator**: Real-time typing indicator (`session/update { typing }`) sent every 5 seconds during LLM processing, enabling messenger bridges to show "typing..." status
- **ACP Permission Protocol**: Tool permission requests (`session/request_permission`) forwarded through ACP to cc-connect for user approval, supporting `allow`/`deny` verdicts with 2-minute timeout
- **ACP Debug Toggle**: Debug logging toggle via ACP config (`nexus config acp debug on/off`) instead of environment variables
- **Config Web UI**: Browser-based configuration panel (`nexus config web`) for managing providers, MCP servers, permissions, and quality gate settings
- **i18n Bilingual Support**: English and Chinese language support with `/lang` command, bilingual welcome screen and help output
- **Single-key Permission Prompts**: Compact permission prompts with auto-submit (`y`/`a`/`n` without Enter), improving vibe-coding flow
- **MCP Tool Whitelist**: Pre-approve MCP tools via `/bypass` command, with web UI permissions panel for visual management
- **Data Redaction**: `read_text_file` / `read_multiple_files` auto-redact sensitive content — lat/lng coordinates fuzzed by a random offset (~1km, numeric shape preserved so generated debug/processing code keeps working), credential fields (password/token/key/账号/私钥) masked to `***REDACTED***`; `read_multiple_files` capped at 100 paths and 100KB per file to prevent context overflow
- **API Key Encryption**: Plaintext provider and MCP keys in `config.json` auto-encrypted to `enc:` AES-256-GCM blobs on startup; MCP server `env` values support `enc:` blobs and `$VAR` / `env:VAR` references (only KEY-named env variables are auto-encrypted), keeping on-disk secrets opaque even when bypassing the CLI/Web UI

### Bugfixes

- **Security Hardening**: Fixed 22+ issues across the audit pass —
  - **Auth & ACP**: constant-time token comparison, MCP error dumps redact credentials
  - **Command & path safety**: block all interpreters/shells and network-exfil tools, `--ignore-scripts` on catalog npm installs, path grants scoped per-request to avoid process-wide accumulation, symlink-escape guard, Windows device path (CON/NUL) blocking
  - **Web UI**: `decodeURIComponent` on DELETE handlers, XSS escaping, removed unauthenticated bootstrap endpoint, API-key masking in config display
  - **File tools**: `read_multiple_files` limits (100 paths / 100KB), JSON.parse try/catch, expanded sensitive-path redaction
- **ESM Require Crash**: Fixed ESM import crash in permissions module and PageUp recall injecting plan blocks
- **Permission Prompt Fixes**: Fixed duplicated key echo, single-key prompt hang/duplicate, and y/N prompt not accepting input
- **Tool-call Display**: Fixed fragile `\r` in-place update, capped preview width, put `agent>` prompt on its own line
- **Skill Creator Fixes**: Fixed double-echo, hang-down, and dedup issues in skill creation flow
- **Config Web UI**: Fixed provider delete never persisted (missing `config.save()`)
- **Sub-agent Permissions**: Fixed parent permission mode propagation to sub-agents in worker mode
- **Session Persistence**: Fixed FOREIGN KEY constraint failed when deleting sessions with task_graphs
- **ACP Transport**: Fixed message lost random length and JSON-RPC `-32603: Invalid string length`

## Nexus-Desktop Release 彩蛋

## Easter Egg

> 🥚 **Easter Egg**: Nexus Desktop is coming soon — stay tuned!
> 
> Nexus Desktop will feature:
> - 🖥️ Standalone desktop application window
> - 📋 Clipboard image paste (Alt+V) with visual preview
> - 🔌 Plugin management GUI
> - 📊 Session history visual browser
> - ⚡ One-click launch, no terminal required
>
> [![Star History Chart](https://api.star-history.com/svg?repos=ppk1234/nexus&type=Date)](https://star-history.com/#ppk1234/nexus&Date)

## License

ISC
