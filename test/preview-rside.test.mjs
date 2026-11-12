/**
 * PR2 right-sidebar rework tests — headless under happy-dom (no Electron):
 *   - rside-tabs: panel switch, persistence, invalid-id fallback
 *   - document dock (文件 tab): LRU eviction ≤8, viewer-node move
 *     stage↔stash, middle-click close, fullscreen overlay + Esc,
 *     fetch-failure tab drop
 *   - browser-tab (浏览器 panel): ≤4 LRU tabs, local iframe sandbox,
 *     external WebContentsView IPC state machine, fallback close, address-bar
 *     navigation, normalizeAddress
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const win = new Window({ url: 'http://localhost/' });
globalThis.window = win;
globalThis.document = win.document;
if (typeof globalThis.HTMLElement === 'undefined') {
  globalThis.HTMLElement = win.HTMLElement;
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = win.localStorage;
}

// ── fake IPC slice for the preview kernel (fetchPreview / revokePreview) ──
const revoked = [];
const previewOpenResults = new Map(); // path → result override
const defaultPreviewOpen = (path) => ({
  ok: true,
  token: `tok-${path.replace(/[^a-zA-Z0-9]/g, '')}`,
  url: `nexus-preview://local/tok-${path.replace(/[^a-zA-Z0-9]/g, '')}`,
  kind: path.toLowerCase().endsWith('.html') ? 'html' : 'image',
  mime: path.toLowerCase().endsWith('.html') ? 'text/html' : 'image/png',
  size: 1024,
  name: path.split(/[\\/]/).pop() ?? path,
});
globalThis.window.nexusDesktop = {
  previewOpen: async (path) => previewOpenResults.get(path) ?? defaultPreviewOpen(path),
  previewClose: async (token) => { revoked.push(token); return { ok: true }; },
  previewRead: async () => ({ ok: false, error: 'not in tests' }),
};

const { mountRsideTabs } = await import(pathToFileURL(join(dist, 'renderer', 'rside-tabs.js')));
const { mountDocDock } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'dock.js')));
const { mountBrowserTabs, normalizeAddress, MAX_BROWSER_TABS } = await import(pathToFileURL(join(dist, 'renderer', 'browser-tab.js')));

after(() => win.close());

const flush = () => new Promise((r) => setTimeout(r, 0));

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  document.body.appendChild(e);
  return e;
}

// ═══════════════════════════ rside-tabs ════════════════════════════

function rsideDom() {
  const nav = el('nav', 'rside-tabs');
  for (const p of ['info', 'files', 'browser', 'sidechat']) {
    const b = document.createElement('button');
    b.className = 'rside-tab' + (p === 'info' ? ' active' : '');
    b.dataset.panel = p;
    if (p === 'info') b.setAttribute('aria-selected', 'true');
    nav.appendChild(b);
  }
  const panels = el('div', 'rside-panels');
  for (const p of ['info', 'files', 'browser', 'sidechat']) {
    const d = document.createElement('div');
    d.className = 'rside-tab-panel' + (p === 'info' ? ' active' : '');
    d.dataset.panel = p;
    if (p !== 'info') d.hidden = true;
    panels.appendChild(d);
  }
  return { nav, panels };
}

test('rside-tabs: mount restores 信息 by default and fires activation', async () => {
  const { nav, panels } = rsideDom();
  const fired = [];
  const handle = mountRsideTabs(nav, panels, { onActivate: (p, prev) => fired.push([p, prev]) });
  assert.equal(handle.get(), 'info');
  assert.deepEqual(fired, [['info', null]]);
  assert.equal(panels.querySelector('[data-panel="info"]').hidden, false);
  assert.equal(panels.querySelector('[data-panel="files"]').hidden, true);
});

test('rside-tabs: clicking a panel swaps active state and persists', async () => {
  const { nav, panels } = rsideDom();
  const handle = mountRsideTabs(nav, panels);
  const filesBtn = nav.querySelector('[data-panel="files"]');
  filesBtn.click();
  assert.equal(handle.get(), 'files');
  assert.equal(panels.querySelector('[data-panel="files"]').hidden, false);
  assert.equal(panels.querySelector('[data-panel="info"]').hidden, true);
  assert.equal(filesBtn.classList.contains('active'), true);
  assert.equal(filesBtn.getAttribute('aria-selected'), 'true');
  assert.equal(win.localStorage.getItem('nexus.right-sidebar.panel'), 'files');
});

test('rside-tabs: a fresh mount restores the persisted panel', async () => {
  win.localStorage.setItem('nexus.right-sidebar.panel', 'browser');
  const { nav, panels } = rsideDom();
  const handle = mountRsideTabs(nav, panels);
  assert.equal(handle.get(), 'browser');
  assert.equal(panels.querySelector('[data-panel="browser"]').hidden, false);
  assert.equal(panels.querySelector('[data-panel="info"]').hidden, true);
  win.localStorage.removeItem('nexus.right-sidebar.panel');
});

test('rside-tabs: invalid set() falls back to 信息; set() of same panel re-fires', async () => {
  const { nav, panels } = rsideDom();
  const fired = [];
  const handle = mountRsideTabs(nav, panels, { onActivate: (p, prev) => fired.push([p, prev]) });
  handle.set('bogus');
  assert.equal(handle.get(), 'info');
  handle.set('info');
  assert.equal(fired.length, 3); // initial + bogus-fallback + same-panel re-fire
});

// ═══════════════════════════ document dock ═════════════════════════

function dockDom() {
  return {
    strip: el('div', 'doc-tab-strip'),
    stage: el('div', 'doc-tab-stage'),
    stash: el('div', 'doc-tab-stash'),
    overlay: el('div', 'preview-overlay hidden'),
  };
}

test('dock: LRU eviction caps the strip at 8 documents', async () => {
  const d = dockDom();
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  for (let i = 1; i <= 9; i++) {
    assert.equal(await dock.open(`C:/docs/a${i}.png`), true);
  }
  await flush();
  assert.equal(dock.list().length, 8);
  // a1 was evicted first (oldest LRU); a2 is now the head.
  assert.equal(dock.list()[0].path, 'C:/docs/a2.png');
  assert.ok(dock.list().some((t) => t.path === 'C:/docs/a9.png'));
  assert.ok(!dock.list().some((t) => t.path === 'C:/docs/a1.png'));
});

test('dock: viewer nodes move stage↔stash on switch (state preserved)', async () => {
  const d = dockDom();
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  assert.equal(await dock.open('C:/docs/one.png'), true);
  assert.equal(await dock.open('C:/docs/two.png'), true);
  await flush();
  const one = dock.list().find((t) => t.path === 'C:/docs/one.png');
  const two = dock.list().find((t) => t.path === 'C:/docs/two.png');
  assert.equal(dock.active().id, two.id); // most-recently-opened is active
  assert.equal(d.stage.contains(two.viewer), true);
  assert.equal(d.stash.contains(one.viewer), true);
  // switch back: the SAME node instance moves (no remount)
  const oneBefore = one.viewer;
  const twoBefore = two.viewer;
  // Activate `one` by re-opening (touch + activate).
  assert.equal(await dock.open('C:/docs/one.png'), true);
  assert.equal(dock.active().id, one.id);
  assert.equal(d.stage.contains(oneBefore), true);
  assert.equal(d.stash.contains(twoBefore), true);
  assert.equal(dock.list().find((t) => t.path === 'C:/docs/one.png').viewer, oneBefore);
});

test('dock: middle-click closes a tab', async () => {
  const d = dockDom();
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  assert.equal(await dock.open('C:/docs/x.png'), true);
  assert.equal(await dock.open('C:/docs/y.png'), true);
  await flush();
  assert.equal(dock.list().length, 2);
  const chip = d.strip.querySelector('.doc-tab[title="C:/docs/x.png"]') ?? d.strip.children[0];
  chip.dispatchEvent(new win.MouseEvent('auxclick', { button: 1, bubbles: true }));
  assert.equal(dock.list().length, 1);
  assert.equal(dock.list()[0].path, 'C:/docs/y.png');
});

test('dock: unsupported paths are rejected (external fallback reachable)', async () => {
  const d = dockDom();
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  assert.equal(await dock.open('C:/docs/app.exe'), false);
  assert.equal(dock.list().length, 0);
});

test('dock: fetch failure drops the placeholder tab (no zombie tabs)', async () => {
  const d = dockDom();
  previewOpenResults.set('C:/docs/forbidden.png', { ok: false, error: '403 forbidden' });
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  assert.equal(await dock.open('C:/docs/forbidden.png'), true); // placeholder accepted
  await flush(); // loadRec resolves, sees the error, drops the tab
  assert.equal(dock.list().length, 0);
  previewOpenResults.delete('C:/docs/forbidden.png');
});

test('dock: fullscreen moves the active viewer into the overlay; Esc returns it', async () => {
  const d = dockDom();
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  assert.equal(await dock.open('C:/docs/full.png'), true);
  await flush();
  const viewer = dock.active().viewer;
  dock.toggleFullscreen();
  assert.ok(d.overlay.classList.contains('visible'));
  assert.ok(d.overlay.querySelector('.preview-overlay-title'));
  assert.ok(d.overlay.querySelector('.preview-overlay-bar'));
  const holder = d.overlay.querySelector('.preview-overlay-stage');
  assert.ok(holder.contains(viewer));
  // Esc on the overlay exits back to the dock stage.
  d.overlay.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(d.overlay.classList.contains('hidden'));
  assert.ok(d.stage.contains(viewer));
});

test('dock: dispose revokes tokens; closeAll removes every viewer', async () => {
  const d = dockDom();
  const dock = mountDocDock({ ...d, getLang: () => 'en' });
  const before = revoked.length; // earlier tests revoke; measure the delta
  assert.equal(await dock.open('C:/docs/rev1.png'), true);
  assert.equal(await dock.open('C:/docs/rev2.png'), true);
  await flush();
  assert.equal(revoked.length, before); // open revokes nothing yet
  dock.closeAll();
  assert.equal(dock.list().length, 0);
  assert.equal(revoked.length, before + 2);
});

// ═══════════════════════════ browser tabs ══════════════════════════

function fakeBrowserIpc() {
  const calls = { open: [], back: [], forward: [], reload: [], close: [], bounds: [] };
  const handlers = [];
  let viewSeq = 0;
  const ipc = {
    webviewOpen: async (url, bounds, viewId, hidden) => {
      const id = viewId ?? `webview-${++viewSeq}`;
      const rec = { url, viewId, hidden, returned: null };
      calls.open.push(rec);
      if (url.includes('dead')) return { ok: false, error: 'unsupported scheme — opened in system handler' };
      rec.returned = id;
      return { ok: true, viewId: id };
    },
    webviewBack: async (viewId) => { calls.back.push(viewId); return { ok: true }; },
    webviewForward: async (viewId) => { calls.forward.push(viewId); return { ok: true }; },
    webviewReload: async (viewId) => { calls.reload.push(viewId); return { ok: true }; },
    webviewClose: async (viewId) => { calls.close.push(viewId); return { ok: true }; },
    webviewBounds: async (bounds, hidden) => { calls.bounds.push({ bounds, hidden }); return { ok: true }; },
    onWebviewEvent: (cb) => { handlers.push(cb); },
  };
  ipc.calls = calls;
  ipc.emit = (ev) => { for (const h of handlers) h(ev); };
  return ipc;
}

test('normalizeAddress: url / bare domain / local path / empty rules', () => {
  assert.deepEqual(normalizeAddress('example.com'), { kind: 'url', target: 'https://example.com' });
  assert.deepEqual(normalizeAddress('https://x.dev/p'), { kind: 'url', target: 'https://x.dev/p' });
  assert.deepEqual(normalizeAddress('C:\\work\\page.html'), { kind: 'local', target: 'C:\\work\\page.html' });
  assert.deepEqual(normalizeAddress('/tmp/a/b.html'), { kind: 'local', target: '/tmp/a/b.html' });
  assert.equal(normalizeAddress(''), null);
  assert.equal(normalizeAddress('   '), null);
});

test('browser: external tabs cap at 4 (LRU eviction)', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: () => {} });
  assert.equal(MAX_BROWSER_TABS, 4);
  for (const n of [1, 2, 3, 4, 5]) await bt.openUrl(`https://host${n}.example.com`);
  assert.equal(bt.list().length, 4);
  assert.ok(bt.list().some((t) => t.url === 'https://host5.example.com'));
  assert.ok(!bt.list().some((t) => t.url === 'https://host1.example.com'));
});

test('browser: local file opens as a sandboxed iframe without same-origin', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: () => {} });
  const ok = await bt.openLocalFile('C:\\work\\site.html');
  assert.equal(ok, true);
  const active = bt.active();
  assert.equal(active.kind, 'local');
  const frame = root.querySelector('.browser-local-frame');
  assert.ok(frame, 'iframe present in DOM');
  // iframe.sandbox is a DOMTokenList at runtime (happy-dom + real DOM) → .contains()
  assert.ok(!frame.sandbox.contains('allow-same-origin'));
  assert.ok(frame.sandbox.contains('allow-scripts'));
});

test('browser: webviewOpen failure closes the tab and notifies', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const notices = [];
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: (m) => notices.push(m) });
  await bt.openUrl('https://dead.example.com');
  assert.equal(bt.list().length, 0);
  assert.ok(notices.length > 0);
});

test('browser: main-side fallback event closes the tab + toasts', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const notices = [];
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: (m) => notices.push(m) });
  await bt.openUrl('https://flaky.example.com');
  assert.equal(bt.list().length, 1);
  ipc.emit({ viewId: ipc.calls.open[0].returned, type: 'fallback', url: 'https://flaky.example.com', error: 'net::ERR' });
  assert.equal(bt.list().length, 0);
  assert.ok(notices.length > 0);
});

test('browser: back/forward/reload route to the active view id', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: () => {} });
  await bt.openUrl('https://nav.example.com');
  const viewId = ipc.calls.open[0].returned;
  assert.equal(bt.active().viewId, viewId);
  await bt.back();
  await bt.forward();
  bt.reload();
  assert.deepEqual(ipc.calls.back, [viewId]);
  assert.deepEqual(ipc.calls.forward, [viewId]);
  assert.deepEqual(ipc.calls.reload, [viewId]);
});

test('browser: address-bar navigation converts the active local tab in place', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: () => {} });
  await bt.openLocalFile('C:\\work\\page.html');
  assert.equal(bt.active().kind, 'local');
  await bt.navigateActive('https://converted.example.com');
  assert.equal(bt.list().length, 1);
  const active = bt.active();
  assert.equal(active.kind, 'external');
  assert.equal(active.url, 'https://converted.example.com');
  assert.ok(active.viewId, 'a WebContentsView id was assigned');
});

test('browser: title events rename the tab; hidden panels hide the views', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: () => {} });
  await bt.openUrl('https://title.example.com');
  const viewId = ipc.calls.open[0].returned;
  ipc.emit({ viewId, type: 'title', title: 'My Page' });
  assert.equal(bt.active().name, 'My Page');
  bt.setPanelVisible(false);
  assert.equal(ipc.calls.bounds.at(-1).hidden, true);
  bt.setPanelVisible(true);
  assert.equal(ipc.calls.bounds.at(-1).hidden, false);
});

test('browser: dispose closes every view and removes the DOM', async () => {
  const root = el('div', 'browser-tab-root');
  const ipc = fakeBrowserIpc();
  const bt = mountBrowserTabs({ root, getLang: () => 'en', ipc, notify: () => {} });
  await bt.openUrl('https://gone1.example.com');
  await bt.openUrl('https://gone2.example.com');
  const closesBefore = ipc.calls.close.length;
  bt.dispose();
  assert.equal(ipc.calls.close.length - closesBefore, 2);
  assert.equal(root.querySelector('.browser-tab-strip'), null);
});
