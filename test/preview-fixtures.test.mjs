/**
 * PR4 4.5 — OOXML fixture regression: the three committed minimal fixtures
 * (report.docx / sales.xlsx / deck.pptx under test/fixtures/) are re-parsed
 * by the shipped dist parser and deep-compared against their committed
 * expected-model JSON snapshots. A parser change that shifts the model
 * shape fails here until the snapshots are regenerated on purpose via
 * `node scripts/generate-doc-fixtures.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const fixtures = join(__dirname, 'fixtures');

const docs = await import(pathToFileURL(join(dist, 'main', 'preview-docs.js')));
const shared = await import(pathToFileURL(join(dist, 'shared', 'preview.js')));
const parseDocumentModel = docs.parseDocumentModel;
const classify = shared.classify;

const CASES = [
  { file: 'report.docx', kind: 'docx' },
  { file: 'sales.xlsx', kind: 'xlsx' },
  { file: 'deck.pptx', kind: 'pptx' },
];

for (const { file, kind } of CASES) {
  test(`fixture ${file}: parse matches the committed snapshot`, async () => {
    // The fixture file's extension must still classify to the same kind.
    assert.equal(classify(file), kind, 'fixture classify() drifted');

    const buf = readFileSync(join(fixtures, file));
    const doc = await parseDocumentModel(buf, kind, file);
    assert.ok(doc, 'parser returned a model for the fixture');

    // Normalize both sides through a JSON round-trip: the parser emits
    // explicit `undefined` fields (image: undefined on slides without a
    // thumbnail) which JSON.stringify drops — the committed snapshots are
    // JSON, so compare the canonical forms.
    const actual = JSON.parse(JSON.stringify(doc));
    const expected = JSON.parse(readFileSync(join(fixtures, `${file}.expected.json`), 'utf8'));
    assert.deepEqual(actual, expected, 'parsed model diverges from the committed snapshot');
  });
}

test('fixtures: structural invariants of the committed models', () => {
  const docx = JSON.parse(readFileSync(join(fixtures, 'report.docx.expected.json'), 'utf8'));
  assert.equal(docx.kind, 'docx');
  assert.equal(docx.title, 'Quarterly Report');
  const types = docx.blocks.map((b) => b.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'paragraph', 'heading', 'table', 'paragraph', 'table']);
  // Nested table falls back to a single raw-text cell.
  const nested = docx.blocks.find((b) => b.rows?.length === 1 && b.rows[0].length === 1);
  assert.ok(nested, 'nested-table fallback cell present');
  assert.match(nested.rows[0][0], /outer/);
  assert.match(nested.rows[0][0], /inner/);

  const xlsx = JSON.parse(readFileSync(join(fixtures, 'sales.xlsx.expected.json'), 'utf8'));
  assert.equal(xlsx.kind, 'xlsx');
  assert.equal(xlsx.sheets.length, 2);
  assert.deepEqual(xlsx.sheets.map((s) => s.name), ['Q1', 'Q2']);
  const q1 = xlsx.sheets[0];
  assert.equal(q1.rows[1][1], 42); // plain number stays a number
  assert.equal(q1.rows[2][0], 'rich'); // rich text normalizes to display text
  assert.equal(q1.rows[3][0], 2); // formula → result
  assert.equal(q1.rows[4][0], '#N/A'); // error → display string
  assert.match(q1.rows[4][1], /^2026-01-01T/); // date → ISO string

  const pptx = JSON.parse(readFileSync(join(fixtures, 'deck.pptx.expected.json'), 'utf8'));
  assert.equal(pptx.kind, 'pptx');
  // slide1 / slide3 / slide7 → numeric (not lexicographic) ordering.
  assert.deepEqual(pptx.slides.map((s) => s.index), [1, 3, 7]);
  assert.ok(pptx.slides[0].image?.startsWith('data:image/png;base64,'), 'PNG thumbnail inlined');
  assert.equal(pptx.slides[0].imageMime, 'image/png');
  assert.equal(pptx.slides[1].image, undefined); // EMF thumbnail skipped
  assert.equal(pptx.slides[2].image, undefined); // no rels → no image
  // Enhanced layout: slide1 carries placed shapes + background; the rest
  // (no a:xfrm) fall back to the legacy layout (no shapes key in the JSON).
  assert.ok(Array.isArray(pptx.slides[0].shapes), 'slide1 shapes in the snapshot');
  assert.deepEqual(pptx.slides[0].shapes.map((s) => s.kind), ['text', 'image', 'table']);
  assert.ok(pptx.slides[0].background?.startsWith('data:image/png;base64,'), 'p:bg background inlined');
  assert.equal(pptx.sizeW, 12192000, 'p:sldSz width in the snapshot');
  assert.equal(pptx.sizeH, 6858000, 'p:sldSz height in the snapshot');
  assert.equal(pptx.slides[1].shapes, undefined, 'slide3 keeps the legacy layout');
});
