import { ToolDefinition, ToolResult } from '../types.js';

export interface McpServerConnection {
  name: string;
  client: unknown; // MCP Client instance
  transport: unknown;
  tools: ToolDefinition[];
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: object;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
