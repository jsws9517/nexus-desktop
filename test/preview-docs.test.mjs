/**
 * PR3 document preview — main-process parser (docx/xlsx/pptx),
 * artifact-body-first shortcut, LRU cache, and the doc-canvas viewer DOM
 * construction under happy-dom. Parsers are pure (no Electron import), so
 * they run straight under node --test against dist/.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// happy-dom globals first so the viewer modules (DOM at call time) work.
const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
if (typeof globalThis.HTMLElement === 'undefined') {
  globalThis.HTMLElement = win.HTMLElement;
}

const {
  parseDocx, parseXlsx, parsePptx, parseDocumentModel,
  docFromArtifactBody, DocCache,
} = await import(pathToFileURL(join(dist, 'main', 'preview-docs.js')));
const { mountViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'core.js')));
const { mountDocxViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'docx.js')));
const { mountXlsxViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'xlsx.js')));
const { mountPptxViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'pptx.js')));
// Viewer labels are i18n'd (default zh-CN). Pin English so the assertions
// below (written against the English strings) are deterministic.
const i18nMod = await import(pathToFileURL(join(dist, 'renderer', 'i18n.js')));
i18nMod.setUiLang('en');

after(() => win.close());

/** Flush microtasks so the viewers' async `loadDocument` resolves. */
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

const baseState = (overrides = {}) => ({
  token: 'tok-doc',
  url: 'nexus-preview://local/tok-doc/test.docx',
  path: '/tmp/test.docx',
  kind: 'docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 1024,
  name: 'test.docx',
  ...overrides,
});

// ── fixture builders ──────────────────────────────────────────────────────

const DOCX_BODY_XML = `
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>
  <w:p><w:r><w:t>Hello &amp; goodbye</w:t></w:r></w:p>
  <w:p><w:r><w:t>line1</w:t><w:tab/><w:t>line2</w:t><w:br/><w:t>line3</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Deep</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    </w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>Tail</w:t></w:r></w:p>
</w:body></w:document>`;

