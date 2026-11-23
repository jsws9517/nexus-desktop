/**
 * Native rules-dedup handoff to nexus-coder.
 *
 * The desktop injects the merged project rules under [Project Constitution];
 * the core skips its own loadRules() when the worker env sets
 * NEXUS_PROJECT_RULES_EXTERNAL=1. No installed core source is rewritten.
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const src = (p) => readFileSync(join(dist, p), 'utf8');

const {
  NEXUS_RULES_EXTERNAL_ENV,
  EXTERNAL_RULES_ENV,
  coreHonorsExternalRules,
} = await import(pathToFileURL(join(dist, 'shared', 'rules-external.js')).href);

test('external-rules env flag constant matches the coder contract', () => {
  assert.equal(NEXUS_RULES_EXTERNAL_ENV, 'NEXUS_PROJECT_RULES_EXTERNAL');
  assert.deepEqual(EXTERNAL_RULES_ENV, { NEXUS_PROJECT_RULES_EXTERNAL: '1' });
});

test('coreHonorsExternalRules detects a native core and rejects an old overlay', () => {
  assert.equal(
    coreHonorsExternalRules(
      "export const NEXUS_RULES_EXTERNAL_ENV = 'NEXUS_PROJECT_RULES_EXTERNAL';",
    ),
    true,
  );
  // Old overlay: flag never referenced -> would double-inject -> warn.
  assert.equal(coreHonorsExternalRules('loadRules(cwd) { /* old */ }'), false);
  assert.equal(coreHonorsExternalRules(''), false);
  assert.equal(coreHonorsExternalRules(null), false);
});

test('WorkerHost injects the flag into both child-process and utility-process spawns', () => {
  const text = src('main/worker-host.js');
  const matches = text.match(/\.\.\.process\.env, \.\.\.EXTERNAL_RULES_ENV, \.\.\.this\.launch\.env/g) || [];
  assert.equal(matches.length, 2, 'flag must be spread in both spawn paths');
  assert.ok(text.includes('rules-external.js'), 'WorkerHost imports the shared module');
});

test('installed core dist has the native gate and no stale patch marker', () => {
  const ctx = readFileSync(
    join(root, 'node_modules', 'nexus-coder', 'dist', 'src', 'context', 'project-context.js'),
    'utf8',
  );
  assert.ok(
    ctx.includes("process.env[NEXUS_RULES_EXTERNAL_ENV]"),
    'installed core must gate loadRules() on the external-rules flag',
  );
  assert.ok(
    !ctx.includes('NEXUS_RULES_DEDUP_PATCH'),
    'installed core must not carry the old source-rewrite marker',
  );
});
