/**
 * P1 unit tests — Sidebar registry + Sub-Agents page.
 *
 * Covers docs/dsh-plugin-adoption-plan.md §4.5 acceptance criteria:
 *   - arbitrary built-in pages register through a single registerTab surface
 *     (SidebarRegistryImpl.register → list/get)
 *   - registry guarantees dispose runs exactly once per mounted page (no
 *     leaked subscriptions or workers on close / replace / clear)
 *   - duplicate ids rejected; unknown ids no-op
 *   - Sub-Agents page renders live fan-out cards from the shared
 *     session map and re-renders on fanout_* events, with the passed-in
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
  const ctx = { sessionId: '', getSubAgentRuns: () => new Map(), subscribe: () => () => {} };
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
  const ctx = { sessionId: '', getSubAgentRuns: () => new Map(), subscribe: () => () => {} };
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
  const ctx = { sessionId: '', getSubAgentRuns: () => new Map(), subscribe: () => () => {} };
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
  const ctx = { sessionId: '', getSubAgentRuns: () => new Map(), subscribe: () => () => {} };
  reg.mount('c1', container, ctx);
  reg.mount('c2', container, ctx);
  assert.equal(reg.clear(), 2);
  assert.equal(disposes, 2);
  assert.equal(reg.list().length, 0);
});

test('registry: mount for an unknown id returns undefined and does not throw', () => {
  const reg = new SidebarRegistryImpl();
  const container = new FakeContainer();
  const ctx = { sessionId: '', getSubAgentRuns: () => new Map(), subscribe: () => () => {} };
  assert.equal(reg.mount('ghost', container, ctx), undefined);
});

// ===========================================================================
// 2. Sub-Agents page (plan §4.4)
// ===========================================================================

function makeCtx(runs, subscriberRef) {
  return {
    sessionId: 's1',
    getSubAgentRuns: () => runs,
    subscribe(fn) {
      subscriberRef.current = fn;
      return () => { subscriberRef.current = null; };
    },
  };
}

/** Build a run entry: the registry is keyed per RUN (not per session), so a
 *  session can hold a graph, a standalone spawn and a fan-out batch at once. */
function makeRun(overrides) {
  return {
    key: overrides.key,
    kind: overrides.kind ?? 'fanout',
    sessionId: overrides.sessionId ?? 's1',
    prompt: overrides.prompt ?? '',
    startTime: overrides.startTime ?? 1,
    ...(overrides.graphId !== undefined ? { graphId: overrides.graphId } : {}),
    ...(overrides.taskOrder !== undefined ? { taskOrder: overrides.taskOrder } : {}),
    tasks: overrides.tasks ?? new Map(),
  };
}

