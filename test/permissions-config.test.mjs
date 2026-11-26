/**
 * Unit tests for the T1-4 permissions whitelist merge (src/shared/permissions-config.ts).
 * Runs against the compiled dist, so `npm run build` must precede it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const { mergePermissionsIntoConfig } = await import(
  pathToFileURL(join(dist, 'shared', 'permissions-config.js'))
);

test('merge touches only the permissions subtree; other top-level keys survive', () => {
  const cfg = {
    language: 'en',
    providers: { openai: { type: 'openai' } },
    permissions: { mode: 'prompt', mcpAllowlist: ['mcp:old'] },
  };
  const res = mergePermissionsIntoConfig(cfg, { permissions: { mcpAllowlist: ['mcp:new'] } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.config.language, 'en');
  assert.deepEqual(res.config.providers, { openai: { type: 'openai' } });
  assert.deepEqual(res.config.permissions.mcpAllowlist, ['mcp:new']);
  // untouched permission field is preserved (merge, not replace)
  assert.equal(res.config.permissions.mode, 'prompt');
});

test('extra top-level keys in the PATCH are ignored (cannot write providers etc.)', () => {
  const cfg = { providers: { keep: true }, permissions: { mode: 'prompt' } };
  const res = mergePermissionsIntoConfig(cfg, {
    permissions: { mode: 'auto' },
    providers: { evil: true },
    language: 'zz',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.config.providers, { keep: true });
  assert.ok(!('language' in res.config));
  assert.equal(res.config.permissions.mode, 'auto');
});

test('unknown permission fields are ignored', () => {
  const cfg = { permissions: { mode: 'prompt' } };
  const res = mergePermissionsIntoConfig(cfg, { permissions: { totallyUnknown: 42, mode: 'auto' } });
  assert.equal(res.ok, true);
  assert.ok(!('totallyUnknown' in res.config.permissions));
});

test('empty arrays are accepted and replace prior values', () => {
  const cfg = { permissions: { mcpAllowlist: ['mcp:x'], allowlist: ['a'] } };
  const res = mergePermissionsIntoConfig(cfg, { permissions: { mcpAllowlist: [] } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.config.permissions.mcpAllowlist, []);
  assert.deepEqual(res.config.permissions.allowlist, ['a']);
});

test('array fields reject non-string members', () => {
  const cfg = { permissions: {} };
  const res = mergePermissionsIntoConfig(cfg, { permissions: { safePaths: ['ok', 123] } });
  assert.equal(res.ok, false);
  assert.match(res.error, /safePaths must be a string array/);
});

test('mode and execPermission enums are validated', () => {
  const cfg = { permissions: {} };
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { mode: 'bogus' } }).ok, false);
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { mode: 'basic' } }).ok, true);
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { mode: 'prompt' } }).ok, true);
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { mode: 'auto' } }).ok, true);
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { mode: 'unattended' } }).ok, true);
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { execPermission: 'bogus' } }).ok, false);
  assert.equal(mergePermissionsIntoConfig(cfg, { permissions: { execPermission: 'deny' } }).ok, true);
});

test('safetyRules validates its known fields and merges into existing rules', () => {
  const cfg = { permissions: { safetyRules: { dbDeletion: 'deny', batchWriteLimit: 50 } } };
  const ok = mergePermissionsIntoConfig(cfg, {
    permissions: { safetyRules: { dbDeletion: 'ask', requireGitCheckpoint: true } },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.permissions.safetyRules.dbDeletion, 'ask');
  assert.equal(ok.config.permissions.safetyRules.batchWriteLimit, 50);
  assert.equal(ok.config.permissions.safetyRules.requireGitCheckpoint, true);

  const bad = mergePermissionsIntoConfig(cfg, { permissions: { safetyRules: { dbDeletion: 'maybe' } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /dbDeletion/);

  const notObject = mergePermissionsIntoConfig(cfg, { permissions: { safetyRules: 'oops' } });
  assert.equal(notObject.ok, false);
});

test('execCommandOverrides validates enum levels', () => {
  const cfg = { permissions: {} };
  const ok = mergePermissionsIntoConfig(cfg, { permissions: { execCommandOverrides: { curl: 'prompt', mv: 'deny' } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.permissions.execCommandOverrides, { curl: 'prompt', mv: 'deny' });
  const bad = mergePermissionsIntoConfig(cfg, { permissions: { execCommandOverrides: { curl: 'maybe' } } });
  assert.equal(bad.ok, false);
});

test('does not mutate the input config object', () => {
  const cfg = { providers: { x: 1 }, permissions: { mode: 'prompt' } };
  const snapshot = JSON.stringify(cfg);
  mergePermissionsIntoConfig(cfg, { permissions: { mode: 'auto' } });
  assert.equal(JSON.stringify(cfg), snapshot);
});

test('rejects a non-object patch', () => {
  const cfg = { permissions: {} };
  assert.equal(mergePermissionsIntoConfig(cfg, null).ok, false);
  assert.equal(mergePermissionsIntoConfig(cfg, 'permissions').ok, false);
  assert.equal(mergePermissionsIntoConfig(cfg, []).ok, false);
});
