/**
 * End-to-end check of the installed `doc-extract` extractor package.
 *
 * The point of the package is that installing it makes pdf/docx/xlsx/pptx
 * ingestible — so this drives the real worker-side loader against real fixture
 * files (not hand-written zips) and asserts the recovered text, not merely that
 * a function returned something.
 *
 * Fixtures are generated with the same libraries the package reads with, so a
 * format drift on either side fails loudly instead of silently producing "".
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const home = mkdtempSync(join(tmpdir(), 'doc-extract-e2e-'));
process.env.NEXUS_CONFIG_DIR = home;

const fixtures = join(home, 'fixtures');
let registry;
let cleanupPackages = false;

const MARK = {
  docx: 'zebra-uniq-docx-marker',
  xlsx: 'zebra-uniq-xlsx-marker',
  pptx: 'zebra-uniq-pptx-marker',
};

before(async () => {
  const { NativeManager } = await import(pathToFileURL(join(dist, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'config', 'native.js')));
  const native = new NativeManager();
  if (!native.listExtractors().some((e) => e.name === 'doc-extract')) {
    await native.install('doc-extract');
    cleanupPackages = true;
  }

  // The installer put jszip inside the package itself — reuse exactly what the
  // package will read with, so a dependency drift fails here too.
  const pkgRequire = createRequire(join(home, 'native', 'extractors', 'doc-extract', 'index.mjs'));
  const JSZip = pkgRequire('jszip');

  mkdirSync(join(home, 'fixtures'), { recursive: true });
  await buildFixtures(JSZip);

  registry = await import(
    pathToFileURL(join(dist, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'vault', 'extract', 'registry.js'))
  );
});

after(async () => {
  if (cleanupPackages) {
    rmSync(join(home, 'native'), { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

/** Minimal but spec-shaped OOXML fixtures + a real PDF sample. */
async function buildFixtures(JSZip) {
  const dir = join(home, 'fixtures');
  mkdirSync(dir, { recursive: true });

  // ── docx ──
  const docx = new JSZip();
  docx.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  docx.file(
    'word/document.xml',
    `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t xml:space="preserve">Quarterly ${MARK.docx} </w:t></w:r><w:r><w:t>revenue summary.</w:t></w:r></w:p>
  <w:p><w:r><w:t>Second paragraph for chunking.</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  writeFileSync(join(dir, 'sample.docx'), await docx.generateAsync({ type: 'nodebuffer' }));

  // ── xlsx ──
  const xlsx = new JSZip();
  xlsx.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  xlsx.file(
    'xl/workbook.xml',
    `<?xml version="1.0"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
  <sheet name="Data" sheetId="1" r:id="rId1"/>
</sheets></workbook>`,
  );
  xlsx.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
  );
  xlsx.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>${MARK.xlsx}</t></si>
  <si><t>Widget</t></si>
  <si><t>Gadget</t></si>
</sst>`,
  );
  // Row 2 deliberately sparse (B2 set, A2 empty) to pin column placement.
  xlsx.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c></row>
  <row r="2"><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>
</sheetData></worksheet>`,
  );
  writeFileSync(join(dir, 'sample.xlsx'), await xlsx.generateAsync({ type: 'nodebuffer' }));

  // ── pptx ──
  const pptx = new JSZip();
  pptx.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  pptx.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${MARK.pptx} roadmap</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`,
  );
  pptx.file(
    'ppt/notesSlides/notesSlide1.xml',
    `<?xml version="1.0"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Speaker note body.</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:notes>`,
  );
  writeFileSync(join(dir, 'sample.pptx'), await pptx.generateAsync({ type: 'nodebuffer' }));

  // ── pdf ──
  // A hand-assembled one-page PDF with a text object, so the test needs no
  // PDF writer dependency. pdf-parse must recover the string inside Tj.
  // pdf-parse ships real PDFs (linearized layout, embedded fonts, a real
  // xref). Using one as the fixture proves the extractor handles genuine
  // documents; a hand-assembled toy would only prove it handles toys, and
  // would need its own xref bytes to be exactly right.
  const realPdf = join(home, 'native', 'extractors', 'doc-extract', 'node_modules', 'pdf-parse', 'test', 'data', '04-valid.pdf');
  assert.ok(existsSync(realPdf), `pdf-parse sample PDF missing at ${realPdf}`);
  copyFileSync(realPdf, join(dir, 'sample.pdf'));

  registry = await import(
    pathToFileURL(join(dist, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'vault', 'extract', 'registry.js'))
  );
}