function makeRunMap(...runs) {
  const m = new Map();
  for (const r of runs) m.set(r.key, r);
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

/** Run sections in render order (group headers excluded). */
function sectionsOf(listEl) {
  return (listEl?.children ?? []).filter((el) => el.className === 'sub-agents-session');
}

/** Group headers in render order, as [kind, text] pairs. */
function groupHeadsOf(listEl) {
  return (listEl?.children ?? [])
    .filter((el) => el.className === 'sub-agents-group-head')
    .map((el) => [el.dataset.kind, el.textContent ?? '']);
}

test('sub-agents page: renders empty state when no runs exist', () => {
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

test('sub-agents page: renders one section per run with task cards', () => {
  const container = new FakeContainer();
  const subscriberRef = { current: null };
  let cardRenderCount = 0;
  const ctx = makeCtx(
    makeRunMap(makeRun({
      key: 'fanout:s1',
      prompt: 'Fan-out run',
      startTime: 1000,
      tasks: new Map([
        ['t1', { description: 'Task one', status: 'running' }],
        ['t2', { description: 'Task two', status: 'succeeded', output: 'done!', durationMs: 1500 }],
      ]),
    })),
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
  const list = root.children?.find?.((el) => el.className === 'sub-agents-list');
  assert.ok(list, 'list rendered');
  // A single fan-out run → one group header + one run section.
  assert.deepEqual(groupHeadsOf(list).map(([kind]) => kind), ['fanout']);
  assert.equal(sectionsOf(list).length, 1, 'one run section');
  const section = sectionsOf(list)[0];
  assert.match(section.children[0].textContent ?? '', /Fan-out run/); // run head
  const cardEls = section.children.filter((el) => el.tagName === 'div' && el.innerHTML?.includes('fake-card'));
  assert.equal(cardEls.length, 2, 'two task cards rendered');
  assert.equal(cardRenderCount, 2);
  dispose();
});

test('sub-agents page: groups runs by kind in dag → standalone → fanout order', () => {
  const container = new FakeContainer();
  const runs = makeRunMap(
    // Deliberately out of order: the fan-out batch is the NEWEST, yet its
    // section must still come last.
    makeRun({ key: 'fanout:s1', kind: 'fanout', prompt: 'Batch', startTime: 900, tasks: new Map([['f1', { status: 'running' }]]) }),
    makeRun({ key: 'standalone:s1', kind: 'standalone', prompt: 'Lone spawn', startTime: 500, tasks: new Map([['x1', { status: 'running' }]]) }),
    makeRun({ key: 'dag:g1', kind: 'dag', graphId: 'g1', prompt: 'g1', startTime: 100, tasks: new Map([['d1', { status: 'pending' }]]) }),
  );
  const ctx = makeCtx(runs, { current: null });
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: (props) => `<div class="fake-card" data-task="${props.taskId}"></div>`,
  });
  const list = findEl(container, 'sub-agents-list');
  assert.deepEqual(
    groupHeadsOf(list).map(([kind, text]) => [kind, text]),
    [['dag', 'Task graph · 1'], ['standalone', 'Standalone · 1'], ['fanout', 'Fan-out · 1']],
    'one labelled section per kind, in SECTION_ORDER',
  );
  // A graph section is headed by its graphId, not by a prompt.
  const dagSection = sectionsOf(list).find((s) => s.dataset.runKind === 'dag');
  assert.match(dagSection.children[0].textContent ?? '', /g1/);
  dispose();
});

test('sub-agents page: a DAG run renders tasks in graph topological order', () => {
  const container = new FakeContainer();
  // Insertion order and status order both disagree with the graph order:
  // t3 finished first, t1 is still pending, and t2 sits between them in the
  // map. Only the graph's own order should win.
  const runs = makeRunMap(makeRun({
    key: 'dag:g1',
    kind: 'dag',
    graphId: 'g1',
    taskOrder: ['t1', 't2', 't3'],
    tasks: new Map([
      ['t3', { description: 'third', status: 'succeeded' }],
      ['t1', { description: 'first', status: 'pending' }],
      ['t2', { description: 'second', status: 'running' }],
    ]),
  }));
  const ctx = makeCtx(runs, { current: null });
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: (props) => `<div class="fake-card" data-task="${props.taskId}"></div>`,
  });
  const dagSection = sectionsOf(findEl(container, 'sub-agents-list'))[0];
  const order = dagSection.children
    .filter((el) => el.innerHTML?.includes('fake-card'))
    .map((el) => el.dataset.taskId);
  assert.deepEqual(order, ['t1', 't2', 't3'], 'graph order preserved, not sorted by status');

  // A standalone run is a flat bag of independent tasks → running-first.
  const flat = makeRunMap(makeRun({
    key: 'standalone:s1',
    kind: 'standalone',
    prompt: 'Lone',
    tasks: new Map([
      ['a', { status: 'succeeded' }],
      ['b', { status: 'running' }],
      ['c', { status: 'pending' }],
    ]),
  }));
  const container2 = new FakeContainer();
  const dispose2 = mountSubAgentsPage(container2, makeCtx(flat, { current: null }), {
    getUiLang: () => 'en',
    renderCard: (props) => `<div class="fake-card" data-task="${props.taskId}"></div>`,
  });
  const flatOrder = sectionsOf(findEl(container2, 'sub-agents-list'))[0].children
    .filter((el) => el.innerHTML?.includes('fake-card'))
    .map((el) => el.dataset.taskId);
  assert.deepEqual(flatOrder, ['b', 'c', 'a'], 'non-DAG runs still sort running-first');
  dispose();
  dispose2();
});

