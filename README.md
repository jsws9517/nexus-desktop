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
- **Slash Commands**: `/model`, `/provider`, `/session`, `/history`, `/resume`, `/memory`, `/insight`, `/tools`, `/skill`, `/config`, `/export`, `/clean`, `/clear`, `/exit`, `/plan`, `/tasks`
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
- `/tools` - List available tools
- `/session` - Show current session info
- `/history` - Browse all sessions
- `/resume <id>` - Resume a past session
- `/memory` - View this session's persistent memory
- `/insight` - Cross-session memory analysis
- `/model` - Show/switch LLM model
- `/provider` - Show/switch LLM provider
- `/skill` - List/load/unload skill plugins
- `/config` - View/edit configuration
- `/export` - Export session as markdown
- `/plan <request>` - Decompose a request into a DAG of sub-tasks (supports `@path` resolution)
- `/tasks [id]` - Show task graph or detailed step info (implicit `-step`)
- `/clean` - Prune zero-token or old sessions
- `/clear` - Clear context (starts fresh)
- `/exit` - Quit

## Development Workflow (开发规范流 / 质量门禁)

Nexus 内置两类编程子 agent —— **Tester**（测试）与 **Committer**（提交），可在编程任务中按需或自动串联，形成 `实现 → 测试 → 提交` 的规范流。

两类子 agent 的能力边界：
- **Tester**：只读，自动探测并运行项目测试 / lint / typecheck，输出 `VERDICT: PASS` / `VERDICT: FAIL`；绝不改源码、不提交。
- **Committer**：审查 git diff，跑一遍测试/构建，通过后用 Conventional Commits 风格创建**本地**原子提交；**绝不 `git push`**。

### 开启状态的两种控制方式

**1. 全局配置开关（config）—— 自动规范流**

在 `config.json`（或 Web 面板 General 区）中配置：

```json
{
  "qualityGate": {
    "autoTest": true,    // 默认 true：实现任务完成后自动跑 Tester
    "autoCommit": false  // 默认 false：测试通过也不自动提交，需手动确认
  }
}
```

- `autoTest=true`：每次 `file_write`/`file_edit` 后默认校验会包含 `npm run test`（当项目有 `test` 脚本时）；实现类任务（DAG 中 `agentHint=general` 的节点，或 `spawn_subagent` 的 general 角色）完成后，自动派生 Tester 子 agent 跑测试。
- `autoCommit=true`：仅当 Tester 输出 `VERDICT: PASS` 时，自动派生 Committer 子 agent 创建本地提交。**默认关闭**以避免未经确认的提交。

Web 面板：`Quality Gate: Auto-Test` / `Quality Gate: Auto-Commit` 两个开关可随时切换。
CLI：`nexus config` 交互编辑（或网页 `nexus config web`）。

**2. 按任务动态按需开启（per-task / on-demand）—— 不受全局开关限制**

- **显式工具调用**：编程过程中随时调用 `spawn_tester`（只读跑测试）或 `spawn_committer`（审查并提交），无需改动任何配置。
- **计划任务标注角色**：用 `/plan` 拆解为 DAG 后，某个节点可在 `agentHint` 标注 `tester` 或 `committer`，DAG 调度时按对应角色执行（即使 `autoTest`/`autoCommit` 关闭也会强制按角色跑）。
- `spawn_subagent` 支持 `agent_type: general | tester | committer` 参数选择角色。

### 推荐用法

| 场景 | 配置 | 行为 |
| --- | --- | --- |
| 默认（回归保护） | `autoTest:true, autoCommit:false` | 编码时自动跑测试；提交由你确认 |
| 全自动 | `autoTest:true, autoCommit:true` | 测试通过后自动本地提交 |
| 单次精细控制 | 不改 config | 直接用 `spawn_tester` / `spawn_committer` 或给 DAG 节点标 `agentHint` |

### 任务 DAG 模式

`/plan` 自动将请求分解为 3-5 个子任务，支持两种模式：

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| `new` | 未引用 `@path` | 所有文件写入 `~/.nexus/tasks/outputs/<project>/` 沙箱 |
| `modify` | 请求包含 `@path` 文件引用 | 直接编辑现有文件；完成后自动创建 git snapshot（`git add -A && git commit`）用于回滚 |

DAG 执行完成后自动运行 **finalize**：清理临时文件（`_probe`、`__pycache__`、`.pytest_cache`、`dist`、`build` 等）、收集可交付产物、生成 `.task-complete.json` 报告。

### 性能优化

- 子 agent `maxTurns` 减少：General 10→6、Tester 8→4、Committer 6→4，缩短无效轮次
- 任务最大重试次数从 2 减为 1
- `src/mcp/client-manager.ts` 工具名去重：内置工具优先于 MCP 同名工具
- MCP 工具调用前置 `existsSync` 检查，避免为不存在的文件弹出授权提示

### 安全约束

- 测试失败 / Tester 出错时，自动提交链会**中止**，不会提交未通过验证的代码。
- Tester 仅读、`exec_command` 跑测试；Committer 只做本地 `add`+`commit`，绝不 push。
- modify 模式的 git snapshot 仅本地提交，绝不 push。
- 相关实现：`src/config/index.ts`（`getQualityGate`/`setQualityGate`）、`src/task/task-tools.ts`（`runQualityGate`）、`src/task/sub-agent-roles.ts`（角色定义）、`src/hooks/auto-validate.ts`（写文件时自动跑测试）、`src/task/dag-scheduler.ts`（finalize / snapshot）。

## Skills

Place skill modules in `~/.nexus/skills/`:

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
