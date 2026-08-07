// Test for desktop/src/session-truncate.ts (the regenerate SQL layer).
// Runs under system node: dev-mode better-sqlite3 is built for the system-node
// ABI, matching the worker that spawns via `node dist/agent-worker.js`.
// Usage: node scripts/test-regenerate-sql.mjs
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKER_MARKERS = ['[Project Directory]', '[Original Request]', '[Prior Task Results]', '[Role:'];
const isWorker = (r) => r.role === 'user' && WORKER_MARKERS.some((mk) => r.content.slice(0, 200).includes(mk));

let failures = 0;
function expect(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else { failures++; console.log(`FAIL: ${label}`); }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'nexus-regen-'));
const nexusDir = join(tempRoot, '.nexus');
mkdirSync(nexusDir, { recursive: true });
process.env.LLMA_DATA_DIR = tempRoot;
console.log(`temp data dir: ${tempRoot}`);

const db = new Database(join(nexusDir, 'sessions.db'));
db.exec(`
CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT);
CREATE TABLE messages (
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
CREATE INDEX idx_messages_session ON messages(session_id);
`);
const ins = db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
const SID = 's1';
const seed = (role, content) => ins.run(SID, role, content, Date.now());

seed('user', 'first ask');
seed('assistant', 'first answer');
seed('user', 'target ask');
seed('assistant', 'old answer 1');
seed('tool', 'old tool payload');
seed('assistant', 'old answer 2');
seed('user', '[Role: general]\nworker dispatch block');
seed('assistant', 'worker result');

const { getMessageRows, deleteMessagesFrom } = await import(new URL('../dist/session-truncate.js', import.meta.url).href);

let rows = getMessageRows(SID);
expect(rows.length === 8, `getMessageRows returns 8 rows (got ${rows.length})`);
expect(rows[0].role === 'user' && rows[0].content === 'first ask', 'rows ordered by id asc');

const userRows = rows.filter((r) => r.role === 'user' && !isWorker(r));
expect(userRows.length === 2, `user rows skip worker blocks (got ${userRows.length})`);
const target = userRows[1];
expect(target && target.content === 'target ask', 'userIndex 1 resolves to "target ask"');

const { deleted } = deleteMessagesFrom(SID, target.id);
expect(deleted === 6, `deleteMessagesFrom removes target + everything after (deleted ${deleted})`);

rows = getMessageRows(SID);
expect(rows.length === 2, `2 rows remain after truncate (got ${rows.length})`);
expect(rows[1].role === 'assistant' && rows[1].content === 'first answer', 'rows before target untouched');

db.close();
console.log(failures === 0 ? '\nSQL TEST: ALL PASS' : `\nSQL TEST: FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
