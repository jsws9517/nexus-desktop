/**
 * i18n sanity check (D4):
 *  1. every dictionary key has non-empty zh-CN + en,
 *  2. every data-i18n / data-i18n-title / data-i18n-placeholder attribute used
 *     in static/index.html maps to an existing key.
 * Runs against the compiled dist (needs `npm run build` first).
 * Exits non-zero on any violation so CI fails on missing translations.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STR } from '../dist/renderer/i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`i18n FAIL: ${msg}`);
};

let html = '';
try {
  html = readFileSync(join(__dirname, '..', 'dist', 'static', 'index.html'), 'utf-8');
} catch {
  fail('dist/static/index.html missing — run `npm run build` first');
  process.exit(1);
}

const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) used.add(m[1]);

for (const key of used) {
  if (!(key in STR)) fail(`used in index.html but missing from dictionary: ${key}`);
}

for (const [key, entry] of Object.entries(STR)) {
  if (typeof entry?.['zh-CN'] !== 'string' || entry['zh-CN'].length === 0) fail(`zh-CN missing/empty: ${key}`);
  if (typeof entry?.en !== 'string' || entry.en.length === 0) fail(`en missing/empty: ${key}`);
}

if (failed) process.exit(1);
console.log(`i18n OK: ${Object.keys(STR).length} keys, ${used.size} used in index.html`);
