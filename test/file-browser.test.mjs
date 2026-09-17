/**
 * Right-panel FileBrowser unit tests.
 *
 * Exercises the dependency-injected component (src/renderer/components/
 * FileBrowser.ts) against a minimal DOM shim — same pattern as
 * sidebar-pages-adoption.test.mjs:
 *   - mount loads the project root lazily (via the injected bridge),
 *   - directory expand/collapse fetches children on first open,
 *   - extension filter hides non-matching files (directories stay),
 *   - "show hidden" reveals dotfiles + noise dirs,
 *   - session_changed re-binds to a new project root,
 *   - auto-collapse fires when tasks need monitoring, on user collapse click,
 *     and on idle timeout — with no auto re-expand after tasks finish,
 *   - dispose removes the DOM and unsubscribes from the event bus.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// --- DOM shim (FakeEl + working classList + fragment + remove) ---
const TICKS = () => new Promise((r) => setTimeout(r, 0));

class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...cls) { for (const c of cls) this.set.add(c); this.sync(); }
  remove(...cls) { for (const c of cls) this.set.delete(c); this.sync(); }
  toggle(cls, force) {
    const on = force === undefined ? !this.set.has(cls) : Boolean(force);
    if (on) this.set.add(cls); else this.set.delete(cls);
    this.sync();
    return on;
  }
  contains(cls) { return this.set.has(cls); }
  sync() {
    const names = [...this.set].join(' ');
    this.el._className = names;
    Object.defineProperty(this.el, 'className', {
      configurable: true,
      get: () => this.el._className,
      set: (v) => { this.el._className = v; this.set = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    this.el._className = names;
  }
}

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this._listeners = {};
    this.dataset = {};
    this.style = {};
    this.scrollTop = 0;
    this._className = '';
    this.classList = new FakeClassList(this);
    this._textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.placeholder = '';
    this.spellcheck = false;
    this.autocomplete = '';
    this.title = '';
    this.type = '';
    this.hidden = false;
  }
  get className() { return this._className; }
  set className(v) { this._className = v; this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  // textContent aggregates descendant text like the real DOM.
  get textContent() {
    let s = this._textContent;
    for (const c of this.children) s += c.textContent;
    return s;
  }
  set textContent(v) { this._textContent = String(v); this.children = []; }
  appendChild(el) { this.children.push(el); return el; }
  replaceChildren(...els) {
    this.children = [];
    for (const e of els) if (e) this.children.push(e);
  }
  addEventListener(ev, fn, opts) { (this._listeners[ev] ??= []).push(fn); if (opts?.passive) this._passive = true; }
  removeEventListener(ev, fn) {
    const arr = this._listeners[ev];
    if (arr) this._listeners[ev] = arr.filter((f) => f !== fn);
  }
  setAttribute(k, v) { this[k] = v; }
  remove() {
    const parent = this._parent;
    if (parent) parent.children = parent.children.filter((c) => c !== this);
  }
  dispatch(ev, arg) {
    for (const fn of this._listeners[ev] ?? []) fn(arg ?? {});
  }
}
class FakeContainer extends FakeEl {
  constructor() { super('div'); }
}
globalThis.document = {
  createElement(tag) { return new FakeEl(tag); },
  createDocumentFragment() { return new FakeEl('#fragment'); },
};

const { mountFileBrowser } = await import(pathToFileURL(join(dist, 'renderer', 'components', 'FileBrowser.js')));

function findEls(root, { cls, text } = {}) {
  const out = [];
  const walk = (el) => {
    const clsOk = !cls || (el.className || '').split(/\s+/).includes(cls);
    const textOk = !text || (el.textContent || '').includes(text);
    if (clsOk && textOk) out.push(el);
    for (const c of el.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

function treeRowTexts(root) {
  return findEls(root, { cls: 'filebrowser-row' }).map((el) => el.textContent).join('|');
}
// Row names with the emoji prefix stripped, so `_main.py` vs `main.py` are
// distinguishable ((sub)string checks on raw text would collide).
function treeRowNames(root) {
  return findEls(root, { cls: 'filebrowser-name' }).map((el) =>
    (el.textContent || '').replace(/^[^\p{L}\p{N}\s._-]+/u, '').trim(),
  );
}

/** Build a mountable context + bridge with scripted directory listings. */
function makeHarness({ entries = [], monitor = false, projectDir = '/proj' } = {}) {
  const calls = [];
  const listing = new Map([[projectDir, entries]]);
  const bridge = {
    listDirectory: async (root, path) => {
      calls.push(['list', root, path]);
      const list = listing.get(path) ?? [];
      return { ok: true, entries: list };
    },
    openExternalFile: async (path) => {
      calls.push(['open', path]);
      return { ok: true };
    },
  };
  let handler = null;
  let currentDir = projectDir;
  let monitorNeeded = () => monitor;
  const ctx = {
    getProjectDir: () => Promise.resolve(currentDir),
    getUiLang: () => 'en',
    subscribe: (fn) => {
      handler = fn;
      return () => { handler = null; };
    },
    isMonitorNeeded: () => monitorNeeded(),
  };
  const container = new FakeContainer();
  return {
    container, bridge, calls, ctx,
    get handler() { return handler; },
    setProjectDir(d) { currentDir = d; },
    setMonitor(fn) { monitorNeeded = fn; },
    setListing(dir, list) { listing.set(dir, list); },
  };
}

