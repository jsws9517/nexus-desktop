// Headless repro: drive the real agent-worker exactly as the app launches it
// (with the core-overlay env), then call setProviderOverride for every
// provider. Prints which one throws and the full worker-side stack.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(root, 'dist', 'agent-worker.js');
const overlayCore =
  process.env.REPRO_NO_OVERLAY === '1'
    ? '' // no overlay: run the base copy from node_modules only
    : process.env.NEXUS_OVERLAY_CORE_DIR ||
      path.join(process.env.APPDATA, 'nexus-desktop', 'overlay', 'core', '1.1.26-2');
const appRoot = root;

const env = {
  ...process.env,
  NEXUS_OVERLAY_CORE_DIR: overlayCore,
  NEXUS_APP_ROOT: appRoot,
};

// Simulate the NEW app spawn: shared ephemeral key (Fix A) + --import hook
// registration (Fix B). REPRO_LEGACY_SPAWN=1 keeps the old broken spawn for
// comparison.
const legacySpawn = process.env.REPRO_LEGACY_SPAWN === '1';
const { randomBytes } = await import('node:crypto');
const { pathToFileURL } = await import('node:url');
const args = legacySpawn
  ? ['--max-old-space-size=1024', workerPath]
  : [
      '--max-old-space-size=1024',
      '--import',
      pathToFileURL(path.join(root, 'dist', 'bootstrap', 'register.js')).href,
      workerPath,
    ];
if (!legacySpawn || process.env.REPRO_KEEP_KEY === '1') env._NEXUS_ENCRYPT_KEY = randomBytes(32).toString('hex');

console.log(`worker      = ${workerPath}`);
console.log(`overlayCore = ${overlayCore || '(none — base copy)'}`);
console.log(`spawn mode  = ${legacySpawn ? 'legacy (no --import, no shared key)' : 'new (--import + _NEXUS_ENCRYPT_KEY)'}`);

const child = spawn(
  process.execPath,
  args,
  { stdio: ['pipe', 'pipe', 'pipe'], env },
);

let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

const pending = new Map();
let nextId = 1;
process.on('SIGINT', () => child.kill());

import readline from 'node:readline';
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'result' && msg.id != null && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  } else if (msg.type === 'log') {
    // console.error(`[worker:${msg.level}] ${msg.message}`);
  }
});

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  const payload = JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id=${id})`)), timeoutMs);
    pending.set(id, {
      resolve: (m) => { clearTimeout(t); resolve(m); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    child.stdin.write(payload);
  });
}

function getErrorText(r) {
  return r && r.error ? `ERROR: ${r.error}` : `OK: ${JSON.stringify(r?.data ?? null).slice(0, 200)}`;
}

const providers = ['deepseek', 'zen', 'agnes', 'zhipu', 'aliyun', 'openrouter', 'coding'];

try {
  console.log('\n--- earlyInit ---');
  const early = await rpc('earlyInit', { cwd: root }, 60000);
  console.log(getErrorText(early));

  for (const name of providers) {
    const r = await rpc('setProviderOverride', { name }, 30000);
    if (r && r.ok) {
      console.log(`\n[setProviderOverride ${name}] ${getErrorText(r)}`);
    } else {
      console.log(`\n[setProviderOverride ${name}] ${getErrorText(r)}`);
      if (r?.errorStack) console.log(`    STACK:\n${r.errorStack.split('\n').join('\n    ')}`);
    }
  }
} catch (e) {
  console.error('repro failed:', e.message);
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 1500);
}
if (stderr.trim()) {
  console.log('\n--- worker stderr (tail) ---');
  console.log(stderr.slice(-2000));
}
