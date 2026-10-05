import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const repoRoot = join(__dirname, '..');

const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));
const { WORKER_METHODS } = await import(pathToFileURL(join(repoRoot, 'dist', 'shared', 'ipc-validation.js')));

/** Minimal Agent stand-in exposing only what initAcp touches. */
function fakeAgent(agentIds, calls) {
  return {
    config: { getAcpConfig: () => ({ agents: agentIds.map((id) => ({ id })) }) },
    /**
     * The single ACP entry point. Note it carries NO `acp` field of its own:
     * initAcp must go through the core's entry point, which is what registers
     * *and* attaches the engines watcher. Reaching for `agent.acp.start()`
     * directly is exactly the bug this guards — a session worker would get a
     * one-shot snapshot and never see a later engines.json edit.
     */
    ensureAcpRegistered: async function () {
      calls.push({ via: 'ensureAcpRegistered', agents: agentIds.length });
      this.acp = {
        start: async () => { calls.push({ via: 'acp.start' }); },
        listAgents: () => agentIds.map((id) => ({ id })),
        isEnabled: () => true,
      };
      return agentIds;
    },
    get acp() {
      return this._acp;
    },
    set acp(v) {
      this._acp = v;
    },
    _acp: undefined,
  };
}

function makeService(agentIds) {
  const calls = [];
  const svc = Object.create(AgentService.prototype);
  svc.agent = fakeAgent(agentIds, calls);
  svc.earlyInit = async () => {};
  return { svc, calls };
}

// ---------------------------------------------------------------------------
// initAcp: the registration step isolated from Agent.init()
// ---------------------------------------------------------------------------

test('initAcp registers the ACP agents and returns their ids', async () => {
  // The bug: the core calls acp.start() from inside Agent.init(), and session
  // workers never run init — only earlyInit — so their registry stayed empty and
  // every acp_route call failed with "Agent <id> not found" while the global
  // worker, which does run init, worked. Same request, different tab, different
  // outcome.
  const { svc, calls } = makeService(['qwen', 'opencode', 'claude', 'kimi']);
  const ids = await svc.initAcp();
  assert.deepEqual(ids, ['qwen', 'opencode', 'claude', 'kimi']);
  assert.deepEqual(
    calls,
    [{ via: 'ensureAcpRegistered', agents: 4 }],
    'initAcp must go through the core entry point, which registers and watches',
  );
});

test('initAcp does not require a full init', async () => {
  // It must stay the cheap path: skills loading in Agent.init() is the 10-20s
  // cost session workers deliberately avoid, so initAcp may only touch the ACP
  // protocol. Assert it never reaches for the full core init.
  const src = readFileSync(join(dist, 'agent', 'service.js'), 'utf8');
  const body = src.match(/async initAcp\(\)\s*\{[\s\S]*?\n {4}\}/);
  assert.ok(body, 'could not locate initAcp in the built output');
  // Strip line comments first: the method explains the old failure in prose, and
  // that prose mentions acp.start(), which the assertion below forbids.
  const code = body[0]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.ok(!/\bagent\.init\(/.test(code), 'initAcp must not call the core Agent.init()');
  assert.ok(!/\bskills\b/.test(code), 'initAcp must not touch the skills registry');
  assert.ok(
    /ensureAcpRegistered\(/.test(code),
    'initAcp must use the core entry point that also attaches the engines watcher',
  );
  assert.ok(
    !/acp\.start\(/.test(code),
    'calling acp.start() directly registers a one-shot snapshot with no watcher',
  );
});

test('initAcp tolerates an absent ACP config instead of throwing', async () => {
  // A worker with acp.enabled=false has no resolved agents. Delegation is simply
  // unavailable there; that must not take the tab down.
  const svc = Object.create(AgentService.prototype);
  let entries = 0;
  svc.agent = {
    config: { getAcpConfig: () => null },
    ensureAcpRegistered: async () => {
      entries += 1;
      return [];
    },
  };
  svc.earlyInit = async () => {};
  assert.deepEqual(await svc.initAcp(), []);
  assert.equal(entries, 1);
});

// ---------------------------------------------------------------------------
// Wiring: every worker that serves chat must have run it
// ---------------------------------------------------------------------------

test('initAcp is a declared worker method', () => {
  assert.ok('initAcp' in WORKER_METHODS, 'initAcp must be in WORKER_METHODS to be routed');
  assert.deepEqual(WORKER_METHODS.initAcp.fields, {}, 'initAcp takes no params');
});

test('the worker dispatches initAcp', () => {
  const src = readFileSync(join(dist, 'agent-worker.js'), 'utf8');
  assert.ok(/initAcp:\s*async/.test(src), 'agent-worker must handle initAcp');
  assert.ok(/service\.initAcp\(/.test(src), 'the handler must delegate to the service');
});

test('every session-worker start path runs initAcp', () => {
  // Three entry points create a worker that can serve chat: the pre-warmed
  // spare, open(), and openNew(). Registering on only some leaves delegation
  // broken on whichever path was taken, and that is invisible because the
  // failure is per-worker — the same request succeeds in one tab and fails in
  // another. Counted, not enumerated, so a new start path cannot skip this.
  const src = readFileSync(join(dist, 'main', 'session-workers.js'), 'utf8');
  const starts = src.match(/request\('earlyInit'/g) ?? [];
  const acp = src.match(/request\('initAcp'/g) ?? [];
  assert.ok(starts.length >= 3, `expected at least 3 earlyInit call sites, found ${starts.length}`);
  assert.equal(
    acp.length,
    starts.length,
    `every earlyInit start path needs initAcp: ${starts.length} start paths, ${acp.length} registrations`,
  );
});

test('the global worker still registers through the full init', () => {
  // The full init path must keep working — initAcp is additive, not a
  // replacement, and init() calls acp.start() first so a double start is a no-op.
  const src = readFileSync(join(dist, 'main', 'index.js'), 'utf8');
  assert.ok(/request\('init'/.test(src), 'the global worker must still request init');
});