const PROJ = [
  { name: 'src', type: 'directory', size: 0 },
  { name: 'a.ts', type: 'file', size: 120 },
  { name: 'b.js', type: 'file', size: 200 },
  { name: '.git', type: 'directory', size: 0 },
  { name: 'node_modules', type: 'directory', size: 0 },
];
const SRC = [
  { name: 'index.ts', type: 'file', size: 42 },
  { name: 'styles.css', type: 'file', size: 99 },
];

test('mount: renders header/tools and lazy-loads the project root', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(h.calls.some(([m, root, path]) => m === 'list' && root === '/proj' && path === '/proj'));
  const text = treeRowTexts(h.container);
  assert.ok(text.includes('a.ts'), 'file row rendered');
  assert.ok(text.includes('src'), 'dir row rendered');
  assert.ok(!text.includes('.git'), 'dotfiles hidden by default');
  assert.ok(!text.includes('node_modules'), 'noise dirs hidden by default');
  assert.ok(findEls(h.container, { cls: 'filebrowser-filter' }).length === 1);
  assert.ok(findEls(h.container, { cls: 'filebrowser-hidden' }).length === 1);
  assert.ok(h.container.classList.contains('collapsed'), 'collapsed by default (no visual jolt at startup)');

  const toggleBtn = findEls(h.container, { cls: 'filebrowser-toggle' })[0];
  toggleBtn.dispatch('click');
  assert.ok(!h.container.classList.contains('collapsed'), 'opens on explicit user click');
});

test('dir expand: lazily lists children, then toggles closed again', async () => {
  const h = makeHarness({ entries: PROJ });
  h.setListing('/proj/src', SRC);
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();

  const srcRow = findEls(h.container, { cls: 'filebrowser-row', text: 'src' })[0];
  assert.ok(srcRow, 'src row present');
  srcRow.dispatch('click');
  await TICKS(); await TICKS();

  assert.ok(h.calls.some(([m, root, path]) => m === 'list' && path === '/proj/src'), 'children listed on first expand');
  assert.ok(treeRowTexts(h.container).includes('index.ts'), 'child file shows after expand');

  srcRow.dispatch('click');
  assert.ok(!treeRowTexts(h.container).includes('index.ts'), 'children hidden after collapse');
});

test('extension filter hides non-matching files but keeps directories', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(treeRowTexts(h.container).includes('b.js'), 'baseline shows js');

  const input = findEls(h.container, { cls: 'filebrowser-filter' })[0];
  input.value = 'ts';
  input.dispatch('input');
  const text = treeRowTexts(h.container);
  assert.ok(text.includes('a.ts'), 'matching ext kept');
  assert.ok(!text.includes('b.js'), 'non-matching ext filtered');
  assert.ok(text.includes('src'), 'directories stay visible');

  input.value = '';
  input.dispatch('input');
  assert.ok(treeRowTexts(h.container).includes('b.js'), 'clear filter restores files');
});

