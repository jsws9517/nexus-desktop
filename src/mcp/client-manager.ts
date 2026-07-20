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
  schemas: Map<string, object>;
}

function normalizeArgs(raw: Record<string, unknown>, schema: object): Record<string, unknown> {
  // Handle case where raw is a JSON string (proxy serialization issue)
  let args = raw;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    args = {};
  }

  const s = schema as { 
    properties?: Record<string, { type?: string; default?: unknown }>;
    required?: string[];
  };
  if (!s.properties) return args as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args as Record<string, unknown>)) {
    const prop = s.properties[key];
    if (!prop) {
      out[key] = val;
    } else if (typeof val === 'string') {
      out[key] = val;
    } else if (prop.type === 'string') {
      out[key] = val == null ? '' : String(val);
    } else if (prop.type === 'number') {
      const n = Number(val);
      out[key] = isNaN(n) ? val : n;
    } else if (prop.type === 'boolean') {
      out[key] = val === 'true' || val === true || val === 1;
    } else if (prop.type === 'array') {
      out[key] = val != null && !Array.isArray(val) ? [val] : (val ?? []);
    } else {
      out[key] = val;
    }
  }
  
  // Fill required params with defaults if missing ONLY when a schema default exists.
  // Do NOT auto-fill strings with "" — that produces invalid values that servers reject
  // (e.g. maps_weather's required "city" becomes "" → INVALID_PARAMS).
  // Instead, let callTool validate and return a clear error before calling the server.
  if (s.required) {
    for (const key of s.required) {
      if (out[key] === undefined || out[key] === null) {
        const prop = s.properties[key];
        if (prop?.default !== undefined) {
          out[key] = prop.default;
        }
      }
    }
  }
  
  return out;
}

export class ClientManager {
  private connections: Map<string, ServerConnection> = new Map();
  private builtinTools = BUILTIN_TOOLS;
  /** Default working directory for builtin exec_command (e.g. active project dir). */
  workDir?: string;
  /** Parent Agent, set by Agent.init() for tools that need agent context. */
  agent?: import('../agent.js').Agent;

  /** Environment variable names that are never safe to pass to a subprocess. */
  private static BLOCKED_ENV_KEYS = new Set([
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
    'PATH', 'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PERL5LIB',
    'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'RUBYLIB',
  ]);

  async connectServer(name: string, config: ServerConfig): Promise<void> {
    const client = new Client(
      { name: `llm-agent-client-${name}`, version: '1.0.0' },
      { capabilities: {} }
    );
    // Strip dangerous environment variables before passing to subprocess
    const safeEnv: Record<string, string> = {};
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        if (!ClientManager.BLOCKED_ENV_KEYS.has(k.toUpperCase())) {
          safeEnv[k] = v as string;
        }
      }
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: safeEnv,
      stderr: 'pipe',
    });

    await client.connect(transport);

    // Fetch tools from the server
    const toolsResult = await client.listTools();
    const tools: ToolDefinition[] = [];
    const schemas = new Map<string, object>();
    for (const t of toolsResult.tools) {
      const schema = t.inputSchema as object;
      tools.push({ name: t.name, description: t.description || '', inputSchema: schema });
      schemas.set(t.name, schema);
    }

    this.connections.set(name, { name, client, transport, tools, schemas });
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
    const seen = new Set<string>();
    const result: ToolDefinition[] = [];
    // Builtin tools first (higher priority)
    for (const t of this.builtinTools) {
      seen.add(t.name);
      result.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
    // MCP tools — skip any name already registered by builtin
    for (const conn of this.connections.values()) {
      for (const t of conn.tools) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        result.push({ name: t.name, description: t.description || '', inputSchema: t.inputSchema as object, server: conn.name });
      }
    }
    return result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Check builtin tools first
    const builtin = this.builtinTools.find((t) => t.name === name);
    if (builtin) {
      return builtin.execute(args, { workDir: this.workDir, agent: this.agent });
    }

    // Find in MCP servers
    for (const conn of this.connections.values()) {
      const hasTool = conn.tools.some((t) => t.name === name);
      if (hasTool) {
        const schema = conn.schemas.get(name) ?? conn.tools.find(t => t.name === name)?.inputSchema;
        const safeArgs = schema ? normalizeArgs(args, schema) : args;

        // Validate required params: if still missing after normalization, return a clear error
        // rather than sending an invalid call that the server might crash on.
        if (schema) {
          const s = schema as { required?: string[]; properties?: Record<string, { type?: string }> };
          if (s.required) {
            const missing = s.required.filter(k => safeArgs[k] === undefined || safeArgs[k] === null);
            if (missing.length > 0) {
              const typeHints = missing.map(k => {
                const prop = s.properties?.[k];
                return prop ? `${k} (${prop.type})` : k;
              });
              return { content: `Missing required parameters for "${name}": ${typeHints.join(', ')}. Please retry with all required parameters.`, isError: true };
            }
          }
        }

        let result;
        try {
          result = await conn.client.callTool({ name, arguments: safeArgs });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const argsDump = JSON.stringify(safeArgs).slice(0, 500);
          const schemaDump = JSON.stringify(schema).slice(0, 500);
          return { content: `MCP tool "${name}" failed: ${errMsg}\nArgs: ${argsDump}\nSchema: ${schemaDump}`, isError: true };
        }
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
