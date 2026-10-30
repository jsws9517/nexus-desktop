/**
 * Core version selection (latest vs beta dist-tags) + local dev pipeline.
 *
 * Pure selection rules are unit-tested offline; the `sync-core.mjs --build`
 * CI-safety behaviour (missing source root skips, exit 0) is exercised via
 * the real script with a NEXUS_CODER_SRC pointing at a nonexistent path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, pickNewestCore } from '../scripts/core-version-select.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('compareVersions: prerelease of a higher tuple beats an older stable', () => {
  assert.equal(compareVersions('1.1.25', '1.1.26-3'), -1);
  assert.equal(compareVersions('1.1.26-3', '1.1.25'), 1);
});

test('compareVersions: same-tuple prereleases and ties', () => {
  assert.equal(compareVersions('1.1.26-3', '1.1.26-4'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-2'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.1.26-3', '1.1.26-3'), 0);
});

test('compareVersions: a stable release always beats its prereleases', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0-beta'), 1);
  assert.equal(compareVersions('1.2.0-beta', '1.2.0'), -1);
});

test('compareVersions: unrelated tuples', () => {
  assert.equal(compareVersions('1.1.27', '1.1.28-1'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.0-1'), 1);
});

test('pickNewestCore: beta wins when it is the newer version', () => {
  assert.equal(pickNewestCore({ latest: '1.1.25', beta: '1.1.26-3' }), '1.1.26-3');
});

test('pickNewestCore: latest wins when beta is older, equal, or missing', () => {
  assert.equal(pickNewestCore({ latest: '2.0.0', beta: '1.9.0-1' }), '2.0.0');
  assert.equal(pickNewestCore({ latest: '1.2.0', beta: '1.2.0' }), '1.2.0');
  assert.equal(pickNewestCore({ latest: '1.2.0' }), '1.2.0');
});

test('pickNewestCore: ignores dist-tags other than latest/beta', () => {
  assert.equal(pickNewestCore({ latest: '1.1.25', beta: '1.1.26-3', next: '9.9.9' }), '1.1.26-3');
});

test('pickNewestCore: throws when neither usable tag is present', () => {
  assert.throws(() => pickNewestCore({ next: '9.9.9' }));
});

test('sync-core --build skips cleanly when the core source is missing (CI safety)', () => {
  const missing = join(__dirname, 'no-such-core-source');
  if (existsSync(missing)) throw new Error(`unexpected fixture: ${missing}`);
  const res = spawnSync(
    process.execPath,
    [join(__dirname, '..', 'scripts', 'sync-core.mjs'), '--build'],
    {
      env: { ...process.env, NEXUS_CODER_SRC: missing, NEXUS_SKIP_CORE_BUILD: '' },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /skipping build/, res.stdout);
});

test('sync-core --build honours NEXUS_SKIP_CORE_BUILD=1', () => {
  const missing = join(__dirname, 'no-such-core-source');
  const res = spawnSync(
    process.execPath,
    [join(__dirname, '..', 'scripts', 'sync-core.mjs'), '--build'],
    {
      // Source root is intentionally missing: the skip flag must bypass the
      // build, and the copy step must stay CI-safe, so this exits 0
      // deterministically on every machine.
      env: { ...process.env, NEXUS_CODER_SRC: missing, NEXUS_SKIP_CORE_BUILD: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /skipping core build/, res.stdout);
});
