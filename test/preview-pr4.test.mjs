/**
 * PR4 — shortcut zoom surfaces, i18n (no hardcoded labels), inline preview
 * card, and the mountViewer dispatch table under happy-dom.
 *
 * - 4.1: every doc viewer exposes a zoomIn/zoomOut/fit surface (canvas zoom)
 *        so the global + / - / F shortcuts hit all of them.
 * - 4.2: labels follow the UI language (mount per language, assert text) —
 *        proof the viewers no longer hardcode English/Chinese.
 * - 4.4: mountViewer dispatch for all media/text kinds + the fallback, and
 *        createInlinePreviewCard DOM / preview-source toggle / dispose.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
if (typeof globalThis.HTMLElement === 'undefined') {
  globalThis.HTMLElement = win.HTMLElement;
}

const { mountViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'core.js')));
const { mountDocxViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'docx.js')));
const { mountPptxViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'pptx.js')));
const { mountFallbackView } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'fallback.js')));
const { mountTextViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'text.js')));
const { createInlinePreviewCard } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'inline.js')));
const i18n = await import(pathToFileURL(join(dist, 'renderer', 'i18n.js')));

after(() => win.close());

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A full PreviewState with a sane kind-specific shape. */
const mkState = (kind, overrides = {}) => ({
  token: `tok-${kind}`,
  url: `nexus-preview://local/tok-${kind}/x.${kind}`,
  path: `C:/docs/x.${kind === 'unsupported' ? 'bin' : kind}`,
  kind,
  mime: kind === 'pdf' ? 'application/pdf' : 'text/plain',
  size: 512,
  name: `x.${kind}`,
  ...overrides,
});

const DOCX_MODEL = {
  kind: 'docx',
  name: 'report.docx',
  title: 'Quarterly Report',
  blocks: [
    { type: 'heading', level: 1, text: 'Quarterly Report' },
    { type: 'paragraph', text: 'Body text.' },
    { type: 'table', rows: [['H1', 'H2'], ['a', 'b']] },
  ],
};
const PPTX_MODEL = {
  kind: 'pptx',
  name: 'deck.pptx',
  slides: [
    { index: 1, title: 'S1', bullets: ['S1', 'b1'], image: 'data:image/png;base64,AAAA', imageMime: 'image/png' },
    { index: 2, title: 'S2', bullets: ['S2'] },
  ],
};

/** Install a recording nexusDesktop mock (extend per-test as needed). */
function mockNexus(overrides = {}) {
  const calls = { previewClose: [], previewRead: [], previewOpen: [], previewDocument: [] };
  win.nexusDesktop = {
    previewOpen: async (path) => { calls.previewOpen.push(path); return { ok: true, token: 'tok-i', url: 'nexus-preview://local/tok-i', kind: 'text', mime: 'text/plain', size: 9, name: 'x.txt', path }; },
    previewRead: async () => ({ ok: true, text: '# hello\nworld' }),
    previewClose: async (tok) => { calls.previewClose.push(tok); return { ok: true }; },
    previewDocument: async () => ({ ok: true, source: 'parse', doc: DOCX_MODEL }),
    revealFile: async () => ({ ok: true }),
    saveArtifact: async () => ({ ok: true }),
    openExternalFile: async () => ({ ok: true }),
    ...overrides,
  };
  return calls;
}

// ── 4.1 — every doc viewer exposes the zoom surface ───────────────────────

test('docx viewer: ±/fit zoom surface drives the canvas zoom', async () => {
  mockNexus({ previewDocument: async () => ({ ok: true, source: 'parse', doc: DOCX_MODEL }) });
  const el = mountDocxViewer(mkState('docx'));
  assert.match(el.className, /preview-docx-viewer/);
  assert.equal(typeof el.zoomIn, 'function');
  assert.equal(typeof el.zoomOut, 'function');
  assert.equal(typeof el.fit, 'function');
  const canvas = el.querySelector('.doc-canvas');
  assert.equal(canvas.style.zoom, '', 'no zoom applied until a shortcut fires');
  el.zoomIn();
  assert.equal(canvas.style.zoom, '1.1');
  el.zoomIn();
  assert.equal(canvas.style.zoom, '1.2');
  el.zoomOut();
  assert.equal(canvas.style.zoom, '1.1');
  el.fit();
  assert.equal(canvas.style.zoom, '1');
});

test('pptx viewer: zoom surface + arrow-key paging coexist', async () => {
  mockNexus({ previewDocument: async () => ({ ok: true, source: 'parse', doc: PPTX_MODEL }) });
  const el = mountPptxViewer(mkState('pptx'));
  assert.match(el.className, /preview-pptx-viewer/);
  assert.equal(typeof el.zoomIn, 'function');
  await tick();
  const canvas = el.querySelector('.doc-canvas');
  el.zoomIn();
  assert.equal(canvas.style.zoom, '1.1');
  // In-viewer ←/→ still pags the slides.
  const next = el.querySelector('.doc-slide-pager .doc-slide-btn:last-child');
  next.click();
  assert.equal(el.querySelector('.doc-slide-counter')?.textContent, '2 / 2');
});

