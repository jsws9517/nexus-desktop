import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WORKER_MARKERS } from './shared/constants.js';

/**
 * Desktop-only direct access to the core session DB (better-sqlite3).
 *
 * Used by regenerate()/withdraw() (the core exposes no "delete messages after
 * X" API) and by windowed message reads / token estimates that avoid pulling
 * every row of a long session into the renderer.
 *
 * Schema coupling: the SQL below mirrors core `src/session/store.ts` (messages
 * table). We verify the required columns via PRAGMA before any query and fail
 * soft (empty results + no throw) so a core schema rename degrades instead of
 * crashing the UI. TODO(收尾): if core renames/changes these columns (or the DB
 * path), this module must be updated in sync.
 */

export interface StoredRow {
  id: number;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
}

/** Mirrors core src/session/store.ts: LLMA_DATA_DIR overrides the data root. */
function dbPath(): string {
  const dir = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  return join(dir, 'sessions.db');
}

const REQUIRED_COLUMNS = ['id', 'session_id', 'role', 'content'];

/**
 * Connection lifecycle.
 *
 * Read connections are long-lived and shared across every call in this process
 * (each worker / test process gets its own module instance), so the expensive
 * open + PRAGMA column-verification cost is paid at most once instead of once
 * per IPC. Multi-worker concurrency is safe: this module is only imported by
 * agent workers, and the core enables journal_mode=WAL, so many processes can
 * read concurrently and writers only take a transient writer lock.
 *
 * Deletions keep a fresh short-lived writer connection (rare, and busy_timeout
 * lets them wait out another process holding the WAL writer lock).
 *
 * Schema verification is itself cached: the messages columns can only change on
 * a core upgrade, which restarts this process. A failed check is re-verified on
 * the next call (covers a fresh install where the table does not exist yet).
 */
let sharedRead: Database.Database | null = null;
let messagesSchemaOk = false;

function openDb(readonly = true): Database.Database | null {
  if (readonly && sharedRead) return sharedRead;
  let db: Database.Database;
  try {
    db = new Database(dbPath(), { readonly });
  } catch {
    return null;
  }
  try {
    // WAL is already enabled by the core; setting busy_timeout makes desktop
    // writes (deleteMessagesFrom) block briefly instead of erroring when another
    // session worker holds the writer lock.
    db.pragma('busy_timeout = 5000');
  } catch {}
  try {
    if (!messagesSchemaOk) {
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      messagesSchemaOk = REQUIRED_COLUMNS.every((c) => names.has(c));
    }
    if (!messagesSchemaOk) {
      db.close();
      return null;
    }
  } catch {
    db.close();
    return null;
  }
  if (readonly) sharedRead = db;
  return db;
}

function rowOf(r: { id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null }): StoredRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    ...(r.thinking ? { thinking: r.thinking } : {}),
  };
}

/** All message rows for a session ordered by insertion (matches core getMessages ordering). */
export function getMessageRows(sessionId: string): StoredRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        'SELECT id, session_id, role, content, thinking FROM messages WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as Array<{ id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null }>;
    return rows.map(rowOf);
  } catch {
    return [];
  }
}

/** Total message count for a session (used for the token-estimate batching). */
export function getMessageCount(sessionId: string): number {
  const db = openDb();
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number };
    return Number(row.n ?? 0);
  } catch {
    return 0;
  }
}

/** Like-pattern escape so markers with `[`, `%`, `_` match literally. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_[]/g, (c) => `\\${c}`);
}

// Exclude sub-agent worker-prompt user rows (same semantics as
// isWorkerPrompt: marker found within the first 200 chars of content).
const WORKER_EXCLUDE_SQL = WORKER_MARKERS.map(
  () => `substr(content,1,200) NOT LIKE '%' || ? || '%' ESCAPE '\\'`,
).join(' AND ');
const WORKER_EXCLUDE_PARAMS = WORKER_MARKERS.map((m) => likeEscape(m));

/** DB id of the most recently inserted user row for a session, or null.
 *  Used to anchor slash-log cards to the exact slash-input message on reload. */
