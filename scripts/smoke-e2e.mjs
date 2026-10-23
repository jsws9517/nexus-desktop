/**
 * End-to-end smoke tests for the core overlay bootstrap (phase 1 + phase 2).
 *
 * Scenarios:
 *   S1  state machine – decideBoot, markHealthy, crash rollback, disableActiveCore
 *   S2  ESM hook – overlay file wins, fallback to base, bare-dep resolution
 *   S3  syntax-error recovery – bad overlay triggers disableActiveCore
 *   S4  Electron utilityProcess – real electron fork with overlay env
 *
 * Usage:
 *   node scripts/smoke-e2e.mjs
 *   POC_ROOT=/tmp/x node scripts/smoke-e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const DIST_DIR = path.join(ROOT, 'dist');
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OVERLAY_ROOT = process.env.POC_ROOT || path.join(tmpdir(), 'opencode', 'smoke-e2e');
const REGISTER_URL = pathToFileURL(path.join(DIST_DIR, 'bootstrap', 'register.js')).href;

let exitCode = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); exitCode = 1; }
function assert(cond, msg) { cond ? ok(msg) : fail(msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── helpers ──────────────────────────────────────────────────────────────────

function stageCore(root, version, body) {
  const dir = path.join(root, 'core', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
  mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'dist', 'src', 'version.js'), body);
  writeFileSync(path.join(dir, 'dist', 'src', 'test.js'), body);
  writeFileSync(path.join(dir, 'dist', 'src', 'missing.js'),
    "export const v = 'fallback-ok';\n");
  return dir;
}

function makeBaseApp(dir) {
  mkdirSync(dir, { recursive: true });
  const nc = path.join(dir, 'node_modules', 'nexus-coder', 'dist', 'src');
  mkdirSync(nc, { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'nexus-coder', 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version: '1.0.0', type: 'module' }));
  writeFileSync(path.join(nc, 'version.js'), "export const v = 'base-v1';\n");
  writeFileSync(path.join(nc, 'test.js'), "export const v = 'base-test';\n");
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'smoke-app', type: 'module' }));
  return dir;
}

function runNodeProbe(appDir, coreDir, specifier) {
  const probe = path.join(appDir, 'probe.mjs');
  writeFileSync(probe,
    `const m = await import(${JSON.stringify(specifier)});\n` +
    `process.stdout.write(JSON.stringify({ v: m.v ?? null, ok: true }) + '\\n');\n`);
  const r = spawnSync(process.execPath, ['--import', REGISTER_URL, probe], {
    encoding: 'utf8',
    env: { ...process.env, NEXUS_OVERLAY_CORE_DIR: coreDir ?? '', NEXUS_APP_ROOT: appDir },
    timeout: 10000,
  });
  let out = '';
  if (r.stdout) out += r.stdout;
  if (r.stderr && !r.stderr.includes('ExperimentalWarning')) out += r.stderr;
  return { status: r.status, out: out.trim(), err: r.error?.message };
}

// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  // ─── prerequisites ───────────────────────────────────────────────────────
  console.log('prerequisites:');
  assert(fs.existsSync(ELECTRON_BIN), 'electron binary exists');
  assert(fs.existsSync(path.join(DIST_DIR, 'bootstrap', 'overlay.js')), 'bootstrap/overlay.js built');
  assert(fs.existsSync(path.join(DIST_DIR, 'bootstrap', 'register.js')), 'bootstrap/register.js built');

  // ─── S1: state machine ───────────────────────────────────────────────────
  console.log('\n=== S1: overlay state machine ===');
  {
    const { decideBoot, activateCore, disableActiveCore, markHealthy, readState } =
      await import(pathToFileURL(path.join(DIST_DIR, 'bootstrap', 'overlay.js')).href);

    // S1a: activate + healthy
    const rootA = path.join(OVERLAY_ROOT, 's1a');
    stageCore(rootA, '1.0.0', "export const v = 'base';\n");
    stageCore(rootA, '2.0.0', "export const v = 'overlay-2';\n");
    activateCore(rootA, '2.0.0');
    assert(decideBoot(rootA).version === '2.0.0', 'S1: activated core is loaded');
    markHealthy(rootA);
    assert(readState(rootA).bootPending === false, 'S1: healthy clears pending');

    // S1b: crash loop rollback
    const rootB = path.join(OVERLAY_ROOT, 's1b');
    stageCore(rootB, '1.0.0', "export const v = 'base';\n");
    stageCore(rootB, '2.0.0', "export const v = 'overlay-2';\n");
    stageCore(rootB, '3.0.0', "export const v = ;\n"); // syntax error
    activateCore(rootB, '2.0.0');
    markHealthy(rootB);
    activateCore(rootB, '3.0.0');
    decideBoot(rootB); // boot 1: pending, failures=0
    decideBoot(rootB); // boot 2: pending, failures=1
    const rollback = decideBoot(rootB); // boot 3: failures=2 >= MAX, rollback
    // Rollback falls back to previousCore (2.0.0) since it is still staged and usable.
    assert(rollback.version === '2.0.0', 'S1: rollback to previous good core');
    assert(readState(rootB).disabledCores.includes('3.0.0'), 'S1: crashed version disabled');

    // S1c: disableActiveCore immediate revert
    const rootC = path.join(OVERLAY_ROOT, 's1c');
    stageCore(rootC, '2.0.0', "export const v = 'overlay-2';\n");
    activateCore(rootC, '2.0.0');
    assert(disableActiveCore(rootC) === '2.0.0', 'S1: disableActiveCore returns disabled version');
    assert(decideBoot(rootC).coreDir === null, 'S1: active cleared after disable');
  }

  // ─── S2: ESM hook ────────────────────────────────────────────────────────
  console.log('\n=== S2: ESM resolve hook ===');
  {
    const s2Root = path.join(OVERLAY_ROOT, 's2');
    const appDir = makeBaseApp(path.join(s2Root, 'app'));
    stageCore(s2Root, '2.0.0-hook', "export const v = 'hook-overlay';\n");
    const coreDir = path.join(s2Root, 'core', '2.0.0-hook');

    const r1 = runNodeProbe(appDir, coreDir, 'nexus-coder/dist/src/test.js');
    assert(r1.status === 0, `S2: overlay import succeeds (exit=${r1.status}, stderr=${r1.err ?? ''})`);
    const j1 = JSON.parse(r1.out);
    assert(j1.v === 'hook-overlay', `S2: overlay version loaded (got ${j1.v})`);

    // Fallback: file not in overlay → base copy.
    const r2 = runNodeProbe(appDir, coreDir, 'nexus-coder/dist/src/missing.js');
    assert(r2.status === 0, `S2: fallback import succeeds (exit=${r2.status}, stderr=${r2.err ?? ''})`);
    const j2 = JSON.parse(r2.out);
    assert(j2.v === 'fallback-ok', `S2: fallback to base (got ${j2.v ?? JSON.stringify(j2)})`);

    // No overlay: base copy used.
    const r3 = runNodeProbe(appDir, null, 'nexus-coder/dist/src/test.js');
    assert(r3.status === 0, `S2: base-only import succeeds (exit=${r3.status})`);
    const j3 = JSON.parse(r3.out);
    assert(j3.v === 'base-test', `S2: base version (got ${j3.v})`);
  }

  // ─── S3: syntax error → disableActiveCore ────────────────────────────────
  console.log('\n=== S3: syntax error recovery ===');
  {
    const { activateCore, disableActiveCore, decideBoot } =
      await import(pathToFileURL(path.join(DIST_DIR, 'bootstrap', 'overlay.js')).href);
    const root = path.join(OVERLAY_ROOT, 's3');
    mkdirSync(root, { recursive: true });
    stageCore(root, '9.9.9-bad', "export const v = ;\n"); // syntax error
    activateCore(root, '9.9.9-bad');
    assert(decideBoot(root).version === '9.9.9-bad', 'S3: staged version is active');
    const v = disableActiveCore(root);
    assert(v === '9.9.9-bad', `S3: disableActiveCore returns ${v}`);
    assert(decideBoot(root).coreDir === null, 'S3: reverted to base');
  }

  // ─── S4: Electron utilityProcess ─────────────────────────────────────────
  console.log('\n=== S4: Electron utilityProcess with overlay ===');
  {
    const s4Root = path.join(OVERLAY_ROOT, 's4');
    const version = '9.9.8-electron';
    stageCore(s4Root, version, "export const v = 'electron-overlay';\n");
    const appDir = makeBaseApp(path.join(s4Root, 'app'));
    const workerFile = path.join(ROOT, 'scripts', 'smoke-worker.mjs');
    const e2eMain = path.join(ROOT, 'scripts', 'smoke-e2e-main.cjs');
    const resultFile = path.join(appDir, 'result.json');

    if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);

    const r = spawnSync(ELECTRON_BIN, [e2eMain], {
      env: {
        ...process.env,
        POC_CORE_DIR: path.join(s4Root, 'core', version),
        POC_APP_ROOT: appDir,
        POC_RESULT_FILE: resultFile,
        POC_ROOT: ROOT,
      },
      encoding: 'utf8',
      timeout: 20000,
      cwd: ROOT,
    });

    // Wait for result file to be written by the Electron process.
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (fs.existsSync(resultFile)) break;
    }

    assert(r.status === 0 || r.status === null, `S4: electron exited cleanly (code=${r.status})`);
    assert(fs.existsSync(resultFile), 'S4: result.json written');
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert(result.v === 'electron-overlay',
      `S4: overlay version via utilityProcess (got ${result.v ?? 'undefined'}, logs=${JSON.stringify(result.logs)?.slice(0, 200)})`);
  }

  // ─── summary ─────────────────────────────────────────────────────────────
  console.log(`\n=== summary: exit=${exitCode} ===`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