test('keyword filter matches filename substrings, not just extensions', async () => {
  const h = makeHarness({
    entries: [
      { name: 'src', type: 'directory', size: 0 },
      { name: 'index.html', type: 'file', size: 10 },
      { name: 'index.css', type: 'file', size: 20 },
      { name: 'readme.md', type: 'file', size: 30 },
    ],
  });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(treeRowTexts(h.container).includes('index.html'), 'baseline');

  const input = findEls(h.container, { cls: 'filebrowser-filter' })[0];
  input.value = 'index';
  input.dispatch('input');
  const text = treeRowTexts(h.container);
  assert.ok(text.includes('index.html'), 'keyword match keeps index.html');
  assert.ok(text.includes('index.css'), 'keyword match keeps index.css');
  assert.ok(!text.includes('readme.md'), 'non-matching name filtered');
  assert.ok(text.includes('src'), 'directories stay visible');

  input.value = 'readme';
  input.dispatch('input');
  const text2 = treeRowTexts(h.container);
  assert.ok(text2.includes('readme.md'), 'different keyword matches');
  assert.ok(!text2.includes('index.html'), 'earlier match now hidden');
});

test('glob pattern filter supports ^ $ * ? wildcards', async () => {
  const h = makeHarness({
    entries: [
      { name: '_main.py', type: 'file', size: 1 },
      { name: 'main.py', type: 'file', size: 2 },
      { name: 'utils.py', type: 'file', size: 3 },
      { name: '_notes.txt', type: 'file', size: 4 },
      { name: 'pack.pyc', type: 'file', size: 5 },
    ],
  });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(treeRowTexts(h.container).includes('main.py'), 'baseline');

  const input = findEls(h.container, { cls: 'filebrowser-filter' })[0];

  // ^_*.py → names starting with `_` and ending in `.py`.
  input.value = '^_*.py';
  input.dispatch('input');
  let names = treeRowNames(h.container);
  assert.ok(names.includes('_main.py'), 'underscore-prefixed py kept');
  assert.ok(!names.includes('main.py'), 'non-underscore py filtered');
  assert.ok(!names.includes('utils.py'), 'plain py filtered by start anchor');
  assert.ok(!names.includes('_notes.txt'), 'wrong extension filtered');
  assert.ok(!names.includes('pack.pyc'), '.pyc must not match *.py');

  // *.py → every .py file, regardless of prefix.
  input.value = '*.py';
  input.dispatch('input');
  names = treeRowNames(h.container);
  assert.ok(names.includes('_main.py') && names.includes('utils.py') && names.includes('main.py'), 'all py files shown');
  assert.ok(!names.includes('_notes.txt'), 'txt filtered out');

  // ^main? → "main" + exactly one more character.
  input.value = '^main?';
  input.dispatch('input');
  names = treeRowNames(h.container);
  assert.ok(names.includes('main.py'), 'single-char wildcard matches');
  assert.ok(!names.includes('_main.py'), 'leading char blocks start anchor');

  // Trailing $ anchor.
  input.value = 'py$';
  input.dispatch('input');
  names = treeRowNames(h.container);
  assert.ok(names.includes('utils.py'), 'ends-with matches py file');
  assert.ok(!names.includes('pack.pyc'), 'ends-with rejects pyc');
});

test('show hidden toggle reveals dotfiles and noise dirs', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(!treeRowTexts(h.container).includes('.git'));

  const toggle = findEls(h.container, { cls: 'filebrowser-hidden' })[0];
  const checkbox = toggle.children[0];
  checkbox.checked = true;
  checkbox.dispatch('change');
  const text = treeRowTexts(h.container);
  assert.ok(text.includes('.git'), 'dotfile shown when hidden toggle on');
  assert.ok(text.includes('node_modules'), 'noise dir shown when hidden toggle on');
});

test('file click opens externally via bridge', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  const fileRow = findEls(h.container, { cls: 'fb-file', text: 'a.ts' })[0];
  assert.ok(fileRow, 'file row present');
  fileRow.dispatch('click');
  await TICKS();
  assert.ok(h.calls.some(([m, path]) => m === 'open' && path.endsWith('a.ts')), 'openExternalFile called');
});

