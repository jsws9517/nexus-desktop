import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sizeOf(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += sizeOf(p);
    else total += statSync(p).size;
  }
  return total;
}
const mb = (n) => (n / 1048576).toFixed(2);

const targets = process.argv.slice(2);
for (const t of targets) {
  try {
    const p = join(process.cwd(), 'node_modules', t);
    console.log(`${t}: ${mb(sizeOf(p))} MB (dev node_modules)`);
  } catch {
    console.log(`${t}: (not found in dev node_modules)`);
  }
}
// list files of exceljs dist
try {
  const d = join(process.cwd(), 'node_modules/exceljs/dist');
  const files = readdirSync(d)
    .map((f) => ({ f, size: statSync(join(d, f)).size }))
    .sort((a, b) => b.size - a.size);
  console.log('\nexceljs/dist:');
  for (const x of files) console.log(`  ${mb(x.size)} MB  ${x.f}`);
} catch {}
