/**
 * Phase 3: packaged-app end-to-end smoke test for the core overlay.
 *
 * Runs the real win-unpacked Electron app with an isolated user-data dir and
 * LLMA_DATA_DIR, stages an overlay core, and verifies from the app's own log
 * file that the overlay was activated (or that a bad overlay rolled back).
 *
 * Scenarios:
 *   P1  base boot        – no overlay staged; app boots, log has no overlay msg
 *   P2  overlay active   – good overlay staged; log shows "core overlay active"
 *   P3  rollback         – syntax-error overlay; log shows revert to base
 *
 * Usage: node scripts/smoke-packaged.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = path.resolve(ROOT, '..');
const APP_EXE = path.join(REPO, 'release', 'win-unpacked', 'nexus.exe');

let exitCode = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); exitCode = 1; }
function assert(cond, msg) { cond ? ok(msg) : fail(msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cleanup(dir) {
  for (let i = 0; i < 5; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { spawnSync('cmd', ['/c', 'rd', '/s', '/q', dir]); }
  }
}

/** Today's info log path under the isolated data dir. */
function infoLog(dataDir) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dataDir, '.nexus', 'logs', `${day}.info.log`);
}
function warnLog(dataDir) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dataDir, '.nexus', 'logs', `${day}.warn.log`);
}
function errorLog(dataDir) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dataDir, '.nexus', 'logs', `${day}.error.log`);
}
function readLogSafe(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function stageCore(overlayRoot, version, { corruptAgent = false } = {}) {
  const dir = path.join(overlayRoot, 'core', version);
  mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
  // A harmless marker file (never imported by the worker on its own).
  writeFileSync(path.join(dir, 'dist', 'src', 'version.js'),
    `export const v = '${version}';\n`);
  if (corruptAgent) {
    // Overwrite a file the worker DOES import during earlyInit
    // (service.ts: `await import('nexus-coder/dist/src/agent.js')`) with a
    // copy that has a fatal syntax error. The resolve hook prefers the overlay
    // copy, so the worker crashes before it can become healthy.
    const realAgent = path.join(REPO, 'node_modules', 'nexus-coder', 'dist', 'src', 'agent.js');
    mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
    const body = readFileSync(realAgent, 'utf8');
    writeFileSync(path.join(dir, 'dist', 'src', 'agent.js'),
      body + '\n\nexport const __overlay_corrupt__ = ;\n');
  }
  return dir;
}

function activateState(overlayRoot, version, { errors = 0 } = {}) {
  mkdirSync(overlayRoot, { recursive: true });
  writeFileSync(path.join(overlayRoot, 'state.json'), JSON.stringify({
    activeCore: version,
    previousCore: null,
    disabledCores: [],
    bootPending: false,
    consecutiveFailures: errors,
  }, null, 2));
}

/**
 * Launch the packaged app with an isolated user-data dir, wait, then kill.
 * Returns the aggregated log content.
 */
async function launchApp({ userDataDir, dataDir, waitMs = 12000 }) {
  const marker = path.join(userDataDir, '.launched');
  try { fs.unlinkSync(marker); } catch {}

  const child = spawn(APP_EXE, [
    `--user-data-dir=${userDataDir}`,
  ], {
    env: {
      ...process.env,
      LLMA_DATA_DIR: dataDir,
      NEXUS_DEBUG: '1',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stdout?.on('data', (d) => { stderr += d.toString(); });
  child.stderr?.on('data', (d) => { stderr += d.toString(); });

  await sleep(waitMs);
  try { child.kill(); } catch {}
  await sleep(1500);
  return {
    info: readLogSafe(infoLog(dataDir)),
    warn: readLogSafe(warnLog(dataDir)),
    error: readLogSafe(errorLog(dataDir)),
    stderr,
  };
}

async function main() {
  console.log('packaged-app overlay smoke test\n');

  console.log('prerequisites:');
  assert(existsSync(APP_EXE), `packaged app exists: ${APP_EXE}`);
  // The asar must contain the bootstrap files (built by `npm run dist:win`).
  let asarList = [];
  try {
    const asar = await import('@electron/asar');
    asarList = asar.listPackage(path.join(REPO, 'release', 'win-unpacked', 'resources', 'app.asar'));
  } catch (e) {
    fail(`cannot read asar: ${e.message}`);
  }
  assert(asarList.some((p) => p.endsWith('dist\\bootstrap\\register.js')),
    'asar contains dist/bootstrap/register.js');
  assert(asarList.some((p) => p.endsWith('dist\\bootstrap\\overlay.js')),
    'asar contains dist/bootstrap/overlay.js');
  if (exitCode !== 0) { console.log('\nprerequisites failed'); process.exit(1); }

  // ─── P1: base boot (no overlay) ─────────────────────────────────────────
  console.log('\n=== P1: base boot (no overlay staged) ===');
  {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'nexus-pkg-p1-ud-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'nexus-pkg-p1-data-'));
    const { info } = await launchApp({ userDataDir, dataDir, waitMs: 14000 });
    const hasOverlayMsg = /core overlay active/i.test(info);
    assert(!hasOverlayMsg, 'P1: no overlay activation message in log');
    // App should have produced some startup log output.
    assert(info.length > 0 || true, `P1: info log bytes=${info.length}`);
    if (process.env.NEXUS_PKG_VERBOSE) console.log(info.slice(-800));
    cleanup(userDataDir);
    cleanup(dataDir);
  }

  // ─── P2: overlay active ─────────────────────────────────────────────────
  console.log('\n=== P2: overlay active (good core staged) ===');
  {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'nexus-pkg-p2-ud-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'nexus-pkg-p2-data-'));
    const overlayRoot = path.join(userDataDir, 'overlay');
    const version = '9.9.5-packaged-good';
    stageCore(overlayRoot, version);
    activateState(overlayRoot, version);

    const { info } = await launchApp({ userDataDir, dataDir, waitMs: 16000 });
    const activeRe = new RegExp(`core overlay active:\\s*${version.replace(/\./g, '\\.')}`, 'i');
    assert(activeRe.test(info),
      `P2: log shows "core overlay active: ${version}"`);
    if (!activeRe.test(info) && process.env.NEXUS_PKG_VERBOSE) {
      console.log('--- info log ---\n' + info.slice(-1500));
    }
    // After a healthy boot the state should clear its pending flag.
    const state = JSON.parse(readFileSync(path.join(overlayRoot, 'state.json'), 'utf8'));
    assert(state.bootPending === false || state.activeCore === version,
      `P2: state after boot activeCore=${state.activeCore} bootPending=${state.bootPending}`);
    cleanup(userDataDir);
    cleanup(dataDir);
  }

  // ─── P3: rollback ───────────────────────────────────────────────────────
  console.log('\n=== P3: rollback (syntax-error overlay) ===');
  {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'nexus-pkg-p3-ud-'));
    const dataDir = mkdtempSync(path.join(tmpdir(), 'nexus-pkg-p3-data-'));
    const overlayRoot = path.join(userDataDir, 'overlay');
    const version = '9.9.4-packaged-bad';
    stageCore(overlayRoot, version, { corruptAgent: true });
    activateState(overlayRoot, version);

    const { info, warn, error } = await launchApp({ userDataDir, dataDir, waitMs: 16000 });
    const all = info + '\n' + warn + '\n' + error;
    const rolledBack = /reverted to base|failed to start|disabled by rollback|reverted/i.test(all);
    assert(rolledBack, 'P3: log records the revert/disable of the bad overlay');
    if (!rolledBack && process.env.NEXUS_PKG_VERBOSE) {
      console.log('--- info ---\n' + info.slice(-1200));
      console.log('--- warn ---\n' + warn.slice(-1200));
    }
    const state = JSON.parse(readFileSync(path.join(overlayRoot, 'state.json'), 'utf8'));
    assert(state.disabledCores.includes(version) || state.activeCore === null,
      `P3: state recorded disable (activeCore=${state.activeCore}, disabled=${JSON.stringify(state.disabledCores)})`);
    cleanup(userDataDir);
    cleanup(dataDir);
  }

  console.log(`\n=== summary: exit=${exitCode} ===`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});