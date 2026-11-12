import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Isolate the native package location: point HOME/USERPROFILE at an empty dir
// so the office-write entry resolves to the fake package below (the real one
// pulls in docx/pptxgenjs/pdfkit; a no-op stub is enough to exercise the
// dynamic-import path that the Windows file:// URL fix targets).
const tmp = mkdtempSync(join(tmpdir(), 'nexus-office-native-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const entryDir = join(tmp, '.nexus', 'native', 'extractors', 'office-write');
mkdirSync(entryDir, { recursive: true });
writeFileSync(
  join(entryDir, 'index.mjs'),
  [
    'export default {',
    '  writeDocx: async (content, outPath) => { globalThis.__officeDocx = { content, outPath }; },',
    '  writePptx: async () => {},',
    '  writePdf: () => {},',
    '};',
    '',
  ].join('\n'),
);

// Force every out-of-sandbox path prompt to deny, so the test is
// deterministic under `node --test` (the worker cwd stays auto-authorized).
const { setPermissionPrompter } = await import(
  pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js'))
);
setPermissionPrompter(() => 'n');

const { callBuiltinTool } = await import(pathToFileURL(join(dist, 'tools', 'index.js')));

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('docx_write dispatches into the native package via a Windows-safe file URL', async () => {
  delete globalThis.__officeDocx;
  const outPath = join(process.cwd(), 'office-native-probe.docx');
  const res = await callBuiltinTool('docx_write', {
    path: outPath,
    content: { title: 't', paragraphs: ['p'] },
  });
  const text = String(res.content);
  // Regression guard: the raw Windows path used to hit the ESM loader with
  // "Only URLs with a scheme in: file, data, and node are supported".
  assert.doesNotMatch(text, /Only URLs with a scheme/);
  assert.doesNotMatch(text, /Office write failed/, text);
  const parsed = JSON.parse(text);
  assert.equal(parsed.artifact.status, 'done');
  assert.equal(parsed.artifact.meta.skill, 'docx.write');
  assert.equal(globalThis.__officeDocx.outPath, outPath);
});
