/**
 * P0 regression tests — Constitution inheritance into sub-agents (§3.7).
 *
 * Verifies the Orchestrator → Executor → worker-params chain that carries the
 * project constitution into every sub-task explicitly (never via implicit
 * filesystem discovery in the child worker):
 *   - executor passes `constitution` into the runSubAgent request params
 *   - worker-param validation accepts the optional `constitution` field
 *     (and still rejects oversized / non-string values)
 *   - orchestrator forwards the constitution text to the executor
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { SubAgentExecutor } = await import(pathToFileURL(join(dist, 'agent', 'sub-agent', 'executor.js')));
const { OrchestratorAgent } = await import(pathToFileURL(join(dist, 'agent', 'sub-agent', 'orchestrator.js')));
const { validateWorkerParams } = await import(pathToFileURL(join(dist, 'shared', 'ipc-validation.js')));

const CONSTITUTION_SAMPLE = '[Project Constitution]\nNexus Desktop — project constitution under test.\n';

// ===========================================================================
// 1. Executor forwards `constitution` into runSubAgent params (§3.7)
// ===========================================================================

test('executor: runSubAgent request carries the constitution text when provided', async () => {
  const requests = [];
  const fakeWorker = {
    async request(method, params) {
      if (method === 'earlyInit' || method === 'startSession') return { ok: true };
      if (method === 'runSubAgent') {
        requests.push(params);
        return { output: 'done', tokenUsage: { prompt: 1, completion: 1 } };
      }
      return {};
    },
    stop() {},
  };

  const executor = new SubAgentExecutor(
    { maxConcurrent: 2 },
    () => fakeWorker,
    'dist/agent-worker.js',
  );

  const results = await executor.executeParallel(
    [
      {
        id: 't1',
        description: 'Task one',
        prompt: 'Do something',
        tools: ['read_media_file', 'query'],
        maxTurns: 5,
        timeoutMs: 5000,
      },
    ],
    'base-session',
    CONSTITUTION_SAMPLE,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'succeeded');
  assert.equal(requests.length, 1, 'runSubAgent called once');
  assert.equal(requests[0].constitution, CONSTITUTION_SAMPLE, 'constitution forwarded verbatim');
  assert.equal(requests[0].taskId, 't1');
});

test('executor: omits constitution param when none was provided (backward compatible)', async () => {
  const requests = [];
  const fakeWorker = {
    async request(method, params) {
      if (method === 'earlyInit' || method === 'startSession') return { ok: true };
      if (method === 'runSubAgent') {
        requests.push(params);
        return { output: 'ok', tokenUsage: { prompt: 0, completion: 0 } };
      }
      return {};
    },
    stop() {},
  };
  const executor = new SubAgentExecutor({ maxConcurrent: 1 }, () => fakeWorker, 'dist/agent-worker.js');
  await executor.executeParallel(
    [{ id: 't1', description: 'T', prompt: 'P', tools: [], maxTurns: 3, timeoutMs: 3000 }],
    'base',
  );
  assert.equal(requests.length, 1);
  assert.equal('constitution' in requests[0], false, 'no constitution key when absent');
});

// ===========================================================================
// 2. Worker param validation accepts the optional constitution field
// ===========================================================================

test('ipc-validation: constitution accepted as an optional string (cap 32 KB)', () => {
  const err = validateWorkerParams('runSubAgent', {
    taskId: 't1',
    prompt: 'P',
    constitution: CONSTITUTION_SAMPLE,
  });
  assert.equal(err, null, 'valid constitution passes validation');
});

test('ipc-validation: oversized constitution rejected (> 32 KB, no silent bloat)', () => {
  const err = validateWorkerParams('runSubAgent', {
    taskId: 't1',
    prompt: 'P',
    constitution: 'x'.repeat(32 * 1024 + 1),
  });
  assert.ok(err, 'oversized constitution rejected');
  assert.match(err, /constitution/i);
});

test('ipc-validation: non-string constitution rejected', () => {
  const err = validateWorkerParams('runSubAgent', {
    taskId: 't1',
    prompt: 'P',
    constitution: 12345,
  });
  assert.ok(err, 'non-string rejected');
});

test('ipc-validation: missing constitution is fine (method unchanged)', () => {
  assert.equal(validateWorkerParams('runSubAgent', { taskId: 't1', prompt: 'P' }), null);
});

// ===========================================================================
// 3. Orchestrator forwards constitution to the executor (§3.7)
// ===========================================================================

test('orchestrator: passes the constitution text into executeParallel', async () => {
  let received = null;
  const resultsPromise = Promise.resolve([
    { taskId: 't1', status: 'succeeded', output: 'ok', tokenUsage: { prompt: 0, completion: 0 }, durationMs: 1 },
  ]);
  const fakeExecutor = {
    executeParallel: async (_tasks, _sid, constitutionText) => {
      received = constitutionText;
      return resultsPromise;
    },
  };
  // OrchestratorAgent delegates to a SubAgentExecutor it constructs internally.
  // Use a minimal instance: we only assert the public orchestrate() forwards.
  const orch = new OrchestratorAgent(null, {});
  // Swap the real executor for the probe (private field on the compiled class).
  orch.executor = fakeExecutor;

  const result = await orch.orchestrate('Do it', 'session-1', CONSTITUTION_SAMPLE);
  assert.equal(received, CONSTITUTION_SAMPLE, 'orchestrator forwarded constitution');
  assert.equal(result.success, true);
});