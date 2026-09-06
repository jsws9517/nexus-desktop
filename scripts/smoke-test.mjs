import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

async function expect(cond, label, detail) {
  if (!cond) { ok = false; console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`PASS: ${label}`);
}

await timeout(500);
const init = await req('init');
await expect(init.ok === true, 'init ok', init.error);console.log('cwd =', init.data?.cwd);

const status = await req('getStatus');
await expect(status.ok === true && typeof status.data.provider === 'string', 'getStatus');

const providers = await req('getProviders');
await expect(Array.isArray(providers.data), 'getProviders list');

const cfg = await req('getConfig');
await expect(cfg.ok === true && !String(cfg.data.providers?.anthropic?.apiKey || '').includes('sk-'), 'getConfig masks apiKey');

const sessions = await req('listSessions');
await expect(Array.isArray(sessions.data?.items), 'listSessions');

const sid = await req('startSession');
await expect(typeof sid.data === 'string' && sid.data.length > 0, 'startSession');

const sessions2 = await req('listSessions');
await expect(Array.isArray(sessions2.data?.items) && sessions2.data.items.length > 0, 'session persisted');

const msgs = await req('getMessages', { sessionId: sid.data });
await expect(
  msgs.data && Array.isArray(msgs.data.items) && typeof msgs.data.total === 'number' && typeof msgs.data.userBefore === 'number',
  'getMessages',
);

const msgsLast = await req('getMessages', { sessionId: sid.data, last: 5 });
await expect(Array.isArray(msgsLast.data?.items) && msgsLast.data.items.length === 0, 'getMessages last');

// Derived session (Desktop /new path): startSession with prevSessionId must
// create a NEW session id (via the core's create-new branch) and keep the
// derived session's own transcript empty.
const sid2 = await req('startSession', { prevSessionId: sid.data });
await expect(
  typeof sid2.data === 'string' && sid2.data.length > 0 && sid2.data !== sid.data,
  'startSession prevSessionId creates distinct id',
  `parent=${sid.data} derived=${sid2.data}`,
);

const derivedMsgs = await req('getMessages', { sessionId: sid2.data, last: 5 });
await expect(
  Array.isArray(derivedMsgs.data?.items) && derivedMsgs.data.items.length === 0,
  'derived session starts empty',
);

await req('deleteSession', { id: sid2.data });
await req('deleteSession', { id: sid.data });

// --- Built-in filesystem tools (src/fs-internal.ts) ---
const fsMod = await import('node:fs/promises');
const osMod = await import('node:os');
const pathMod = await import('node:path');
const { FILESYSTEM_TOOLS, FILESYSTEM_TOOL_DEFS, callFsTool } = await import(pathToFileURL(join(__dirname, '..', 'dist', 'fs-internal.js')));
// Non-interactive: any out-of-allow path must be DENIED (never a dead prompt).
(await import(pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js'))))
  .setPermissionPrompter(() => 'n');

await expect(
  FILESYSTEM_TOOLS.size === 3 &&
    ['read_media_file', 'list_directory_with_sizes', 'list_allowed_directories'].every((n) => FILESYSTEM_TOOLS.has(n)),
  'fs-internal tool set',
);
await expect(FILESYSTEM_TOOL_DEFS.every((d) => d.server === 'filesystem-internal'), 'fs-internal defs tagged');

const fsTmp = pathMod.join(process.cwd(), '.smoke-fs-test');
await fsMod.mkdir(fsTmp, { recursive: true });
await fsMod.writeFile(pathMod.join(fsTmp, 'one.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64',
));
await fsMod.writeFile(pathMod.join(fsTmp, 'a.txt'), 'hello');

const list = await callFsTool('list_directory_with_sizes', { path: fsTmp });
const listJson = JSON.parse(list.content);
await expect(
  list.isError !== true && Array.isArray(listJson.entries) && listJson.entries.find((e) => e.name === 'a.txt')?.size === 5,
  'list_directory_with_sizes sizes',
);

const media = await callFsTool('read_media_file', { path: pathMod.join(fsTmp, 'one.png') });
await expect(
  media.isError !== true && media.content.startsWith('![one.png](data:image/png;base64,'),
  'read_media_file data-URI',
  media.content?.slice(0, 60),
);

const allowed = await callFsTool('list_allowed_directories');
const allowedJson = JSON.parse(allowed.content);
await expect(
  allowedJson.cwd === process.cwd() && typeof allowedJson.sandboxActive === 'boolean' && Array.isArray(allowedJson.grantedRoots),
  'list_allowed_directories boundary report',
);

const denied = await callFsTool('list_directory_with_sizes', { path: osMod.tmpdir() });
await expect(denied.isError === true, 'fs-internal out-of-root denied', (denied.content || '').slice(0, 60));

await fsMod.rm(fsTmp, { recursive: true, force: true });

await req('shutdown');
child.on('exit', () => {
  console.log(ok ? '\nSMOKE TEST: ALL PASS' : '\nSMOKE TEST: FAILED');
  process.exit(ok ? 0 : 1);
});
