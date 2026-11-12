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

const baseState = (overrides = {}) => ({
  token: 'abcdef0123456789',
  url: 'nexus-preview://local/abcdef0123456789/test.png',
  kind: 'image',
  mime: 'image/png',
  size: 102400,
  name: 'test.png',
  ...overrides,
});

test('mountImageViewer creates img element with proper class', () => {
  const fn = mountImageViewer(baseState({ kind: 'image' }));
  const el = fn();
  assert.ok(el instanceof HTMLElement);
  assert.equal(el.className.includes('preview-viewer'), true);
  assert.equal(el.querySelectorAll('img').length, 1);
  const img = el.querySelector('img');
  assert.ok(img);
  assert.equal(img.getAttribute('src'), 'nexus-preview://local/abcdef0123456789/test.png');
  // draggable=false sets a property, not an attribute — use hasAttribute check
  assert.equal(img.hasAttribute('draggable'), false);
});

test('mountVideoViewer creates <video> for video kind', () => {
  const fn = mountVideoViewer(baseState({ kind: 'video', mime: 'video/mp4' }));
  const el = fn();
  assert.ok(el instanceof HTMLElement);
  assert.equal(el.querySelectorAll('video').length, 1);
  const vid = el.querySelector('video');
  assert.ok(vid);
  assert.equal(vid.hasAttribute('controls'), true);
});

test('mountVideoViewer creates <audio> for audio kind', () => {
  const fn = mountVideoViewer(baseState({ kind: 'audio', mime: 'audio/mpeg' }));
  const el = fn();
  assert.ok(el.querySelectorAll('audio').length > 0);
  const aud = el.querySelector('audio');
  assert.ok(aud);
  assert.equal(aud.hasAttribute('controls'), true);
});

test('mountPdfViewer creates iframe without sandbox restrictions on origin', () => {
  const fn = mountPdfViewer(baseState({ kind: 'pdf', url: 'nexus-preview://local/abcdef0123456789/test.pdf' }));
  const el = fn();
  assert.ok(el instanceof HTMLElement);
  assert.equal(el.querySelectorAll('iframe').length, 1);
  const iframe = el.querySelector('iframe');
  assert.ok(iframe);
  assert.equal(iframe.getAttribute('src'), 'nexus-preview://local/abcdef0123456789/test.pdf');
  // No sandbox attributes — PDF viewer needs full privileges.
  assert.equal(iframe.hasAttribute('sandbox'), false);
});

test('mountHtmlViewer creates sandboxed iframe blocking same-origin', () => {
  const fn = mountHtmlViewer(baseState({ kind: 'html' }));
  const el = fn();
  assert.equal(el.querySelectorAll('iframe').length, 1);
  const iframe = el.querySelector('iframe');
  assert.ok(iframe);
  // Sandbox allows scripts but NOT same-origin / popups / top-nav.
  assert.ok(iframe.getAttribute('sandbox')?.includes('allow-scripts'));
  assert.ok(!iframe.getAttribute('sandbox')?.includes('allow-same-origin'));
  assert.ok(!iframe.getAttribute('sandbox')?.includes('allow-popups'));
});

test('mountFallbackView shows message and open button', () => {
  const fn = mountFallbackView(baseState({ kind: 'unsupported', mime: '', size: 0, name: 'broken.exe' }));
  const el = fn();
  assert.ok(el instanceof HTMLElement);
  assert.ok(el.textContent?.includes('external') || el.textContent?.includes('预览') || el.textContent?.includes('Open'));
  const btn = el.querySelector('button');
  assert.ok(btn);
  assert.ok(btn.textContent?.trim().toLowerCase().includes('open'));
});

test('formatBytes formats correctly across ranges', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(500), '500 B');
  assert.match(formatBytes(2048), /KB/);
  assert.match(formatBytes(2 * 1024 * 1024), /MB/);
  assert.match(formatBytes(3 * 1024 * 1024 * 1024), /GB/);
});

test('all viewers return an HTMLElement', async () => {
  const testers = [
    { fn: mountImageViewer, state: baseState({ kind: 'image' }) },
    { fn: mountVideoViewer, state: baseState({ kind: 'video' }) },
    { fn: mountPdfViewer, state: baseState({ kind: 'pdf' }) },
    { fn: mountHtmlViewer, state: baseState({ kind: 'html' }) },
    { fn: mountFallbackView, state: baseState({ kind: 'unsupported' }) },
  ];
  for (const { fn, state } of testers) {
    // Each viewer returns a factory function; call it to get the actual DOM node.
    const factory = fn(state);
    const el = typeof factory === 'function' ? factory() : factory;
    assert.ok(el != null && typeof el === 'object' && ('nodeType' in el || 'tagName' in el),
      `viewer for ${state.kind} returned a DOM node (got ${typeof el})`);
  }
});
