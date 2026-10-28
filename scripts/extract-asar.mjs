// Extract release/win-unpacked/resources/app.asar into a dir, then overlay
// app.asar.unpacked, so the app's node_modules can be exercised under plain
// system Node (with dev's system-ABI better-sqlite3 swapped back in).
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [asarPath, outDir, devSqliteNode] = process.argv.slice(2);
if (!asarPath || !outDir) {
  console.error('usage: node extract-asar.mjs <app.asar> <outDir> [devSystemAbiBetterSqlite3.node]');
  process.exit(2);
}

const buf = readFileSync(asarPath);
const headerLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerLen).toString('utf8'));
// file offsets in the header are relative to the start of the data section,
// which begins right after the 16-byte prefix + the 4-byte-padded JSON header.
const dataStart = 16 + ((headerLen + 3) & ~3);

let count = 0;
(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child.files, p);
    else if (!child.unpacked) {
      const off = dataStart + Number(child.offset);
      const data = buf.subarray(off, off + child.size);
      const dest = join(outDir, p);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      count++;
    }
  }
})(header.files, '');
console.log(`extracted ${count} files from asar -> ${outDir}`);

// overlay unpacked (native binaries)
const unpackedSrc = join(dirname(asarPath), 'app.asar.unpacked');
if (existsSync(unpackedSrc)) {
  cpSync(unpackedSrc, join(outDir, 'app.asar.unpacked'), { recursive: true });
  console.log('overlaid app.asar.unpacked');
}
// runtime resolution: node_modules must sit next to dist/ (app root = asar root).
// app.asar.unpacked mirrors the asar root layout (node_modules/...), so merge it in.
const up = join(outDir, 'app.asar.unpacked');
if (existsSync(up)) {
  for (const entry of readdirSync(up)) {
    cpSync(join(up, entry), join(outDir, entry), { recursive: true });
  }
  console.log('merged unpacked entries into app root');
}
// swap in the system-ABI better-sqlite3 build (dev's) so plain Node can load it
if (devSqliteNode && existsSync(devSqliteNode)) {
  const target = join(outDir, 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node');
  mkdirSync(dirname(target), { recursive: true });
  cpSync(devSqliteNode, target);
  console.log('swapped in dev system-ABI better-sqlite3 prebuild');
}
