/**
 * L5 — session-db writer-connection pool: capped, reusable, busy_timeout.
 *
 *  - Writer handles are pooled (capped at 2), reused across write calls
 *    instead of paying a fresh better-sqlite3 open()+close() every time.
 *  - Every pooled handle carries busy_timeout, so a writer that loses the
 *    WAL lock to another process waits it out instead of silently no-oping.
 *  - The write path still behaves (binding updates / /clear deletes land).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Point the session DB at a throwaway dir BEFORE importing session-db.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-db-pool-'));
const nexusDir = join(tmp, '.nexus');
mkdirSync(nexusDir, { recursive: true });
process.env.LLMA_DATA_DIR = tmp;

const mod = await import('../dist/session-db.js');
const { setSessionBinding, deleteAllSessionMessages, writerPoolStats, writerBusyTimeoutMs, getMessageCount } = mod;

before(() => {
  const db = new Database(join(nexusDir, 'sessions.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
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
  `);
  db.prepare('INSERT INTO sessions (id, name, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('s1', 'Test', 'p', 'm', Date.now(), Date.now());
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 5; i++) ins.run('s1', 'user', `msg ${i}`, Date.now() + i);
  db.close();
});

test('writer handles are pooled, not opened+closed per call', () => {
  setSessionBinding('s1', 'p', 'm-1');
  const afterFirst = writerPoolStats();
  assert.equal(afterFirst.open, 1, 'one writer handle stays open after the first write');
  assert.equal(afterFirst.pooled, 1, 'it returns to the pool (reused next time, not closed)');
  setSessionBinding('s1', 'p', 'm-2');
  // The second call reused the pooled handle — no second open was paid.
  const afterSecond = writerPoolStats();
  assert.equal(afterSecond.open, 1, 'still exactly one open handle after a second write (reused, not churned)');
  assert.equal(afterSecond.pooled, 1, 'the idle handle is pooled, ready for the next write');
});

test('the pool stays bounded under a burst of writes', () => {
  // More writes than the cap: open/pooled handles must not grow unbounded.
  for (let i = 0; i < 5; i++) setSessionBinding('s1', 'p', `m-${i}`);
  const s = writerPoolStats();
  assert.equal(s.cap, 2, 'the loose cap is 2');
  assert.ok(s.pooled <= s.cap, `pooled (${s.pooled}) stays within the cap`);
  assert.ok(s.open <= s.cap, `open handles (${s.open}) stay within the cap`);
  assert.equal(s.open, 1, 'steady state: one reused handle, no churn');
});

test('pooled writer handles carry busy_timeout (they wait, not drop)', () => {
  // Touch a handle first so one exists, then read its effective busy_timeout.
  setSessionBinding('s1', 'p', 'm-rt');
  const ms = writerBusyTimeoutMs();
  assert.equal(ms, 5000, 'the writer handle waits out a foreign lock for 5s');
});

test('the write path still lands (binding update + /clear delete)', () => {
  setSessionBinding('s1', 'agnes', 'agnes-2');
  const del = deleteAllSessionMessages('s1');
  assert.ok(del.deleted >= 5, 'the /clear delete removed the seeded rows');
  assert.equal(getMessageCount('s1'), 0, 'the session is now empty');
});
