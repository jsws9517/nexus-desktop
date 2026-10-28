// Run FROM INSIDE the extracted-asar dir so every import resolves against the
// pruned node_modules (the packaged runtime graph, not dev's full tree).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
let fails = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log('PASS', label);
  } catch (e) {
    fails++;
    console.log('FAIL', label, '—', e.message?.split('\n')[0]);
  }
}

await check('better-sqlite3 (system ABI) opens in-memory db', () => {
  const DB = require_('better-sqlite3');
  const db = new DB(':memory:');
  db.exec('CREATE TABLE t(x)');
  db.close();
});

await check('exceljs loads via lib/ entry and writes xlsx', async () => {
  const m = await import('exceljs');
  const ns = m.default ?? m;
  const wb = new ns.Workbook();
  wb.addWorksheet('t').getCell('A1').value = 42;
  const buf = await wb.xlsx.writeBuffer();
  if (!(buf.byteLength > 500)) throw new Error('xlsx buffer too small: ' + buf.byteLength);
});

await check('vega engine loads (re-exports sub-packages)', async () => {
  await import('vega');
});

await check('vega-lite loads + compiles a spec (full engine chain)', async () => {
  const vl = await import('vega-lite');
  const ns = vl.default ?? vl;
  // compile exercises the real vega-lite -> vega utility chain the chart tool uses
  const spec = { data: { values: [{ x: 1, y: 2 }] }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } };
  const out = ns.compile(spec).spec;
  if (!out || !out.marks) throw new Error('compile returned no spec');
});

await check('@larksuiteoapi/node-sdk loads via lib/ (Feishu bridge)', () => {
  const m = require_('@larksuiteoapi/node-sdk');
  if (!m.Client && !m.ClientV2) throw new Error('no Client export');
});

await check('openai loads', async () => await import('openai'));
await check('@anthropic-ai/sdk loads', async () => await import('@anthropic-ai/sdk'));
await check('@modelcontextprotocol/sdk loads (subpath, as app imports it)', async () => {
  const m = await import('@modelcontextprotocol/sdk/client/index.js');
  if (!m.Client) throw new Error('no Client export');
});
await check('nexus-coder present', () => {
  const p = new URL('./node_modules/nexus-coder/dist/src/cli/index.js', import.meta.url);
  if (!existsSync(fileURLToPath(p))) throw new Error('cli entry missing');
});

// tiktoken is an OPTIONAL dep: absence must be a clean ERR_MODULE_NOT_FOUND
await check('tiktoken cleanly absent (optional, heuristic fallback)', async () => {
  try {
    await import('tiktoken');
    throw new Error('tiktoken still present — exclusion failed');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
});

console.log(fails ? `\nRESULT: ${fails} FAILURES` : '\nRESULT: ALL PASS');
process.exit(fails ? 1 : 0);
