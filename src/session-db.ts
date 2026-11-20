import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WORKER_MARKERS } from './shared/constants.js';
import { boundedSet } from './shared/bounded.js';
import { logger } from './shared/logger.js';
import { parseArtifactContent, type ArtifactListItem } from './shared/artifact.js';
import {
  FILE_ARTIFACT_SQL_EXTENSIONS,
  MAX_FILE_REFS_PER_MESSAGE,
  artifactTypeForPath,
  baseNameOf,
  decodeFileItemId,
  extractPathsForMessage,
  fileArtifactEnvelope,
  isAbsoluteFilePath,
} from './shared/file-artifacts.js';

/**
 * Desktop-only direct access to the core session DB (better-sqlite3).
 *
 * Used by regenerate()/withdraw() (the core exposes no "delete messages after
 * X" API), by windowed message reads / token estimates that avoid pulling
 * every row of a long session into the renderer, and by the main-process
 * `nexus:listSessions` handler that serves the sidebar directly.
 *
 * Schema coupling: the SQL below mirrors core `src/session/store.ts` (messages
 * + sessions tables). We verify the required columns via PRAGMA before any
 * query and fail soft (empty results / null + no throw) so a core schema rename
 * degrades instead of crashing the UI. TODO(收尾): if core renames/changes these
 * columns (or the DB path), this module must be updated in sync.
 */

