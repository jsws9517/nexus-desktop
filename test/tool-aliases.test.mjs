import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Isolate the native office-write package location so the alias test is
// deterministic: with HOME/USERPROFILE pointed at an empty dir, the
// office-write native entry is "not installed" and every resolved call must
// return the needs_package envelope — carrying the CANONICAL tool name.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-tool-aliases-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { BUILTIN_TOOL_ALIASES, INTERNAL_TOOLS, callBuiltinTool } = await import(
  pathToFileURL(join(dist, 'tools', 'index.js'))
);

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('BUILTIN_TOOL_ALIASES maps underscored variants of every dotted tool', () => {
  assert.equal(BUILTIN_TOOL_ALIASES['docx_write'], 'docx.write');
  assert.equal(BUILTIN_TOOL_ALIASES['pptx_write'], 'pptx.write');
  assert.equal(BUILTIN_TOOL_ALIASES['pdf_write'], 'pdf.write');
  assert.equal(BUILTIN_TOOL_ALIASES['bi_chart'], 'bi.chart');
  assert.equal(BUILTIN_TOOL_ALIASES['sheet_read'], 'sheet.read');
  assert.equal(BUILTIN_TOOL_ALIASES['sheet_analyze'], 'sheet.analyze');
  assert.equal(BUILTIN_TOOL_ALIASES['sheet_write'], 'sheet.write');
  // No alias for a name that is already canonical.
  assert.equal(BUILTIN_TOOL_ALIASES['docx.write'], undefined);
});

test('dotted tool names are registered and underscore variants are not', () => {
  assert.ok(INTERNAL_TOOLS.has('docx.write'));
  assert.ok(!INTERNAL_TOOLS.has('docx_write'));
});

test('callBuiltinTool resolves docx_write → docx.write', async () => {
  const res = await callBuiltinTool('docx_write', {
    path: join(process.cwd(), 'out.docx'),
    content: { paragraphs: ['hello'] },
  });
  const parsed = JSON.parse(String(res.content));
  assert.equal(parsed.code, 'needs_package', 'isolated HOME: package gate must fire');
  assert.equal(parsed.tool, 'docx.write', 'the canonical dotted name must reach the handler');
});

test('callBuiltinTool still reports unknown tools as not found', async () => {
  const res = await callBuiltinTool('totally_bogus_tool', {});
  assert.ok(res.isError);
  assert.match(String(res.content), /Tool "totally_bogus_tool" not found/);
});
