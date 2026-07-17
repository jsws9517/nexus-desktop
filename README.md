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
- **MCP Tools**: Connect to external MCP servers for specialized capabilities; builtin tools take priority over MCP for deduplication
- **Path Authorization**: Prompt/Allow/Deny with per-session (`y`) and persistent (`a`) grants, cached in `path-auth.json`; early `existsSync` checks avoid unnecessary auth prompts for missing files
- **Slash Commands**: `/model`, `/provider`, `/session`, `/resume`, `/memory`, `/insight`, `/tools`, `/skills`, `/config`, `/clear`, `/exit`, `/plan`, `/tasks`, `/btw`, `/theme`
- **Skills/Plugins**: Dynamic loading from `~/.nexus/skills/` with auto-generated fallback for invalid skill directories
- **ACP Protocol**: Agent-to-agent communication via WebSocket
- **Diff Renderer**: Colorized inline diff output for LLM responses
- **Vision / Multi-Modal**: `analyze_image` tool with local (Florence-2) and cloud vision providers (GLM-4V, Agnes-2V, etc.), configurable fallback modes
- **Task DAG Engine**: Decompose requests into 3-5 sub-tasks, execute with dependency resolution, support `new` (greenfield) and `modify` (edit existing) modes with automatic git snapshot & rollback safety
- **Temp File Cleanup**: Post-task finalization removes probe/scratch/cache files and collects deliverables into a sandboxed output directory

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
- `/theme` - Show/switch color theme
- `/flush` - Clear the screen
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

### Security Constraints

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

## License

ISC
