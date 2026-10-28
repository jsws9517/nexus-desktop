import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'release/win-unpacked';

function sizeOf(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(p);
    else total += statSync(p).size;
  }
  return total;
}

const mb = (n) => (n / 1024 / 1024).toFixed(2);

const total = sizeOf(root);
console.log(`${root} total: ${mb(total)} MB`);

const asarPath = join(root, 'resources', 'app.asar');
console.log(`app.asar: ${mb(statSync(asarPath).size)} MB`);

const unpackedDir = join(root, 'resources', 'app.asar.unpacked');
let unpackedSize = 0;
try {
  unpackedSize = sizeOf(unpackedDir);
  console.log(`app.asar.unpacked: ${mb(unpackedSize)} MB`);
} catch {
  console.log(`app.asar.unpacked: (none)`);
}

// exe sizes
for (const f of readdirSync(root)) {
  if (f.endsWith('.exe')) {
    console.log(`${f}: ${mb(statSync(join(root, f)).size)} MB`);
  }
}

// --- asar internal size analysis (parse asar header) ---
// asar format: [4B header size][4B pad? actually: 4 bytes total size, 4 bytes header size, 4 pad][JSON header]
const buf = readFileSync(asarPath);
// First 8 bytes: uint32 size of the "size" field area. Format:
// 4 bytes: size of header string (padded), 4 bytes: value of that size... simplified:
// bytes[0..4) = uint32 le = size of next field; bytes[4..8) = uint32 le = actual header json length (padded)
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'));
console.error('header parsed, walking...');

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child.files, p, out);
    else out.push({ path: p, size: child.size ?? 0 });
  }
}
const files = [];
walk(header.files, '', files);

const byTop = new Map();
for (const f of files) {
  const top = f.path.split('/').slice(0, 3).join('/');
  byTop.set(top, (byTop.get(top) ?? 0) + f.size);
}
console.log('\n--- asar top-level breakdown (MB) ---');
for (const [k, v] of [...byTop].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`${mb(v)} MB  ${k}`);
}

// detailed: which node_modules packages are heavy
const byPkg = new Map();
for (const f of files) {
  const m = f.path.match(/^node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (m) {
    const pkg = m[1];
    byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + f.size);
  }
}
console.log('\n--- heaviest node_modules packages (MB) ---');
for (const [k, v] of [...byPkg].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log(`${mb(v)} MB  ${k}`);
}
