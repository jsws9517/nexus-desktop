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
let ok = true;

function req(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, data: undefined });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'result') {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  } else {
    console.log(`[worker] ${msg.type}:`, JSON.stringify(msg).slice(0, 200));
  }
});

const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

async function expect(cond, label) {
  if (!cond) { ok = false; console.log(`FAIL: ${label}`); }
  else console.log(`PASS: ${label}`);
}

await timeout(500);
const init = await req('init');
await expect(init.ok === true, 'init ok');console.log('cwd =', init.data?.cwd);

const status = await req('getStatus');
await expect(status.ok === true && typeof status.data.provider === 'string', 'getStatus');

const providers = await req('getProviders');
await expect(Array.isArray(providers.data), 'getProviders list');

const cfg = await req('getConfig');
await expect(cfg.ok === true && !String(cfg.data.providers?.anthropic?.apiKey || '').includes('sk-'), 'getConfig masks apiKey');

const sessions = await req('listSessions');
await expect(Array.isArray(sessions.data), 'listSessions');

const sid = await req('startSession');
await expect(typeof sid.data === 'string' && sid.data.length > 0, 'startSession');

const sessions2 = await req('listSessions');
await expect(Array.isArray(sessions2.data) && sessions2.data.length > 0, 'session persisted');

const msgs = await req('getMessages', { sessionId: sid.data });
await expect(Array.isArray(msgs.data), 'getMessages');

await req('deleteSession', { id: sid.data });

await req('shutdown');
child.on('exit', () => {
  console.log(ok ? '\nSMOKE TEST: ALL PASS' : '\nSMOKE TEST: FAILED');
  process.exit(ok ? 0 : 1);
});
