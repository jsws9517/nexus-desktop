// End-to-end: extract the packaged asar, overlay unpacked natives, swap in the
// system-ABI better-sqlite3 prebuild, then exercise the pruned module graph +
// the packaged worker under plain Node.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = join(root, '.slim-test');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const asar = join(root, 'release/win-unpacked/resources/app.asar');
const devSqlite = join(root, 'node_modules/better-sqlite3/prebuilds/win32-x64.node');

console.log('--- extract ---');
let r = spawn('node', [join(root, 'scripts/extract-asar.mjs'), asar, tmp, devSqlite], { stdio: 'inherit' });
await new Promise((res) => r.on('exit', res));
console.log('[e2e] extract exited, status =', r.status);
if (r.status !== 0) process.exit(1);

copyFileSync(join(root, 'scripts/probe-slim-modules.mjs'), join(tmp, 'probe.mjs'));
console.log('\n--- module probes (inside extracted pruned tree) ---');
r = spawn('node', [join(tmp, 'probe.mjs')], { cwd: tmp, stdio: 'inherit' });
await new Promise((res) => r.on('exit', res));
const probeOk = r.status === 0;

console.log('\n--- packaged worker boot (init + getStatus, read-only) ---');
const child = spawn('node', [join(tmp, 'dist/agent-worker.js')], {
  cwd: tmp,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
child.stdin.write(JSON.stringify({ id: 1, method: 'init' }) + '\n');
await new Promise((res) => setTimeout(res, 25_000));
child.stdin.write(JSON.stringify({ id: 2, method: 'getStatus' }) + '\n');
await new Promise((res) => setTimeout(res, 5_000));
child.stdin.write(JSON.stringify({ id: 3, method: 'shutdown' }) + '\n');
const exited = await new Promise((res) => child.on('exit', (c) => res(c)));
const initOk = out.includes('"id":1') && out.includes('"ok":true');
console.log(initOk ? 'worker init ok' : 'worker init NOT ok');
console.log(out.split('\n').slice(0, 6).join('\n'));

rmSync(tmp, { recursive: true, force: true });
console.log(`\nworker exit code: ${exited}, probes ok: ${probeOk}`);
process.exit(probeOk && initOk && exited === 0 ? 0 : 1);
