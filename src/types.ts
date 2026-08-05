export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Model reasoning/reasoning_content captured during streaming. Persisted for
   *  the session transcript only — never sent back to the LLM as context. */
  thinking?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Originating MCP server name, if this is an MCP-provided tool. */
  server?: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  /** Originating MCP server name, if this is an MCP-provided tool. */
  server?: string;
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

export interface FileOutput {
  path: string;
  mimeType: string;
  name: string;
}

export type AgentEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call_start'; index: number; name: string; args: Record<string, unknown> }
  | { type: 'tool_call_end'; index: number; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; index: number; name: string; content: string; isError?: boolean }
  | { type: 'file_ready'; path: string; mimeType: string; name: string }
  | { type: 'state_delta'; contextTokens: number; turn: number }
  | { type: 'turn_end'; stopReason: string; usage?: TurnUsage }
  | { type: 'session_end' }
  | {
      type: 'task_graph';
      graphId: string;
      tasks: Array<{
        id: string;
        description: string;
        role: string;
        status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
        error?: string;
      }>;
    }
  | { type: 'task_started'; taskId: string; description: string; role: string }
  | { type: 'task_completed'; taskId: string }
  | { type: 'task_failed'; taskId: string; error: string };
