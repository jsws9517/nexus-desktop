/**
 * P2 contract verification: the desktop ⇄ core no-dependency contract.
 *
 * The core exports three pure-data lists through the facade
 * (`nexus-coder/dist/src/desktop-api.js` -> `dist/src/contract.js`):
 * AGENT_EVENT_TYPES, WORKER_METHODS, CORE_TOOL_NAMES. These tests assert
 * the desktop's own copies/still-hold:
 *
 *  1. event coverage — every core event type is either explicitly handled
 *     by `handleAgentEvent` or named in the passthrough justification list;
 *  2. worker RPC — the desktop's `WORKER_METHODS` spec map keys match the
 *     contract list exactly (both directions);
 *  3. tool names — every core tool name the desktop hard-codes still
 *     exists in the core's tool surface;
 *  4. facade symbol snapshot — the facade's runtime value surface is
 *     pinned (a silent symbol removal fails here, and at compile time for
 *     the desktop's TS imports).
 *
 * Drift in the core that misses this suite is a failing test here, not a
 * runtime crash in a shipped app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FACADE = 'nexus-coder/dist/src/desktop-api.js';

const serviceSrc = fs.readFileSync('src/agent/service.ts', 'utf8');
const ipcValidationSrc = fs.readFileSync('src/shared/ipc-validation.ts', 'utf8');

/** Event types `handleAgentEvent` branches on (feeds the turn monitors). */
function handledEventTypes(src) {
  const out = new Set();
  for (const m of src.matchAll(/event\.type === '([a-z_0-9]+)'/g)) out.add(m[1]);
  return out;
}

/**
 * Events that pass through `handleAgentEvent` untouched (forwarded to the UI
 * via `this.onEvent`). Each entry MUST carry a reason: an event the desktop
 * neither monitors nor explains is exactly the drift this suite exists to
 * catch.
 */
const KNOWN_PASSTHROUGH = new Set([
  'thinking_closed',      // UI renders the thinking-block close marker
  'session_start',        // UI session banner
  'session_end',          // UI session banner
  'turns_exhausted',      // surfaced by the UI's turn-limit notice
  'steer_applied',        // logged + UI notice only; monitor state is turn-scoped
  'rollback_applied',     // destructive op already confirmed up-front (UI card)
  'rollback_restored',    // UI reloads the transcript
  'tool_call_dropped',    // degraded-echo family; repetition guard sees the result
  'degenerate_echo',      // logged for diagnosis; no monitor consumes it
  'security_blocked',     // the sentinel's own log path already reported it
  'file_ready',           // media files: UI file-card bridge, not a monitor input
  'bg_job_event',         // JobWatcher owns background-job state, not the monitors
  'media_task_event',     // async media-task UI card, not a monitor input
  'subagent_status',      // sub-agent progress card in the UI
  'task_graph',           // task-graph DAG rendering in the UI
  'task_started',         // task-family UI cards
  'task_interrupted',     // task-family UI cards
  'task_failed',          // task-family UI cards
  'task_completed',       // task-family UI cards
]);

function toolNamesInBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = src.indexOf('\n]);', start);
  assert.ok(end !== -1, `block terminator not found after ${startMarker}`);
  return [...src.slice(start, end).matchAll(/'([a-z_0-9.]+)'/g)].map((m) => m[1]);
}

test('facade exposes the three contract lists as arrays', async () => {
  const facade = await import(FACADE);
  for (const name of ['AGENT_EVENT_TYPES', 'WORKER_METHODS', 'CORE_TOOL_NAMES']) {
    assert.ok(Array.isArray(facade[name]), `${name} must be an array`);
    assert.ok(facade[name].length > 0, `${name} must not be empty`);
    assert.ok(
      new Set(facade[name]).size === facade[name].length,
      `${name} must contain no duplicates`,
    );
    assert.ok(facade[name].every((s) => typeof s === 'string' && s.length > 0),
      `${name} entries must be non-empty strings`);
  }
});

