/**
 * Regression tests — desktop background-job auto-continue (wake turns).
 *
 * The reported gap: on desktop, a finished background job only ANNOUNCED its
 * result (bg_job_event + a text summary); the agent itself was never woken,
 * so the conversation stalled until the user nudged it. The CLI wires a
 * JobWatcher behind config `wake.enabled` (default OFF, opt-in); the desktop
 * host wires the SAME watcher but defaults ON (AgentService.attachJobWatcher),
 * honoring an explicit opt-out (config wake.enabled:false or NEXUS_WAKE_ENABLED
 * =0/false). Cooldown / rate / stall params still come from the shared wake
 * config.
 *
 * Covered here (worker side, against the compiled dist):
 *   - a completed job fires exactly one wake turn through runTurn() (the same
 *     choke point as user turns), with the guard + job label in the prompt;
 *   - terminal completion text is NOT duplicated by the watcher (the agent's
 *     own manager listener already announced it);
 *   - progress / stalled rule lines surface as text events, but stalled does
 *     NOT wake (default kinds = succeeded+failed);
 *   - a busy agent defers the wake; it fires once idle;
 *   - an explicit config wake.enabled:false disables the desktop default;
 *   - the hourly ledger (6/hour) caps wake turns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));

/** Either locale's wake_turn_guard marker (worker i18n language is config-driven). */
const GUARD_RE = /Background job wake|后台作业唤醒/;

function fakeJob(status = 'succeeded', label = 'npm test') {
  const now = Date.now();
  return {
    id: 'bg_test',
    label,
    command: 'npm test',
    status,
    pid: 4242,
    startedAt: now - 10_000,
    finishedAt: status === 'succeeded' ? now : undefined,
    exitCode: status === 'succeeded' ? 0 : 1,
    logFile: 'C:\\logs\\bg_test.log',
    logBytes: 1024,
  };
}

function makeService({ busy = false, wakeConfigOverride, wakeNode, getWakeConfig } = {}) {
  let busyNow = busy;
  const svc = new AgentService();
  svc.agent = {
    isBusy: () => busyNow,
    config: {
      getWakeConfig: () => getWakeConfig ?? {
        enabled: false, // core default — the desktop host flips it ON
        cooldownMs: wakeConfigOverride?.cooldownMs ?? 60_000,
        maxTurnsPerHour: wakeConfigOverride?.maxTurnsPerHour ?? 6,
        kinds: wakeConfigOverride?.kinds ?? ['succeeded', 'failed'],
        stallAlertMs: wakeConfigOverride?.stallAlertMs ?? 600_000,
      },
      get: () => (wakeNode !== undefined ? { wake: wakeNode } : {}),
    },
  };
  const events = [];
  const wakePrompts = [];
  svc.onEvent = (e) => events.push(e);
  svc.onLog = () => {};
  svc.runTurn = async (input) => {
    wakePrompts.push(input);
    return { prompt: 0, completion: 0 };
  };
  return {
    svc,
    events,
    wakePrompts,
    setBusy: (v) => { busyNow = v; },
    /** Attach the watcher through the real (private) method. */
    attach: (mgr) => svc.attachJobWatcher(mgr),
    /** Flush fire-and-forget wake turns (manager -> watcher -> runTurn is async). */
    flush: async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

test('a completed bg job auto-continues: one wake turn through runTurn (desktop default ON)', async () => {
  const h = makeService();
  const mgr = new EventEmitter();
  h.attach(mgr);
  mgr.emit('event', { type: 'completed', job: fakeJob('succeeded') });
  await h.flush();

  assert.equal(h.wakePrompts.length, 1, 'exactly one wake turn for one completion');
  assert.ok(GUARD_RE.test(h.wakePrompts[0]), `guard line missing: ${h.wakePrompts[0]}`);
  assert.ok(h.wakePrompts[0].includes('npm test'), 'job label in the wake prompt');
  // The watcher suppresses its OWN completion text (the agent's manager
  // listener already announced it) — no duplicated summary line.
  assert.ok(
    !h.events.some((e) => e.type === 'text' && e.text.includes('退出码 0')),
    'completion summary must not be emitted twice',
  );
});

test('progress and stalled lines surface as text, but stalled does not wake', async () => {
  const h = makeService();
  const mgr = new EventEmitter();
  h.attach(mgr);

  const running = fakeJob('running', 'build');
  mgr.emit('event', { type: 'progress', job: running, elapsedMs: 120_000, logDeltaBytes: 512, tail: ['writing shard 8/40'] });
  mgr.emit('event', { type: 'stalled', job: running, idleMs: 600_001 });
  await h.flush();

  const texts = h.events.filter((e) => e.type === 'text').map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('[bg] build')), `progress line missing: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes('build') && /卡住|stalled/i.test(t)), `stalled line missing: ${JSON.stringify(texts)}`);
  assert.equal(h.wakePrompts.length, 0, 'stalled is not in the default wake kinds (succeeded+failed)');
});

test('a busy agent defers the wake; it fires once idle', async () => {
  const h = makeService({ busy: true });
  const mgr = new EventEmitter();
  h.attach(mgr);

  mgr.emit('event', { type: 'completed', job: fakeJob('succeeded') });
  await h.flush();
  assert.equal(h.wakePrompts.length, 0, 'no wake while a user turn is running');

  h.setBusy(false);
  mgr.emit('event', { type: 'completed', job: fakeJob('failed', 'npm test') });
  await h.flush();
  assert.equal(h.wakePrompts.length, 1, 'fires once the agent is idle');
  assert.ok(h.wakePrompts[0].includes('npm test'));
});

test('explicit config wake.enabled:false disables the desktop default', async () => {
  const h = makeService({ wakeNode: { enabled: false } });
  const mgr = new EventEmitter();
  h.attach(mgr);

  mgr.emit('event', { type: 'completed', job: fakeJob('succeeded') });
  await h.flush();
  assert.equal(h.wakePrompts.length, 0, 'explicit opt-out wins over the host default');
});

test('the hourly ledger caps wake turns (6/hour by default)', async () => {
  // Zero cooldown so back-to-back completions are not throttled by the 60s
  // cooldown — only the 6/hour ledger should cap the count.
  const h = makeService({ wakeConfigOverride: { cooldownMs: 0, maxTurnsPerHour: 6 } });
  const mgr = new EventEmitter();
  h.attach(mgr);

  // Sequential: the re-entrancy guard (one wake turn in flight) means back-to-
  // back emissions during a running wake are deferred, so interleave a flush
  // between completions to let each wake settle before the next one.
  for (let i = 0; i < 8; i++) {
    const job = fakeJob('succeeded', `job-${i}`);
    job.id = `bg_${i}`;
    mgr.emit('event', { type: 'completed', job });
    await h.flush();
  }
  assert.equal(h.wakePrompts.length, 6, `expected exactly 6 wake turns, got ${h.wakePrompts.length}`);
});
