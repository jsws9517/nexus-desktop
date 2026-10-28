import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const asarPath = process.argv[2] ?? 'release/win-unpacked/resources/app.asar';
const buf = readFileSync(asarPath);
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'));

const files = [];
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child.files, p);
    else files.push({ path: p, size: child.size ?? 0 });
  }
})(header.files, '');

const mb = (n) => (n / 1048576).toFixed(2);

function sumIf(pred, label) {
  const s = files.filter((f) => pred(f.path)).reduce((a, f) => a + f.size, 0);
  console.log(`${mb(s)} MB  ${label}  (${files.filter((f) => pred(f.path)).length} files)`);
  return s;
}

console.log('total asar content:', mb(files.reduce((a, f) => a + f.size, 0)), 'MB\n');
sumIf((p) => p.endsWith('.map'), '**/*.map');
sumIf((p) => p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts'), '**/*.d.ts*');
sumIf((p) => p.includes('tiktoken'), 'tiktoken/**');
sumIf((p) => p.startsWith('node_modules/openai/src/'), 'openai/src');
sumIf((p) => p.startsWith('node_modules/zod/src/'), 'zod/src');
sumIf((p) => p.startsWith('node_modules/@anthropic-ai/sdk/src'), '@anthropic-ai/sdk/src');
sumIf((p) => p.includes('exceljs'), 'exceljs all');
sumIf((p) => p.includes('exceljs') && p.endsWith('.map'), 'exceljs maps');
sumIf((p) => p.includes('exceljs.bare'), 'exceljs bare*');
sumIf((p) => p.includes('@larksuiteoapi'), '@larksuiteoapi all');
sumIf((p) => p.endsWith('.md') || p.includes('LICENSE') || p.includes('CHANGELOG'), 'md/license/changelog');
sumIf((p) => p.includes('test') || p.includes('tests') || p.includes('__tests__'), 'test dirs');
sumIf((p) => p.includes('/docs/') || p.includes('/example/') || p.includes('/examples/'), 'docs/examples');

// per-package: how much is "removable" (map + dts + src) vs runtime
const byPkg = new Map();
for (const f of files) {
  const m = f.path.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (!m) continue;
  const pkg = m[1];
  let rec = byPkg.get(pkg);
  if (!rec) {
    rec = { total: 0, removable: 0 };
    byPkg.set(pkg, rec);
  }
  rec.total += f.size;
  if (
    f.path.endsWith('.map') ||
    f.path.endsWith('.d.ts') ||
    f.path.endsWith('.d.mts') ||
    f.path.endsWith('.d.cts') ||
    /\/src\//.test(f.path) ||
    /\/test(\/|s)/.test(f.path)
  ) {
    rec.removable += f.size;
  }
}
console.log('\n--- packages with removable dev payload (pkg total / removable) ---');
const rows = [...byPkg.entries()]
  .filter(([, r]) => r.removable > 500_000)
  .sort((a, b) => b[1].removable - a[1].removable)
  .slice(0, 20);
for (const [k, r] of rows) {
  console.log(`${mb(r.total)} MB total, ${mb(r.removable)} MB removable  ${k}`);
}
console.log('\nremovable grand total:', mb(rows.reduce((a, [, r]) => a + r.removable, 0)), 'MB (top-20 pkg, >0.5MB)');
