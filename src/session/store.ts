import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { Session, StoredMessage } from './types.js';

const DB_PATH = (() => {
  const dir = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'sessions.db');
})();

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
  thinking TEXT,
  tokens INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- Task progress tables (created by ProgressTracker too). Declared here so
-- SessionStore.deleteSession can clean them up even when no task ran in this
-- database before deletion.
CREATE TABLE IF NOT EXISTS task_graphs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  root_request TEXT NOT NULL,
  project_name TEXT,
  nodes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id TEXT NOT NULL,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_graph ON task_events(graph_id);
CREATE INDEX IF NOT EXISTS idx_task_graphs_session ON task_graphs(session_id);
`;

export interface ListSessionsOptions {
  /** Max rows to return. When unset, all matching rows are returned. */
  limit?: number;
  /** Skip the first N matching rows (for pagination). */
  offset?: number;
  /** Include ACP client sessions (internal noise). Defaults to false. */
  includeAcp?: boolean;
}

export class SessionStore {
  private db: Database.Database;
  private static tempDatabasePaths: Set<string> = new Set();

  constructor(customDbPath?: string) {
    const dbPath = customDbPath || DB_PATH;
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(INIT_SQL);
    // Migration for databases created before the `thinking` column existed.
    const cols = this.db.pragma(`table_info(messages)`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'thinking')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
    }

    // Register temp database for cleanup
    if (customDbPath) {
      SessionStore.tempDatabasePaths.add(dbPath);
    }
  }

  static async cleanupTempDatabases(): Promise<void> {
    for (const dbPath of SessionStore.tempDatabasePaths) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(dbPath);
      } catch {
        // ignore
      }
    }
    SessionStore.tempDatabasePaths.clear();
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

  listSessions(options: ListSessionsOptions = {}): { items: Session[]; total: number } {
    const { limit, offset, includeAcp } = options;
    // ACP client sessions (tagged via metadata.isAcp, or legacy rows named
    // 'ACP Session') are internal channel noise, not user conversations.
    // Exclude them from the user-facing list by default.
    const acpFilter = includeAcp
      ? ''
      : "WHERE (COALESCE(json_extract(metadata, '$.isAcp'), 0) != 1 AND name != 'ACP Session')";
    const count = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions ${acpFilter}`)
      .get() as { n: number };
    let sql = `SELECT id, name, provider, model, created_at, updated_at
               FROM sessions ${acpFilter} ORDER BY updated_at DESC`;
    const args: unknown[] = [];
    if (limit !== undefined && limit >= 0) {
      sql += ' LIMIT ?';
      args.push(limit);
      if (offset !== undefined && offset > 0) {
        sql += ' OFFSET ?';
        args.push(offset);
      }
    }
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return { items: rows.map((r) => this.rowToSession(r)), total: Number(count.n) };
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
    // Temporarily disable FK enforcement, then clean up all related tables
    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM task_events WHERE graph_id IN (SELECT id FROM task_graphs WHERE session_id = ?)').run(id);
      this.db.prepare('DELETE FROM task_graphs WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  addMessage(message: StoredMessage): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, thinking, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      message.sessionId,
      message.role,
      message.content,
      message.toolCalls || null,
      message.toolCallId || null,
      message.thinking || null,
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
      id: row.id ? String(row.id) : '',
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
      thinking: row.thinking ? String(row.thinking) : undefined,
      tokens: row.tokens ? Number(row.tokens) : undefined,
      createdAt: Number(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
