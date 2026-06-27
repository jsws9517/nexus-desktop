import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Session, StoredMessage } from './types.js';

const DATA_DIR = join(homedir(), '.llm-agent');
const DB_PATH = join(DATA_DIR, 'sessions.db');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  tokens INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
`;

export class SessionStore {
  private db: Database.Database;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.exec(INIT_SQL);
  }

  createSession(session: Session): void {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, name, provider, model, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      session.id,
      session.name,
      session.provider,
      session.model,
      session.createdAt,
      session.updatedAt,
      session.metadata ? JSON.stringify(session.metadata) : null
    );
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return this.rowToSession(row);
  }

  listSessions(): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as
      Record<string, unknown>[];
    return rows.map((r) => this.rowToSession(r));
  }

  updateSession(id: string, updates: Partial<Pick<Session, 'name' | 'updatedAt' | 'metadata'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.updatedAt !== undefined) { sets.push('updated_at = ?'); values.push(updates.updatedAt); }
    if (updates.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  addMessage(message: StoredMessage): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      message.sessionId,
      message.role,
      message.content,
      message.toolCalls || null,
      message.toolCallId || null,
      message.tokens || null,
      message.createdAt
    );
  }

  getMessages(sessionId: string): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMessage(r));
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      name: row.name ? String(row.name) : '',
      provider: String(row.provider),
      model: String(row.model),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
    };
  }

  private rowToMessage(row: Record<string, unknown>): StoredMessage {
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as StoredMessage['role'],
      content: String(row.content),
      toolCalls: row.tool_calls ? String(row.tool_calls) : undefined,
      toolCallId: row.tool_call_id ? String(row.tool_call_id) : undefined,
      tokens: row.tokens ? Number(row.tokens) : undefined,
      createdAt: Number(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
