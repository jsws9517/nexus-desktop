import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcStatic = join(__dirname, '..', 'static');
const outStatic = join(__dirname, '..', 'dist', 'static');

if (existsSync(srcStatic)) {
  mkdirSync(outStatic, { recursive: true });
  for (const file of readdirSync(srcStatic)) {
    copyFileSync(join(srcStatic, file), join(outStatic, file));
    console.log(`[nexus-desktop] copied static/${file}`);
  }
}

// Vega bundles are vendored from node_modules (the renderer has no bundler; it
// loads them as classic <script> tags). Copied at build so the repo stays clean.
const vegaBundles = [
  ['vega', 'build/vega.min.js'],
  ['vega-lite', 'build/vega-lite.min.js'],
  ['vega-embed', 'build/vega-embed.min.js'],
];
mkdirSync(outStatic, { recursive: true });
for (const [pkg, rel] of vegaBundles) {
  const from = join(__dirname, '..', 'node_modules', pkg, rel);
  if (!existsSync(from)) {
    console.warn(`[nexus-desktop] WARN: missing ${pkg} bundle at ${from}`);
    continue;
  }
  const to = join(outStatic, rel.split('/').at(-1));
  copyFileSync(from, to);
  console.log(`[nexus-desktop] copied ${pkg} bundle -> static/${rel.split('/').at(-1)}`);
}