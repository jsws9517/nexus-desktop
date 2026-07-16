import { ToolDefinition, ToolResult } from '../types.js';

export interface McpServerConnection {
  name: string;
  client: unknown; // MCP Client instance
  transport: unknown;
  tools: ToolDefinition[];
}

export interface BuiltinToolContext {
  /** Default working directory for shell commands (e.g. the active project dir). */
  workDir?: string;
  /** The parent Agent instance, available when called from within a chat session. */
  agent?: import('../agent.js').Agent;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: object;
  execute(args: Record<string, unknown>, ctx?: BuiltinToolContext): Promise<ToolResult>;
}
