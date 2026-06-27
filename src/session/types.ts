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
  tokens?: number;
  createdAt: number;
}
