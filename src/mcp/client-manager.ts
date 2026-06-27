import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolDefinition, ToolResult } from '../types.js';
import { BUILTIN_TOOLS } from './builtin-tools.js';
import { ServerConfig } from '../config/types.js';

interface ServerConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: ToolDefinition[];
}

export class ClientManager {
  private connections: Map<string, ServerConnection> = new Map();
  private builtinTools = BUILTIN_TOOLS;

  async connectServer(name: string, config: ServerConfig): Promise<void> {
    const client = new Client(
      { name: `llm-agent-client-${name}`, version: '1.0.0' },
      { capabilities: {} }
    );
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env as Record<string, string>,
    });

    await client.connect(transport);

    // Fetch tools from the server
    const toolsResult = await client.listTools();
    const tools: ToolDefinition[] = toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema as object,
    }));

    this.connections.set(name, { name, client, transport, tools });
  }

  async connectAll(servers: Record<string, ServerConfig>): Promise<void> {
    for (const [name, config] of Object.entries(servers)) {
      if (config.autoStart !== false) {
        try {
          await this.connectServer(name, config);
        } catch (err) {
          console.error(`Failed to connect MCP server "${name}":`, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  getAllTools(): ToolDefinition[] {
    const mcpTools: ToolDefinition[] = [];
    for (const conn of this.connections.values()) {
      mcpTools.push(...conn.tools);
    }
    const builtinToolDefs: ToolDefinition[] = this.builtinTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return [...builtinToolDefs, ...mcpTools];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Check builtin tools first
    const builtin = this.builtinTools.find((t) => t.name === name);
    if (builtin) {
      return builtin.execute(args);
    }

    // Find in MCP servers
    for (const conn of this.connections.values()) {
      const hasTool = conn.tools.some((t) => t.name === name);
      if (hasTool) {
        const result = await conn.client.callTool({ name, arguments: args });
        const content = (result.content as Array<{ type: string; text?: string }>)
          .map((c) => (c.type === 'text' ? (c.text || '') : JSON.stringify(c)))
          .join('\n');
        return { content, isError: result.isError as boolean | undefined };
      }
    }

    return { content: `Tool "${name}" not found`, isError: true };
  }

  listConnections(): { name: string; toolCount: number; status: string }[] {
    return Array.from(this.connections.values()).map((c) => ({
      name: c.name,
      toolCount: c.tools.length,
      status: 'connected',
    }));
  }

  async disconnect(name?: string): Promise<void> {
    if (name) {
      const conn = this.connections.get(name);
      if (conn) {
        await conn.client.close();
        this.connections.delete(name);
      }
    } else {
      for (const conn of this.connections.values()) {
        await conn.client.close();
      }
      this.connections.clear();
    }
  }
}
