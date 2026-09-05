import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Point the session DB at a throwaway dir BEFORE importing session-db so
// dbPath() resolves under the temp root (same env the core uses).
const tmp = mkdtempSync(join(tmpdir(), 'nexus-db-test-'));
const nexusDir = join(tmp, '.nexus');
mkdirSync(nexusDir, { recursive: true });
process.env.LLMA_DATA_DIR = tmp;

const { getMessageWindow, getMessageLast, getMessageCount, getMessageRows, deleteMessagesFrom, getNonEmptySessionIds, estimateSessionTokens, getSessionIdsByTaskGraph, estimateSessionTokensCached } =
  await import('../dist/session-db.js');

let db;
before(() => {
  db = new Database(join(nexusDir, 'sessions.db'));
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
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE TABLE IF NOT EXISTS task_graphs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      root_request TEXT NOT NULL,
      project_name TEXT,
      nodes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const sid = 'sess-1';
  db.prepare('INSERT INTO sessions (id, name, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid, 'Test', 'anthropic', 'claude', Date.now(), Date.now());
  const ins = db.prepare(
    'INSERT INTO messages (session_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const rows = [
    ['sess-1', 'user', '[Project Directory] D:/x', null], // worker block
    ['sess-1', 'user', 'hello', null],
    ['sess-1', 'assistant', 'hi there', 'thinking step 1'],
    ['sess-1', 'tool', 'tool result', null],
    ['sess-1', 'user', 'second prompt', null],
    ['sess-1', 'assistant', 'reply', null],
  ];
  rows.forEach((r, i) => ins.run(...r, Date.now() + i));
  const ig = db.prepare(
    `INSERT INTO task_graphs (id, session_id, root_request, project_name, nodes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const graphs = [
    ['graph-abc-1', 'sess-1', 'root1', 'alpha', '[]', 1, 1],
    ['graph-zzz-2', 'sess-2', 'root2', 'beta', '[]', 2, 2],
    ['graph-abc-3', 'sess-1', 'root3', 'gamma_50%', '[]', 3, 3], // graphId + tricky project name
    ['graph-esc-4', 'sess-2', 'root4', 'pre_esc', '[]', 4, 4],
    ['graph-pre-5', 'sess-1', 'root5', 'preXesc', '[]', 5, 5], // must NOT match 'pre_'
  ];
  graphs.forEach((g) => ig.run(...g));
});

test('getMessageRows returns all rows in insertion order', () => {
  const rows = getMessageRows('sess-1');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].content, '[Project Directory] D:/x');
  assert.equal(rows[4].role, 'user');
  assert.equal(rows[2].thinking, 'thinking step 1');
});

test('getMessageWindow paginates with exact total', () => {
  const w = getMessageWindow('sess-1', 0, 2);
  assert.equal(w.total, 6);
  assert.equal(w.items.length, 2);
  assert.equal(w.items[0].role, 'user');
  const w2 = getMessageWindow('sess-1', 2, 2);
  assert.equal(w2.items.length, 2);
  assert.equal(w2.items[0].content, 'hi there');
});

test('userBefore counts displayable user rows before the window (skips worker blocks)', () => {
  // Window starting at index 3 (tool row): displayable user rows before it = 1 (hello).
  const w = getMessageWindow('sess-1', 3, 2);
  assert.equal(w.items[0].role, 'tool');
  assert.equal(w.userBefore, 1);
  // Last window covering from index 3: userBefore still 1.
  const last = getMessageLast('sess-1', 3);
  assert.equal(last.userBefore, 1);
});

test('getMessageLast returns newest rows in oldest->newest order', () => {
  const last = getMessageLast('sess-1', 3);
  assert.equal(last.items.length, 3);
  assert.deepEqual(
    last.items.map((r) => r.content),
    ['tool result', 'second prompt', 'reply'],
  );
});

test('getMessageCount counts all rows', () => {
  assert.equal(getMessageCount('sess-1'), 6);
});

test('estimateSessionTokens sums content+thinking across batches', () => {
  const est = estimateSessionTokens('sess-1', (content, thinking) => {
    return (content ?? '').length + (thinking ? thinking.length : 0);
  }, 2);
  // contents: '[Project Directory] D:/x' + hello + hi there + tool result + second prompt + reply
  const expected = '[Project Directory] D:/x'.length + 'hello'.length + 'hi there'.length + 'tool result'.length + 'second prompt'.length + 'reply'.length + 'thinking step 1'.length;
  assert.equal(est, expected);
});

test('deleteMessagesFrom removes target and everything after', () => {
  const before = getMessageCount('sess-1');
  const target = getMessageRows('sess-1')[1]; // id of 'hello'
  const res = deleteMessagesFrom('sess-1', target.id);
  assert.equal(res.deleted, before - 1); // target + 4 after
  const after = getMessageRows('sess-1');
  assert.equal(after.length, 1);
  assert.equal(after[0].content, '[Project Directory] D:/x');
});

test('getNonEmptySessionIds returns sessions with at least one message', () => {
  const ids = getNonEmptySessionIds();
  assert.ok(ids.has('sess-1'));
});

test('returns empty results for missing sessions', () => {
  assert.deepEqual(getMessageWindow('nope', 0, 10), { items: [], total: 0, userBefore: 0 });
  assert.equal(getMessageCount('nope'), 0);
  assert.equal(deleteMessagesFrom('nope', 1).deleted, 0);
});

test('getSessionIdsByTaskGraph matches graphId substrings', () => {
  assert.deepEqual([...getSessionIdsByTaskGraph('abc')].sort(), ['sess-1']);
  assert.deepEqual([...getSessionIdsByTaskGraph('graph-zzz')].sort(), ['sess-2']);
  assert.deepEqual([...getSessionIdsByTaskGraph('zzz')].sort(), ['sess-2']);
});

test('getSessionIdsByTaskGraph matches project_name substrings', () => {
  assert.deepEqual([...getSessionIdsByTaskGraph('alp')].sort(), ['sess-1']);
  assert.deepEqual([...getSessionIdsByTaskGraph('beta')].sort(), ['sess-2']);
});

test('getSessionIdsByTaskGraph escapes LIKE wildcards (% and _)', () => {
  // Literal '%' in the query must only match the graph whose project_name has
  // an actual '50%' — not act as a wildcard.
  assert.deepEqual([...getSessionIdsByTaskGraph('50%')].sort(), ['sess-1']);
  // Literal '_' matches 'pre_esc' but NOT 'preXesc' (single-char wildcard off).
  assert.deepEqual([...getSessionIdsByTaskGraph('pre_')].sort(), ['sess-2']);
});

test('getSessionIdsByTaskGraph returns empty set for no match', () => {
  assert.equal(getSessionIdsByTaskGraph('nomatch-xyz').size, 0);
});

test('getSessionIdsByTaskGraph degrades to id-only when project_name is absent', () => {
  // Legacy core DB without the ALTER TABLE project_name column: id matching
  // still works, project-name matching silently no-ops.
  db.prepare('ALTER TABLE task_graphs DROP COLUMN project_name').run();
  assert.deepEqual([...getSessionIdsByTaskGraph('zzz')].sort(), ['sess-2']);
  assert.equal(getSessionIdsByTaskGraph('beta').size, 0);
});

test('estimateSessionTokensCached computes incrementally and invalidates after truncation', () => {
  const sid = 'sess-cache';
  db.prepare('INSERT INTO sessions (id, name, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sid, 'Cache', 'anthropic', 'claude', Date.now(), Date.now());
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  const k = Date.now();
  ins.run(sid, 'user', 'aaa', k + 1);
  ins.run(sid, 'user', 'bbb', k + 2);
  const est = (c) => c.length;
  // First call: full pass, batchSize=1 exercises cross-batch accumulation.
  let r = estimateSessionTokensCached(sid, 'v1', est, 1);
  assert.equal(r.tokenEstimate, 6);
  assert.equal(r.messageCount, 2);
  // New row appended: only the delta is scanned, totals still exact.
  ins.run(sid, 'user', 'ccccc', k + 3);
  r = estimateSessionTokensCached(sid, 'v1', est, 1);
  assert.equal(r.tokenEstimate, 11);
  assert.equal(r.messageCount, 3);
  // Cached result unchanged when nothing changed.
  r = estimateSessionTokensCached(sid, 'v1', est, 1);
  assert.equal(r.tokenEstimate, 11);
  assert.equal(r.messageCount, 3);
  // Truncation (delete 'bbb' onward) must be detected and recomputed in full.
  const target = getMessageRows(sid).find((x) => x.content === 'bbb');
  assert.ok(target, 'bbb row exists');
  deleteMessagesFrom(sid, target.id);
  r = estimateSessionTokensCached(sid, 'v1', est, 1);
  assert.equal(r.tokenEstimate, 3); // 'aaa'
  assert.equal(r.messageCount, 1);
  // Different cache key (e.g. provider switch) recomputes independently.
  r = estimateSessionTokensCached(sid, 'v2', est, 1);
  assert.equal(r.tokenEstimate, 3);
  assert.equal(r.messageCount, 1);
});