test('text viewer: ±/fit scale the body font (gutter stays aligned)', async () => {
  const calls = mockNexus();
  const el = mountTextViewer(mkState('text'));
  win.document.body.appendChild(el);
  await tick();
  assert.equal(typeof el.zoomIn, 'function');
  const body = el.querySelector('.preview-text-body');
  assert.ok(body);
  const before = body.style.fontSize || '13px';
  el.zoomIn();
  assert.notEqual(body.style.fontSize, before);
  el.fit();
  assert.equal(body.style.fontSize, '13px');
  void calls;
});

test('text viewer: content + gutter render from the loaded source (regression: centered shrink-wrap)', async () => {
  const calls = mockNexus({ previewRead: async () => ({ ok: true, text: 'alpha\nbeta\ngamma' }) });
  const el = mountTextViewer(mkState('text'));
  win.document.body.appendChild(el);
  await tick();
  const content = el.querySelector('.preview-text-content');
  assert.ok(content, 'content column present');
  assert.equal(content.textContent, 'alpha\nbeta\ngamma', 'all lines rendered into the content column');
  const gutter = el.querySelector('.preview-text-gutter');
  assert.equal(gutter?.textContent, '1\n2\n3', 'line numbers 1..N');
  assert.ok(el.querySelector('.preview-text-search-input'), 'in-view search bar present');
  void calls;
});

test('styles.css: the text viewer fills the box (no centered shrink-wrap children)', () => {
  const css = readFileSync(join(__dirname, '..', 'static', 'styles.css'), 'utf8');
  const rule = css.match(/\.preview-text-viewer\s*\{[^}]*\}/g)?.find((r) => r.includes('flex-direction: column'));
  assert.ok(rule, '.preview-text-viewer column-flex rule found');
  assert.match(rule, /align-items:\s*stretch/, 'text/markdown children must stretch, not center (shrink-wrap bug)');
});

// ── 4.2 — labels follow the UI language (no hardcoded strings) ───────────

test('docx KPI labels + eyebrow follow the UI language', async () => {
  i18n.setUiLang('en');
  mockNexus({ previewDocument: async () => ({ ok: true, source: 'parse', doc: DOCX_MODEL }) });
  let el = mountDocxViewer(mkState('docx'));
  await tick();
  assert.equal(el.querySelector('.doc-eyebrow')?.textContent, 'DOCX · document');
  assert.deepEqual(
    [...el.querySelectorAll('.doc-kpi-label')].map((n) => n.textContent),
    ['Paragraphs', 'Tables', 'Words (approx)'],
  );
  el.remove();

  i18n.setUiLang('zh-CN');
  mockNexus({ previewDocument: async () => ({ ok: true, source: 'parse', doc: DOCX_MODEL }) });
  el = mountDocxViewer(mkState('docx'));
  await tick();
  assert.equal(el.querySelector('.doc-eyebrow')?.textContent, 'DOCX · 文档');
  assert.deepEqual(
    [...el.querySelectorAll('.doc-kpi-label')].map((n) => n.textContent),
    ['段落', '表格', '字数（约）'],
  );
  el.remove();
  i18n.setUiLang('zh-CN');
});

test('fallback viewer: message + open-external button follow the language', async () => {
  i18n.setUiLang('en');
  mockNexus();
  let el = mountFallbackView(mkState('unsupported'));
  assert.equal(el.querySelector('.preview-fallback-msg')?.textContent,
    'This file type cannot be previewed inline. Open with the default application instead.');
  assert.equal(el.querySelector('.btn')?.textContent, 'Open externally');
  el.remove();

  i18n.setUiLang('zh-CN');
  mockNexus();
  el = mountFallbackView(mkState('unsupported'));
  assert.match(el.querySelector('.preview-fallback-msg')?.textContent, /默认应用/);
  assert.equal(el.querySelector('.btn')?.textContent, '外部打开');
  el.remove();
  i18n.setUiLang('zh-CN');
});

test('pptx slide pager button labels follow the language', async () => {
  i18n.setUiLang('en');
  mockNexus({ previewDocument: async () => ({ ok: true, source: 'parse', doc: PPTX_MODEL }) });
  let el = mountPptxViewer(mkState('pptx'));
  await tick();
  assert.equal(el.querySelector('.doc-slide-btn')?.getAttribute('aria-label'), 'Previous slide');
  el.remove();

  i18n.setUiLang('zh-CN');
  mockNexus({ previewDocument: async () => ({ ok: true, source: 'parse', doc: PPTX_MODEL }) });
  el = mountPptxViewer(mkState('pptx'));
  await tick();
  assert.equal(el.querySelector('.doc-slide-btn')?.getAttribute('aria-label'), '上一张幻灯片');
  el.remove();
});