export interface StoredRow {
  id: number;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  toolCalls?: string;
  toolCallId?: string;
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
 * (each worker / test process / the main process gets its own module instance),
 * so the expensive open + PRAGMA column-verification cost is paid at most once
 * instead of once per IPC. Multi-process concurrency is safe: the core enables
 * journal_mode=WAL, so many processes can read concurrently and writers only
 * take a transient writer lock.
 *
 * L5: writes use a capped reusable pool (borrowWriter/returnWriter, up to
 * WRITER_POOL_MAX idle handles) instead of an open+close per call; every
 * writer handle carries busy_timeout so a lock held by another process is
 * waited out, not dropped.
 *
 * Schema verification is itself cached: the messages columns can only change on
 * a core upgrade, which restarts this process. A failed check is re-verified on
 * the next call (covers a fresh install where the table does not exist yet).
 */
let sharedRead: Database.Database | null = null;
let messagesSchemaOk = false;
// L4: one-shot diagnostics — the first open failure prints WHY (an ABI
// mismatch in dev mode vs. anything else) instead of every call silently
// degrading to no-op.
let openFailureWarned = false;

function openDb(): Database.Database | null {
  if (sharedRead) return sharedRead;
  let db: Database.Database;
  try {
    db = new Database(dbPath(), { readonly: true });
  } catch (err) {
    warnOpenFailure(err);
    return null;
  }
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
  sharedRead = db;
  return db;
}

/** L4: print the cause of the first open failure exactly once (both paths). */
function warnOpenFailure(err: unknown): void {
  if (openFailureWarned) return;
  openFailureWarned = true;
  const msg = err instanceof Error ? err.message : String(err);
  // In dev, node_modules' better-sqlite3 is built for the SYSTEM Node ABI
  // while the Electron main process needs the Electron ABI — the load
  // throws and every main-side DB call silently no-op'd, making dev
  // behave differently from the packaged app. Detect that specific cause
  // and say so explicitly; the degradation itself is kept by design.
  const abiMismatch =
    /NODE_MODULE_VERSION|different version of Node|was compiled against|incompatible ABI|Invalid module identifier/i.test(msg);
  if (abiMismatch) {
    logger.warn(
      `session-db: better-sqlite3 ABI mismatch (dev: module built for system Node, not the Electron runtime) — main-side session DB operations are NO-OP (reads return empty, deletes are skipped). Rebuild the native module: \`npm run rebuild:electron\`.`,
    );
  } else {
    logger.warn(`session-db: unable to open ${dbPath()}: ${msg} — main-side DB operations are NO-OP until this is fixed.`);
  }
}

// ---------------------------------------------------------------------------
// L5: capped, reusable writer-connection pool.
//
// Every desktop write (deleteMessagesFrom / deleteAllSessionMessages /
// setSessionBinding / updateTaskGraphProjectName) used to pay a fresh
// better-sqlite3 open()+close() — a few ms of ABI + disk work each time, with
// no bound on how many handles a burst of concurrent writes could hold. Now
// a small pool of idle writer handles (capped at WRITER_POOL_MAX) is reused
// across calls, and a burst beyond the cap falls back to a transient open
// (the old behavior) instead of degrading writes.
//
// Each handle carries busy_timeout = WRITER_BUSY_TIMEOUT_MS, so a writer that
// loses the WAL writer lock to another process (main + N session workers)
// WAITS it out instead of erroring — the silent no-op drop that reads as a
// "sudden interrupt" (a binding update / /clear that just… didn't happen).
// ---------------------------------------------------------------------------
const WRITER_POOL_MAX = 2;
const WRITER_BUSY_TIMEOUT_MS = 5000;
let writerPool: Database.Database[] = [];
/** Open writer handles in this process (pooled + checked out). */
let writerHandles = 0;

/** Open (or reuse) a writer handle. Returns null when the DB is unopenable. */
function openWriterDb(): Database.Database | null {
  const idle = writerPool.pop();
  if (idle) return idle;
  let db: Database.Database;
  try {
    db = new Database(dbPath(), { readonly: false });
  } catch (err) {
    warnOpenFailure(err);
    return null;
  }
  try {
    db.pragma(`busy_timeout = ${WRITER_BUSY_TIMEOUT_MS}`);
  } catch {
    /* pragma failure must not kill the write path */
  }
  writerHandles++;
  return db;
}

/** Borrow a writer handle (fresh open only when the pool is empty). */
export function borrowWriter(): Database.Database | null {
  const db = openWriterDb();
  if (!db) return null;
  // Same soft schema gate as the read path: a core schema rename degrades
  // writes to no-ops, and the check re-runs on every borrow until it passes.
  try {
    if (!messagesSchemaOk) {
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      messagesSchemaOk = REQUIRED_COLUMNS.every((c) => names.has(c));
      if (!messagesSchemaOk) {
        returnWriter(db);
        return null;
      }
    }
    return db;
  } catch {
    returnWriter(db);
    return null;
  }
}

/**
 * Return a borrowed handle: to the pool when under the cap (stays open,
 * zero-cost next borrow), otherwise closed. The cap keeps a long-lived
 * worker from pinning more than WRITER_POOL_MAX writer handles.
 */
function returnWriter(db: Database.Database): void {
  if (writerPool.length < WRITER_POOL_MAX) {
    writerPool.push(db);
  } else {
    writerHandles = Math.max(0, writerHandles - 1);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/** L5 test/debug seam: how many writer handles this process holds. */
export function writerPoolStats(): { pooled: number; open: number; cap: number } {
  return { pooled: writerPool.length, open: writerHandles, cap: WRITER_POOL_MAX };
}

/** L5 test seam: the effective busy_timeout on a pooled writer handle (ms). */
export function writerBusyTimeoutMs(): number {
  const db = borrowWriter();
  if (!db) return 0;
  let v = 0;
  try {
    // better-sqlite3's read pragma reports the value under the column `timeout`.
    const row = (db.pragma('busy_timeout') as Array<{ timeout?: number; busy_timeout?: number }>)[0];
    v = Number(row?.timeout ?? row?.busy_timeout ?? 0);
  } catch {
    /* pragma read failure reports 0 */
  } finally {
    returnWriter(db);
  }
  return v;
}

function rowOf(r: { id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null; tool_calls?: string | null; tool_call_id?: string | null }): StoredRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    ...(r.thinking ? { thinking: r.thinking } : {}),
    ...(r.tool_calls ? { toolCalls: r.tool_calls } : {}),
    ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
  };
}

/** All message rows for a session ordered by insertion (matches core getMessages ordering). */
export function getMessageRows(sessionId: string): StoredRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        'SELECT id, session_id, role, content, thinking, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC',
      )
      .all(sessionId) as Array<{ id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null; tool_calls?: string | null; tool_call_id?: string | null }>;
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
        'SELECT id, session_id, role, content, thinking, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ? OFFSET ?',
      )
      .all(sessionId, lim, off) as Array<{ id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null; tool_calls?: string | null; tool_call_id?: string | null }>;
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
           SELECT id, session_id, role, content, thinking, tool_calls, tool_call_id FROM messages
           WHERE session_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(sessionId, lim) as Array<{ id: number; session_id: string; role: StoredRow['role']; content: string; thinking?: string | null; tool_calls?: string | null; tool_call_id?: string | null }>;
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

