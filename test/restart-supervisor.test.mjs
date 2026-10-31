import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RestartSupervisor } from '../dist/main/restart-supervisor.js';

/**
 * Regression: hot restart after a core overlay activation used to cascade.
 *
 * restartWorker() stops the running host and immediately starts a
 * replacement; the old host's exit arrives ~3s later. Without the
 * intentional-stop tag that expected exit looked like a crash, scheduled
 * another restart, which stopped the healthy replacement, which scheduled
 * another — attempts climbed 1→2→3 and the breaker left no worker at all
 * (only a full app restart recovered; the renderer showed 核心进程异常).
 */

class FakeScheduler {
  constructor() {
    this.pending = [];
  }
  schedule(fn, ms) {
    const handle = {
      fn,
      ms,
      cleared: false,
      clear() {
        this.cleared = true;
      },
    };
    this.pending.push(handle);
    return handle;
  }
  /** Fire all non-cleared pending timers. Returns how many fired. */
  fireAll() {
    const fired = this.pending.filter((h) => !h.cleared);
    for (const h of fired) h.fn();
    this.pending = [];
    return fired.length;
  }
}

function makeSupervisor() {
  const scheduler = new FakeScheduler();
  const restarts = [];
  const logs = [];
  const sup = new RestartSupervisor({
    scheduler,
    onLog: (level, message) => logs.push({ level, message }),
    onRestart: () => restarts.push(Date.now()),
  });
  return { sup, scheduler, restarts, logs };
}

describe('RestartSupervisor', () => {
  it('a stopped host: its late exit is expected and schedules NOTHING', () => {
    const { sup, scheduler, restarts, logs } = makeSupervisor();
    const oldWorker = { id: 'old' };

    // Hot restart: stop the old host and tag it.
    sup.markStopped(oldWorker);
    // Seconds later the old host finishes its graceful shutdown and reports
    // its exit. This must NOT count as a crash: no backoff timer, no
    // restart, no scary logs.
    assert.equal(sup.recordExit(oldWorker, 400), true, 'tagged host exit must be expected');
    assert.equal(restarts.length, 0);
    assert.equal(scheduler.pending.length, 0, 'expected exit must not schedule a restart');
    assert.deepEqual(logs, []);
  });

  it('the cascade scenario: activation hot-restart produces zero crash-restarts', () => {
    const { sup, scheduler, restarts } = makeSupervisor();
    const gen1 = { gen: 1 };
    const gen2 = { gen: 2 };

    // restartWorker(): stop+tag gen1, start gen2.
    sup.markStopped(gen1);
    // gen2 proves healthy (earlyInit ok, initOkPromise true) → done.
    // Then gen1's exit event finally arrives:
    assert.equal(sup.recordExit(gen1, 0), true, 'gen1 exit is expected, not a crash');
    assert.equal(restarts.length, 0, 'clean hot restart must trigger zero crash-restarts');
    assert.equal(scheduler.pending.length, 0);
    // And gen2 keeps running indefinitely.
    void gen2;
  });

  it('an unexpected crash still backs off and eventually trips the breaker', () => {
    const { sup, scheduler, restarts, logs } = makeSupervisor();

    assert.equal(sup.recordExit({ id: 'c1' }, 5000), false, 'untagged exit is a crash');
    assert.equal(restarts.length, 0, 'backoff timer not fired yet');
    assert.equal(scheduler.pending.length, 1);
    assert.equal(scheduler.pending[0].ms, 1000, 'first backoff is 1s');

    assert.equal(scheduler.fireAll(), 1);
    assert.equal(restarts.length, 1, 'attempt 1 fires');
    assert.equal(sup.recordExit({ id: 'c2' }, 5000), false);
    assert.equal(scheduler.pending[0].ms, 2000, 'backoff doubled');
    assert.equal(scheduler.fireAll(), 1);
    assert.equal(restarts.length, 2);
    assert.equal(sup.recordExit({ id: 'c3' }, 5000), false);
    assert.equal(scheduler.pending[0].ms, 4000, 'backoff doubled again');
    assert.equal(scheduler.fireAll(), 1);
    assert.equal(restarts.length, 3);
    // Breaker: one more fast death → no more restarts, error logged.
    assert.equal(sup.recordExit({ id: 'c4' }, 5000), false);
    assert.equal(scheduler.pending.length, 0, 'breaker tripped: nothing scheduled');
    assert.equal(
      logs.some((l) => l.level === 'error' && /crashed repeatedly/.test(l.message)),
      true,
      'exhaustion must be reported as an error',
    );
  });

  it('a stable long-lived worker refreshes the retry budget on exit', () => {
    const { sup, scheduler } = makeSupervisor();
    // Two fast crashes in a row (attempts → 2).
    sup.recordExit({ a: 1 }, 1000);
    sup.requestCrashRestart();
    assert.equal(scheduler.pending.length, 2);
    // Then a worker that lived ≥ stableLifetimeMs exits unexpectedly:
    // budget resets, and the next backoff is the first one (1s).
    assert.equal(sup.recordExit({ b: 1 }, 10 * 60_000), false);
    assert.equal(scheduler.pending.at(-1).ms, 1000, 'long-lived worker earned a fresh budget');
  });

  it('only one pending restart at a time: a new crash clears the old timer', () => {
    const { sup, scheduler } = makeSupervisor();
    sup.recordExit({ x: 1 }, 1000);
    sup.recordExit({ x: 2 }, 1000);
    assert.equal(
      scheduler.pending.filter((h) => !h.cleared).length,
      1,
      'the older timer must be cancelled, not stacked',
    );
  });

  it('app exit suppresses all restart scheduling, quietly', () => {
    const { sup, scheduler, restarts, logs } = makeSupervisor();
    sup.recordExit({ q: 1 }, 1000);
    assert.equal(scheduler.pending.length, 1);
    const logsBeforeQuit = logs.length;
    sup.markAppExiting();
    assert.equal(sup.isAppExiting, true);
    assert.equal(scheduler.fireAll(), 0, 'pending restart cancelled by quit');
    assert.equal(sup.requestCrashRestart(), 'exhausted');
    assert.equal(restarts.length, 0);
    assert.equal(logs.length, logsBeforeQuit, 'no log lines after quit begins');
  });
});
