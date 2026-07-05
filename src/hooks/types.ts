import { ToolCall, ToolResult, ToolDefinition, Message } from '../types.js';

export interface HookContext {
  turn: number;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  message?: Message;
  userInput?: string;
  signal: AbortSignal;
  toolDefinitions?: ToolDefinition[];
}

export type HookResult = 'allow' | { verdict: 'deny'; reason: string };

export interface Hooks {
  preLlmCall?: (ctx: HookContext) => Promise<void>;
  postLlmCall?: (ctx: HookContext) => Promise<void>;
  preToolUse?: (ctx: HookContext) => Promise<HookResult>;
  postToolUse?: (ctx: HookContext) => Promise<void>;
  onError?: (ctx: HookContext, error: Error) => Promise<void>;
  onTurnEnd?: (ctx: HookContext) => Promise<void>;
}
