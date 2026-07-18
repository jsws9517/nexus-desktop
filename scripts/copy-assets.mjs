// Copy non-TypeScript runtime assets (e.g. the Florence-2 python script) into
// the dist tree so the npm package can actually load local vision offline.
// tsc only emits .js, so .py files must be copied explicitly.
import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(__filename), '..');

const assets = [
  { from: 'src/vision/local_vision.py', to: 'dist/src/vision/local_vision.py' },
];

let copied = 0;
for (const { from, to } of assets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  if (!existsSync(src)) {
    console.warn(`[copy-assets] skip missing: ${from}`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  copied++;
  console.log(`[copy-assets] ${from} -> ${to}`);
}

console.log(`[copy-assets] done (${copied} file(s))`);
