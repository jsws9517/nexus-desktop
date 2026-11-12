/**
 * PR4 4.5 — generate the three minimal committed OOXML fixtures + their
 * expected-model JSON snapshots under test/fixtures/.
 *
 * The generator imports the DIST parser (dist/main/preview-docs.js), so the
 * snapshots match the shipped parser byte-for-byte. Run it once after
 * `npm run build`, then commit the generated files:
 *
 *   npm run build
 *   node scripts/generate-doc-fixtures.mjs
 *
 * Regenerate ONLY when a parser change is intended to shift the model shape;
 * the regression test (test/preview-fixtures.test.mjs) fails otherwise.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures');
mkdirSync(outDir, { recursive: true });

const { parseDocumentModel } = await import(pathToFileURL(join(root, 'dist', 'main', 'preview-docs.js')));

// ── 1. report.docx — headings, entities, tab/br runs, flat + nested table ─

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
  <w:p><w:r><w:t>Revenue &amp; growth overview</w:t></w:r></w:p>
  <w:p><w:r><w:t>North</w:t><w:tab/><w:t>South</w:t><w:br/><w:t>East</w:t></w:r></w:p>
  <w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>revenue</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>north</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>Notes follow</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    </w:tc></w:tr>
  </w:tbl>
</w:body>
</w:document>`;

async function buildDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', DOCX_XML);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ── 2. sales.xlsx — two sheets, typed cells ──────────────────────────────

async function buildXlsx() {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Q1');
  s1.getCell('A1').value = 'name';
  s1.getCell('B1').value = 'qty';
  s1.getCell('A2').value = 'widget';
  s1.getCell('B2').value = 42;
  s1.getCell('A3').value = { richText: [{ text: 'rich' }] };
  s1.getCell('B3').value = 3.14;
  s1.getCell('A4').value = { formula: '1+1', result: 2 };
  s1.getCell('A5').value = { error: '#N/A' };
  s1.getCell('B5').value = new Date(Date.UTC(2026, 0, 1));
  const s2 = wb.addWorksheet('Q2');
  s2.getCell('A1').value = 'name';
  s2.getCell('B1').value = 'qty';
  s2.getCell('A2').value = 'gadget';
  s2.getCell('B2').value = 7;
  return await wb.xlsx.writeBuffer();
}

// ── 3. deck.pptx — three slides (numeric order), one inlined image ──────

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function slideXml(title, ...bullets) {
  const runs = [title, ...bullets]
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('');
  return `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:pPr/>${runs}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
}

async function buildPptx() {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml('Title One', 'Point a', 'Point b'));
  zip.file('ppt/slides/slide3.xml', slideXml('Three'));
  zip.file('ppt/slides/slide7.xml', slideXml('Seven', 'Last point'));
  // slide1 → real PNG thumbnail (inlined); slide3 → EMF (skipped); slide7 → no rels.
  zip.file('ppt/media/image1.png', PNG_1PX);
  zip.file('ppt/media/diagram.emf', Buffer.from([0x01, 0x02]));
  zip.file('ppt/slides/_rels/slide1.xml.rels',
    '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>');
  zip.file('ppt/slides/_rels/slide3.xml.rels',
    '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/diagram.emf"/></Relationships>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

const CASES = [
  { kind: 'docx', name: 'report.docx', build: buildDocx },
  { kind: 'xlsx', name: 'sales.xlsx', build: buildXlsx },
  { kind: 'pptx', name: 'deck.pptx', build: buildPptx },
];

let failed = false;
for (const { kind, name, build } of CASES) {
  const buf = await build();
  writeFileSync(join(outDir, name), buf);
  const doc = await parseDocumentModel(buf, kind, name);
  if (!doc) {
    console.error(`generate-doc-fixtures: parser returned null for ${name} — aborting`);
    failed = true;
    break;
  }
  const expectedPath = join(outDir, `${name}.expected.json`);
  writeFileSync(expectedPath, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${name} (${buf.length}B) + snapshot`);
}
if (failed) process.exit(1);
console.log('fixture generation complete — run test/preview-fixtures.test.mjs to verify');
