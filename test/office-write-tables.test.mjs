import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// This test drives the REAL installed native office-write package (do NOT
// isolate HOME). It is skipped on machines where the package is not present,
// so the suite stays green everywhere while still guarding the capability
// (tables + ordered blocks) that the python-docx exec fallback exists to cover.
const nativeEntry = join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.nexus', 'native', 'extractors', 'office-write', 'index.mjs',
);

test('docx_write renders real tables via the native package (ordered blocks)', {
  skip: !nativeEntry || !existsSync(nativeEntry),
}, async () => {
  const { setPermissionPrompter } = await import(
    pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js'))
  );
  // Accept out-of-sandbox write prompts deterministically (no TTY under node --test).
  setPermissionPrompter(() => 'y');

  const { callBuiltinTool } = await import(pathToFileURL(join(dist, 'tools', 'index.js')));
  const outPath = join(mkdtempSync(join(tmpdir(), 'nexus-docx-tables-')), 'report.docx');

  const res = await callBuiltinTool('docx_write', {
    path: outPath,
    content: {
      blocks: [
        { type: 'heading', text: '1 总体漏斗', level: 1 },
        { type: 'paragraph', text: '全部 AOI 经五步筛选。' },
        { type: 'table', columns: ['步骤', '条件'], rows: [['1', '覆盖筛选'], ['2', '门限']] },
        { type: 'table', columns: ['数据'], rows: [['AOI 清单']] },
      ],
    },
  });
  assert.ok(!res.isError, String(res.content).slice(0, 300));
  const parsed = JSON.parse(String(res.content));
  assert.equal(parsed.artifact.status, 'done');
  assert.equal(parsed.artifact.meta.skill, 'docx.write');

  // A .docx is a zip; count real table elements to prove tables were rendered
  // (the pre-fix writeDocx silently dropped content.tables → 0 tables).
  const JSZip = require('jszip');
  const xml = await JSZip.loadAsync(readFileSync(outPath)).then(z => z.file('word/document.xml').async('string'));
  const tblCount = (xml.match(/<w:tbl>/g) || []).length;
  assert.ok(tblCount >= 2, `expected >=2 <w:tbl> elements, got ${tblCount}`);
  assert.ok(xml.includes('1A1A2E'), 'header-row shading should be present');

  try { rmSync(outPath, { force: true }); } catch {}
});

test('docx_write refuses empty content with a failed artifact (no silent blank file)', {
  skip: !nativeEntry || !existsSync(nativeEntry),
}, async () => {
  const { setPermissionPrompter } = await import(
    pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js'))
  );
  setPermissionPrompter(() => 'y');
  const { callBuiltinTool } = await import(pathToFileURL(join(dist, 'tools', 'index.js')));
  const outPath = join(mkdtempSync(join(tmpdir(), 'nexus-docx-empty-')), 'empty.docx');

  for (const content of [{}, { paragraphs: [] }, 'garbage-not-json']) {
    const res = await callBuiltinTool('docx_write', { path: outPath, content });
    const parsed = JSON.parse(String(res.content));
    assert.ok(res.isError, 'empty/blank content must be an error, not a done artifact');
    assert.equal(parsed.artifact.status, 'draft');
    // No blank / 0-byte file may be left behind.
    assert.ok(!existsSync(outPath) || readFileSync(outPath).length === 0, 'must not emit a blank file');
  }
});

test('docx_write normalizes a JSON-string content argument into a non-empty doc', {
  skip: !nativeEntry || !existsSync(nativeEntry),
}, async () => {
  const { setPermissionPrompter } = await import(
    pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js'))
  );
  setPermissionPrompter(() => 'y');
  const { callBuiltinTool } = await import(pathToFileURL(join(dist, 'tools', 'index.js')));
  const outPath = join(mkdtempSync(join(tmpdir(), 'nexus-docx-str-')), 'str.docx');
  const res = await callBuiltinTool('docx_write', {
    path: outPath,
    content: JSON.stringify({ blocks: [{ type: 'heading', text: 'H', level: 1 }, { type: 'paragraph', text: 'via string' }] }),
  });
  const parsed = JSON.parse(String(res.content));
  assert.equal(parsed.artifact.status, 'done');
  assert.ok(parsed.artifact.body.size > 0, 'string content should produce a non-empty file');
  try { rmSync(outPath, { force: true }); } catch {}
});
