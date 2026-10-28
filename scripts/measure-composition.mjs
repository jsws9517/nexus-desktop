import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sz(d) {
  let t = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name);
    t += e.isDirectory() ? sz(f) : statSync(f).size;
  }
  return t;
}
const mb = (n) => (n / 1048576).toFixed(2);

const wu = 'release/win-unpacked';
console.log('=== win-unpacked top-level ===');
for (const e of readdirSync(wu, { withFileTypes: true })) {
  const f = join(wu, e.name);
  console.log(`${mb(e.isDirectory() ? sz(f) : statSync(f).size)} MB  ${e.name}${e.isDirectory() ? '/' : ''}`);
}
console.log('win-unpacked total:', mb(sz(wu)), 'MB');

console.log('\n=== exe (NSIS installer) ===');
const exe = 'release/nexus-Setup-0.3.0.exe';
console.log('exe:', mb(statSync(exe).size), 'MB =', statSync(exe).size, 'bytes');

console.log('\n=== resources dir (what NSIS compresses) ===');
const res = join(wu, 'resources');
for (const e of readdirSync(res, { withFileTypes: true })) {
  const f = join(res, e.name);
  console.log(`${mb(e.isDirectory() ? sz(f) : statSync(f).size)} MB  ${e.name}${e.isDirectory() ? '/' : ''}`);
}