test('sub-agents page: re-associates to the active session on tab switch (session_changed)', () => {
  const container = new FakeContainer();
  const handlers = [];
  let active = 's1';
  const runs = makeRunMap(
    makeRun({ key: 'fanout:s1', sessionId: 's1', prompt: 'Batch A', startTime: 10, tasks: new Map([['a', { status: 'running' }]]) }),
    makeRun({ key: 'fanout:s2', sessionId: 's2', prompt: 'Batch B', startTime: 5, tasks: new Map([['b', { status: 'succeeded' }]]) }),
  );
  const ctx = {
    sessionId: 's1',
    getActiveSessionId: () => active,
    getSubAgentRuns: () => runs,
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

    // Initially bound to s1 → only Batch A.
    assert.equal(sectionsOf(list()).length, 1);
    assert.match(sectionsOf(list())[0].children[0].textContent ?? '', /Batch A/);
    assert.match(scope(), /s1/, 'scope label shows the bound session');

    // User switches to s2 → the panel re-associates on the session_changed bus.
    active = 's2';
    for (const h of handlers) h({ type: 'session_changed', sessionId: 's2' });
    assert.equal(sectionsOf(list()).length, 1, 'still one section after switch');
    assert.match(sectionsOf(list())[0].children[0].textContent ?? '', /Batch B/, 'now tracks the active session');
    assert.match(scope(), /s2/, 'scope label follows the switch');

    // Switch to an untouched session → session-scoped empty state (global map non-empty).
    active = 's3';
    for (const h of handlers) h({ type: 'session_changed', sessionId: 's3' });
    assert.equal(list().children.length, 1, 'empty state shown');
    assert.match(list().children[0].textContent ?? '', /No sub-agent tasks in the current session/, 'scoped empty hint');
  } finally {
    dispose();
  }
});

test('sub-agents page: re-renders on fanout_start / subagent_task_progress events', () => {
  const container = new FakeContainer();
  let handlers = [];
  const runs = new Map();
  const ctx = {
    sessionId: 's1',
    getSubAgentRuns: () => runs,
    subscribe(fn) { handlers.push(fn); return () => { handlers = []; }; },
  };
  let renders = 0;
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: () => { renders++; return '<div class="fake-card"></div>'; },
  });
  assert.equal(renders, 0, 'empty map → no cards');

  // simulate a fanout_start arriving on the bus
  const startEvt = { type: 'fanout_start', sessionId: 's1', prompt: 'Run!' };
  runs.set('fanout:s1', makeRun({ key: 'fanout:s1', prompt: 'Run!', startTime: 5, tasks: new Map([['k1', { status: 'pending' }]]) }));
  for (const h of handlers) h(startEvt);
  assert.equal(renders, 1, 'one card after fanout_start');

  // task becomes succeeded → re-render
  runs.get('fanout:s1').tasks.set('k1', { status: 'succeeded', output: 'ok' });
  for (const h of handlers) h({ type: 'fanout_task_progress', taskId: 'k1', status: 'succeeded' });
  assert.equal(renders, 2, 're-rendered on fanout_task_progress');

  // A mirrored core run (DAG / standalone) reports through the synthesized
  // event — the page must refresh for those too.
  for (const h of handlers) h({ type: 'subagent_task_progress', taskId: 'd1', status: 'running' });
  assert.equal(renders, 3, 're-rendered on subagent_task_progress');

  dispose();
  assert.equal(handlers.length, 0, 'unsubscribed on dispose');
});

