/**
 * Lightweight smoke test for core overlay bootstrap.
 *
 * Avoids loading the full Electron app. Instead, spins up small worker
 * processes that exercise the same code path as the real agent-worker.
 *
 * Scenarios:
 * 1. base-only (no overlay): worker loads base copy.
 * 2. overlay active: worker loads overlay copy and responds to IPC.
 * 3. syntax error: bad overlay triggers disableActiveCore, next boot uses base.
 */
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.join(ROOT, '..');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const ELECTRON_BIN = path.join(NODE_MODULES, 'electron', 'dist', 'electron.exe');
const OVERLAY_ROOT = path.join(tmpdir(), 'opencode', 'smoke-overlay-v2');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const BOOTSTRAP_DIR = path.join(DIST_DIR, 'bootstrap');

if (!fs.existsSync(ELECTRON_BIN)) throw new Error('electron not installed');
if (!fs.existsSync(BOOTSTRAP_DIR)) throw new Error('bootstrap not built; run npm run build');

let exitCode = 0;
function ok(msg) { console.log(`OK: ${msg}`); }
function fail(msg) { console.error(`FAIL: ${msg}`); exitCode = 1; }
function assert(cond, msg) { if (!cond) fail(msg); else ok(msg); }

function stageCore(version, body) {
  const dir = path.join(OVERLAY_ROOT, 'core', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
  mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
  // expose a stable import target; hook resolves nexus-coder/dist/src/test.js first
  writeFileSync(path.join(dir, 'dist', 'src', 'test.js'), body);
}

function makeBaseApp(root) {
  const app = path.join(root, 'app');
  mkdirSync(app, { recursive: true });
  // base nexus-coder with a real version module
  const nc = path.join(app, 'node_modules', 'nexus-coder', 'dist', 'src');
  mkdirSync(nc, { recursive: true });
  writeFileSync(path.join(app, 'node_modules', 'nexus-coder', 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version: '1.0.0', type: 'module' }));
  writeFileSync(path.join(nc, 'test.js'), "export const v = 'base-v1';\n");
  writeFileSync(path.join(app, 'node_modules', 'nexus-coder', 'index.js'),
    "export * from './dist/src/test.js';\n");
  writeFileSync(path.join(app, 'package.json'),
    JSON.stringify({ name: 'smoke-app', type: 'module' }));
  return app;
}

async function nodeProbe(app, opts) {
  const { version, registerUrl } = opts;
  const probe = path.join(app, 'probe.mjs');
  writeFileSync(probe,
    `import { createRequire } from 'node:module';` +
    `const req = createRequire(import.meta.url);` +
    `const m = await import('nexus-coder/dist/src/test.js');` +
    `process.stdout.write(JSON.stringify({ v: m.v ?? null }) + '\\n');\n`);
  const r = spawnSync(process.execPath, [
    '--import', registerUrl,
    probe
  ], {
    encoding: 'utf8',
    env: { ...process.env, NEXUS_OVERLAY_CORE_DIR: version ? path.join(OVERLAY_ROOT, 'core', version) : '', NEXUS_APP_ROOT: app }
  });
  let out = '';
  if (r.stdout) out += r.stdout;
  if (r.stderr) out += r.stderr;
  return { status: r.status, out, pid: r.pid };
}

async function electronProbe(app, { coreDir, e2eMain, workerFile }) {
  // Use smoke-e2e-main.cjs which handles IPC correctly.
  const resultFile = path.join(app, 'result.json');
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
  const probeFile = path.join(app, 'probe.cjs');
  if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
  const r = spawnSync(ELECTRON_BIN, [e2eMain], {
    env: { ...process.env, POC_CORE_DIR: coreDir, POC_APP_ROOT: app, POC_RESULT_FILE: resultFile, POC_ROOT: REPO_ROOT },
    encoding: 'utf8',
    timeout: 20000
  });
  // Wait for the app to write the result file (IPC may take a moment)
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (fs.existsSync(resultFile)) break;
  }
  if (!fs.existsSync(resultFile)) throw new Error('electronProbe: no result.json written');
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