// ── 4.4 — mountViewer dispatch table ───────────────────────────────────────

test('mountViewer dispatches every media/text kind to the right viewer', async () => {
  mockNexus();
  const expectations = [
    ['image', /preview-image-viewer/],
    ['video', /preview-media-viewer/],
    ['audio', /preview-media-viewer/],
    ['pdf', /preview-pdf-viewer/],
    ['html', /preview-html-viewer/],
    ['markdown', /preview-text-viewer/],
    ['text', /preview-text-viewer/],
  ];
  for (const [kind, re] of expectations) {
    const el = mountViewer(mkState(kind));
    assert.match(el.className, re, `${kind} → ${el.className}`);
    assert.ok(!(el.className.includes('preview-fallback')), `${kind} must not fall back`);
    el.dispose?.();
  }
});

test('mountViewer falls back for unknown / unsupported kinds', async () => {
  mockNexus();
  for (const kind of ['zip', 'unsupported', 'pdfx']) {
    const el = mountViewer(mkState(kind));
    assert.match(el.className, /preview-fallback/, `${kind} → ${el.className}`);
    el.dispose?.();
  }
});

// ── 4.4 — inline preview card ───────────────────────────────────────────────

test('createInlinePreviewCard: DOM structure + preview/source toggle + dispose', async () => {
  const calls = mockNexus();
  const anchor = win.document.createElement('div');
  win.document.body.appendChild(anchor);

  const card = createInlinePreviewCard('C:/docs/x.txt', 'en', { after: anchor });
  assert.match(card.root.className, /inline-preview-card/);
  assert.equal(card.root.dataset.kind, 'text');
  assert.equal(anchor.nextElementSibling, card.root);
  await tick();
  assert.ok(card.root.querySelector('.ipc-stage'), 'stage present');
  assert.ok(card.root.querySelector('.preview-text-viewer'), 'viewer mounted into the stage');

  // preview/source toggle (text is a source kind).
  assert.equal(card.root.querySelector('.ipc-mode-badge')?.hidden, false);
  card.toggleSource();
  await tick();
  assert.ok(card.root.querySelector('.ipc-source'), 'source <pre> inserted on toggle');
  card.toggleSource();
  await tick();
  assert.equal(card.root.querySelector('.ipc-source'), null, 'source view removed on toggle back');

  // dispose revokes the token + removes the card.
  card.dispose();
  assert.equal(card.root.isConnected, false);
  assert.ok(calls.previewClose.includes('tok-i'), 'dispose revoked the preview token');
  anchor.remove();
});

test('createInlinePreviewCard: unsupported kind shows the unavailable status', async () => {
  mockNexus({ previewOpen: async () => ({ ok: false, error: 'outside allowed roots' }) });
  const anchor = win.document.createElement('div');
  win.document.body.appendChild(anchor);
  const card = createInlinePreviewCard('C:/docs/x.txt', 'en', { after: anchor, kind: 'unsupported' });
  await tick();
  const status = card.root.querySelector('.ipc-status');
  assert.match(status?.textContent ?? '', /unavailable/i);
  assert.equal(status?.classList.contains('error'), true);
  anchor.remove();
});

// ── 4.2 — STR completeness: every PR4 key has zh-CN + en ──────────────────

test('i18n: PR4 STR keys are defined in both languages', () => {
  const keys = [
    'docParsing', 'docEyebrow', 'docUnsupported', 'docNoSheets', 'docNoSlides',
    'docXlsxTruncated', 'docPptxTruncated',
    'docKpiParagraphs', 'docKpiTables', 'docKpiWords', 'docKpiSheets', 'docKpiSheet',
    'docKpiRows', 'docKpiColumns', 'docKpiSlides', 'docKpiPage',
    'docSlidePrev', 'docSlideNext', 'docImageRotateLeft', 'docImageRotateRight',
    'docTextSearchPlaceholder', 'docTextSearchCount', 'docTextTruncated',
    'docLoadFailed', 'docUnsupportedMsg', 'docUnimplMsg', 'docOpenExternal', 'docExternalFailed',
    'inlinePreviewFavorite', 'inlinePreviewLike', 'inlinePreviewMore',
  ];
  for (const key of keys) {
    const entry = i18n.STR[key];
    assert.ok(entry, `missing STR key ${key}`);
    assert.ok(typeof entry['zh-CN'] === 'string' && entry['zh-CN'].length > 0, `${key} zh-CN empty`);
    assert.ok(typeof entry.en === 'string' && entry.en.length > 0, `${key} en empty`);
  }
});
