/**
 * Minimal worker for scenario4 of smoke-overlay-v2.mjs.
 * Loaded by electronProbe via utilityProcess.fork into the main process started
 * from scripts/smoke-e2e-main.cjs.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.POC_ROOT || 'D:/agent-cli/nexus-desktop';
// Static import so the resolve hook is registered before any nexus-coder module loads.
await import(pathToFileURL(join(REPO_ROOT, 'dist', 'bootstrap', 'register.js')).href);

const resultFile = process.env.POC_RESULT_FILE;
let v = null;
let err = null;
try {
  const m = await import('nexus-coder/dist/src/test.js');
  v = m.v ?? null;
} catch (e) {
  err = e.message;
}
// Write to file as backup in case IPC is lost.
writeFileSync(resultFile, JSON.stringify({ v, err, core: process.env.NEXUS_OVERLAY_CORE_DIR }));
// Send result via parentPort when available (utilityProcess/Worker context).
if (process.parentPort) {
  process.parentPort.postMessage({ v, err, core: process.env.NEXUS_OVERLAY_CORE_DIR });
}
console.error(`worker done v=${v} err=${err}`);
