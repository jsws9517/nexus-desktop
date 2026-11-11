/**
 * T6 automation IPC — negative validation, store status, and second-instance
 * non-trigger tests.
 *
 * All 5 automation IPC channels (automationList/Upsert/Delete/RunNow/Runs)
 * are main-process-owned (no worker round-trip). The negative validation tests
 * use `validateAutomationParams` from the single-source spec map. The store
 * tests use a temp NEXUS_CONFIG_DIR so no real ~/.nexus data is touched.
 *
 * Second-instance non-trigger is asserted structurally: the app uses
 * requestSingleInstanceLock() and the second-instance handler calls only
 * showMainWindow(), never startAutomationRunner() — verified by source scan.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const coreDist = join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src');

// Isolate automation.db under a temp dir so no real ~/.nexus data is touched.
// NEXUS_CONFIG_DIR is read at call time by paths.nativeData(), so set it before
// any import that instantiates a store.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-aut-ipc-'));
process.env.NEXUS_CONFIG_DIR = tmp;

// Validate params against the single-source spec map.
const { validateAutomationParams } = await import(
  pathToFileURL(join(dist, 'shared', 'ipc-validation.js'))
);

// ─────────────────────────────────────────────────────────────────────────────
// 1. automationList — no params (fields: {}); any junk rejected
// ─────────────────────────────────────────────────────────────────────────────
test('automationList: no params accepted', () => {
  assert.equal(validateAutomationParams('automationList'), null);
  assert.equal(validateAutomationParams('automationList', {}), null);
});

test('automationList: unknown method rejected', () => {
  assert.match(
    validateAutomationParams('automationListX', {}) ?? '',
    /unknown automation method/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. automationUpsert — required: name, schedule, prompt
// ─────────────────────────────────────────────────────────────────────────────
test('automationUpsert: missing name rejected', () => {
  const err = validateAutomationParams('automationUpsert', {
    prompt: 'x',
    schedule: { type: 'cron', expr: '* * * * *' },
  });
  assert.match(err ?? '', /missing required param: name/);
});

test('automationUpsert: missing schedule rejected', () => {
  const err = validateAutomationParams('automationUpsert', {
    name: 'test',
    prompt: 'x',
  });
  assert.match(err ?? '', /missing required param: schedule/);
});

test('automationUpsert: missing prompt rejected', () => {
  const err = validateAutomationParams('automationUpsert', {
    name: 'test',
    schedule: { type: 'cron', expr: '* * * * *' },
  });
  assert.match(err ?? '', /missing required param: prompt/);
});

test('automationUpsert: name too long rejected', () => {
  const err = validateAutomationParams('automationUpsert', {
    name: 'x'.repeat(201),
    prompt: 'x',
    schedule: { type: 'cron', expr: '* * * * *' },
  });
  assert.match(err ?? '', /exceeds max length 200/);
});

test('automationUpsert: prompt too long rejected', () => {
  const err = validateAutomationParams('automationUpsert', {
    name: 'ok',
    prompt: 'x'.repeat(65537),
    schedule: { type: 'cron', expr: '* * * * *' },
  });
  assert.match(err ?? '', /exceeds max length 65536/);
});

test('automationUpsert: invalid profile enum rejected', () => {
  const err = validateAutomationParams('automationUpsert', {
    name: 'ok',
    prompt: 'x',
    schedule: { type: 'cron', expr: '* * * * *' },
    profile: 'nonexistent',
  });
  assert.match(err ?? '', /must be one of/);
});

test('automationUpsert: valid params accepted', () => {
  assert.equal(
    validateAutomationParams('automationUpsert', {
      name: 'ok',
      prompt: 'x',
      schedule: { type: 'cron', expr: '0 9 * * 1', tz: 'Asia/Shanghai' },
      profile: 'office',
      missPolicy: 'catchup',
      enabled: true,
    }),
    null,
  );
});

test('automationUpsert: interval schedule accepted', () => {
  assert.equal(
    validateAutomationParams('automationUpsert', {
      name: 'ok',
      prompt: 'x',
      schedule: { type: 'interval', everyMs: 3600000 },
    }),
    null,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. automationDelete — required: id (string ≤ 64)
// ─────────────────────────────────────────────────────────────────────────────
test('automationDelete: missing id rejected', () => {
  assert.match(validateAutomationParams('automationDelete', {}) ?? '', /missing required param: id/);
});

test('automationDelete: non-string id rejected', () => {
  assert.equal(validateAutomationParams('automationDelete', { id: 42 }), 'params.id must be a string');
});

test('automationDelete: id too long rejected', () => {
  assert.match(
    validateAutomationParams('automationDelete', { id: 'x'.repeat(65) }) ?? '',
    /exceeds max length 64/,
  );
});

test('automationDelete: valid id accepted', () => {
  assert.equal(validateAutomationParams('automationDelete', { id: 'aut_abc123' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. automationRunNow — required: id (string ≤ 64)
// ─────────────────────────────────────────────────────────────────────────────
test('automationRunNow: missing id rejected', () => {
  assert.match(validateAutomationParams('automationRunNow', {}) ?? '', /missing required param: id/);
});

test('automationRunNow: valid id accepted', () => {
  assert.equal(validateAutomationParams('automationRunNow', { id: 'aut_abc123' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. automationRuns — optional: id, limit
// ─────────────────────────────────────────────────────────────────────────────
test('automationRuns: no params accepted', () => {
  assert.equal(validateAutomationParams('automationRuns'), null);
  assert.equal(validateAutomationParams('automationRuns', {}), null);
});

test('automationRuns: limit must be a number', () => {
  assert.equal(validateAutomationParams('automationRuns', { limit: '5' }), 'params.limit must be a finite number');
});

test('automationRuns: valid params accepted', () => {
  assert.equal(
    validateAutomationParams('automationRuns', { id: 'aut_abc', limit: 10 }),
    null,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Store status: interrupted ≠ failed (roadmap acceptance criterion)
// ─────────────────────────────────────────────────────────────────────────────
test('store: interrupted status is distinct from failed', async () => {
  const { AutomationStore } = await import(pathToFileURL(join(coreDist, 'automation', 'store.js')));
  const store = new AutomationStore(join(tmp, 'interrupt-test.db'));

  const now = Date.now();
  const aut = {
    id: 'aut_int',
    name: 'interrupt test',
    enabled: true,
    schedule: { type: 'interval', everyMs: 3600_000 },
    prompt: 'test prompt',
    profile: 'default',
    createdAt: now,
    updatedAt: now,
  };
  store.insert(aut);

  // Start a run, then mark it interrupted (what interruptRunningRuns does on quit).
  const runId = 'run_int_test_001';
  store.startRun({
    id: runId,
    automationId: 'aut_int',
    status: 'pending',
    startedAt: now,
  });
  store.finishRun(runId, 'interrupted', { error: 'app quit while run in progress' });

  const runs = store.listRuns('aut_int', 10);
  const target = runs.find((r) => r.id === runId);
  assert.ok(target, 'run row exists');
  assert.equal(target.status, 'interrupted');
  assert.notEqual(target.status, 'failed');

  // The store must expose 'interrupted' as a first-class status in the
  // lastCompletedRunAt query (so the runner can use it for cold-start
  // missed-window detection without re-firing an interrupted run).
  const lastAt = store.lastCompletedRunAt('aut_int');
  assert.equal(typeof lastAt, 'number', 'interrupted run counts as completed for next-fire');

  store.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Second-instance non-trigger (structural source scan)
// ─────────────────────────────────────────────────────────────────────────────
test('second-instance: source never calls startAutomationRunner in second-instance handler', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  // Find the actual handler body (between the second-instance app.on line and
  // the closing brace+semicolon) and check it does not contain a bare call
  // to startAutomationRunner. Comments mentioning it are fine.
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l.includes("app.on('second-instance'"));
  assert.ok(startIdx >= 0, 'second-instance handler found in source');
  // Collect handler body lines until we hit the closing `});`
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].includes('});')) { endIdx = i; break; }
  }
  const handlerBody = lines.slice(startIdx, endIdx + 1).join('\n');
  // Remove comment lines so only executable code is checked.
  const codeLines = handlerBody
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.ok(
    !codeLines.includes('startAutomationRunner('),
    'second-instance handler must not call startAutomationRunner()',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. automation worker is not registered in SessionWorkers (tab table invariant)
// ─────────────────────────────────────────────────────────────────────────────
test('automation worker: not in SessionWorkers or resource monitor', () => {
  const runnerSrc = readFileSync(join(__dirname, '..', 'src', 'main', 'automation-runner.ts'), 'utf8');
  // The runner tracks in-flight workers in its own map, never in SessionWorkers
  // or the resource monitor.
  assert.ok(!runnerSrc.includes('sessionWorkers'), 'automation-runner.ts must not touch sessionWorkers');
  assert.ok(!runnerSrc.includes('resourceMon'), 'automation-runner.ts must not touch resourceMon');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Protocol gate: nexusDesktopProtocol === DESKTOP_PROTOCOL_FALLBACK
// ─────────────────────────────────────────────────────────────────────────────
test('protocol: nexusDesktopProtocol matches fallback constant', async () => {
  const proto = await import(pathToFileURL(join(dist, 'core-overlay', 'protocol.js')));
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(
    pkg.nexusDesktopProtocol,
    proto.DESKTOP_PROTOCOL_FALLBACK,
    'nexusDesktopProtocol must equal DESKTOP_PROTOCOL_FALLBACK',
  );
});

// ── cleanup ──────────────────────────────────────────────────────────────────
after(async () => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  delete process.env.NEXUS_CONFIG_DIR;
});