test('handleAgentEvent covers every core event type (handled or explicitly passed through)', async () => {
  const facade = await import(FACADE);
  const handled = handledEventTypes(serviceSrc);

  // 1. Every core event is accounted for.
  const unaccounted = facade.AGENT_EVENT_TYPES.filter(
    (t) => !handled.has(t) && !KNOWN_PASSTHROUGH.has(t),
  );
  assert.deepEqual(
    unaccounted,
    [],
    `core event types with no desktop handler and no passthrough justification: ${unaccounted.join(', ')}`,
  );

  // 2. The passthrough list is itself honest: no stale entries (handled or
  //    no longer emitted by the core) may linger in it.
  const stale = [...KNOWN_PASSTHROUGH].filter((t) => handled.has(t));
  assert.deepEqual(stale, [],
    `passthrough entries that handleAgentEvent actually handles: ${stale.join(', ')} — move them out of the list`);
  const gone = [...KNOWN_PASSTHROUGH].filter((t) => !facade.AGENT_EVENT_TYPES.includes(t));
  assert.deepEqual(gone, [],
    `passthrough entries the core no longer emits: ${gone.join(', ')} — the list drifted`);
});

test('desktop WORKER_METHODS spec map matches the contract list exactly', async () => {
  const facade = await import(FACADE);
  const start = ipcValidationSrc.indexOf('export const WORKER_METHODS = {');
  assert.ok(start !== -1, 'WORKER_METHODS spec map not found in ipc-validation.ts');
  const end = ipcValidationSrc.indexOf('\n} satisfies Record<string, MethodSpec>;', start);
  assert.ok(end !== -1, 'WORKER_METHODS block terminator not found');
  const block = ipcValidationSrc.slice(start, end);
  // Every spec entry is two-space-indented `  <name>: {` (nested keys sit at
  // four spaces, so the indent alone is the discriminator).
  const desktopKeys = [...block.matchAll(/^ {2}([a-zA-Z]\w*): \{/gm)].map((m) => m[1]);
  assert.ok(desktopKeys.length >= 50,
    `expected ~62 worker methods, extracted ${desktopKeys.length} — the spec map layout must have changed`);

  const contract = new Set(facade.WORKER_METHODS);
  const desktop = new Set(desktopKeys);
  const missingOnDesktop = [...contract].filter((m) => !desktop.has(m));
  const extraOnDesktop = [...desktop].filter((m) => !contract.has(m));
  assert.deepEqual(missingOnDesktop, [],
    `worker methods declared by the core contract but missing from the desktop spec map: ${missingOnDesktop.join(', ')}`);
  assert.deepEqual(extraOnDesktop, [],
    `desktop spec-map methods absent from the core contract (add them to core src/contract.ts): ${extraOnDesktop.join(', ')}`);
});

test('every hard-coded core tool name the desktop references is a real core tool', async () => {
  const facade = await import(FACADE);
  const contract = new Set(facade.CORE_TOOL_NAMES);

  // The delegation tool set is hard-coded in service.ts: a renamed/removed
  // spawn/acp tool would silently stop earning its outcome log line.
  const delegation = toolNamesInBlock(serviceSrc, 'const DELEGATION_TOOLS');
  const badDelegation = delegation.filter((n) => !contract.has(n));
  assert.deepEqual(badDelegation, [],
    `DELEGATION_TOOLS names that are no longer core tools: ${badDelegation.join(', ')}`);

  // Prompt-fix canaries: the desktop's [Desktop Prompt Fixes] block tells the
  // model to call these names; each must still exist in the core.
  for (const name of ['generate_image', 'generate_video', 'media_task', 'bg_job']) {
    assert.ok(contract.has(name), `prompt-referenced tool "${name}" is missing from the core contract`);
  }
});

test('facade runtime value surface matches the checked-in snapshot', async () => {
  const facade = await import(FACADE);
  const snapshot = JSON.parse(
    fs.readFileSync('test/fixtures/desktop-api-snapshot.json', 'utf8'),
  );
  const keys = Object.keys(facade).sort();
  const missing = snapshot.exports.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !snapshot.exports.includes(k));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `facade value surface drifted from test/fixtures/desktop-api-snapshot.json ` +
      `(missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}). ` +
      'If the change is deliberate, regenerate the snapshot from this message.',
  );
});