interface TokenBaselineEntry extends TokenEstimate {}

/** Hard cap on per-session token-estimate cache/baseline entries — prevents
 *  unbounded memory growth across many sessions on a long-lived worker. */
const MAX_TOKEN_CACHE_ENTRIES = 200;

/**
 * Per-session "cleared at" snapshots. When the user runs `/clear` the in-memory
 * context is wiped but the DB rows stay (the transcript is only runtime, not
 * persisted), so to make the standalone counter restart from zero we record the
 * cumulative estimate at clear time and subtract it from later results. Keyed by
 * the same `${provider}:${sessionId}` as tokenCache so a model switch (which
 * invalidates the estimator) simply shows the raw total again.
 */
const tokenBaselines = new Map<string, TokenBaselineEntry>();

/**
 * Raw cumulative estimate (ignores baselines). Callers that must see absolute
 * totals — `recordTokenBaseline`, regenerates, etc. — use this so a baseline
 * never feeds back into itself.
 */
export function estimateSessionTokensRaw(
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
    boundedSet(tokenCache, cacheKey, entry, MAX_TOKEN_CACHE_ENTRIES);
    return { tokenEstimate: entry.tokenEstimate, messageCount: entry.messageCount };
  } catch {
    return { tokenEstimate: 0, messageCount: 0 };
  }
}

/**
 * Baseline-aware estimate for display. Delegates to `estimateSessionTokensRaw`
 * then subtracts the `/clear` snapshot (if any) so the counter restarts near
 * zero and only grows with messages produced after the clear.
 */
export function estimateSessionTokensCached(
  sessionId: string,
  key: string,
  estimate: (content: string, thinking?: string) => number,
  batchSize = 500,
): TokenEstimate {
  const raw = estimateSessionTokensRaw(sessionId, key, estimate, batchSize);
  const cacheKey = `${key}:${sessionId}`;
  const base = tokenBaselines.get(cacheKey);
  if (!base) return raw;
  return {
    tokenEstimate: Math.max(0, raw.tokenEstimate - base.tokenEstimate),
    messageCount: Math.max(0, raw.messageCount - base.messageCount),
  };
}

/**
 * Snapshot the current raw running totals as the "start of a fresh context"
 * marker. Called when the user runs `/clear`: from this point the reported
 * estimate is `max(0, raw - snapshot)`, so the side panel resets towards zero
 * and only counts messages arriving after the clear. Re-entrant: taking a new
 * snapshot simply moves the offset forward (messages before it are never
 * double-subtracted because the snapshot always targets the raw total).
 */
export function recordTokenBaseline(
  sessionId: string,
  key: string,
  estimate: (content: string, thinking?: string) => number,
  batchSize = 500,
): TokenEstimate {
  const raw = estimateSessionTokensRaw(sessionId, key, estimate, batchSize);
  const cacheKey = `${key}:${sessionId}`;
  boundedSet(tokenBaselines, cacheKey, {
    tokenEstimate: raw.tokenEstimate,
    messageCount: raw.messageCount,
  }, MAX_TOKEN_CACHE_ENTRIES);
  return raw;
}

/** Delete the target message and everything after it for a session (inclusive). */
export function deleteMessagesFrom(sessionId: string, fromId: number): { deleted: number } {
  const db = borrowWriter();
  if (!db) return { deleted: 0 };
  try {
    const info = db
      .prepare('DELETE FROM messages WHERE session_id = ? AND id >= ?')
      .run(sessionId, fromId);
    // Keep the token caches honest: a truncation drops MAX(id), but delete the
    // entries outright so a subsequent read cannot serve a stale estimate.
    invalidateTokenCaches(sessionId);
    return { deleted: info.changes };
  } catch {
    return { deleted: 0 };
  } finally {
    returnWriter(db);
  }
}

