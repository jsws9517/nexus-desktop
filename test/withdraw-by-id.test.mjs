/**
 * Regression for the "Stop → undo last prompt rolls back too many turns" bug.
 *
 * Withdraw/regenerate used to take a renderer-generated positional `userIndex`
 * and re-apply it to a fresh DB read. Any user row that exists only in the DB —
 * a background-job wake prompt, an injected <user_steer> follow-up, an
 * auto-continue — shifts that index. Because `deleteMessagesFrom` is an
 * inclusive tail delete, an off-by-N index removed the wrong prompt AND every
 * later turn (the reported "last 3 conversation records were rolled back").
 *
 * These tests drive the REAL AgentService.withdraw/regenerate with a fake core
 * agent (no LLM) against a seeded temp SQLite DB, and verify that resolving by
 * persisted row id lands on exactly the clicked row even when the positional
 * index would have pointed at an earlier prompt.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Own sandbox: env must be set before the dist modules resolve their data root.
const sandbox = mkdtempSync(join(tmpdir(), 'nexus-withdraw-id-'));
process.env.NEXUS_CONFIG_DIR = join(sandbox, '.nexus');
process.env.LLMA_DATA_DIR = sandbox;

const SID = 'withdraw-by-id-session';
const nexusDir = join(sandbox, '.nexus');
mkdirSync(nexusDir, { recursive: true });
const dbPath = join(nexusDir, 'sessions.db');

// Open + seed the DB before the first session-db read (its path is resolved
// from LLMA_DATA_DIR, set by sandbox-env.mjs above).
const db = new Database(dbPath);
// session-db keeps long-lived read/writer handles for the process lifetime, so
// Windows will not let us delete the temp DB file here. Close our writer and
// leave the sandbox to the OS temp cleaner (same constraint the other DB tests
// hit on Windows).
after(() => { try { db.close(); } catch {} });
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
    created_at INTEGER NOT NULL
  );
`);

const WORKER = '[Project Directory] D:/x';
const WAKE = '【后台作业唤醒】本轮由后台作业自动触发';
const LAST = 'last prompt clicked after Stop';

/** Contents of the seeded rows, in id order. Row 4 is a DB-only user row the
 *  renderer never rendered as a bubble — the source of the old index drift. */
const SEED = [
  ['user', WORKER],
  ['user', 'first ask'],
  ['assistant', 'reply 1'],
  ['user', WAKE],
  ['user', 'second ask'],
  ['assistant', 'reply 2'],
  ['tool', 'tool result'],
  ['user', LAST],
  ['assistant', 'in-flight reply from the stopped turn'],
  ['tool', 'in-flight tool result'],
];

let ids = [];

beforeEach(() => {
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(SID);
  const ins = db.prepare(
    'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
  );
  ids = SEED.map(([role, content], i) => Number(ins.run(SID, role, content, 1000 + i).lastInsertRowid));
});

const { getMessageRows } = await import(pathToFileURL(join(dist, 'session-db.js')).href);
const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')).href);

function makeService() {
  const svc = new AgentService();
  const fake = {
    isBusy: () => false,
    getCurrentSessionId: () => SID,
    startSessionCalls: [],
    chatInputs: [],
    startSession: async (name, sid) => { fake.startSessionCalls.push([name, sid]); },
    chat: async (text) => { fake.chatInputs.push(text); },
    abort: () => {},
    context: { getTokenCount: () => 0 },
    provider: { model: 'regression-test' },
    config: { getActiveProvider: () => 'regression-test', getProvider: () => ({}) },
  };
  svc.agent = fake; // private at TS level, present at runtime
  return { svc, fake };
}

const surviving = () => getMessageRows(SID).map((r) => r.content);

test('positional index is stale: a DB-only wake row shifts it onto an earlier prompt', () => {
  const userRows = getMessageRows(SID).filter(
    (r) => r.role === 'user' && !String(r.content).startsWith('[Project Directory]'),
  );
  // Renderer never saw the wake bubble, so the clicked last prompt had index 2.
  assert.equal(userRows[2].content, 'second ask');
  assert.equal(userRows[3].content, LAST);
});

test('withdraw(sid, messageId) deletes from the clicked row only, not from the stale index', async () => {
  const { svc, fake } = makeService();
  const text = await svc.withdraw(SID, ids[7]); // the last user prompt

  assert.equal(text, LAST);
  assert.deepEqual(surviving(), SEED.slice(0, 7).map(([, c]) => c));
  assert.deepEqual(fake.startSessionCalls, [[undefined, SID]]);
  assert.deepEqual(fake.chatInputs, [], 'withdraw must not re-run the prompt');
});

test('regenerate(sid, messageId) truncates to the clicked row then re-runs exactly that prompt', async () => {
  const { svc, fake } = makeService();
  await svc.regenerate(SID, ids[7]);

  assert.deepEqual(fake.chatInputs, [LAST]);
  assert.deepEqual(surviving(), SEED.slice(0, 7).map(([, c]) => c));
  assert.deepEqual(fake.startSessionCalls, [[undefined, SID]]);
});

test('withdraw rejects worker-block and unknown ids without touching the transcript', async () => {
  const { svc } = makeService();
  const before = surviving();

  await assert.rejects(() => svc.withdraw(SID, ids[0]), /no user message with id/);
  await assert.rejects(() => svc.withdraw(SID, 999999), /no user message with id/);

  assert.deepEqual(surviving(), before);
});
