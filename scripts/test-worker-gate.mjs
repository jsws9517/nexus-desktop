// Gate test for the agent-worker init gate: sends `init` and then IMMEDIATELY
// dispatches `listSessions` before init has resolved (the race that produced
// "Agent not initialized" on startup). Works under system node because dev-mode
// better-sqlite3 is built for the system-node ABI.
// Usage: node scripts/test-worker-gate.mjs
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', 'dist', 'agent-worker.js');

const child = spawn('node', [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

let nextId = 1;
const pending = new Map();
let failures = 0;
function expect(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else { failures++; console.log(`FAIL: ${label}`); }
}

function req(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: `timeout ${method}` }); }, 60000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'result') {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  } else {
    console.log(`[worker] ${msg.type}:`, JSON.stringify(msg).slice(0, 160));
  }
});

// Fire init and listSessions back-to-back — listSessions MUST wait for init.
const initP = req('init');
const listP = req('listSessions');
const startP = req('startSession');

const init = await initP;
expect(init.ok === true, `init ok (${init.error ?? ''})`);

const listed = await listP;
expect(listed.ok === true && Array.isArray(listed.data?.items), `listSessions waited for init (${listed.error ?? 'ok'})`);

const started = await startP;
expect(started.ok === true && typeof started.data === 'string' && started.data.length > 0, 'startSession ok');

await req('shutdown');
console.log(failures === 0 ? '\nWORKER GATE TEST: ALL PASS' : `\nWORKER GATE TEST: FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
