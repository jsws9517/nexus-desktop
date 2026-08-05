export interface Session {
  id: string;
  name: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: string; // JSON
  toolCallId?: string;
  thinking?: string; // reasoning_content transcript (display only, not LLM context)
  tokens?: number;
  createdAt: number;
}