export function getLastUserMessageId(sessionId: string): number | null {
  const db = openDb();
  if (!db) return null;
  try {
    const row = db
      .prepare('SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId, 'user') as { id: number } | undefined;
    return row ? row.id : null;
  } catch {
    return null;
  }
}

/** Count of displayable user rows before `beforeId` (exclusive). */
function countUserBefore(db: Database.Database, sessionId: string, beforeId: number | null): number {
  if (beforeId === null) return 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
         WHERE session_id = ? AND role = 'user' AND id < ?
           AND (${WORKER_EXCLUDE_SQL})`,
      )
      .get(sessionId, beforeId, ...WORKER_EXCLUDE_PARAMS) as { n: number };
    return Number(row.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Windowed message reads (oldest→newest). `offset` is 0-based over the full row
 * list; returns `{ items, total, userBefore }` so the renderer can paginate
 * history while keeping regenerate()'s user index stable.
 */
export function getMessageWindow(
  sessionId: string,
  offset: number,
  limit: number,
): { items: StoredRow[]; total: number; userBefore: number } {
  const db = openDb();
  if (!db) return { items: [], total: 0, userBefore: 0 };
  try {
    const off = Math.max(0, offset);
    const lim = Math.max(1, Math.min(500, limit));
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number };
    const total = Number(totalRow.n ?? 0);
    let beforeId: number | null = null;
    if (off > 0) {
      const start = db
        .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?')
        .get(sessionId, off) as { id: number } | undefined;
      beforeId = start ? start.id : null;
    }
    const userBefore = countUserBefore(db, sessionId, beforeId);
    const rows = db
      .prepare(
        'SELECT id, session_id, role, content, thinking FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ? OFFSET ?',
      )
      .all(sessionId, lim, off) as Array<{ id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null }>;
    return { items: rows.map(rowOf), total, userBefore };
  } catch {
    return { items: [], total: 0, userBefore: 0 };
  }
}

/** The N newest rows (oldest→newest order), same shape as getMessageWindow. */
export function getMessageLast(
  sessionId: string,
  n: number,
): { items: StoredRow[]; total: number; userBefore: number } {
  const db = openDb();
  if (!db) return { items: [], total: 0, userBefore: 0 };
  try {
    const lim = Math.max(1, Math.min(500, n));
    const totalRow = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number };
    const total = Number(totalRow.n ?? 0);
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT id, session_id, role, content, thinking FROM messages
           WHERE session_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(sessionId, lim) as Array<{ id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null }>;
    const beforeId = rows.length > 0 ? rows[0].id : null;
    const userBefore = countUserBefore(db, sessionId, beforeId);
    return { items: rows.map(rowOf), total, userBefore };
  } catch {
    return { items: [], total: 0, userBefore: 0 };
  }
}

/**
 * Windowed token estimate over a session's messages. Batches of `batchSize`
 * rows are pulled and counted with `estimate(content, thinking)` to keep memory
 * bounded for very long sessions. Falls back to a rough char/4 estimate when no
 * provider tokenizer is available (mirrors the core's fallback).
 */
export function estimateSessionTokens(
  sessionId: string,
  estimate: (content: string, thinking?: string) => number,
  batchSize = 500,
): number {
  const db = openDb();
  if (!db) return 0;
  let total = 0;
  try {
    let lastId = 0;
    for (;;) {
      const rows = db
        .prepare(
          'SELECT id, content, thinking FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
        )
        .all(sessionId, lastId, batchSize) as Array<{ id: number; content: string; thinking?: string | null }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        total += estimate(r.content, r.thinking ?? undefined);
      }
      lastId = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Per-call result shared by the cached estimate below. */
export interface TokenEstimate {
  tokenEstimate: number;
  messageCount: number;
}

interface TokenCacheEntry extends TokenEstimate {
  /** Highest message id already folded into the running totals. */
  lastId: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

/**
 * Incremental token estimate: after the first full pass, subsequent calls only
 * scan rows newer than the cached `lastId` and add their tokens to the running
 * total, so the expensive tokenizer work over a long session is paid once, not
 * on every status refresh.
 *
 * Cache keying: `key` must identify the estimator (e.g. `${provider.name}/$
 * {provider.model}`), because a different tokenizer yields different per-row
 * counts and the totals are not interchangeable.
 *
 * Deletion detection: `deleteMessagesFrom` truncates a tail (`id >= fromId`) so
 * it always lowers the session's MAX(id); when the observed max drops below the
 * cached watermark, the entry is treated as stale and recomputed in full.
 */
export function estimateSessionTokensCached(
  sessionId: string,
  key: string,
  estimate: (content: string, thinking?: string) => number,
  batchSize = 500,
): TokenEstimate {
  const db = openDb();
  if (!db) return { tokenEstimate: 0, messageCount: 0 };
  const cacheKey = `${key}:${sessionId}`;
  const scan = (lastId: number): { total: number; count: number; nextId: number } => {
    let total = 0;
    let count = 0;
    for (;;) {
      const rows = db
        .prepare(
          'SELECT id, content, thinking FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
        )
        .all(sessionId, lastId, batchSize) as Array<{ id: number; content: string; thinking?: string | null }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        total += estimate(r.content, r.thinking ?? undefined);
        count++;
      }
      lastId = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
    }
    return { total, count, nextId: lastId };
  };
  try {
    const prev = tokenCache.get(cacheKey);
    let curMax = 0;
    if (prev) {
      const maxRow = db
        .prepare('SELECT MAX(id) AS m FROM messages WHERE session_id = ?')
        .get(sessionId) as { m: number | null };
      curMax = Number(maxRow.m ?? 0);
    }
    // No new rows and no truncation → cached result is still exact.
    if (prev && curMax === prev.lastId) {
      return { tokenEstimate: prev.tokenEstimate, messageCount: prev.messageCount };
    }
    const recompute = !prev || curMax < prev.lastId;
    const { total, count, nextId } = scan(recompute ? 0 : prev.lastId);
    const entry: TokenCacheEntry = {
      lastId: nextId,
      tokenEstimate: recompute ? total : prev.tokenEstimate + total,
      messageCount: recompute ? count : prev.messageCount + count,
    };
    tokenCache.set(cacheKey, entry);
    return { tokenEstimate: entry.tokenEstimate, messageCount: entry.messageCount };
  } catch {
    return { tokenEstimate: 0, messageCount: 0 };
  }
}

/** Delete the target message and everything after it for a session (inclusive). */
export function deleteMessagesFrom(sessionId: string, fromId: number): { deleted: number } {
  const db = openDb(false);
  if (!db) return { deleted: 0 };
  try {
    const info = db
      .prepare('DELETE FROM messages WHERE session_id = ? AND id >= ?')
      .run(sessionId, fromId);
    return { deleted: info.changes };
  } catch {
    return { deleted: 0 };
  } finally {
    db.close();
  }
}

// task_graphs schema check is cached the same way as the messages one. The
// project_name presence is kept separate so the query branch can be re-decided
// cheaply if the column disappears at runtime (schema migration test).
let taskGraphSchemaOk = false;
let taskGraphHasProjectName = false;

function checkTaskGraphSchema(db: Database.Database): boolean {
  if (taskGraphSchemaOk) return true;
  try {
    const cols = db.prepare('PRAGMA table_info(task_graphs)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    taskGraphHasProjectName = names.has('project_name');
    taskGraphSchemaOk = names.has('id') && names.has('session_id');
    return taskGraphSchemaOk;
  } catch {
    return false;
  }
}

/**
 * Session ids whose task graph matches `q` against the graph id (graphId) or
 * its project name. Used by listSessions({ search }) so a query can find
 * sessions by graphId / projectName (mirrors core task_graphs schema). Returns
 * an empty set when the DB/table is missing or the expected columns are absent
 * (soft failure — a fresh install or core schema rename degrades to a no-op).
 */
export function getSessionIdsByTaskGraph(q: string): Set<string> {
  const db = openDb();
  if (!db) return new Set<string>();
  try {
    if (!checkTaskGraphSchema(db)) return new Set<string>();
    const pattern = `%${likeEscape(q)}%`;
    let rows: Array<{ session_id: string }>;
    if (taskGraphHasProjectName) {
      try {
        rows = db
          .prepare(
            `SELECT session_id FROM task_graphs
             WHERE id LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\'`,
          )
          .all(pattern, pattern) as Array<{ session_id: string }>;
      } catch {
        // project_name dropped at runtime (schema migration test): fall back to
        // graph-id-only matching and remember it so we stop probing that column.
        taskGraphHasProjectName = false;
        rows = db
          .prepare(`SELECT session_id FROM task_graphs WHERE id LIKE ? ESCAPE '\\'`)
          .all(pattern) as Array<{ session_id: string }>;
      }
    } else {
      // Legacy core DB where the ALTER TABLE project_name never ran: degrade to
      // graph-id-only matching so search still works.
      rows = db
        .prepare(`SELECT session_id FROM task_graphs WHERE id LIKE ? ESCAPE '\\'`)
        .all(pattern) as Array<{ session_id: string }>;
    }
    return new Set(rows.map((r) => String(r.session_id)));
  } catch {
    return new Set<string>();
  }
}

/**
 * Sessions that actually contain at least one message row. Used by
 * listSessions({ excludeEmpty }) so the initial-load flow never picks an
 * empty-context session. Returns an empty set when the DB/messages table does
 * not exist yet (fresh install).
 */
export function getNonEmptySessionIds(): Set<string> {
  const db = openDb();
  if (!db) return new Set<string>();
  try {
    const rows = db.prepare('SELECT DISTINCT session_id FROM messages').all() as Array<{ session_id: string }>;
    return new Set(rows.map((r) => r.session_id));
  } catch {
    return new Set<string>();
  }
}
