/**
 * Jobs sidebar page unit tests — core `bg_` background job list.
 *
 * Covers:
 *   - status vocabulary normalization (core killed/lost + unknown fallback)
 *   - core raw job → JobRow mapping
 *   - mount renders the shell-jobs section from injected pulls
 *   - bg_job_event merges into the list without a full re-pull
 *   - dispose unsubscribes and clears the DOM + interval
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// --- minimal DOM shim ---
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.textContent = '';
    this._listeners = {};
    this._innerHTML = '';
  }
  className = '';
  dataset = {};
  style = {};
  type = '';
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    // Mirror the browser: assigning '' tears down all child nodes.
    if (this._innerHTML === '') this.children = [];
  }
  appendChild(el) { this.children.push(el); return el; }
  replaceChildren(...els) { this.children = [...els]; }
  addEventListener(ev, fn) { this._listeners[ev] = fn; }
  dispatch(ev, arg) { this._listeners[ev]?.(arg ?? {}); }
}
class FakeContainer extends FakeEl {
  constructor() { super('div'); }
}
globalThis.document = {
  createElement(tag) { return new FakeEl(tag); },
};

const {
  mountJobsPage,
  normalizeJobStatus,
  coreJobToRow,
} = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'jobs.js')));

function hasClass(el, className) {
  return String(el?.className ?? '').split(/\s+/).includes(className);
}

function findEl(root, className) {
  if (hasClass(root, className)) return root;
  for (const c of root.children ?? []) {
    const hit = findEl(c, className);
    if (hit) return hit;
  }
  return undefined;
}

function findAll(root, className, out = []) {
  if (hasClass(root, className)) out.push(root);
  for (const c of root.children ?? []) findAll(c, className, out);
  return out;
}

// ===========================================================================
// 1. Status normalization
// ===========================================================================

test('normalizeJobStatus: core vocabulary maps to SubTaskStatus', () => {
  assert.equal(normalizeJobStatus('queued'), 'queued');
  assert.equal(normalizeJobStatus('running'), 'running');
  assert.equal(normalizeJobStatus('succeeded'), 'succeeded');
  assert.equal(normalizeJobStatus('failed'), 'failed');
  assert.equal(normalizeJobStatus('timeout'), 'timeout');
  assert.equal(normalizeJobStatus('killed'), 'cancelled');
  assert.equal(normalizeJobStatus('lost'), 'failed');
});

test('normalizeJobStatus: unknown + edge vocabulary falls back to pending', () => {
  assert.equal(normalizeJobStatus('created'), 'pending');
  assert.equal(normalizeJobStatus('cancelled'), 'cancelled');
  assert.equal(normalizeJobStatus('stale'), 'timeout');
  assert.equal(normalizeJobStatus(undefined), 'pending');
  assert.equal(normalizeJobStatus('weird'), 'pending');
});

// ===========================================================================
// 2. Raw job → JobRow mapping
// ===========================================================================

test('coreJobToRow: maps shell BgJob fields + duration', () => {
  const row = coreJobToRow({
    id: 'bg_abc123',
    label: 'build',
    status: 'running',
    command: 'npm run build',
    pid: 4242,
    logBytes: 1024,
    startedAt: 1000,
    finishedAt: 4000,
    sessionId: 'sess-1',
    error: undefined,
  });
  assert.ok(row);
  assert.equal(row.id, 'bg_abc123');
  assert.equal(row.title, 'build');
  assert.equal(row.status, 'running');
  assert.equal(row.command, 'npm run build');
  assert.equal(row.pid, 4242);
  assert.equal(row.durationMs, 3000);
  assert.equal(row.sessionId, 'sess-1');
});

test('coreJobToRow: null on garbage', () => {
  assert.equal(coreJobToRow(null), null);
  assert.equal(coreJobToRow({}), null);
  assert.equal(coreJobToRow('x'), null);
});

// ===========================================================================
// 3. Mount + render
// ===========================================================================

function makeCtx(subscribers = []) {
  return {
    sessionId: 'sess-1',
    getActiveSessionId: () => 'sess-1',
    getUiLang: () => 'en',
    getFanoutSessions: () => new Map(),
    subscribe(fn) {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  };
}

test('mountJobsPage: renders the shell-jobs section from an injected pull', async () => {
  const subscribers = [];
  const container = new FakeContainer();
  const ctx = makeCtx(subscribers);

  const dispose = mountJobsPage(container, ctx, {
    listCore: async () => ({
      ok: true,
      jobs: [
        { id: 'bg_1', label: 'sleepy', status: 'running', command: 'sleep 99', pid: 1, logBytes: 10, startedAt: 1 },
      ],
    }),
    killCore: async () => ({ ok: true }),
    tailCore: async () => ({ ok: true, text: 'tail…' }),
    getUiLang: () => 'en',
  });

  try {
    // pull is async — wait a microtask turn for the list promise + render
    await new Promise((r) => setTimeout(r, 10));

    const sections = findAll(container, 'jobs-section');
    assert.equal(sections.length, 1, 'single shell-jobs section');

    const shellHead = findEl(container, 'jobs-section-head');
    assert.ok(shellHead, 'shell section rendered');
    assert.match(shellHead.textContent, /Shell jobs — 1/);

    assert.equal(findAll(container, 'job-source-badge').length, 0, 'no per-card source badge');

    assert.equal(subscribers.length, 1, 'subscribed to the event bus');
  } finally {
    dispose();
  }
  assert.equal(subscribers.length, 0, 'unsubscribed on dispose');
  assert.equal(container.children.length, 0, 'DOM cleared on dispose');
});

test('mountJobsPage: bg_job_event merges a new core job without re-pull', async () => {
  const subscribers = [];
  const container = new FakeContainer();
  const ctx = makeCtx(subscribers);

  let pulls = 0;
  const dispose = mountJobsPage(container, ctx, {
    listCore: async () => { pulls++; return { ok: true, jobs: [] }; },
    killCore: async () => ({ ok: true }),
    tailCore: async () => ({ ok: true, text: '' }),
    getUiLang: () => 'en',
  });

  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pulls, 1);

    const before = findAll(container, 'jobs-section').length;
    assert.equal(before, 0, 'starts empty');

    subscribers[0]({
      type: 'bg_job_event',
      kind: 'status',
      job: {
        id: 'bg_live',
        label: 'watcher',
        status: 'running',
        command: 'ping',
        pid: 99,
        logBytes: 5,
        startedAt: Date.now(),
        sessionId: 'sess-1',
      },
    });

    const heads = findAll(container, 'jobs-section-head');
    assert.equal(heads.length, 1, 'shell section appeared after event');
    assert.match(heads[0].textContent, /Shell jobs — 1/);

    // Terminal completion flips the status without needing a pull.
    subscribers[0]({
      type: 'bg_job_event',
      kind: 'completed',
      job: { id: 'bg_live', label: 'watcher', status: 'succeeded', sessionId: 'sess-1' },
    });
    const wrappers = findAll(container, 'job-card-wrapper');
    assert.ok(wrappers.length >= 1);
    assert.ok(
      wrappers.some((w) => String(w.className).includes('status-succeeded')),
      'card wrapper shows succeeded status',
    );

    assert.equal(pulls, 1, 'no extra pull for pure event merges');
  } finally {
    dispose();
  }
});

test('mountJobsPage: dispose clears interval (no throw on later ticks)', async () => {
  const container = new FakeContainer();
  const ctx = makeCtx([]);
  const dispose = mountJobsPage(container, ctx, {
    listCore: async () => ({ ok: true, jobs: [] }),
    getUiLang: () => 'en',
  });
  await new Promise((r) => setTimeout(r, 10));
  dispose();
  // If clearInterval failed, a later 10s tick would touch a cleared container.
  // We only assert dispose is idempotent-safe here.
  assert.doesNotThrow(() => dispose());
});

test('mountJobsPage: terminal cards expose Remove and drop the row on success', async () => {
  const subscribers = [];
  const container = new FakeContainer();
  const ctx = makeCtx(subscribers);
  const removed = [];

  const dispose = mountJobsPage(container, ctx, {
    listCore: async () => ({
      ok: true,
      jobs: [
        { id: 'bg_done', label: 'done', status: 'failed', command: 'false', startedAt: 1, finishedAt: 2, sessionId: 'sess-1' },
      ],
    }),
    killCore: async () => ({ ok: true }),
    removeCore: async (id, sessionId) => { removed.push({ id, sessionId }); return { ok: true }; },
    tailCore: async () => ({ ok: true, text: '' }),
    getUiLang: () => 'en',
  });

  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(findAll(container, 'job-action-remove').length >= 1, 'Remove button on terminal card');

    const rmBtn = findAll(container, 'job-action-remove')[0];
    rmBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(removed, [{ id: 'bg_done', sessionId: 'sess-1' }], 'removeCore called with id + owning sessionId');
    assert.equal(findAll(container, 'job-card-wrapper').length, 0, 'card removed after success');

    // A late bg_job_event for the removed id must NOT resurrect the card.
    subscribers[0]({
      type: 'bg_job_event',
      kind: 'completed',
      job: { id: 'bg_done', label: 'done', status: 'failed', sessionId: 'sess-1' },
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(findAll(container, 'job-card-wrapper').length, 0, 'tombstone blocks late event re-add');
  } finally {
    dispose();
  }
});

test('mountJobsPage: pull after remove does not resurrect a tombstoned job', async () => {
  const subscribers = [];
  const container = new FakeContainer();
  const ctx = makeCtx(subscribers);
  let listCalls = 0;
  const dispose = mountJobsPage(container, ctx, {
    listCore: async () => {
      listCalls++;
      // Backend still returns the job (stale / wrong-worker race) — tombstone wins.
      return {
        ok: true,
        jobs: [
          { id: 'bg_stale', label: 'stale', status: 'failed', startedAt: 1, finishedAt: 2, sessionId: 'sess-1' },
        ],
      };
    },
    removeCore: async () => ({ ok: true }),
    getUiLang: () => 'en',
  });

  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(findAll(container, 'job-card-wrapper').length, 1, 'initial pull shows the job');

    const rmBtn = findAll(container, 'job-action-remove')[0];
    rmBtn.dispatch('click');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(findAll(container, 'job-card-wrapper').length, 0, 'removed locally');
    const pullsAfterRemove = listCalls;

    // session_changed forces an immediate re-pull from the backend.
    subscribers[0]({ type: 'session_changed', sessionId: 'sess-1' });
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(listCalls > pullsAfterRemove, 'session_changed triggered a re-pull');
    assert.equal(
      findAll(container, 'job-card-wrapper').length,
      0,
      'stale backend row must not resurrect a tombstoned job',
    );
  } finally {
    dispose();
  }
});

test('mountJobsPage: non-terminal cards show Kill, not Remove', async () => {
  const container = new FakeContainer();
  const ctx = makeCtx([]);
  const dispose = mountJobsPage(container, ctx, {
    listCore: async () => ({
      ok: true,
      jobs: [{ id: 'bg_run', label: 'run', status: 'running', command: 'sleep 9', pid: 1, startedAt: 1, sessionId: 'sess-1' }],
    }),
    killCore: async () => ({ ok: true }),
    removeCore: async () => ({ ok: true }),
    tailCore: async () => ({ ok: true, text: '' }),
    getUiLang: () => 'en',
  });

  try {
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(findAll(container, 'job-action-remove').length, 0, 'no Remove while running');
    assert.ok(findAll(container, 'job-action-btn').length >= 1, 'Kill still available');
  } finally {
    dispose();
  }
});
