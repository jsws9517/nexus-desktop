import { ToolDefinition, ToolResult } from '../types.js';

export interface AgentContext {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  sendMessage(message: string): Promise<void>;
  /** Ask the user a question and wait for their response. Returns the user's answer or null if cancelled. */
  askUser(question: string, options?: string[]): Promise<string | null>;
  /** Root directory of the currently executing skill on disk */
  skillRoot?: string;
}

/** A single step in a skill's workflow with its completion criterion */
export interface SkillStep {
  name: string;
  done: string;
}

export interface Skill {
  name: string;
  version: string;
  description?: string;
  /** Root directory of this skill on disk (set by loader) */
  rootDir?: string;
  /** Source directory type: 'skills' | 'plugins' | 'claude' */
  source?: 'skills' | 'plugins' | 'claude';
  /** Optional structured steps with completion criteria for multi-step workflows */
  steps?: SkillStep[];
  init?(ctx: AgentContext): Promise<void>;
  tools?: ToolDefinition[];
  callTool?(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  handleCommand?(cmd: string, args: string[]): Promise<string>;
}
