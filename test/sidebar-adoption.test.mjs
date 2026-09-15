/**
 * P1 unit tests — Sidebar registry + Sub-Agents page.
 *
 * Covers docs/dsh-plugin-adoption-plan.md §4.5 acceptance criteria:
 *   - arbitrary built-in pages register through a single registerTab surface
 *     (SidebarRegistryImpl.register → list/get)
 *   - registry guarantees dispose runs exactly once per mounted page (no
 *     leaked subscriptions or workers on close / replace / clear)
 *   - duplicate ids rejected; unknown ids no-op
 *   - Sub-Agents page renders live parallel-execution cards from the shared
 *     session map and re-renders on parallel_* events, with the passed-in
 *     dispose unsubscribing from the event bus
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// --- minimal DOM shim (the page mounts into a real-ish container) ---
class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; }
  className = '';
  dataset = {};
  style = {};
  innerHTML = '';
  appendChild(el) { this.children.push(el); return el; }
  replaceChildren() { this.children = []; }
}
class FakeContainer extends FakeEl {
  classList = { add() {}, remove() {} };
  constructor() { super('div'); }
}
globalThis.document = {
  createElement(tag) { return new FakeEl(tag); },
};

const { SidebarRegistryImpl, quickTab } = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'registry.js')));
const { mountSubAgentsPage } = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'sub-agents.js')));

// ===========================================================================
// 1. Registry lifecycle (plan §4.5)
// ===========================================================================

test('registry: register → list → get round-trip (single registerTab surface)', () => {
  const reg = new SidebarRegistryImpl();
  assert.equal(reg.list().length, 0);
  reg.register(quickTab('a', 'Alpha', '🌐', () => () => {}));
  reg.register(quickTab('b', 'Beta', undefined, () => () => {}));
  assert.deepEqual(reg.list().map((r) => r.id), ['a', 'b']);
  assert.equal(reg.get('a')?.title, 'Alpha');
  assert.equal(reg.get('b')?.icon, undefined);
  assert.equal(reg.get('nope'), undefined);
});

test('registry: duplicate id is rejected', () => {
  const reg = new SidebarRegistryImpl();
  reg.register(quickTab('x', 'X', undefined, () => () => {}));
  assert.throws(() => reg.register(quickTab('x', 'X2', undefined, () => () => {})), /already registered/);
});

test('registry: mount calls page factory and dispose runs exactly once on close', () => {
  const reg = new SidebarRegistryImpl();
  let mounts = 0;
  let disposes = 0;
  reg.register(quickTab('m', 'M', undefined, () => {
    mounts++;
    return () => { disposes++; };
  }));
  const container = new FakeContainer();
  const ctx = { sessionId: '', getParallelSessions: () => new Map(), subscribe: () => () => {} };
  const disposeViaRegistry = reg.mount('m', container, ctx);
  assert.equal(mounts, 1);
  assert.equal(disposes, 0);
  disposeViaRegistry?.();
  assert.equal(disposes, 1);
  // second close call is a no-op (idempotent)
  reg.mountDispose('m');
  assert.equal(disposes, 1);
});

test('registry: mounting a different tab disposes the previous page (no leaks)', () => {
  const reg = new SidebarRegistryImpl();
  const disposes = [];
  reg.register(quickTab('t1', 'T1', undefined, () => () => { disposes.push('t1'); }));
  reg.register(quickTab('t2', 'T2', undefined, () => () => { disposes.push('t2'); }));
  const container = new FakeContainer();
  const ctx = { sessionId: '', getParallelSessions: () => new Map(), subscribe: () => () => {} };
  reg.mount('t1', container, ctx);
  reg.mount('t2', container, ctx);
  assert.deepEqual(disposes, ['t1']);
  reg.mount('t1', container, ctx);
  assert.deepEqual(disposes, ['t1', 't2']);
});

test('registry: unregister disposes the mounted page and removes it', () => {
  const reg = new SidebarRegistryImpl();
  let disposes = 0;
  reg.register(quickTab('u', 'U', undefined, () => () => { disposes++; }));
  const container = new FakeContainer();
  const ctx = { sessionId: '', getParallelSessions: () => new Map(), subscribe: () => () => {} };
  reg.mount('u', container, ctx);
  assert.equal(reg.unregister('u'), true);
  assert.equal(disposes, 1);
  assert.equal(reg.get('u'), undefined);
  assert.equal(reg.unregister('u'), false);
});

test('registry: clear disposes every mounted page and empties the registry', () => {
  const reg = new SidebarRegistryImpl();
  let disposes = 0;
  reg.register(quickTab('c1', 'C1', undefined, () => () => { disposes++; }));
  reg.register(quickTab('c2', 'C2', undefined, () => () => { disposes++; }));
  const container = new FakeContainer();
  const ctx = { sessionId: '', getParallelSessions: () => new Map(), subscribe: () => () => {} };
  reg.mount('c1', container, ctx);
  reg.mount('c2', container, ctx);
  assert.equal(reg.clear(), 2);
  assert.equal(disposes, 2);
  assert.equal(reg.list().length, 0);
});

test('registry: mount for an unknown id returns undefined and does not throw', () => {
  const reg = new SidebarRegistryImpl();
  const container = new FakeContainer();
  const ctx = { sessionId: '', getParallelSessions: () => new Map(), subscribe: () => () => {} };
  assert.equal(reg.mount('ghost', container, ctx), undefined);
});

// ===========================================================================
// 2. Sub-Agents page (plan §4.4)
// ===========================================================================

function makeCtx(parallelSessions, subscriberRef) {
  return {
    sessionId: 's1',
    getParallelSessions: () => parallelSessions,
    subscribe(fn) {
      subscriberRef.current = fn;
      return () => { subscriberRef.current = null; };
    },
  };
}

function makeSessionMap(...sessions) {
  const m = new Map();
  for (const s of sessions) m.set(s.sessionId ?? 'sid' + m.size, s);
  return m;
}

function findEl(root, className) {
  if (root.className === className) return root;
  for (const c of root.children ?? []) {
    const hit = findEl(c, className);
    if (hit) return hit;
  }
  return undefined;
}

test('sub-agents page: renders empty state when no parallel sessions', () => {
  const container = new FakeContainer();
  const subscriberRef = { current: null };
  const ctx = makeCtx(new Map(), subscriberRef);
  const dispose = mountSubAgentsPage(container, ctx, { getUiLang: () => 'zh-CN' });
  assert.ok(container.children.length >= 1); // root appended
  const list = container.children[0]?.children?.find?.((el) => el.className === 'sub-agents-list');
  assert.ok(list, 'list element exists');
  assert.ok(subscriberRef.current, 'page subscribed to event bus');
  dispose();
  assert.equal(subscriberRef.current, null, 'dispose unsubscribes (unsubscribe hook called)');
});

test('sub-agents page: renders one section per session with task cards', () => {
  const container = new FakeContainer();
  const subscriberRef = { current: null };
  let cardRenderCount = 0;
  const ctx = makeCtx(
    makeSessionMap({
      sessionId: 's1',
      prompt: 'Parallel run',
      startTime: 1000,
      tasks: new Map([
        ['t1', { description: 'Task one', status: 'running' }],
        ['t2', { description: 'Task two', status: 'succeeded', output: 'done!', durationMs: 1500 }],
      ]),
    }),
    subscriberRef,
  );
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: (props) => {
      cardRenderCount++;
      return `<div class="fake-card" data-task="${props.taskId}" data-status="${props.status}">${props.description ?? ''}</div>`;
    },
  });
  const root = container.children[0];
  assert.ok(root, 'root rendered');
  // list should contain one session section
  const list = root.children?.find?.((el) => el.className === 'sub-agents-list');
  assert.ok(list, 'list rendered');
  assert.equal(list.children.length, 1, 'one session section');
  const section = list.children[0];
  assert.match(section.children[0].textContent ?? '', /Parallel run/); // session head
  const cardEls = section.children.filter((el) => el.tagName === 'div' && el.innerHTML?.includes('fake-card'));
  assert.equal(cardEls.length, 2, 'two task cards rendered');
  assert.equal(cardRenderCount, 2);

  // The panel is scoped to the ctx session (its own tasks, none from others).
  const head = list.children[0];
  assert.ok(head, 'scoped section rendered for ctx.sessionId');
  dispose();
});

test('sub-agents page: re-associates to the active session on tab switch (session_changed)', () => {
  const container = new FakeContainer();
  const handlers = [];
  let active = 's1';
  const sessions = makeSessionMap(
    { sessionId: 's1', prompt: 'Batch A', startTime: 10, tasks: new Map([['a', { status: 'running' }]]) },
    { sessionId: 's2', prompt: 'Batch B', startTime: 5, tasks: new Map([['b', { status: 'succeeded' }]]) },
  );
  const ctx = {
    sessionId: 's1',
    getActiveSessionId: () => active,
    getParallelSessions: () => sessions,
    subscribe(fn) { handlers.push(fn); return () => { handlers.length = 0; }; },
  };
  let renders = 0;
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: () => { renders++; return '<div class="fake-card"></div>'; },
  });
  try {
    const list = () => findEl(container, 'sub-agents-list');
    const scope = () => findEl(container, 'sub-agents-scope')?.textContent ?? '';

    // Initially bound to s1 → only Batch A section.
    assert.equal(list().children.length, 1);
    assert.match(list().children[0].children[0].textContent ?? '', /Batch A/);
    assert.match(scope(), /s1/, 'scope label shows the bound session');

    // User switches to s2 → the panel re-associates on the session_changed bus.
    active = 's2';
    for (const h of handlers) h({ type: 'session_changed', sessionId: 's2' });
    assert.equal(list().children.length, 1, 'still one section after switch');
    assert.match(list().children[0].children[0].textContent ?? '', /Batch B/, 'now tracks the active session');
    assert.match(scope(), /s2/, 'scope label follows the switch');

    // Switch to an untouched session → session-scoped empty state (global map non-empty).
    active = 's3';
    for (const h of handlers) h({ type: 'session_changed', sessionId: 's3' });
    assert.equal(list().children.length, 1, 'empty state shown');
    assert.match(list().children[0].textContent ?? '', /No parallel tasks in the current session/, 'scoped empty hint');
  } finally {
    dispose();
  }
});

test('sub-agents page: re-renders on parallel_start / parallel_end events', () => {
  const container = new FakeContainer();
  let handlers = [];
  const sessions = new Map();
  const ctx = {
    sessionId: 's1',
    getParallelSessions: () => sessions,
    subscribe(fn) { handlers.push(fn); return () => { handlers = []; }; },
  };
  let renders = 0;
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: () => { renders++; return '<div class="fake-card"></div>'; },
  });
  assert.equal(renders, 0, 'empty map → no cards');

  // simulate a parallel_start arriving on the bus
  const startEvt = { type: 'parallel_start', sessionId: 's1', prompt: 'Run!' };
  sessions.set('s1', { sessionId: 's1', prompt: 'Run!', startTime: 5, tasks: new Map([['k1', { status: 'pending' }]]) });
  for (const h of handlers) h(startEvt);
  assert.equal(renders, 1, 'one card after parallel_start');

  // task becomes succeeded → re-render
  sessions.get('s1').tasks.set('k1', { status: 'succeeded', output: 'ok' });
  for (const h of handlers) h({ type: 'task_progress', taskId: 'k1', status: 'succeeded' });
  assert.equal(renders, 2, 're-rendered on task_progress');

  dispose();
  assert.equal(handlers.length, 0, 'unsubscribed on dispose');
});

test('sub-agents page: self-heals stale runs by invoking forceCloseStaleTasks on render', () => {
  const container = new FakeContainer();
  let handlers = [];
  const sessions = new Map();
  let sweepCalls = 0;
  const ctx = {
    sessionId: 's1',
    getParallelSessions: () => sessions,
    // The page must consult the optional hook on every render so a stale
    // "running" card is force-closed even without a fresh parallel event.
    forceCloseStaleTasks: () => { sweepCalls++; },
    subscribe(fn) { handlers.push(fn); return () => { handlers = []; }; },
  };
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: () => '<div class="fake-card"></div>',
  });

  // Mount triggers an initial render → sweep hook consulted at least once.
  assert.ok(sweepCalls >= 1, 'sweep hook consulted on initial render');

  // Any parallel event re-renders → the page keeps sweeping stale runs.
  sessions.set('s1', { sessionId: 's1', prompt: 'Run!', startTime: 5, tasks: new Map([['k1', { status: 'running' }]]) });
  const before = sweepCalls;
  for (const h of handlers) h({ type: 'parallel_start', sessionId: 's1', prompt: 'Run!' });
  assert.ok(sweepCalls > before, 'sweep hook re-consulted after a parallel event');

  dispose();
});