test('task events collapse the browser while monitoring is needed', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(h.container.classList.contains('collapsed'), 'collapsed by default');

  // A user expands it, then task activity collapses it again.
  const toggleBtn = findEls(h.container, { cls: 'filebrowser-toggle' })[0];
  toggleBtn.dispatch('click');
  assert.ok(!h.container.classList.contains('collapsed'), 'user can expand');

  h.setMonitor(() => true);
  h.handler({ type: 'task_graph', tasks: [] });
  assert.ok(h.container.classList.contains('collapsed'), 'collapsed when tasks need monitoring');

  // Tasks finishing does NOT auto re-expand (manual choice).
  h.setMonitor(() => false);
  h.handler({ type: 'task_completed' });
  assert.ok(h.container.classList.contains('collapsed'), 'stays collapsed after tasks finish');
});

test('collapse button toggles the browser body', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  const btn = findEls(h.container, { cls: 'filebrowser-toggle' })[0];
  assert.ok(h.container.classList.contains('collapsed'), 'collapsed by default');
  btn.dispatch('click');
  assert.ok(!h.container.classList.contains('collapsed'), 'first click expands');
  btn.dispatch('click');
  assert.ok(h.container.classList.contains('collapsed'), 'second click collapses');
  btn.dispatch('click');
  assert.ok(!h.container.classList.contains('collapsed'), 'third click expands again');

  // The whole header bar is the collapsible panel: clicking it toggles too.
  const head = findEls(h.container, { cls: 'filebrowser-head' })[0];
  head.dispatch('click');
  assert.ok(h.container.classList.contains('collapsed'), 'header bar click collapses the panel');
  head.dispatch('click');
  assert.ok(!h.container.classList.contains('collapsed'), 'header bar click expands the panel');
});

test('idle timeout collapses the browser and interaction resets it', async () => {
  const h = makeHarness({ entries: PROJ });
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge, idleMs: 30 });
  await TICKS(); await TICKS();

  // Open it first (default is collapsed), then let it go idle.
  const toggleBtn = findEls(h.container, { cls: 'filebrowser-toggle' })[0];
  toggleBtn.dispatch('click');
  assert.ok(!h.container.classList.contains('collapsed'), 'expanded after user opens');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(h.container.classList.contains('collapsed'), 'collapsed after idle timeout');

  // Interaction re-arms the timer before any collapse.
  toggleBtn.dispatch('click');
  h.container.dispatch('pointerdown');
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(!h.container.classList.contains('collapsed'), 'interaction keeps it open');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(h.container.classList.contains('collapsed'), 'collapses again once idle resumes');
});

test('session_changed reloads the tree for the new project root', async () => {
  const h = makeHarness({ entries: PROJ });
  h.setListing('/proj2', [{ name: 'main.rs', type: 'file', size: 7 }]);
  mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(treeRowTexts(h.container).includes('a.ts'));

  h.setProjectDir('/proj2');
  h.handler({ type: 'session_changed', sessionId: 'x' });
  await TICKS(); await TICKS(); await TICKS();
  const text = treeRowTexts(h.container);
  assert.ok(text.includes('main.rs'), 'new root listed');
  assert.ok(!text.includes('a.ts'), 'old root cleared');
  assert.ok(h.calls.some(([m, root, path]) => m === 'list' && root === '/proj2'), 'listed under new root');
});

test('dispose removes DOM and unsubscribes from the event bus', async () => {
  const h = makeHarness({ entries: PROJ });
  const dispose = mountFileBrowser(h.container, h.ctx, { bridge: h.bridge });
  await TICKS(); await TICKS();
  assert.ok(h.container.children.length > 0, 'DOM mounted');
  assert.ok(h.handler, 'subscribed');

  dispose();
  assert.equal(h.container.children.length, 0, 'DOM removed on dispose');
  assert.equal(h.handler, null, 'unsubscribed on dispose');

  h.setMonitor(() => true);
  let threw = false;
  try { h.handler && h.handler({ type: 'task_started' }); } catch { threw = true; }
  assert.ok(!threw, 'post-dispose events are inert');
});