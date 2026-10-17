/**
 * `loadExtractorPackages()` must make an installed package's formats visible to
 * the worker's own registry, no matter which process installed it.
 *
 * The regression this pins: an extractor package imports the core registry by
 * an absolute file URL baked in at install time. When the package was
 * installed by a different consumer (the standalone `nexus` CLI, whose core
 * lives under the coder repo), that URL points at a second copy of the
 * registry. Node keys its ESM cache on the resolved URL, so the package's
 * `registerExtractor()` calls landed in a module the worker never reads and
 * `hasExtractor()` stayed false — the format looked uninstalled even though the
 * package was present.
 *
 * The loader now copies missing extractors across the two module instances
 * (src/agent/extractor-loader.ts). This test reproduces the mismatch with a
 * self-contained second registry module, so it needs no network and no real
 * extractor package.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

/** A minimal stand-in for the core registry, living under vault/extract/. */
const FAKE_REGISTRY = `
const map = new Map();
export function registerExtractor(ext, fn) { map.set(ext, fn); }
export function hasExtractor(ext) { return map.has(ext); }
export function getExtractor(ext) { return map.get(ext); }
export function listExtractorExts() { return [...map.keys()].sort(); }
`;

test('a package that registered into another registry instance is copied into the worker registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'extractor-loader-'));
  const pkgDir = join(home, 'native', 'extractors', 'cross-instance');
  const fakeRegistry = join(pkgDir, 'other', 'vault', 'extract', 'registry.js');
  mkdirSync(dirname(fakeRegistry), { recursive: true });
  writeFileSync(fakeRegistry, FAKE_REGISTRY, 'utf8');
  // The package imports the *other* registry — exactly the CLI-installed shape.
  const pkgEntry = join(pkgDir, 'index.mjs');
  writeFileSync(
    pkgEntry,
    `import { registerExtractor } from ${JSON.stringify(pathToFileURL(fakeRegistry).href)};\n` +
      `registerExtractor('fakefmt', () => ({ text: 'x', format: 'fakefmt' }));\n`,
    'utf8',
  );

  // A fresh process is required: the loader's `loadedOnce` and the registry are
  // both process-global, so a second call in this process would be a no-op.
  const probe = `
    const loader = await import(${JSON.stringify(pathToFileURL(join(dist, 'agent', 'extractor-loader.js')).href)});
    const res = await loader.loadExtractorPackages();
    const reg = await import(${JSON.stringify(
      pathToFileURL(join(dist, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'vault', 'extract', 'registry.js')).href,
    )});
    console.log(JSON.stringify({ loaded: res.loaded, has: reg.hasExtractor('fakefmt') }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, NEXUS_CONFIG_DIR: home },
    encoding: 'utf8',
  });

  try {
    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.deepEqual(out.loaded, ['cross-instance'], 'the package must be reported loaded');
    assert.equal(out.has, true, 'its extractor must be visible in the worker registry');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