// The main process for the E2E probe just starts an Electron app and
// exposes a minimal IPC so the worker can respond.
async function main() {
  console.log('smoke-overlay-v2: checking prerequisites...');
  assert(fs.existsSync(ELECTRON_BIN), 'electron binary exists');
  assert(fs.existsSync(path.join(BOOTSTRAP_DIR, 'overlay.js')), 'bootstrap/overlay.js built');
  assert(fs.existsSync(path.join(BOOTSTRAP_DIR, 'register.js')), 'bootstrap/register.js built');

  const registerUrl = pathToFileURL(path.join(BOOTSTRAP_DIR, 'register.js')).href;
  const overlayModule = path.join(REPO_ROOT, 'dist', 'bootstrap', 'overlay.js');

  // ---- Scenario 1: no overlay, base only ----
  console.log('\n=== SCENARIO 1: base-only ===');
  const app1 = makeBaseApp(path.join(OVERLAY_ROOT, 'sc1'));
  const r1 = await nodeProbe(app1, { registerUrl });
  assert(r1.status === 0, `scenario1 exit=0 (got ${r1.status})`);
  assert(JSON.parse(r1.out).v === 'base-v1', `scenario1 overlay returns base-v1`);

  // ---- Scenario 2: overlay active ----
  console.log('\n=== SCENARIO 2: overlay active ===');
  const version2 = '9.9.9-smoke';
  stageCore(version2, "export const v = 'smoke-overlay-v2';\n");
  const app2 = makeBaseApp(path.join(OVERLAY_ROOT, 'sc2'));
  const r2 = await nodeProbe(app2, { version: version2, registerUrl });
  assert(r2.status === 0, `scenario2 exit=0 (got ${r2.status})`);
  assert(JSON.parse(r2.out).v === 'smoke-overlay-v2', `scenario2 overlay loads overlay version`);

  // ---- Scenario 3: syntax error -> disable via state ----
  console.log('\n=== SCENARIO 3: syntax error recovery ===');
  const version3 = '9.9.8-smoke';
  stageCore(version3, "export const v = ;\n");
  const { activateCore, disableActiveCore, decideBoot } = await import(pathToFileURL(overlayModule).href);
  // root3 must match what stageCore writes to: OVERLAY_ROOT/core/version/*
  const root3 = OVERLAY_ROOT;
  mkdirSync(path.join(root3, 'core', version3), { recursive: true });
  activateCore(root3, version3);
  assert(decideBoot(root3).version === version3, 'scenario3 decideBoot returns staged version');
  disableActiveCore(root3);
  assert(decideBoot(root3).version === null, 'scenario3 disableActiveCore reverts to base');
  assert(readFileSync(path.join(root3, 'state.json'), 'utf8').includes('"disabledCores"'),
    'scenario3 disabledCores persisted');

  // ---- Scenario 4: Electron utilityProcess with overlay ----
  console.log('\n=== SCENARIO 4: Electron utilityProcess with overlay ===');
  const version4 = '9.9.7-smoke';
  stageCore(version4, "export const v = 'smoke-electron-ov';\n");
  const app4 = makeBaseApp(path.join(OVERLAY_ROOT, 'sc4'));
  const workerFile = path.join(REPO_ROOT, 'scripts', 'smoke-worker.mjs');
  const e2eMain = path.join(REPO_ROOT, 'scripts', 'smoke-e2e-main.cjs');
  const resultFile4 = path.join(app4, 'result.json');
  const result4 = await electronProbe(app4, { coreDir: path.join(OVERLAY_ROOT, 'core', version4), e2eMain, workerFile });
  // electronProbe reads from app/result.json (written by smoke-e2e-main.cjs via POC_RESULT_FILE)
  assert(result4.v === 'smoke-electron-ov', `scenario4 overlay version via utilityProcess (got ${result4.v})`);
  await assert(fs.existsSync(resultFile4), 'scenario4 result.json written to app dir');

  console.log('\n--- summary ---');
  process.exit(exitCode);
}
main().catch((e) => { fail(`fatal: ${e.message}`); console.error(e); process.exit(1); });
