import { randomUUID } from 'crypto';
import { Message } from '../types.js';
import { LLMProvider } from '../llm/provider.js';
import { SessionStore, ListSessionsOptions } from './store.js';
import { Session, StoredMessage } from './types.js';

export class SessionManager {
  private store: SessionStore;

  constructor(customDbPath?: string) {
    this.store = new SessionStore(customDbPath);
  }

  create(name: string, provider: string, model: string, metadata?: Record<string, unknown>): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      name: name || `Session ${new Date().toLocaleString()}`,
      provider,
      model,
      createdAt: now,
      updatedAt: now,
      ...(metadata ? { metadata } : {}),
    };
    this.store.createSession(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.store.getSession(id);
  }

  list(options?: ListSessionsOptions): { items: Session[]; total: number } {
    return this.store.listSessions(options);
  }

  rename(id: string, name: string): void {
    this.store.updateSession(id, { name, updatedAt: Date.now() });
  }

  delete(id: string): void {
    this.store.deleteSession(id);
  }

  touch(id: string): void {
    this.store.updateSession(id, { updatedAt: Date.now() });
  }

  /** Merge new fields into a session's metadata (preserving existing keys). */
  updateMetadata(id: string, metadata: Record<string, unknown>): void {
    const existing = this.get(id)?.metadata ?? {};
    this.store.updateSession(id, { metadata: { ...existing, ...metadata } });
  }

  addMessage(sessionId: string, message: Message, tokens?: number): void {
    const stored: StoredMessage = {
      id: 0,
      sessionId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
      toolCallId: message.toolCallId,
      thinking: message.thinking,
      tokens,
      createdAt: Date.now(),
    };
    this.store.addMessage(stored);
    this.touch(sessionId);
  }

  getMessages(sessionId: string): Message[] {
    const stored = this.store.getMessages(sessionId);
    return stored.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      toolCallId: m.toolCallId,
      thinking: m.thinking,
    }));
  }

  loadSession(id: string): { session: Session; messages: Message[] } | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    const messages = this.getMessages(id);
    return { session, messages };
  }

  getTokenEstimate(sessionId: string, provider?: LLMProvider): number {
    const messages = this.getMessages(sessionId);
    return messages.reduce((sum, m) => {
      return sum + (provider?.countTokens(m.content) || Math.ceil(m.content.length / 4));
    }, 0);
  }
}
