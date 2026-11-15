/**
 * H6 — session-worker crash auto-respawn + turn_lost.
 *
 * A per-session worker that dies mid-turn used to silently vanish from the tab
 * bar (its row was dropped on exit) and an in-flight turn looked like a hang.
 * Now: an unexpected exit of a still-bound worker auto-respawns + re-binds the
 * session (through open()), and a turn that was in flight gets a `turn_lost`
 * event so the UI can explain the interruption. Explicit closes never
 * respawn, and the respawn budget is loose-bounded so a crash loop cannot
 * spawn forever.
 *
 * The test drives SessionWorkers with a fake worker host: wire() assigns the
 * real onExit handler, and firing it simulates the process dying.
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// dist/main/worker-host.js statically imports `electron` (for the packaged
// utilityProcess fork). Under plain node the npm `electron` package only
// exports a binary path string, so the named imports cannot link. Stub it with
// a synchronous resolve+load hook pair BEFORE the module under test is
// imported; the respawn logic never forks, so the stubs are inert.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: 'electron-stub:', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'electron-stub:') {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const app = { getPath: () => "", on: () => {} };\n' +
          'export const utilityProcess = { fork: () => { throw new Error("no electron fork in tests"); } };\n',
      };
    }
    return nextLoad(url, context);
  },
});

const { SessionWorkers } = await import(pathToFileURL(join(dist, 'main', 'session-workers.js')));

/** Fake WorkerHost: only the surface wire() / open() touch is real. */
function fakeWorker(bound) {
  return {
    alive: true,
    onExit: null,
    onEvent: null,
    onPermission: null,
    onLog: null,
    onRateLimitReport: null,
    onMcpRequest: null,
    onHealthy: null,
    request: async () => 'ok',
    stop() {
      this.alive = false;
    },
    bound,
  };
}

/**
 * A bound row the way wire() would hold it, with the fake worker installed and
 * its handlers wired. `open` is faked so the respawn never spawns a real
 * process: it records the call and leaves the row as-is.
 */
function makeHarness({ busy = false } = {}) {
  const sw = new SessionWorkers();
  sw.onLog = () => {};
  sw.onChange = () => {};
  const events = [];
  sw.onEvent = (sessionId, event) => events.push({ sessionId, event });

  const worker = fakeWorker({});
  const bound = { sessionId: 'sess-h6', provider: 'p', model: 'm', busy, fanout: false, cwd: null, worker };
  worker.bound = bound;
  sw.wire(bound);
  sw.map.set(bound.sessionId, bound);

  const opens = [];
  sw.open = async (sid, opts) => {
    opens.push({ sid, opts });
    return { sessionId: sid, provider: 'p', model: 'm', busy: false };
  };

  return { sw, bound, worker, events, opens };
}

test('crash with an in-flight turn emits turn_lost AND auto-respawns', async () => {
  const { sw, worker, events, opens } = makeHarness({ busy: true });
  worker.onExit(1); // unexpected exit while still the bound row

  assert.ok(opens.length === 1, 'a respawn was attempted');
  assert.equal(opens[0].sid, 'sess-h6');
  assert.equal(opens[0].opts.rearm, false, 'a respawn must not re-arm the crash budget');
  assert.ok(
    sw.respawnCounts.get('sess-h6') === 1,
    'the crash budget accrued one attempt',
  );
  const lost = events.filter((e) => e.event.type === 'turn_lost');
  assert.equal(lost.length, 1, 'turn_lost emitted for the in-flight turn');
  assert.equal(lost[0].event.reason, 'worker_exited');
  assert.equal(lost[0].sessionId, 'sess-h6');
});

test('crash while idle respawns but does NOT emit turn_lost', async () => {
  const { worker, events, opens } = makeHarness({ busy: false });
  worker.onExit(0);
  assert.equal(opens.length, 1, 'still auto-respawns when idle');
  assert.equal(events.filter((e) => e.event.type === 'turn_lost').length, 0);
});

test('an explicitly user-closed session is not respawned', async () => {
  const { sw, bound, worker, opens } = makeHarness();
  // close() removes the row first; simulate the marker-only branch directly:
  sw.map.set(bound.sessionId, bound);
  sw.closedByUser.add(bound.sessionId);
  worker.onExit(1);
  assert.equal(opens.length, 0, 'a user-closed session never respawns');
  assert.equal(sw.map.has(bound.sessionId), false, 'the row was dropped as before');
});

test('the respawn budget is loose-bounded: exhausted attempts stop respawning', async () => {
  const { sw, bound, worker, opens } = makeHarness();
  sw.respawnCounts.set(bound.sessionId, 99); // beyond the cap (3)
  worker.onExit(1);
  assert.equal(opens.length, 0, 'an exhausted budget gives up instead of looping');
  assert.equal(sw.map.has(bound.sessionId), false, 'the tab row is dropped so the user can reopen');
});

test('close() marks the session user-closed so its exit never respawns', async () => {
  const { sw, bound, worker } = makeHarness();
  sw.close(bound.sessionId);
  assert.equal(sw.map.has(bound.sessionId), false);
  assert.ok(sw.closedByUser.has(bound.sessionId), 'close() arms the no-respawn marker');
  // The exit that follows the close must be inert now.
  worker.onExit(1);
  assert.equal(sw.map.has(bound.sessionId), false);
});

test('a replaced row (restart swap) never acts on its own exit', async () => {
  // restartWorkers clears the map BEFORE stopping the old hosts: the old
  // worker's exit sees a different row and must not delete/respawn anything.
  const { sw, bound, worker, opens } = makeHarness();
  const replacement = { ...bound, worker: fakeWorker({}) };
  sw.map.set(bound.sessionId, replacement);
  worker.onExit(1); // the OLD host dies
  assert.equal(opens.length, 0, 'an old host dying after a swap must not respawn');
  assert.equal(sw.map.get(bound.sessionId), replacement, 'the replacement row survived');
});

// ---------------------------------------------------------------------------
// M13: a core hot-restart swaps every tab's worker. An in-flight turn dies with
// the swap — noteRestartLoss() tells the UI (turn_lost, reason
// 'worker_restarted') so a restart never looks like a hang. Idle tabs emit
// nothing.
// ---------------------------------------------------------------------------

test('M13: a busy tab losing its worker to a restart emits turn_lost', () => {
  const { sw, events } = makeHarness({ busy: true });
  sw.noteRestartLoss({ sessionId: 'sess-h6', busy: true, fanout: false });
  const lost = events.filter((e) => e.event.type === 'turn_lost');
  assert.equal(lost.length, 1, 'the in-flight turn is reported lost');
  assert.equal(lost[0].event.reason, 'worker_restarted');
  assert.equal(lost[0].sessionId, 'sess-h6');
});

test('M13: a fan-out tab losing its worker to a restart emits turn_lost', () => {
  const { sw, events } = makeHarness({ busy: false });
  // fan-out holds the tab even when `busy` is false.
  sw.noteRestartLoss({ sessionId: 'sess-h6', busy: false, fanout: true });
  assert.equal(events.filter((e) => e.event.type === 'turn_lost').length, 1);
});

test('M13: an idle tab losing its worker to a restart emits nothing', () => {
  const { sw, events } = makeHarness({ busy: false });
  sw.noteRestartLoss({ sessionId: 'sess-h6', busy: false, fanout: false });
  assert.equal(events.length, 0, 'no turn to lose, no event');
});