/**
 * Delete EVERY persisted message for a session. Used by `/clear` on the desktop:
 * the core's clearCommand only wipes the in-memory context (see
 * context-manager.js clear()), leaving the DB transcript intact — which a later
 * tab reopen / worker restart reloads straight back into context (agent.js
 * startSession → setMessages), resurrecting the oversized-context failure that
 * /clear was supposed to fix. Clearing the rows makes the clear durable.
 */
export function deleteAllSessionMessages(sessionId: string): { deleted: number } {
  const db = borrowWriter();
  if (!db) return { deleted: 0 };
  try {
    const info = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    invalidateTokenCaches(sessionId);
    return { deleted: info.changes };
  } catch {
    return { deleted: 0 };
  } finally {
    returnWriter(db);
  }
}

/** Drop any token-cache / baseline entries for a session (all cache keys). */
function invalidateTokenCaches(sessionId: string): void {
  const suffix = `:${sessionId}`;
  for (const key of tokenCache.keys()) {
    if (key.endsWith(suffix)) tokenCache.delete(key);
  }
  for (const key of tokenBaselines.keys()) {
    if (key.endsWith(suffix)) tokenBaselines.delete(key);
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

/** One row of the user-facing session list (mirrors core `Session`). */
export interface SessionListItem {
  id: string;
  name: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
  excludeMock?: boolean;
  excludeEmpty?: boolean;
  search?: string;
}

// sessions-table schema check, same soft-fail pattern as the messages one.
let sessionsSchemaOk = false;
const SESSION_COLUMNS = ['id', 'name', 'provider', 'model', 'created_at', 'updated_at'];

function checkSessionsSchema(db: Database.Database): boolean {
  if (sessionsSchemaOk) return true;
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    sessionsSchemaOk = SESSION_COLUMNS.every((c) => names.has(c));
    return sessionsSchemaOk;
  } catch {
    return false;
  }
}

function toSessionItem(r: Record<string, unknown>): SessionListItem {
  let metadata: Record<string, unknown> | undefined;
  if (r.metadata) {
    try {
      const parsed = JSON.parse(String(r.metadata));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      // Corrupt metadata must not lose the row — the core's rowToSession throws
      // here, but a sidebar entry with no metadata beats a missing entry.
    }
  }
  return {
    id: r.id ? String(r.id) : '',
    name: r.name ? String(r.name) : '',
    provider: r.provider ? String(r.provider) : '',
    model: r.model ? String(r.model) : '',
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * The session list, straight from the DB — same SQL, filters and ordering as
 * core `SessionStore.listSessions` plus the desktop-side filters the agent
 * service used to apply *after* fetching every row:
 *
 * - ACP channel rows excluded (`metadata.isAcp` / legacy `'ACP Session'`).
 * - `excludeMock` → `model NOT LIKE '%mock%'` (was: full fetch + `/mock/i`).
 * - `excludeEmpty` → `EXISTS (SELECT 1 FROM messages ...)` (was: full fetch +
 *   DISTINCT session_id set).
 * - `search` → name/id LIKE plus the task-graph id set (all in SQL).
 *
 * Returns `null` when the DB (or its schema) is unreadable so callers can fall
 * back to the worker path instead of reporting an empty sidebar. The read is
 * side-effect free, so it is safe to serve from the main process while workers
 * keep writing under WAL.
 */
export function listSessions(
  opts: ListSessionsOptions = {},
): { items: SessionListItem[]; total: number } | null {
  const db = openDb();
  if (!db || !checkSessionsSchema(db)) return null;
  try {
    const where = ["(COALESCE(json_extract(metadata, '$.isAcp'), 0) != 1 AND name != 'ACP Session')"];
    const params: unknown[] = [];
    if (opts.excludeMock) where.push(`model NOT LIKE '%mock%'`);
    if (opts.excludeEmpty) where.push('EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)');
    const q = opts.search?.trim().toLowerCase();
    if (q) {
      const like = `%${likeEscape(q)}%`;
      const parts = [`name LIKE ? ESCAPE '\\'`, `id LIKE ? ESCAPE '\\'`];
      params.push(like, like);
      const byTaskGraph = getSessionIdsByTaskGraph(q);
      if (byTaskGraph.size > 0) {
        parts.push(`id IN (${Array.from(byTaskGraph).map(() => '?').join(',')})`);
        params.push(...byTaskGraph);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    const clause = where.join(' AND ');
    const countRow = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${clause}`).get(...params) as { n: number };
    let sql = `SELECT id, name, provider, model, created_at, updated_at, metadata
               FROM sessions WHERE ${clause} ORDER BY updated_at DESC`;
    const rowParams = [...params];
    if (opts.limit !== undefined && opts.limit >= 0) {
      sql += ' LIMIT ?';
      rowParams.push(opts.limit);
      if (opts.offset !== undefined && opts.offset > 0) {
        sql += ' OFFSET ?';
        rowParams.push(opts.offset);
      }
    }
    const rows = db.prepare(sql).all(...rowParams) as Array<Record<string, unknown>>;
    return { items: rows.map(toSessionItem), total: Number(countRow.n ?? 0) };
  } catch {
    return null;
  }
}

// ── T2-4: cross-session artifact index ──────────────────────────────────────

export interface QueryArtifactsOptions {
  limit?: number;
  sessionId?: string;
  type?: string;
  sinceMs?: number;
}

/** Short human-readable preview for the index row (never the full body). */
function artifactPreview(artifact: ReturnType<typeof parseArtifactContent>): string {
  if (!artifact) return '';
  const raw = typeof artifact.body === 'string'
    ? artifact.body
    : artifact.body == null
      ? ''
      : JSON.stringify(artifact.body);
  return raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
}

/**
 * Cross-session artifact index. Scans tool messages whose content carries an
 * Artifact envelope and returns light metadata rows, newest first.
 *
 * All filters are bound SQL parameters (no LIKE/string interpolation from user
 * input): the envelope marker is a constant bound parameter, `sessionId` /
 * `sinceMs` are direct column comparisons, and `type` is read with JSON1 from
 * the envelope. Rows with a malformed envelope are skipped, not fatal (AC-6 /
 * risk §6). Wrapping `json_extract` in `CASE WHEN json_valid` guarantees it is
 * never called on non-JSON tool output.
 *
 * It ALSO indexes file references — the `@<abs path>` lines the attach flow
 * writes into user messages, and deliverable paths in tool/assistant output.
 * Those are synthesized into the same Artifact envelope on read, so a regular
 * attachment or a sub-agent's `.docx` shows up here even though no skill
 * wrapped it. Their ids are negative: `-(messageId * 100 + pathIndex)`.
 */
export function queryArtifacts(opts: QueryArtifactsOptions = {}): { items: ArtifactListItem[] } | null {
  const db = openDb();
  if (!db || !checkSessionsSchema(db)) return null;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const where = [
    // Bound constant marker + JSON shape guards: malformed envelopes are
    // excluded in SQL so LIMIT counts only usable rows (not skipped junk).
    'm.content LIKE ?',
    'json_valid(m.content) = 1',
    "json_extract(m.content, '$.__artifactVersion') = 1",
    "json_extract(m.content, '$.artifact.id') IS NOT NULL",
    "json_extract(m.content, '$.artifact.type') IS NOT NULL",
  ];
  const params: unknown[] = ['%"__artifactVersion"%'];
  if (opts.sessionId) {
    where.push('m.session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.sinceMs !== undefined && Number.isFinite(opts.sinceMs)) {
    where.push('m.created_at >= ?');
    params.push(opts.sinceMs);
  }
  if (opts.type) {
    where.push("json_extract(m.content, '$.artifact.type') = ?");
    params.push(opts.type);
  }
  const sql = `SELECT m.id AS id, m.session_id AS session_id, s.name AS session_name,
                      m.content AS content, m.created_at AS created_at
               FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
               WHERE ${where.join(' AND ')}
               -- A session can be deleted while its messages rows survive
               -- (the delete path is not fully cascading, or rows were
               -- written after the delete). Surfacing their artifacts
               -- would point "Open session" at an id that no longer
               -- exists, so drop rows whose session row is gone.
               AND EXISTS (SELECT 1 FROM sessions s2 WHERE s2.id = m.session_id)
               ORDER BY m.created_at DESC, m.id DESC LIMIT ?`;
  // Oversample so a rare row that passes the SQL shape guards but fails full
  // envelope validation does not starve the page of `limit` valid items.
  params.push(Math.min(Math.max(limit * 2, 20), 1000));
  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      id: number; session_id: string; session_name: string | null;
      content: string; created_at: number;
    }>;
    const items: ArtifactListItem[] = [];
    const seen = new Set<string>();
    // Paths already covered by a structured envelope (e.g. docx.write's refs)
    // must not reappear as a second, poorer file row.
    const seenPaths = new Set<string>();
    for (const r of rows) {
      const artifact = parseArtifactContent(r.content);
      if (!artifact) continue;
      // JS re-check of the type filter: keeps the result correct even if a
      // legacy envelope stores its type somewhere JSON1 cannot reach.
      if (opts.type && artifact.type !== opts.type) continue;
      const sessionId = artifact.meta?.sessionId || r.session_id || '';
      const key = `${sessionId}|${artifact.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const ref of artifact.refs ?? []) {
        if (ref.kind === 'file' && typeof ref.path === 'string' && ref.path) {
          seenPaths.add(ref.path.toLowerCase());
        }
      }
      items.push({
        id: r.id,
        sessionId,
        sessionName: r.session_name ?? '',
        type: artifact.type ?? '',
        title: artifact.title ?? '',
        createdAt: Number(r.created_at) || 0,
        preview: artifactPreview(artifact),
      });
      if (items.length >= limit) break;
    }

    // File references (regular attachments / produced deliverables). Only the
    // slots the envelope rows left can be filled; the walk stops as soon as
    // they are.
    const fileRows = queryFileReferenceItems(
      db, opts, Math.min(Math.max(limit - items.length, 20), 400), seenPaths,
    );
    items.push(...fileRows);

    // Newest first, matching the envelope query's ORDER BY. Positive ids sort
    // before negative ones only as a stable tiebreaker.
    items.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    return { items: items.slice(0, limit) };
  } catch {
    return null;
  }
}

/** Cache `existsSync` per path: the page polls, but files rarely appear/vanish. */
const PATH_EXISTS_TTL_MS = 60_000;
const pathExistsCache = new Map<string, { ok: boolean; at: number }>();

/**
 * Does a persisted session row exist for `sessionId`? Used by openSession to
 * refuse to spawn a blank worker for an id that has already been deleted (or
 * that was never a real session). A direct DB read: cheap, no worker round-trip.
 * Returns true when the DB is unavailable so a transient read failure never
 * blocks a legitimately-reopenable session.
 */
export function sessionExists(sessionId: string): boolean {
  if (!sessionId) return false;
  const db = openDb();
  if (!db) return true;
  try {
    const row = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
    return row != null;
  } catch {
    return true;
  }
}

function fileExistsCached(path: string, onMiss?: () => void): boolean {
  const now = Date.now();
  const hit = pathExistsCache.get(path);
  if (hit && now - hit.at < PATH_EXISTS_TTL_MS) return hit.ok;
  onMiss?.();
  let ok = false;
  try {
    ok = existsSync(path);
  } catch {
    ok = false;
  }
  if (pathExistsCache.size > 2000) pathExistsCache.clear();
  pathExistsCache.set(path, { ok, at: now });
  return ok;
}

/** Rows the file index may examine per call, and the wall-clock budget for it. */
const FILE_WALK_MAX_MS = 400;
const FILE_WALK_BATCH = 800;
/** Disk stats allowed per call. Cache misses only, so a poll after the first
 *  one pays nothing for paths it has already checked. */
const MAX_STAT_CHECKS = 400;

/**
 * Index rows for file references. The SQL prefilter is intentionally narrow
 * (role + a distinctive extension list) so ordinary prose is never parsed; the
 * authoritative decision is made in JS: the path must be absolute, must carry a
 * known deliverable extension (or come from an explicit `@` attachment line),
 * and must still exist on disk.
 *
 * The walk is over `m.id DESC` (the rowid PK index), not `created_at DESC`:
 * `ORDER BY created_at` with a LIKE prefilter forces a full scan of the whole
 * message table (seconds on a large history, blocking the main process on every
 * poll), while the rowid walk answers the same "newest first" question in tens
 * of milliseconds. Message ids are append-only, so id order IS time order.
 */
function queryFileReferenceItems(
  db: Database.Database,
  opts: QueryArtifactsOptions,
  need: number,
  seenPaths: Set<string>,
): ArtifactListItem[] {
  const extClause = FILE_ARTIFACT_SQL_EXTENSIONS.map(() => 'm.content LIKE ?').join(' OR ');
  // Inline base64 images (`![x](data:image/png;base64,...)`) mention `.png` in
  // their alt text but are megabytes of payload; excluding them keeps the walk
  // cheap and leaves the real path to the small JSON result beside them.
  const where: string[] = [
    `((m.role = 'user' AND m.content LIKE '%@%') OR ((m.role = 'tool' OR m.role = 'assistant') AND (${extClause})))`,
    `m.content NOT LIKE '%;base64,%'`,
  ];
  const params: unknown[] = FILE_ARTIFACT_SQL_EXTENSIONS.map((ext) => `%${ext}%`);
  if (opts.sessionId) {
    where.push('m.session_id = ?');
    params.push(opts.sessionId);
  }
  const sql = `SELECT m.id AS id, m.session_id AS session_id, s.name AS session_name,
                      m.role AS role, m.content AS content, m.created_at AS created_at
               FROM messages m LEFT JOIN sessions s ON s.id = m.session_id
               WHERE m.id < ? AND ${where.join(' AND ')}
               -- Same guard as the envelope query: drop file rows whose
               -- owning session has been deleted (its artifacts would
               -- point "Open session" at a gone id).
               AND EXISTS (SELECT 1 FROM sessions s2 WHERE s2.id = m.session_id)
               ORDER BY m.id DESC LIMIT ?`;
  const stmt = db.prepare(sql);

  let hi = Number((db.prepare('SELECT MAX(id) AS id FROM messages').get() as
    | { id: number | null } | undefined)?.id) || 0;
  hi += 1; // exclusive upper bound
  const startedAt = Date.now();
  const out: ArtifactListItem[] = [];
  const sinceMs = opts.sinceMs !== undefined && Number.isFinite(opts.sinceMs) ? opts.sinceMs : undefined;
  let stats = 0;

  while (out.length < need && hi > 1 && Date.now() - startedAt < FILE_WALK_MAX_MS && stats < MAX_STAT_CHECKS) {
    const rows = stmt.all(hi, ...params, FILE_WALK_BATCH) as Array<{
      id: number; session_id: string; session_name: string | null;
      role: string; content: string; created_at: number;
    }>;
    if (rows.length === 0) break;
    hi = rows[rows.length - 1].id; // next batch continues below the oldest row
    let reachedCutoff = false;
    for (const r of rows) {
      const createdAt = Number(r.created_at) || 0;
      // ids descend with time, so once a row predates the cutoff every later id
      // does too: stop instead of scanning the rest of the history.
      if (sinceMs !== undefined && createdAt < sinceMs) {
        reachedCutoff = true;
        continue;
      }
      const paths = extractPathsForMessage(r.role, r.content).slice(0, MAX_FILE_REFS_PER_MESSAGE);
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        if (!isAbsoluteFilePath(path)) continue;
        const key = path.toLowerCase();
        if (seenPaths.has(key)) continue;
        if (!fileExistsCached(path, () => { stats++; })) continue;
        seenPaths.add(key);
        const type = artifactTypeForPath(path);
        if (opts.type && type !== opts.type) continue;
        out.push({
          // Negative id namespace: -(messageId * 100 + pathIndex). Decoded by
          // getArtifactMessageContent() into the same synthesized envelope.
          id: -(r.id * 100 + i),
          sessionId: r.session_id || '',
          sessionName: r.session_name ?? '',
          type,
          title: baseNameOf(path),
          createdAt,
          preview: path,
        });
      }
      if (out.length >= need) break;
    }
    if (reachedCutoff) break;
    if (rows.length < FILE_WALK_BATCH) break; // no more matching rows at all
  }
  return out;
}

/**
 * Fetch the raw tool-message content for a full artifact (by message id).
 *
 * Negative ids address a synthesized file artifact: `-(messageId * 100 + i)`
 * from queryArtifacts. The envelope is rebuilt from the source message on
 * demand, so no extra table or write cycle is needed.
 */
export function getArtifactMessageContent(messageId: number): string | null {
  const db = openDb();
  if (!db || !Number.isInteger(messageId) || messageId === 0) return null;
  try {
    if (messageId < 0) {
      const decoded = decodeFileItemId(messageId);
      if (!decoded) return null;
      const row = db
        .prepare('SELECT session_id, role, content FROM messages WHERE id = ?')
        .get(decoded.messageId) as
        | { session_id: string; role: string; content: string }
        | undefined;
      if (!row) return null;
      const path = extractPathsForMessage(row.role, row.content)[decoded.index];
      if (!path || !isAbsoluteFilePath(path) || !fileExistsCached(path)) return null;
      return fileArtifactEnvelope(path, {
        sessionId: row.session_id,
        origin: row.role === 'user' ? 'user' : 'task',
      });
    }
    const row = db.prepare('SELECT content FROM messages WHERE id = ?').get(messageId) as
      | { content: string }
      | undefined;
    return row?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * Update the project_name column in task_graphs for a given graph id.
 * Used by /rename-project to sync the DB after renaming directories.
 */
export function updateTaskGraphProjectName(graphId: string, newName: string): void {
  const db = borrowWriter();
  if (!db) return;
  try {
    db.prepare('UPDATE task_graphs SET project_name = ?, updated_at = ? WHERE id = ?')
      .run(newName, Date.now(), graphId);
  } catch {
    // table may not exist yet on fresh install
  } finally {
    returnWriter(db);
  }
}

/**
 * Read the provider/model a session is bound to, or null when it has none
 * recorded / the DB is unreadable.
 *
 * The core writes these two columns ONCE, inside `session.create()`. Every later
 * per-tab provider/model change is an in-memory override inside that tab's
 * worker, so without this the desktop has no way to tell which pair a session
 * was actually left on — and a reopened tab silently boots on whatever the
 * global config.json currently says instead.
 */
export function getSessionBinding(sessionId: string): { provider: string; model: string } | null {
  if (!sessionId) return null;
  const db = openDb();
  if (!db || !checkSessionsSchema(db)) return null;
  try {
    const row = db
      .prepare('SELECT provider, model FROM sessions WHERE id = ?')
      .get(sessionId) as { provider?: string; model?: string } | undefined;
    if (!row) return null;
    return { provider: String(row.provider ?? ''), model: String(row.model ?? '') };
  } catch {
    return null;
  }
}

/**
 * Persist the provider/model a session is currently running on, so the binding
 * survives a tab close and the sidebar stops showing the model the session was
 * born with. `updated_at` is deliberately left alone: a model switch is not user
 * activity and must not reorder the session list.
 *
 * Same short-lived writer connection + busy_timeout handling as
 * deleteMessagesFrom — another worker may hold the WAL writer lock.
 */
export function setSessionBinding(
  sessionId: string,
  provider: string,
  model: string,
): { provider: string; model: string } | null {
  if (!sessionId || !provider || !model) return null;
  const db = borrowWriter();
  if (!db) return null;
  try {
    const info = db
      .prepare('UPDATE sessions SET provider = ?, model = ? WHERE id = ?')
      .run(provider, model, sessionId);
    if (info.changes === 0) return null;
    return { provider, model };
  } catch {
    // sessions table missing or schema drift — the in-memory override still works
    return null;
  } finally {
    returnWriter(db);
  }
}
