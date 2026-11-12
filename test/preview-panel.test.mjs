/**
 * P0 Preview panel renderer tests — exercises the viewer DOM construction
 * headlessly under happy-dom (no real Electron required). Tests that each
 * viewer creates the right markup structure so the panel can render correctly.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
// Node 22 (Electron's runtime, and what CI runs) has no Web Storage globals;
// Node 26 does. The video viewer persists volume/speed via sessionStorage, so
// borrow happy-dom's implementation when the runtime has none.
globalThis.sessionStorage ??= win.sessionStorage;
// happy-dom does not polyfill HTMLElement globally by default in node --test.
// Set it explicitly so the viewers' instanceof checks work.
if (typeof globalThis.HTMLElement === 'undefined') {
  // eslint-disable-next-line no-undef
  globalThis.HTMLElement = win.HTMLElement;
}

const { mountImageViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'image.js')));
const { mountVideoViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'video.js')));
const { mountPdfViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'pdf.js')));
const { mountHtmlViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'html.js')));
const { mountFallbackView } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'fallback.js')));
const { formatBytes } = await import(pathToFileURL(join(dist, 'shared', 'preview.js')));

after(() => win.close());

/**
 * `baseState` now includes `path` (the real absolute source path) in addition
 * to the token/url/kind/mime/size/name fields the kernel requires.
 */
const baseState = (overrides = {}) => ({
  token: 'abcdef0123456789',
  url: 'nexus-preview://local/abcdef0123456789/test.png',
  path: '/tmp/test.png',
  kind: 'image',
  mime: 'image/png',
  size: 102400,
  name: 'test.png',
  ...overrides,
});

test('mountImageViewer creates img element with proper class', () => {
  const el = mountImageViewer(baseState({ kind: 'image' }));
  assert.ok(el instanceof HTMLElement);
  assert.equal(el.className.includes('preview-viewer'), true);
  assert.equal(el.querySelectorAll('img').length, 1);
  const img = el.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), 'nexus-preview://local/abcdef0123456789/test.png');
  // draggable=false sets a property, not an attribute — use hasAttribute check
  assert.equal(img.hasAttribute('draggable'), false);
});

test('mountImageViewer exposes zoomIn / zoomOut / fit control surface', () => {
  const el = mountImageViewer(baseState({ kind: 'image' }));
  assert.equal(typeof el.zoomIn, 'function');
  assert.equal(typeof el.zoomOut, 'function');
  assert.equal(typeof el.fit, 'function');
});

test('mountVideoViewer creates <video> for video kind', () => {
  const el = mountVideoViewer(baseState({ kind: 'video', mime: 'video/mp4' }));
  assert.ok(el instanceof HTMLElement);
  assert.equal(el.querySelectorAll('video').length, 1);
  const vid = el.querySelector('video');
  assert.ok(vid);
  assert.equal(vid.hasAttribute('controls'), true);
});

test('mountVideoViewer creates <audio> for audio kind', () => {
  const el = mountVideoViewer(baseState({ kind: 'audio', mime: 'audio/mpeg' }));
  assert.ok(el.querySelectorAll('audio').length > 0);
  const aud = el.querySelector('audio');
  assert.ok(aud);
  assert.equal(aud.hasAttribute('controls'), true);
});

test('mountPdfViewer creates iframe without sandbox restrictions on origin', () => {
  const el = mountPdfViewer(baseState({ kind: 'pdf', url: 'nexus-preview://local/abcdef0123456789/test.pdf' }));
  assert.ok(el instanceof HTMLElement);
  assert.equal(el.querySelectorAll('iframe').length, 1);
  const iframe = el.querySelector('iframe');
  assert.ok(iframe);
  assert.equal(iframe.getAttribute('src'), 'nexus-preview://local/abcdef0123456789/test.pdf');
  // No sandbox attributes — PDF viewer needs full privileges.
  assert.equal(iframe.hasAttribute('sandbox'), false);
});

test('mountHtmlViewer creates sandboxed iframe blocking same-origin', () => {
  const el = mountHtmlViewer(baseState({ kind: 'html' }));
  assert.equal(el.querySelectorAll('iframe').length, 1);
  const iframe = el.querySelector('iframe');
  assert.ok(iframe);
  // Sandbox allows scripts but NOT same-origin / popups / top-nav.
  assert.ok(iframe.getAttribute('sandbox')?.includes('allow-scripts'));
  assert.ok(!iframe.getAttribute('sandbox')?.includes('allow-same-origin'));
  assert.ok(!iframe.getAttribute('sandbox')?.includes('allow-popups'));
});

test('mountFallbackView shows message and open button using state.path', () => {
  const el = mountFallbackView(baseState({ kind: 'unsupported', mime: '', size: 0, name: 'broken.exe', path: '/tmp/broken.exe' }));
  assert.ok(el instanceof HTMLElement);
  assert.ok(el.textContent?.includes('external') || el.textContent?.includes('预览') || el.textContent?.includes('Open'));
  const btn = el.querySelector('button');
  assert.ok(btn);
  // The button label is i18n'd (docOpenExternal); accept the English or the
  // default zh-CN rendering so the test is language-agnostic.
  assert.ok(btn.textContent?.trim().toLowerCase().includes('open') || btn.textContent?.includes('打开'));
});

test('formatBytes formats correctly across ranges', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.match(formatBytes(2048), /KB/);
  assert.match(formatBytes(2 * 1024 * 1024), /MB/);
  assert.match(formatBytes(3 * 1024 * 1024 * 1024), /GB/);
});

test('all viewers return an HTMLElement directly (not a factory)', () => {
  const testers = [
    { fn: mountImageViewer, state: baseState({ kind: 'image' }) },
    { fn: mountVideoViewer, state: baseState({ kind: 'video' }) },
    { fn: mountPdfViewer, state: baseState({ kind: 'pdf' }) },
    { fn: mountHtmlViewer, state: baseState({ kind: 'html' }) },
    { fn: mountFallbackView, state: baseState({ kind: 'unsupported' }) },
  ];
  for (const { fn, state } of testers) {
    const el = fn(state);
    assert.ok(el != null && typeof el === 'object' && ('nodeType' in el || 'tagName' in el),
      `viewer for ${state.kind} returned a DOM node (got ${typeof el})`);
  }
});
