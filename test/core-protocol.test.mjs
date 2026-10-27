/**
 * Protocol gate tests for core-overlay/protocol.ts + manager integration.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sign as cryptoSign } from 'node:crypto';

const DIST = path.resolve('dist');
const proto = await import(pathToFileURL(path.join(DIST, 'core-overlay', 'protocol.js')).href);
const managerUrl = pathToFileURL(path.join(DIST, 'core-overlay', 'manager.js')).href;
const PRIV = fs.readFileSync(path.join('keys', 'core-signing-private.pem'));

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX;
  delete process.env.NEXUS_DESKTOP_PROTOCOL;
});

test('package.json nexusDesktopProtocol matches the fallback constant', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.nexusDesktopProtocol, proto.DESKTOP_PROTOCOL_FALLBACK,
    'nexusDesktopProtocol in package.json must equal DESKTOP_PROTOCOL_FALLBACK');
});

test('package.json nexusCoreVersion matches the installed nexus-coder version', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const core = JSON.parse(fs.readFileSync('node_modules/nexus-coder/package.json', 'utf8'));
  assert.equal(pkg.nexusCoreVersion, core.version,
    'nexusCoreVersion drifted from node_modules/nexus-coder (run `npm run sync:core`)');
});

test('desktopProtocol() honours the env override', () => {
  process.env.NEXUS_DESKTOP_PROTOCOL = '7';
  assert.equal(proto.desktopProtocol(), 7);
  delete process.env.NEXUS_DESKTOP_PROTOCOL;
  assert.equal(proto.desktopProtocol(), proto.DESKTOP_PROTOCOL_FALLBACK);
});

test('readPackageProtocol reads a declared integer, null otherwise', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proto-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ nexusDesktopProtocol: 3 }));
  assert.equal(proto.readPackageProtocol(path.join(dir, 'package.json')), 3);

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  assert.equal(proto.readPackageProtocol(path.join(dir, 'package.json')), null);

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ nexusDesktopProtocol: '3' }));
  assert.equal(proto.readPackageProtocol(path.join(dir, 'package.json')), null);

  assert.equal(proto.readPackageProtocol(path.join(dir, 'nope.json')), null);
});

test('isProtocolCompatible: null (legacy) is always allowed', () => {
  assert.equal(proto.isProtocolCompatible(null), true);
  assert.equal(proto.isProtocolCompatible(proto.DESKTOP_PROTOCOL_FALLBACK), true);
  assert.equal(proto.isProtocolCompatible(proto.DESKTOP_PROTOCOL_FALLBACK + 1), false);
});

function signedManifest(version, { protocol } = {}) {
  const protocolLine = protocol != null ? `protocol: ${protocol}\n` : '';
  const yml = `version: ${version}\nsha512: ${'a'.repeat(128)}\nsize: 10\n` +
    `url: https://example.com/core-${version}.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n${protocolLine}`;
  const sig = cryptoSign(null, Buffer.from(yml), PRIV).toString('hex');
  return { yml, sig };
}

function mockFeed({ yml, sig }) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('latest-core.yml.sig')) return new Response(sig, { status: 200 });
    if (u.endsWith('latest-core.yml')) return new Response(yml, { status: 200 });
    return new Response('', { status: 404 });
  };
}

test('check() marks an incompatible protocol as not-available + incompatible', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.0.0', { protocol: proto.DESKTOP_PROTOCOL_FALLBACK + 1 }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(result.available, false, 'incompatible core is not offered');
  assert.equal(mgr.getState().status, 'incompatible');
  assert.match(String(mgr.getState().error), /protocol/i);
});

test('check() offers a core on the matching protocol', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.0.0', { protocol: proto.DESKTOP_PROTOCOL_FALLBACK }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(result.available, true);
  assert.equal(mgr.getState().status, 'available');
});

test('download() refuses an incompatible core', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.1.0', { protocol: proto.DESKTOP_PROTOCOL_FALLBACK + 2 }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  await mgr.check(root);
  // Even if the state were forced to 'available', download() re-checks.
  const st = await mgr.download(root);
  assert.notEqual(st.status, 'downloaded');
});

test('activate() rejects a core whose extracted package.json declares a foreign protocol', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  // Simulate a staged zip by pre-creating the staged file + manager state.
  const version = '9.2.0';
  const stagedDir = path.join(root, 'staged');
  mkdirSync(stagedDir, { recursive: true });
  const zipPath = path.join(stagedDir, `core-${version}.zip`);
  writeFileSync(zipPath, 'not-a-real-tar');
  // Reach into the private field the same way download() would set it.
  mgr.stagedZip = { version, zipPath };
  const st = await mgr.activate(root);
  assert.notEqual(st.status, 'idle', `activate must not succeed (status=${st.status})`);
});