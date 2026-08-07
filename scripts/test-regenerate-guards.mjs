// Test for AgentService.regenerate guard paths (no LLM call) under system node.
// Verifies the orchestration through the real compiled service: init + startSession
// + regenerate on an empty / wrong session must throw BEFORE chat() runs.
// Usage: node scripts/test-regenerate-guards.mjs
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function expect(cond, label) {
  if (cond) console.log(`PASS: ${label}`);
  else { failures++; console.log(`FAIL: ${label}`); }
}

async function expectThrow(promise, pattern, label) {
  let threw = false;
  let msg = '';
  try {
    await promise;
  } catch (err) {
    threw = true;
    msg = err.message;
  }
  expect(threw && pattern.test(msg), `${label} (got: ${msg || 'no error'})`);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'nexus-regen-guard-'));
const nexusDir = join(tempRoot, '.nexus');
mkdirSync(nexusDir, { recursive: true });
process.env.LLMA_DATA_DIR = tempRoot;
console.log(`temp data dir: ${tempRoot}`);

const { AgentService } = await import(new URL('../dist/agent-service.js', import.meta.url).href);

const svc = new AgentService();
svc.onLog = (level, msg) => console.log(`[${level}] ${msg}`);

await svc.init();
console.log('init ok');

const sid = await svc.startSession();
console.log(`session ${sid}`);

await expectThrow(svc.regenerate(sid, 0), /no user message at index 0/, 'empty session throws before chat()');
await expectThrow(svc.regenerate('missing-session', 0), /Session mismatch/, 'wrong session throws Session mismatch');

await svc.shutdown();
try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
console.log(failures === 0 ? '\nGUARD TEST: ALL PASS' : `\nGUARD TEST: FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
