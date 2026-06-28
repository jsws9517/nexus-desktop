# NexusAgent

A powerful TypeScript CLI agent connecting multiple LLM providers, MCP tools, skills/plugins, and ACP protocol — the intelligent hub for your development workflow.

## Features

- **Multi-Provider LLM Support**: Anthropic (Claude) and OpenAI (GPT) with easy switching
- **Session Management**: Persistent chat sessions with SQLite storage, cross-process recovery
- **Long Context Handling**: Sliding window + automatic summarization
- **MCP Tools**: Connect to external MCP servers + built-in tools (file_read, file_write, exec_command, fetch_url)
- **Skills/Plugins**: Dynamic loading from `~/.nexus/skills/`
- **ACP Protocol**: Agent-to-agent communication support

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

# Add MCP server
nexus config mcp add filesystem --command npx --args -y @modelcontextprotocol/server-filesystem /path/to/allow
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
- `/session` - Show current session
- `/clear` - Clear context
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
npm run typecheck  # Check types
```

## License

ISC
