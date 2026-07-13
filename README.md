# NexusAgent

A powerful TypeScript CLI agent connecting multiple LLM providers, MCP tools, filesystem automation, skills/plugins, and ACP protocol — the intelligent hub for your development workflow.

## Features

- **Multi-Provider LLM Support**: Anthropic (Claude) and OpenAI (GPT) with easy switching, configurable via CLI
- **Session Management**: Persistent chat sessions with SQLite storage, cross-process recovery, `/resume` browsing
- **Long Context Handling**: Sliding window + automatic summarization + context compaction
- **Per-Session Persistent Memory**: Automatic memory summaries persisted per session, `/memory` view, cross-session `/insight` analysis
- **Rich Interactive Chat**: Streaming output with gradient separator, session report, `/history` browsing, PageUp traversal
- **Built-in Filesystem Tools**: Full file read/write/edit/move/copy/delete/directory-tree — no external MCP server needed
- **MCP Tools**: Connect to external MCP servers for specialized capabilities
- **Path Authorization**: Prompt/Allow/Deny with per-session (`y`) and persistent (`a`) grants, cached in `path-auth.json`
- **Slash Commands**: `/model`, `/provider`, `/session`, `/history`, `/resume`, `/memory`, `/insight`, `/tools`, `/skill`, `/config`, `/export`, `/clean`, `/clear`, `/exit`
- **Skills/Plugins**: Dynamic loading from `~/.nexus/skills/`
- **ACP Protocol**: Agent-to-agent communication via WebSocket
- **Diff Renderer**: Colorized inline diff output for LLM responses
- **Vision / Multi-Modal**: `analyze_image` tool with local (Florence-2) and cloud vision providers (GLM-4V, Agnes-2V, etc.), configurable fallback modes

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
- `/clean` - Prune zero-token or old sessions
- `/clear` - Clear context (starts fresh)
- `/exit` - Quit

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
| `local-only` | Use local Florence-2 only; never call cloud APIs |
| `cloud-only` | Use active cloud provider only; never call local model |

```bash
# Show current mode
nexus config vision-mode list

# Change mode
nexus config vision-mode set local-only
nexus config vision-mode set cloud-first
```

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
