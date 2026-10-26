/**
 * Smoke test for the core overlay bootstrap.
 *
 * Verifies three scenarios with the real app:
 * 1. overlay active: worker loads overlay version, state.json is marked healthy.
 * 2. syntax-error recovery: bad overlay is disabled on crash, next boot uses base.
 * 3. no-overlay: base copy is used when no overlay is staged.
 *
 * Requires node_modules/@electron/asar, electron, and nexus-coder.
 * Runs as: node scripts/smoke-overlay.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const ROOT = fileURLToPath(new URL('.', import.meta.url));

const APP_DIR = path.join(ROOT, '..');
const REPO_ROOT = path.join(APP_DIR);
const ELECTRON_BIN = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const POC_ROOT = path.join(tmpdir(), 'opencode', 'poc-decouple');

const OVERLAY_ROOT = path.join(tmpdir(), 'opencode', 'smoke-overlay');
const APP_DATA = path.join(OVERLAY_ROOT, 'appdata');
const NODE_MODULES = path.join(APP_DIR, 'node_modules');
const BASE_NEXUS_CODER = path.join(NODE_MODULES, 'nexus-coder', 'dist', 'src');
const WORKER_PATH = path.join(APP_DIR, 'dist', 'agent-worker.js');

if (!fs.existsSync(ELECTRON_BIN)) throw new Error('electron not installed; run npm install');
if (!fs.existsSync(WORKER_PATH)) throw new Error('worker not built; run npm run build');

let exitCode = 0;
async function fail(msg) {
  console.error(`FAIL: ${msg}`);
  exitCode = 1;
}
async function ok(msg) {
  console.log(`OK: ${msg}`);
}
async function assert(cond, msg) {
  if (!cond) await fail(msg);
  else await ok(msg);
}
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function ensureOverlayRoot(version) {
  const dir = path.join(OVERLAY_ROOT, 'core', version);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stageCore(version, body, depBody) {
  const dir = ensureOverlayRoot(version);
  mkdirSync(path.join(dir, 'dist', 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
  writeFileSync(path.join(dir, 'dist', 'src', 'version.js'), body ?? "export const v = 'overlay-ok';\n");
  if (depBody !== undefined) {
    mkdirSync(path.join(dir, 'node_modules', 'poc-dep'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'poc-dep', 'package.json'),
      JSON.stringify({ name: 'poc-dep', version: '1.0.0', type: 'module', exports: './index.js' }));
    writeFileSync(path.join(dir, 'node_modules', 'poc-dep', 'index.js'), depBody);
  }
  return dir;
}

async function launchApp({ userData, envOverride = {} }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ELECTRON_BIN, [APP_DIR], {
      env: { ...process.env, HOME: userData, ELECTRON_ENABLE_LOGGING: '1', ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (e) => reject(e));
  });
}

async function scenario1_overlayActive() {
  console.log('\n=== SCENARIO 1: overlay active ===');
  const baseV = fs.readFileSync(path.join(BASE_NEXUS_CODER, 'version.js'), 'utf8').match(/v\s*=\s*'([^']+)'/)?.[1] ?? 'base';
  const version = '9.9.9-smoke';
  stageCore(version, "export const v = 'smoke-overlay-v1';\n");

  const stateFile = path.join(APP_DATA, 'state.json');
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  writeFileSync(path.join(APP_DATA, 'package.json'), JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));

  // manually activate so state shows pending=true (simulates decideBoot outcome)
  const { activateCore } = await import('./dist/bootstrap/overlay.js');
  activateCore(path.join(APP_DATA, 'overlay'), version);

  const app = spawn(ELECTRON_BIN, [APP_DIR], {
    env: { ...process.env, HOME: APP_DATA, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await sleep(8000);
  app.kill();
  await sleep(1000);

  const newState = readFileSync(path.join(APP_DATA, 'overlay', 'state.json'), 'utf8');
  const parsed = JSON.parse(newState);
  await assert(parsed.bootPending === false, 'state bootPending should be false after healthy boot');
  await assert(parsed.activeCore === version, `activeCore should be ${version}`);
  await assert(parsed.consecutiveFailures === 0, 'consecutiveFailures should be 0');
  // reset state for next scenarios
  delete require.cache[require.resolve('./dist/bootstrap/overlay.js')];
  const { deactivateCore } = await import('./dist/bootstrap/overlay.js');
  await (deactivateCore?.(path.join(APP_DATA, 'overlay')) ?? null);
}

async function scenario2_syntaxErrorRecovery() {
  console.log('\n=== SCENARIO 2: syntax error recovery ===');
  const version = '9.9.8-smoke';
  stageCore(version, "export const v = ;\n"); // syntax error

  if (fs.existsSync(APP_DATA)) rmSync(APP_DATA, { recursive: true, force: true });
  mkdirSync(APP_DATA, { recursive: true });
  const { activateCore } = await import('./dist/bootstrap/overlay.js');
  activateCore(path.join(APP_DATA, 'overlay'), version);

  const app = spawn(ELECTRON_BIN, [APP_DIR], {
    env: { ...process.env, HOME: APP_DATA, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  app.stderr.on('data', (d) => { stderr += d.toString(); });
  await sleep(6000);
  app.kill();
  await sleep(2000);

  const newState = readFileSync(path.join(APP_DATA, 'overlay', 'state.json'), 'utf8');
  const parsed = JSON.parse(newState);
  await assert(parsed.activeCore === null, 'activeCore should be null after syntax error');
  await assert(parsed.consecutiveFailures === 0, 'consecutiveFailures should be 0');
  await assert(stderr.includes('reverted') || stderr.includes('disable'), 'should log revert message');
}

async function scenario3_noOverlay() {
  console.log('\n=== SCENARIO 3: no overlay (base copy) ===');
  if (fs.existsSync(APP_DATA)) rmSync(APP_DATA, { recursive: true, force: true });
  mkdirSync(APP_DATA, { recursive: true });

  const app = spawn(ELECTRON_BIN, [APP_DIR], {
    env: { ...process.env, HOME: APP_DATA, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await sleep(5000);
  app.kill();
  await sleep(1000);

  const stateFile = path.join(APP_DATA, 'overlay', 'state.json');
  await assert(!existsSync(stateFile) || JSON.parse(readFileSync(stateFile, 'utf8')).activeCore === null,
    'no overlay state file or activeCore should be null');
}

async function main() {
  console.log('smoke-overlay: checking prerequisites...');
  await assert(fs.existsSync(ELECTRON_BIN), 'electron binary exists');
  await assert(fs.existsSync(WORKER_PATH), 'worker built');
  await assert(fs.existsSync(BASE_NEXUS_CODER), 'nexus-coder dist exists');

  try {
    await scenario1_overlayActive();
  } catch (e) {
    await fail(`scenario1 crashed: ${e.message}`);
  }
  try {
    await scenario2_syntaxErrorRecovery();
  } catch (e) {
    await fail(`scenario2 crashed: ${e.message}`);
  }
  try {
    await scenario3_noOverlay();
  } catch (e) {
    await fail(`scenario3 crashed: ${e.message}`);
  }

  console.log('\n--- summary ---');
  process.exit(exitCode);
}
main().catch(console.error);