test('sub-agents page: self-heals stale runs by invoking forceCloseStaleTasks on render', () => {
  const container = new FakeContainer();
  let handlers = [];
  const runs = new Map();
  let sweepCalls = 0;
  const ctx = {
    sessionId: 's1',
    getSubAgentRuns: () => runs,
    // The page must consult the optional hook on every render so a stale
    // "running" card is force-closed even without a fresh fan-out event.
    forceCloseStaleTasks: () => { sweepCalls++; },
    subscribe(fn) { handlers.push(fn); return () => { handlers = []; }; },
  };
  const dispose = mountSubAgentsPage(container, ctx, {
    getUiLang: () => 'en',
    renderCard: () => '<div class="fake-card"></div>',
  });

  // Mount triggers an initial render → sweep hook consulted at least once.
  assert.ok(sweepCalls >= 1, 'sweep hook consulted on initial render');

  // Any fan-out event re-renders → the page keeps sweeping stale runs.
  runs.set('fanout:s1', makeRun({ key: 'fanout:s1', prompt: 'Run!', startTime: 5, tasks: new Map([['k1', { status: 'running' }]]) }));
  const before = sweepCalls;
  for (const h of handlers) h({ type: 'fanout_start', sessionId: 's1', prompt: 'Run!' });
  assert.ok(sweepCalls > before, 'sweep hook re-consulted after a fan-out event');

  dispose();
});

test('sub-agents page: re-paints static labels + empty state when the UI language changes', () => {
  const container = new FakeContainer();
  const handlers = [];
  const runs = new Map();
  let lang = 'zh-CN';
  const ctx = {
    sessionId: 's1',
    getUiLang: () => lang,
    getSubAgentRuns: () => runs,
    subscribe(fn) { handlers.push(fn); return () => { handlers.length = 0; }; },
  };
  const title = () => findEl(container, 'sub-agents-title')?.textContent ?? '';
  const empty = () => findEl(container, 'sub-agents-empty')?.textContent ?? '';
  const dispose = mountSubAgentsPage(container, ctx, {
    renderCard: () => '<div class="fake-card"></div>',
  });
  try {
    assert.equal(title(), '🛰 子代理面板', 'mounts in the current language');
    assert.match(empty(), /暂无多任务执行/, 'empty state follows mount language');

    // Language switch → the panel re-paints immediately (language_changed bus).
    lang = 'en';
    for (const h of handlers) h({ type: 'language_changed' });
    assert.equal(title(), '🛰 Sub-Agent Panel', 'title repainted in English');
    assert.match(empty(), /No multi-task runs yet/, 'empty state repainted');
  } finally {
    dispose();
  }
});

test('sub-agents page: section headers follow the UI language', () => {
  const container = new FakeContainer();
  const handlers = [];
  let lang = 'zh-CN';
  const runs = makeRunMap(
    makeRun({ key: 'dag:g1', kind: 'dag', graphId: 'g1', taskOrder: ['d1'], tasks: new Map([['d1', { status: 'running' }]]) }),
    makeRun({ key: 'standalone:s1', kind: 'standalone', prompt: 'Lone', tasks: new Map([['x1', { status: 'running' }]]) }),
    makeRun({ key: 'fanout:s1', kind: 'fanout', prompt: 'Batch', tasks: new Map([['f1', { status: 'running' }]]) }),
  );
  const ctx = {
    sessionId: 's1',
    getUiLang: () => lang,
    getSubAgentRuns: () => runs,
    subscribe(fn) { handlers.push(fn); return () => { handlers.length = 0; }; },
  };
  const dispose = mountSubAgentsPage(container, ctx, {
    renderCard: () => '<div class="fake-card"></div>',
  });
  try {
    assert.deepEqual(
      groupHeadsOf(findEl(container, 'sub-agents-list')).map(([, text]) => text),
      ['任务图 · 1', '独立子代理 · 1', '多任务执行 · 1'],
    );
    lang = 'en';
    for (const h of handlers) h({ type: 'language_changed' });
    assert.deepEqual(
      groupHeadsOf(findEl(container, 'sub-agents-list')).map(([, text]) => text),
      ['Task graph · 1', 'Standalone · 1', 'Fan-out · 1'],
    );
  } finally {
    dispose();
  }
});