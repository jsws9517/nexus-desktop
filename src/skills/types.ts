import { ToolDefinition, ToolResult } from '../types.js';

export interface AgentContext {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  sendMessage(message: string): Promise<void>;
  /** Ask the user a question and wait for their response. Returns the user's answer or null if cancelled. */
  askUser(question: string, options?: string[]): Promise<string | null>;
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
