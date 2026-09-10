import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Isolate the path-authorizer's persisted grant file so tests never read the
// developer's real ~/.nexus/path-auth.json (same trick as security-tools).
const tmp = mkdtempSync(join(tmpdir(), 'nexus-skills-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.LLMA_DATA_DIR = tmp;

const { callSheetTool, SHEET_TOOLS, callChartTool, CHART_TOOLS } = await import(
  pathToFileURL(join(dist, 'tools', 'index.js'))
);
const { parseArtifactContent } = await import(pathToFileURL(join(dist, 'shared', 'artifact.js')));

// Force every out-of-sandbox path prompt to deny, so tests are deterministic
// under `node --test` (which gives the child no console to answer prompts on).
const { setPermissionPrompter } = await import(
  pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js')),
);
setPermissionPrompter(() => 'n');

const workDir = join(process.cwd(), '.sec-sheet');
mkdirSync(workDir, { recursive: true });

const csvPath = join(workDir, 'sales.csv');
writeFileSync(csvPath, 'month,amount\nJan,120\nFeb,260\nMar,90\n', 'utf8');

const xlsxPath = join(workDir, 'scores.xlsx');
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(['name', 'score']);
  ws.addRow(['alice', 90]);
  ws.addRow(['bob', 80]);
  ws.addRow(['carol', 95]);
  await wb.xlsx.writeFile(xlsxPath);
}

const ctx = { getConfig: () => ({}), requestWriteApproval: async () => true };

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

test('sheet tools are registered', () => {
  assert.ok(SHEET_TOOLS.has('sheet.read'));
  assert.ok(SHEET_TOOLS.has('sheet.analyze'));
  assert.ok(CHART_TOOLS.has('bi.chart'));
});

test('sheet.read parses a CSV file into a sheet artifact', async () => {
  const res = await callSheetTool('sheet.read', { path: csvPath }, ctx);
  assert.ok(!res.isError, res.content);
  const art = parseArtifactContent(res.content);
  assert.equal(art?.type, 'sheet');
  assert.deepEqual(art?.body.columns, ['month', 'amount']);
  assert.equal(art?.body.rowCount, 3);
  assert.deepEqual(art?.body.rows, [['Jan', 120], ['Feb', 260], ['Mar', 90]]);
});

test('sheet.read parses an XLSX workbook (first sheet)', async () => {
  const res = await callSheetTool('sheet.read', { path: xlsxPath }, ctx);
  assert.ok(!res.isError, res.content);
  const art = parseArtifactContent(res.content);
  assert.deepEqual(art?.body.columns, ['name', 'score']);
  assert.equal(art?.body.rowCount, 3);
});

test('sheet.read denies a path outside allowed roots', async () => {
  const res = await callSheetTool('sheet.read', { path: join(tmpdir(), 'nexus-outside.csv') }, ctx);
  assert.ok(res.isError, 'expected denial');
});

test('sheet.analyze profiles numeric columns deterministically', async () => {
  const res = await callSheetTool(
    'sheet.analyze',
    {
      data: {
        columns: ['month', 'amount'],
        rows: [['Jan', 120], ['Feb', 260], ['Mar', 90]],
      },
    },
    ctx,
  );
  assert.ok(!res.isError, res.content);
  const art = parseArtifactContent(res.content);
  const amount = art?.body.analysis.find((c) => c.name === 'amount');
  assert.equal(amount.type, 'number');
  assert.equal(amount.min, 90);
  assert.equal(amount.max, 260);
  assert.equal(amount.sum, 470);
  assert.equal(amount.avg, 470 / 3);
  const month = art?.body.analysis.find((c) => c.name === 'month');
  assert.equal(month.type, 'string');
  assert.equal(month.unique, 3);
});

test('unknown skill names error out', async () => {
  const res = await callSheetTool('nope', {}, ctx);
  assert.ok(res.isError);
});

test('bi.chart compiles a convenience-form spec into a chart artifact', async () => {
  const res = await callChartTool(
    'bi.chart',
    {
      data: { columns: ['month', 'amount'], rows: [['Jan', 120], ['Feb', 260]] },
      mark: 'bar',
      x: 'month',
      y: 'amount',
      title: 'Sales',
    },
    ctx,
  );
  assert.ok(!res.isError, res.content);
  const art = parseArtifactContent(res.content);
  assert.equal(art?.type, 'chart');
  assert.equal(art?.body.mark, 'bar');
  assert.equal(art?.body.spec?.marks?.[0]?.type, 'rect');
  assert.equal(art?.body.columns.length, 2);
});

test('bi.chart rejects untracked encoding channels', async () => {
  const res = await callChartTool(
    'bi.chart',
    {
      data: { columns: ['a'], rows: [[1]] },
      encoding: { gradient: { field: 'a', type: 'quantitative' } },
    },
    ctx,
  );
  assert.ok(res.isError, 'expected rejection');
  assert.ok(String(res.content).includes('untracked'), res.content);
});

test('bi.chart rejects unknown field types', async () => {
  const res = await callChartTool(
    'bi.chart',
    {
      data: { columns: ['a'], rows: [[1]] },
      mark: 'bar',
      x: 'a',
      y: 'a',
      encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'a', type: 'mystical' } },
    },
    ctx,
  );
  assert.ok(res.isError, 'expected rejection');
});

test('bi.chart validates the final spec with vega-lite compile', async () => {
  const res = await callChartTool(
    'bi.chart',
    { data: { columns: ['a'], rows: [[1, 2, 3]] }, mark: 'line', x: 'a', y: 'a' },
    ctx,
  );
  assert.ok(!res.isError, res.content);
  const art = parseArtifactContent(res.content);
  assert.equal(art?.body.spec?.marks?.[0]?.type, 'line');
});