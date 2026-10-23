/**
 * Core overlay bootstrap (phase 1): boot state machine + ESM resolve hook.
 *
 * Imports compiled output from dist/ (run via `npm run test:unit`, which builds first).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  decideBoot,
  markHealthy,
  activateCore,
  disableActiveCore,
  readState,
  prepareLaunch,
  coreDirFor,
  MAX_BOOT_FAILURES,
} from '../dist/bootstrap/overlay.js';

const tmp = mkdtempSync(join(tmpdir(), 'core-overlay-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function freshRoot() {
  return join(tmp, `case-${++seq}`, 'overlay');
}

function stageCore(root, version, body = "export const v = 'ok';\n") {
  const dir = coreDirFor(root, version);
  mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
  writeFileSync(join(dir, 'dist', 'src', 'version.js'), body);
}

test('no overlay: decideBoot returns base copy and leaves nothing pending', () => {
  const root = freshRoot();
  const d = decideBoot(root);
  assert.equal(d.coreDir, null);
  assert.equal(d.version, null);
  assert.equal(readState(root).bootPending, false);
});

test('activated core is loaded and marked pending until healthy', () => {
  const root = freshRoot();
  stageCore(root, '2.0.0');
  activateCore(root, '2.0.0');

  const d = decideBoot(root);
  assert.equal(d.coreDir, coreDirFor(root, '2.0.0'));
  assert.equal(readState(root).bootPending, true);

  markHealthy(root);
  const s = readState(root);
  assert.equal(s.bootPending, false);
  assert.equal(s.consecutiveFailures, 0);
});

test('crash loop rolls back to previous good core after MAX_BOOT_FAILURES', () => {
  const root = freshRoot();
  stageCore(root, '1.0.0');
  stageCore(root, '2.0.0');
  activateCore(root, '1.0.0');
  markHealthy(root);
  activateCore(root, '2.0.0');

  assert.equal(MAX_BOOT_FAILURES, 2, 'test assumes threshold of 2');
  // Boot A and B: 2.0.0 never becomes healthy (B counts one failure).
  assert.equal(decideBoot(root).version, '2.0.0');
  assert.equal(decideBoot(root).version, '2.0.0');
  // Boot C: failure count reaches the threshold, roll back to 1.0.0.
  const d = decideBoot(root);
  assert.equal(d.version, '1.0.0');
  assert.deepEqual(d.disabledNow, ['2.0.0']);
  assert.ok(readState(root).disabledCores.includes('2.0.0'));
});

test('crash loop with no previous core falls back to base copy', () => {
  const root = freshRoot();
  stageCore(root, '2.0.0');
  activateCore(root, '2.0.0');
  for (let i = 0; i <= MAX_BOOT_FAILURES; i++) decideBoot(root);
  const d = decideBoot(root);
  assert.equal(d.coreDir, null);
  assert.equal(readState(root).activeCore, null);
});

test('disabled version is never re-activated by decideBoot', () => {
  const root = freshRoot();
  stageCore(root, '3.0.0');
  activateCore(root, '3.0.0');
  const disabled = disableActiveCore(root);
  assert.equal(disabled, '3.0.0');
  assert.equal(decideBoot(root).coreDir, null);
  assert.equal(decideBoot(root).coreDir, null);
});

test('activateCore rejects unstaged or malformed versions', () => {
  const root = freshRoot();
  assert.throws(() => activateCore(root, '9.9.9'), /not staged/);
  assert.throws(() => activateCore(root, '../escape'), /invalid core version/);
});

test('corrupt state.json is treated as empty state, not an error', () => {
  const root = freshRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'state.json'), '{not json');
  assert.equal(readState(root).activeCore, null);
  assert.equal(decideBoot(root).coreDir, null);
});

test('state with traversal version or missing package.json is rejected', () => {
  const root = freshRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'state.json'), JSON.stringify({ activeCore: '../../etc', disabledCores: 'x' }));
  assert.equal(readState(root).activeCore, null);

  stageCore(root, '4.0.0');
  activateCore(root, '4.0.0');
  rmSync(join(coreDirFor(root, '4.0.0'), 'package.json'));
  const d = decideBoot(root);
  assert.equal(d.coreDir, null);
  assert.deepEqual(d.disabledNow, ['4.0.0']);
});

test('prepareLaunch describes overlay env only when a core is active', () => {
  const root = freshRoot();
  const appRoot = join(tmp, 'app-root');
  const base = prepareLaunch(root, appRoot);
  assert.deepEqual(base.env, {});

  stageCore(root, '5.0.0');
  activateCore(root, '5.0.0');
  const ov = prepareLaunch(root, appRoot);
  assert.equal(ov.version, '5.0.0');
  assert.equal(ov.env.NEXUS_OVERLAY_CORE_DIR, coreDirFor(root, '5.0.0'));
  assert.equal(ov.env.NEXUS_APP_ROOT, appRoot);
});

// ---- resolve hook (real node child processes) ----

const registerFile = fileURLToPath(new URL('../dist/bootstrap/register.js', import.meta.url));
const registerUrl = pathToFileURL(registerFile).href;

function makeApp(name, { versionBody, depBody = "export default 'dep-from-base';\n" }) {
  const app = join(tmp, name, 'app');
  const nc = join(app, 'node_modules', 'nexus-coder', 'dist', 'src');
  mkdirSync(nc, { recursive: true });
  writeFileSync(join(app, 'node_modules', 'nexus-coder', 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version: '1.0.0', type: 'module' }));
  writeFileSync(join(nc, 'version.js'), "export const v = 'base';\n");
  writeFileSync(join(nc, 'base-only.js'), "export const v = 'base-only';\n");
  mkdirSync(join(app, 'node_modules', 'poc-dep'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'poc-dep', 'package.json'),
    JSON.stringify({ name: 'poc-dep', version: '1.0.0', type: 'module', exports: './index.js' }));
  writeFileSync(join(app, 'node_modules', 'poc-dep', 'index.js'), depBody);
  writeFileSync(join(app, 'index.js'), 'export {};\n');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));

  const coreDir = join(tmp, name, 'overlay-core');
  mkdirSync(join(coreDir, 'dist', 'src'), { recursive: true });
  writeFileSync(join(coreDir, 'package.json'), JSON.stringify({ name: 'nexus-coder', version: '2.0.0', type: 'module' }));
  if (versionBody !== undefined) {
    writeFileSync(join(coreDir, 'dist', 'src', 'version.js'), versionBody);
  }
  return { app, coreDir };
}

function runProbe({ app, coreDir }, specifier) {
  const probe = join(app, 'probe.mjs');
  writeFileSync(probe,
    `const m = await import(${JSON.stringify(specifier)});\nconsole.log(JSON.stringify({ v: m.v ?? null, dep: m.dep ?? null }));\n`);
  return spawnSync(process.execPath, ['--import', registerUrl, probe], {
    env: { ...process.env, NEXUS_OVERLAY_CORE_DIR: coreDir, NEXUS_APP_ROOT: app },
    encoding: 'utf8',
  });
}

test('hook: overlay file wins over base for nexus-coder/*', () => {
  const fx = makeApp('hook-overlay', {
    versionBody: "import depBase from 'poc-dep';\nexport const v = 'overlay';\nexport const dep = depBase;\n",
  });
  const r = runProbe(fx, 'nexus-coder/dist/src/version.js');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { v: 'overlay', dep: 'dep-from-base' });
});

test('hook: file missing from overlay falls back to base copy', () => {
  const fx = makeApp('hook-fallback', { versionBody: "export const v = 'overlay';\n" });
  const r = runProbe(fx, 'nexus-coder/dist/src/base-only.js');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).v, 'base-only');
});

test('hook: syntax error in overlay fails the process (caller must roll back)', () => {
  const fx = makeApp('hook-syntax', { versionBody: 'export const v = ;\n' });
  const r = runProbe(fx, 'nexus-coder/dist/src/version.js');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SyntaxError/);
});

test('hook: no env means no-op (base behaviour unchanged)', () => {
  const fx = makeApp('hook-noop', { versionBody: "export const v = 'overlay';\n" });
  const probe = join(fx.app, 'probe-noop.mjs');
  writeFileSync(probe, "const m = await import('nexus-coder/dist/src/version.js');\nconsole.log(m.v);\n");
  const env = { ...process.env };
  delete env.NEXUS_OVERLAY_CORE_DIR;
  delete env.NEXUS_APP_ROOT;
  const r = spawnSync(process.execPath, ['--import', registerUrl, probe], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'base');
});

test('syntax-error overlay: disableActiveCore reverts to base on next decision', () => {
  const root = freshRoot();
  stageCore(root, '6.0.0', 'export const = ;\n');
  activateCore(root, '6.0.0');
  assert.equal(disableActiveCore(root), '6.0.0');
  assert.equal(decideBoot(root).coreDir, null);
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8').includes('"6.0.0"'), true);
});
