import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Desktop-only direct access to the core session DB.
 *
 * Used by regenerate(): the core exposes no "delete messages after X" API and,
 * per project convention, the dev/core branch stays untouched. This module
 * duplicates the `messages` table schema from core src/session/store.ts.
 *
 * TODO(收尾): if core ever renames/changes these columns (or the DB path), the
 * SQL below must be updated in sync.
 */
export interface StoredRow {
  id: number;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Mirrors core src/session/store.ts: LLMA_DATA_DIR overrides the data root. */
function dbPath(): string {
  const dir = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  return join(dir, 'sessions.db');
}

function openDb(): Database.Database {
  return new Database(dbPath());
}

/** All message rows for a session ordered by insertion (matches core getMessages ordering). */
export function getMessageRows(sessionId: string): StoredRow[] {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        'SELECT id, session_id AS sessionId, role, content FROM messages WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as Array<{ id: number; sessionId: string; role: StoredRow['role']; content: string }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.sessionId, role: r.role, content: r.content }));
  } finally {
    db.close();
  }
}

/** Delete the target message and everything after it for a session (inclusive). */
export function deleteMessagesFrom(sessionId: string, fromId: number): { deleted: number } {
  const db = openDb();
  try {
    const info = db
      .prepare('DELETE FROM messages WHERE session_id = ? AND id >= ?')
      .run(sessionId, fromId);
    return { deleted: info.changes };
  } finally {
    db.close();
  }
}
