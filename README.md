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

## License

ISC