async function docxFixture(documentXml = DOCX_BODY_XML) {
  const zip = new JSZip();
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function xlsxFixture() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.getCell('A1').value = 'name'; ws.getCell('B1').value = 'qty';
  ws.getCell('A2').value = 'widget'; ws.getCell('B2').value = 42;
  ws.getCell('A3').value = { richText: [{ text: 'rich' }] }; ws.getCell('B3').value = 3.14;
  ws.getCell('A4').value = { formula: '1+1', result: 2 };
  ws.getCell('A5').value = { error: '#N/A' };
  ws.getCell('B5').value = new Date(Date.UTC(2026, 0, 1));
  return await wb.xlsx.writeBuffer();
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function pptxFixture() {
  const slide = (title, ...bullets) => {
    const runs = [title, ...bullets].map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('');
    return `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:pPr/><a:p>${''}</a:p>${runs}</a:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  };
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slide('Title One', 'Point a', 'Point b'));
  zip.file('ppt/slides/slide2.xml', slide('Two'));
  zip.file('ppt/slides/slide10.xml', slide('Ten'));
  zip.file('ppt/media/image1.png', PNG_1PX);
  zip.file('ppt/media/diagram.emf', Buffer.from([0x01, 0x02]));
  zip.file('ppt/slides/_rels/slide1.xml.rels',
    '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>');
  zip.file('ppt/slides/_rels/slide2.xml.rels',
    '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/diagram.emf"/></Relationships>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ── docx parser ───────────────────────────────────────────────────────────

test('parseDocx: headings (pStyle + outlineLvl), paragraphs, entities, tab/br', async () => {
  const doc = await parseDocx(await docxFixture(), 'test.docx');
  assert.equal(doc.kind, 'docx');
  assert.equal(doc.title, 'Intro');
  const blocks = doc.blocks;
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Intro' });
  assert.deepEqual(blocks[1], { type: 'paragraph', text: 'Hello & goodbye' });
  assert.deepEqual(blocks[2], { type: 'paragraph', text: 'line1\tline2\nline3' });
  assert.deepEqual(blocks[4], { type: 'heading', level: 2, text: 'Deep' });
  assert.deepEqual(blocks[6], { type: 'paragraph', text: 'Tail' });
});

test('parseDocx: flat table rows + nested-table raw-text fallback in document order', async () => {
  const doc = await parseDocx(await docxFixture(), 'test.docx');
  const blocks = doc.blocks;
  assert.deepEqual(blocks[3], { type: 'table', rows: [['A', 'B'], ['C', 'D']] });
  // Nested table → single raw-text cell (plan fallback), paragraphs newline-joined.
  assert.equal(blocks[5].type, 'table');
  assert.equal(blocks[5].rows.length, 1);
  assert.match(blocks[5].rows[0][0], /outer/);
  assert.match(blocks[5].rows[0][0], /inner/);
  // Tables stay in document order relative to paragraphs.
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'paragraph', 'table', 'heading', 'table', 'paragraph']);
});

// ── xlsx parser ───────────────────────────────────────────────────────────

test('parseXlsx: numbers stay numbers, rich/formula/error/Date normalize', async () => {
  const doc = await parseXlsx(await xlsxFixture(), 'book.xlsx');
  assert.equal(doc.kind, 'xlsx');
  assert.equal(doc.sheets.length, 1);
  const sheet = doc.sheets[0];
  assert.equal(sheet.name, 'Data');
  assert.equal(sheet.truncated, false);
  const [r1, r2, r3, r4, r5] = sheet.rows;
  assert.deepEqual(r1, ['name', 'qty']);
  assert.deepEqual(r2, ['widget', 42]);
  assert.equal(typeof r2[1], 'number');
  assert.equal(r3[0], 'rich');
  assert.equal(r3[1], 3.14);
  assert.equal(r4[0], 2); // formula → result number
  assert.equal(r5[0], '#N/A'); // error cell → display string
  assert.equal(r5[1], '2026-01-01T00:00:00.000Z'); // date → ISO string
  // Trailing all-empty rows are dropped (rowCount may over-report).
  for (const row of sheet.rows) assert.ok(row.some((c) => c !== ''), 'no all-empty rows survive');
});

// ── pptx parser ───────────────────────────────────────────────────────────

test('parsePptx: numeric slide order, titles/bullets, image inline, EMF skipped', async () => {
  const doc = await parsePptx(await pptxFixture(), 'deck.pptx');
  assert.equal(doc.kind, 'pptx');
  assert.deepEqual(doc.slides.map((s) => s.index), [1, 2, 10]);
  assert.equal(doc.slides[0].title, 'Title One');
  assert.deepEqual(doc.slides[0].bullets, ['Title One', 'Point a', 'Point b']);
  assert.ok(doc.slides[0].image?.startsWith('data:image/png;base64,'));
  assert.equal(doc.slides[0].imageMime, 'image/png');
  assert.equal(doc.slides[1].image, undefined); // EMF not inlined
  assert.equal(doc.truncated, undefined);
});

// ── dispatch + artifact-body-first ────────────────────────────────────────

test('parseDocumentModel dispatches on kind, null for non-doc kinds', async () => {
  const x = await parseDocumentModel(await docxFixture(), 'docx', 'a.docx');
  assert.equal(x?.kind, 'docx');
  const y = await parseDocumentModel(await xlsxFixture(), 'xlsx', 'a.xlsx');
  assert.equal(y?.kind, 'xlsx');
  const z = await parseDocumentModel(await pptxFixture(), 'pptx', 'a.pptx');
  assert.equal(z?.kind, 'pptx');
  assert.equal(await parseDocumentModel(Buffer.from('x'), 'image', 'a.png'), null);
});

test('docFromArtifactBody: docx markdown-lite, pptx slide splits, xlsx → null', () => {
  const docx = docFromArtifactBody('docx', 'a.docx', '# H1\n\npara one\npara two\n\n# H2');
  assert.ok(docx && docx.kind === 'docx');
  assert.equal(docx.title, 'H1');
  assert.deepEqual(docx.blocks, [
    { type: 'heading', level: 1, text: 'H1' },
    { type: 'paragraph', text: 'para one\npara two' },
    { type: 'heading', level: 1, text: 'H2' },
  ]);

  const pptx = docFromArtifactBody('pptx', 'a.pptx', 'Slide A\nbullet\n\n---\nSlide B');
  assert.ok(pptx && pptx.kind === 'pptx');
  assert.equal(pptx.slides.length, 2);
  assert.equal(pptx.slides[0].title, 'Slide A');
  assert.deepEqual(pptx.slides[0].bullets, ['Slide A', 'bullet']);
  assert.equal(pptx.slides[1].title, 'Slide B');

  assert.equal(docFromArtifactBody('xlsx', 'a.xlsx', 'col\nval'), null);
  assert.equal(docFromArtifactBody('docx', 'a.docx', ''), null);
});

// ── LRU cache ─────────────────────────────────────────────────────────────

test('DocCache: key is path|mtime|size, LRU eviction + get-refresh', () => {
  assert.equal(DocCache.key('/a/b.docx', 123, 456), '/a/b.docx|123|456');
  const c = new DocCache(2);
  const docA = { kind: 'docx', name: 'a', blocks: [] };
  const docB = { kind: 'docx', name: 'b', blocks: [] };
  const docC = { kind: 'docx', name: 'c', blocks: [] };
  c.set('a', docA);
  c.set('b', docB);
  c.get('b'); // refresh b → a is now the oldest
  c.set('c', docC); // evicts a
  assert.equal(c.size, 2);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), docB);
  assert.equal(c.get('c'), docC);
  c.clear();
  assert.equal(c.size, 0);
});

// ── doc-canvas viewer DOM (happy-dom) ────────────────────────────────────

function mockPreviewDocument(result) {
  win.nexusDesktop = {
    previewDocument: async () => result,
    previewRead: async () => ({ ok: false }),
    previewClose: async () => ({ ok: true }),
  };
}

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

test('mountDocxViewer renders doc-canvas (eyebrow/title/KPIs/blocks) + error state', async () => {
  mockPreviewDocument({ ok: true, source: 'parse', doc: DOCX_MODEL });
  const el = mountDocxViewer(baseState({ name: 'report.docx' }));
  assert.ok(el instanceof win.HTMLElement);
  assert.match(el.className, /preview-docx-viewer/);
  assert.match(el.className, /preview-doc-viewer/);
  // Loading skeleton is up until the async model load resolves.
  assert.notEqual(el.querySelector('.doc-loading'), null);
  await tick();
  assert.equal(el.querySelector('.doc-loading'), null);
  assert.equal(el.querySelector('.doc-eyebrow')?.textContent, 'DOCX · document');
  assert.equal(el.querySelector('.doc-title')?.textContent, 'Quarterly Report');
  assert.equal(el.querySelectorAll('.doc-kpi').length, 3);
  assert.equal(el.querySelectorAll('.doc-body p.doc-p').length, 1);
  assert.equal(el.querySelectorAll('.doc-body h2.doc-h').length, 1);
  assert.equal(el.querySelectorAll('.doc-body table.doc-table').length, 1);

  // Error state.
  mockPreviewDocument({ ok: false, error: 'outside allowed roots' });
  const el2 = mountDocxViewer(baseState());
  await tick();
  assert.match(el2.querySelector('.preview-error')?.textContent ?? '', /outside allowed roots/);
});

const XLSX_MODEL = {
  kind: 'xlsx',
  name: 'book.xlsx',
  sheets: [
    { name: 'Data', rows: [['name', 'qty'], ['widget', 42]] },
    { name: 'Extra', rows: [['x']], truncated: false },
  ],
};

test('mountXlsxViewer: sheet tabs, numeric right-align class, KPI switch', async () => {
  mockPreviewDocument({ ok: true, source: 'parse', doc: XLSX_MODEL });
  const el = mountXlsxViewer(baseState({ kind: 'xlsx', name: 'book.xlsx' }));
  assert.match(el.className, /preview-xlsx-viewer/);
  await tick();
  const tabs = el.querySelectorAll('.doc-sheet-tab');
  assert.equal(tabs.length, 2);
  assert.match(tabs[0].className, /active/);
  // Numbers get the right-align class, strings don't.
  const tds = el.querySelectorAll('.doc-xlsx-table td');
  assert.ok([...tds].some((td) => td.classList.contains('num')));
  assert.ok([...tds].some((td) => !td.classList.contains('num')));
  assert.match(el.querySelector('.doc-kpi-value')?.textContent ?? '', /Data/);
  // Switch to the second sheet.
  tabs[1].click();
  assert.match(tabs[1].className, /active/);
  assert.match(el.querySelector('.doc-kpi-value')?.textContent ?? '', /Extra/);
  // 'Extra' sheet: one header cell, no body rows → zero <td>.
  assert.equal(el.querySelectorAll('.doc-xlsx-table th').length, 1);
  assert.equal(el.querySelectorAll('.doc-xlsx-table td').length, 0);
});

const PPTX_MODEL = {
  kind: 'pptx',
  name: 'deck.pptx',
  slides: [
    { index: 1, title: 'S1', bullets: ['S1', 'b1'], image: 'data:image/png;base64,AAAA', imageMime: 'image/png' },
    { index: 2, title: 'S2', bullets: ['S2'] },
  ],
};

test('mountPptxViewer: pager, keyboard arrows, thumbnail, counter', async () => {
  mockPreviewDocument({ ok: true, source: 'parse', doc: PPTX_MODEL });
  const el = mountPptxViewer(baseState({ kind: 'pptx', name: 'deck.pptx' }));
  assert.match(el.className, /preview-pptx-viewer/);
  await tick();
  const counter = el.querySelector('.doc-slide-counter');
  assert.equal(counter?.textContent, '1 / 2');
  const prev = el.querySelector('.doc-slide-pager .doc-slide-btn');
  const next = el.querySelector('.doc-slide-pager .doc-slide-btn:last-child');
  assert.equal(prev.disabled, true);
  assert.ok(el.querySelector('.doc-slide img.doc-slide-image'));
  // Next → slide 2 (no thumbnail there), arrows via keydown too.
  next.click();
  assert.equal(el.querySelector('.doc-slide-counter')?.textContent, '2 / 2');
  assert.equal(el.querySelector('.doc-slide img'), null);
  assert.equal(next.disabled, true);
  const keydown = new win.KeyboardEvent('keydown', { key: 'ArrowLeft' });
  el.querySelector('.doc-body')?.dispatchEvent(keydown);
  assert.equal(el.querySelector('.doc-slide-counter')?.textContent, '1 / 2');
});

// ── dispatch in the kernel ────────────────────────────────────────────────

test('mountViewer routes docx/xlsx/pptx to the doc-canvas viewers (not fallback)', async () => {
  mockPreviewDocument({ ok: true, source: 'parse', doc: DOCX_MODEL });
  const d = mountViewer(baseState({ kind: 'docx' }));
  assert.match(d.className, /preview-docx-viewer/);
  assert.equal(d.className.includes('preview-fallback'), false);

  mockPreviewDocument({ ok: true, source: 'parse', doc: XLSX_MODEL });
  const x = mountViewer(baseState({ kind: 'xlsx', name: 'book.xlsx' }));
  assert.match(x.className, /preview-xlsx-viewer/);

  mockPreviewDocument({ ok: true, source: 'parse', doc: PPTX_MODEL });
  const p = mountViewer(baseState({ kind: 'pptx', name: 'deck.pptx' }));
  assert.match(p.className, /preview-pptx-viewer/);
});

// ── PR3 media viewer enhancements ─────────────────────────────────────────

test('pdf viewer: host-side zoom bar scales the iframe', async () => {
  const { mountPdfViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'pdf.js')));
  const el = mountPdfViewer(baseState({ kind: 'pdf', name: 'doc.pdf' }));
  const bar = el.querySelector('.preview-pdf-bar');
  assert.ok(bar);
  const label = el.querySelector('.preview-pdf-zoom-label');
  assert.equal(label.textContent, '100%');
  const iframe = el.querySelector('iframe');
  assert.ok(iframe);
  assert.equal(iframe.getAttribute('src'), baseState({ kind: 'pdf' }).url);
  el.zoomIn();
  assert.equal(label.textContent, '120%');
  assert.match(iframe.style.transform, /scale\(1\.2\)/);
  el.fit();
  assert.equal(label.textContent, '100%');
  assert.equal(iframe.style.transform, '');
});

test('image viewer: rotate bar + checkerboard class + zoom surface', async () => {
  const { mountImageViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'image.js')));
  const el = mountImageViewer(baseState({ kind: 'image' }));
  const img = el.querySelector('img.preview-img');
  assert.ok(img);
  // Checkerboard is a CSS class on the img (background shows through alpha).
  assert.equal(img.getAttribute('class'), 'preview-img');
  const btns = el.querySelectorAll('.preview-image-bar .preview-image-btn');
  assert.equal(btns.length, 3);
  // Rotate right → 90°, then left back to identity.
  btns[1].click();
  assert.match(img.style.transform, /rotate\(90deg\)/);
  btns[0].click();
  assert.doesNotMatch(img.style.transform, /rotate/); // 90 - 90 → 0° → identity
});

test('text viewer: line-number gutter, mono body, live search highlight', async () => {
  win.nexusDesktop = {
    previewRead: async () => ({ ok: true, text: 'alpha\nbeta\nalpha' }),
    previewClose: async () => ({ ok: true }),
  };
  const { mountTextViewer } = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'viewers', 'text.js')));
  const el = mountTextViewer(baseState({ kind: 'text', name: 'a.txt' }));
  // The viewer only renders once connected to a host DOM.
  win.document.body.appendChild(el);
  await tick();
  const gutter = el.querySelector('.preview-text-gutter');
  assert.equal(gutter.textContent, '1\n2\n3');
  const input = el.querySelector('.preview-text-search-input');
  assert.ok(input);
  // Debounced live search: type a query, wait past the 150ms debounce.
  input.value = 'alpha';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const marks = el.querySelectorAll('.preview-text-content mark.preview-text-match');
  assert.equal(marks.length, 2);
  assert.match(el.querySelector('.preview-text-search-count').textContent, /2 lines/);
});
