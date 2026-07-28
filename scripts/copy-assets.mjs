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

for (const { from, to } of assets) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
}
