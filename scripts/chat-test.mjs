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
let sawText = false;
let sawTurnEnd = false;
let permissionQuestions = 0;

function req(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'result') {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  } else if (msg.type === 'event') {
    if (msg.event.type === 'text') { sawText = true; process.stdout.write(msg.event.text); }
    if (msg.event.type === 'turn_end') sawTurnEnd = true;
    if (msg.event.type === 'thinking') process.stdout.write('[thinking]');
    if (msg.event.type === 'tool_call_start') process.stdout.write(`\n[tool:${msg.event.name}]\n`);
  } else if (msg.type === 'permission') {
    permissionQuestions++;
    console.log(`\n[PERMISSION] ${msg.question.slice(0, 120)}`);
    child.stdin.write(JSON.stringify({ id: nextId++, method: 'resolvePermission', params: { id: msg.id, answer: 'y' } }) + '\n');
  }
});

const ok = async (cond, label) => {
  console.log(`\n${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exit(1);
};

const init = await req('init');
await ok(init.ok === true, 'init');
await req('startSession');
console.log('\n>>> sending chat...');
await req('chat', { input: '请用一句话回答：1+1等于几？' });
await ok(sawText, 'streamed text');
await ok(sawTurnEnd, 'turn_end');
console.log(`permission questions asked: ${permissionQuestions}`);
await req('shutdown');
process.exit(0);