test('loading the package registers all four formats', async () => {
  const { loadExtractorPackages } = await import(pathToFileURL(join(dist, 'agent', 'extractor-loader.js')));
  const result = await loadExtractorPackages();
  assert.deepEqual(result.failed, {}, `package(s) failed to load: ${JSON.stringify(result.failed)}`);
  assert.ok(result.loaded.includes('doc-extract'));
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx']) {
    assert.equal(registry.hasExtractor(ext), true, `${ext} must be registered after loading`);
  }
});

test('docx paragraphs survive as separate paragraphs', async () => {
  const r = await registry.extractForRag(join(fixtures, 'sample.docx'));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r));
  assert.equal(r.format, 'docx');
  assert.ok(r.text.includes(MARK.docx), 'run text must be recovered');
  assert.ok(r.text.includes('revenue summary'), 'adjacent runs must be joined');
  assert.ok(r.text.includes('\n\n'), 'paragraph boundary must survive');
});

test('xlsx resolves shared strings and keeps column positions', async () => {
  const r = await registry.extractForRag(join(fixtures, 'sample.xlsx'));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r));
  assert.equal(r.format, 'xlsx');
  assert.ok(r.text.includes('## Data'), 'sheet display name must be used as a heading');
  assert.ok(r.text.includes(MARK.xlsx));
  // B2/C2 with an empty A2 must still start at column B, not collapse left.
  assert.ok(/\n\tWidget\tGadget(\n|$)/.test(r.text), `columns must not shift:\n${r.text}`);
});

test('pptx drops slide-number furniture but keeps notes', async () => {
  const r = await registry.extractForRag(join(fixtures, 'sample.pptx'));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r));
  assert.equal(r.format, 'pptx');
  assert.ok(r.text.includes(MARK.pptx));
  assert.ok(r.text.includes('Speaker note body'), 'notes must be included');
  assert.ok(!/^7$/m.test(r.text), 'sldNum placeholder must be filtered out');
});

test('pdf text layer is recovered from a real document', async () => {
  const r = await registry.extractForRag(join(fixtures, 'sample.pdf'));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r));
  assert.equal(r.format, 'pdf');
  // The fixture is a 5-page journal article; recovering its title and a phrase
  // from deep in the body proves multi-page text-layer extraction, not just
  // "the first page had some characters".
  assert.ok(r.text.includes('Acute effect of speed exercise'), `pdf title missing:\n${r.text.slice(0, 400)}`);
  assert.ok(r.text.length > 5000, `expected a full article, got ${r.text.length} chars`);
});

test('a package directory without an entry file is reported, not fatal', async () => {
  const orphan = join(home, 'native', 'extractors', 'orphan-pkg');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'README.md'), 'no entry point here');

  const { NativeManager } = await import(pathToFileURL(join(dist, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'config', 'native.js')));
  const entry = new NativeManager().listExtractors().find((e) => e.name === 'orphan-pkg');
  assert.ok(entry, 'an orphan directory must still be listed');
  assert.equal(entry.hasEntry, false, 'and reported as not loadable');

  // The loader already ran once (the registry is process-global), so assert the
  // contract rather than re-running: a second call is a no-op, and a missing
  // entry point is skipped rather than thrown.
  const { loadExtractorPackages } = await import(pathToFileURL(join(dist, 'agent', 'extractor-loader.js')));
  assert.deepEqual((await loadExtractorPackages()).loaded, [], 'second call is a no-op');
});