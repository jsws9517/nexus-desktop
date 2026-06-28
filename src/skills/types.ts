import { ToolDefinition, ToolResult } from '../types.js';

export interface AgentContext {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  sendMessage(message: string): Promise<void>;
}

export interface Skill {
  name: string;
  version: string;
  description?: string;
  init?(ctx: AgentContext): Promise<void>;
  tools?: ToolDefinition[];
  callTool?(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  handleCommand?(cmd: string, args: string[]): Promise<string>;
}
