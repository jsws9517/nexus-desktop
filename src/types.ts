export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ChatChunk {
  type: 'text' | 'tool_call' | 'thinking' | 'done';
  text?: string;
  toolCall?: ToolCall;
  thinking?: string;
  thinkingBudget?: number;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call_start'; index: number; name: string; args: Record<string, unknown> }
  | { type: 'tool_call_end'; index: number; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; index: number; name: string; content: string; isError?: boolean }
  | { type: 'state_delta'; contextTokens: number; turn: number }
  | { type: 'turn_end'; stopReason: string; usage?: TurnUsage }
  | { type: 'session_end' };
