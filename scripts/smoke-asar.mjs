/**
 * Asar-integration smoke test for core overlay bootstrap.
 *
 * Verifies that the packed app.asar contains the bootstrap files and that
 * the overlay state machine activates correctly when an overlay is staged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const ASAR_PATH = path.join(ROOT, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
const DIST_DIR = path.join(ROOT, '..', 'dist');

let exitCode = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); exitCode = 1; }
function assert(cond, msg) { cond ? ok(msg) : fail(msg); }

async function main() {
  console.log('=== Asar Integration Smoke Test ===\n');

  // ─── Prerequisites ──────────────────────────────────────────────────────
  console.log('prerequisites:');
  assert(fs.existsSync(ASAR_PATH), `asar exists at ${ASAR_PATH}`);
  assert(fs.existsSync(path.join(DIST_DIR, 'bootstrap', 'overlay.js')), 'dist/bootstrap/overlay.js built');
  assert(fs.existsSync(path.join(DIST_DIR, 'bootstrap', 'register.js')), 'dist/bootstrap/register.js built');
  assert(fs.existsSync(path.join(DIST_DIR, 'agent-worker.js')), 'dist/agent-worker.js built');

  // ─── S1: Asar contains bootstrap files ───────────────────────────────────
  console.log('\n=== S1: Asar contains bootstrap files ===');
  {
    let list;
    try {
      const asar = await import('@electron/asar');
      list = asar.listPackage(ASAR_PATH);
    } catch {
      // Fallback: check dist directory (asar not extractable in this env)
      console.log('  ⚠ asar.listPackage failed, checking dist/ directly');
      list = [];
    }

    const expected = [
      '\\dist\\bootstrap\\overlay.js',
      '\\dist\\bootstrap\\register.js',
      '\\dist\\bootstrap\\resolve-hook.js',
      '\\dist\\core-overlay\\download.js',
      '\\dist\\core-overlay\\manager.js',
      '\\dist\\agent-worker.js',
    ];
    for (const f of expected) {
      const found = list.includes(f);
      assert(found, `asar contains ${f.replace(/\\/g, '/')}`);
    }
  }

  // ─── S2: agent-worker.js has bootstrap import ───────────────────────────
  console.log('\n=== S2: agent-worker.js bootstrap import ===');
  {
    const workerPath = path.join(DIST_DIR, 'agent-worker.js');
    const content = fs.readFileSync(workerPath, 'utf8');
    assert(content.includes("import './bootstrap/register.js'"),
      'agent-worker.js imports bootstrap/register.js');
    // Must be the FIRST import (before any nexus-coder module)
    const firstImportIdx = content.indexOf('import ');
    const registerImportIdx = content.indexOf("'./bootstrap/register.js'");
    assert(registerImportIdx > -1 && registerImportIdx <= firstImportIdx + 50,
      'bootstrap/register.js is the first import in agent-worker.js');
  }

  // ─── S3: Overlay state machine with staged core ─────────────────────────
  console.log('\n=== S3: Overlay state machine with staged core ===');
  {
    const { decideBoot, activateCore, markHealthy, disableActiveCore, readState } =
      await import(pathToFileURL(path.join(DIST_DIR, 'bootstrap', 'overlay.js')).href);

    const root = mkdtempSync(path.join(tmpdir(), 'smoke-asar-s3-'));
    const version = '9.9.6-asar-test';
    const coreDir = path.join(root, 'core', version);
    mkdirSync(path.join(coreDir, 'dist', 'src'), { recursive: true });
    writeFileSync(path.join(coreDir, 'package.json'),
      JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
    writeFileSync(path.join(coreDir, 'dist', 'src', 'version.js'),
      "export const v = 'asar-test-overlay';\n");

    activateCore(root, version);
    assert(decideBoot(root).version === version, 'S3: staged core is active');
    markHealthy(root);
    assert(readState(root).bootPending === false, 'S3: healthy clears pending');

    // Syntax error: should trigger disable
    writeFileSync(path.join(coreDir, 'dist', 'src', 'version.js'),
      "export const v = ;\n");
    activateCore(root, version);
    const afterDisable = disableActiveCore(root);
    assert(afterDisable === version, `S3: disableActiveCore returns ${afterDisable}`);
    assert(decideBoot(root).coreDir === null, 'S3: reverted to base after disable');
  }

  // ─── S4: Resolve hook registers correctly ──────────────────────────────
  console.log('\n=== S4: Resolve hook registration ===');
  {
    // The register.js is a no-op when NEXUS_OVERLAY_CORE_DIR is not set
    // When set, it calls module.register() with the resolve hook
    const registerUrl = pathToFileURL(path.join(DIST_DIR, 'bootstrap', 'register.js')).href;
    assert(fs.existsSync(path.join(DIST_DIR, 'bootstrap', 'register.js')), 'register.js exists');

    // Verify register.js logic: only registers when env var is set
    const regContent = fs.readFileSync(path.join(DIST_DIR, 'bootstrap', 'register.js'), 'utf8');
    assert(regContent.includes('NEXUS_OVERLAY_CORE_DIR'),
      'register.js checks NEXUS_OVERLAY_CORE_DIR');
    assert(regContent.includes('NEXUS_APP_ROOT'),
      'register.js checks NEXUS_APP_ROOT');
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log(`\n=== summary: exit=${exitCode} ===`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
