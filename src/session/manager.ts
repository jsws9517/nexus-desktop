import { randomUUID } from 'crypto';
import { Message } from '../types.js';
import { SessionStore } from './store.js';
import { Session, StoredMessage } from './types.js';

export class SessionManager {
  private store: SessionStore;

  constructor() {
    this.store = new SessionStore();
  }

  create(name: string, provider: string, model: string): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      name: name || `Session ${new Date().toLocaleString()}`,
      provider,
      model,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createSession(session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.store.getSession(id);
  }

  list(): Session[] {
    return this.store.listSessions();
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

  addMessage(sessionId: string, message: Message, tokens?: number): void {
    const stored: StoredMessage = {
      id: 0,
      sessionId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : undefined,
      toolCallId: message.toolCallId,
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
    }));
  }

  loadSession(id: string): { session: Session; messages: Message[] } | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    const messages = this.getMessages(id);
    return { session, messages };
  }
}
