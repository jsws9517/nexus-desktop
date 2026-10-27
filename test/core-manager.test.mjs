/**
 * CoreUpdateManager state-machine tests.
 *
 * Mocks global.fetch to drive check() through available / not-available and
 * verifies the emitted UpdateState transitions (regression: check() used to
 * stay stuck on 'checking').
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sign as cryptoSign } from 'node:crypto';
import { loadSigningKey } from './helpers/signing.mjs';

const DIST = path.resolve('dist');
const MANAGER_URL = pathToFileURL(path.join(DIST, 'core-overlay', 'manager.js')).href;
const OVERLAY_URL = pathToFileURL(path.join(DIST, 'bootstrap', 'overlay.js')).href;
// CI has no release key; trust whatever key these tests sign with.
const SIGNING = loadSigningKey();
const PRIV = SIGNING.privateKey;
process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = SIGNING.pubKeyB64;

async function stageActive(root, version) {
  const dir = path.join(root, 'core', version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'nexus-coder', version, type: 'module' }));
  // Mark it active so check() can compare the running version.
  const { activateCore } = await import(OVERLAY_URL);
  activateCore(root, version);
}

/** Build a signed latest-core.yml + .sig served by the mocked fetch. */
function signedManifest(version, sha512 = 'a'.repeat(128)) {
  const yml = `version: ${version}\nsha512: ${sha512}\nsize: 1234\n` +
    `url: https://example.com/core-${version}.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n`;
  const sig = cryptoSign(null, Buffer.from(yml), PRIV).toString('hex');
  return { yml, sig };
}

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('check() emits available when a newer signed manifest exists', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-mgr-'));
  const { yml, sig } = signedManifest('2.0.0');
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('latest-core.yml.sig')) return new Response(sig, { status: 200 });
    if (u.endsWith('latest-core.yml')) return new Response(yml, { status: 200 });
    return new Response('', { status: 404 });
  };
  const { CoreUpdateManager } = await import(MANAGER_URL);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const states = [];
  mgr.onState = (s) => states.push(s.status);
  const result = await mgr.check(root);
  assert.equal(result.available, true);
  assert.equal(result.latest.version, '2.0.0');
  assert.ok(states.includes('available'), `states=${JSON.stringify(states)}`);
  assert.equal(mgr.getState().status, 'available');
});

test('check() emits not-available when already on the latest version', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-mgr-'));
  await stageActive(root, '2.0.0');
  const { yml, sig } = signedManifest('2.0.0');
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('latest-core.yml.sig')) return new Response(sig, { status: 200 });
    if (u.endsWith('latest-core.yml')) return new Response(yml, { status: 200 });
    return new Response('', { status: 404 });
  };
  const { CoreUpdateManager, } = await import(MANAGER_URL);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const states = [];
  mgr.onState = (s) => states.push(s.status);
  const result = await mgr.check(root);
  assert.equal(result.available, false);
  assert.equal(result.active, '2.0.0');
  assert.ok(states.includes('not-available'), `states=${JSON.stringify(states)}`);
});

test('check() rejects a tampered manifest (bad signature)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'core-mgr-'));
  const { sig } = signedManifest('3.0.0');
  // Manifest text differs from what the signature covers.
  const tampered = `version: 3.0.0\nsha512: ${'b'.repeat(128)}\nsize: 1\n` +
    `url: https://example.com/x.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('latest-core.yml.sig')) return new Response(sig, { status: 200 });
    if (u.endsWith('latest-core.yml')) return new Response(tampered, { status: 200 });
    return new Response('', { status: 404 });
  };
  const { CoreUpdateManager } = await import(MANAGER_URL);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(mgr.getState().status, 'error');
  assert.match(String(mgr.getState().error), /signature/i);
  assert.equal(result.available, false);
});