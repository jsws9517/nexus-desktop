// Verify a slimmed asar: excluded dev payloads are gone, runtime files intact.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'release/win-unpacked';
const asarPath = join(root, 'resources', 'app.asar');

const buf = readFileSync(asarPath);
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'));

const files = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child.files, p);
    else files.push(p);
  }
})(header.files, '');

const mb = (n) => (n / 1048576).toFixed(2);
console.log('asar:', mb(statSync(asarPath).size), 'MB,', files.length, 'files');

const has = (re) => files.filter((f) => re.test(f));

console.log('\n--- must be GONE ---');
const gone = [
  [/^node_modules\/tiktoken\//, 'tiktoken'],
  [/^node_modules\/exceljs\/dist\//, 'exceljs/dist'],
  [/^node_modules\/openai\/src\//, 'openai/src'],
  [/^node_modules\/zod\/src\//, 'zod/src'],
  [/^node_modules\/@anthropic-ai\/sdk\/src/, '@anthropic-ai/sdk/src'],
  [/^node_modules\/@larksuiteoapi\/node-sdk\/es\//, 'lark es/'],
  [/^node_modules\/vega-lite\/src\//, 'vega-lite/src (ts source)'],
  [/^node_modules\/pngjs\/coverage\//, 'pngjs/coverage'],
  [/\.(map)$/, '*.map'],
  [/\.(d\.ts|d\.mts|d\.cts)$/, '*.d.ts*'],
  [/\.(md)$/, '*.md'],
];
let bad = false;
for (const [re, label] of gone) {
  const left = has(re);
  if (left.length > 0) {
    bad = true;
    console.log(`  STILL PRESENT: ${label} (${left.length}) e.g. ${left.slice(0, 3).join(', ')}`);
  } else {
    console.log(`  OK absent: ${label}`);
  }
}

console.log('\n--- must still EXIST ---');
const required = [
  'node_modules/exceljs/lib/exceljs.nodejs.js',
  'node_modules/exceljs/lib/doc/workbook.js',
  'node_modules/exceljs/lib/stream/xlsx/workbook-writer.js',
  'node_modules/better-sqlite3/prebuilds/win32-x64.node',
  'node_modules/openai/index.js',
  'node_modules/zod/index.cjs',
  'node_modules/@anthropic-ai/sdk/index.js',
  'node_modules/nexus-coder/dist/src/cli/index.js',
  'node_modules/@larksuiteoapi/node-sdk/lib/index.js',
  'node_modules/vega-lite/build/vega-lite.min.js',
  'node_modules/vega-util/package.json',
  'node_modules/vega-expression/package.json',
  'node_modules/vega-event-selector/package.json',
  'dist/static/vega.min.js',
  'dist/static/vega-lite.min.js',
  'dist/static/vega-embed.min.js',
  'dist/main/index.js',
  'dist/agent-worker.js',
  'package.json',
];
for (const p of required) {
  const ok = files.includes(p);
  if (!ok) bad = true;
  console.log(`  ${ok ? 'OK' : 'MISSING'}  ${p}`);
}
// better-sqlite3 unpacked binary on disk
console.log('  unpacked .node:', existsSync(join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node')) ? 'OK' : 'MISSING');

console.log(bad ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(bad ? 1 : 0);
