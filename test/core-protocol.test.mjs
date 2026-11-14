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
import { loadSigningKey } from './helpers/signing.mjs';

const DIST = path.resolve('dist');
const proto = await import(pathToFileURL(path.join(DIST, 'core-overlay', 'protocol.js')).href);
const managerUrl = pathToFileURL(path.join(DIST, 'core-overlay', 'manager.js')).href;
// CI has no release key; trust whatever key these tests sign with.
const SIGNING = loadSigningKey();
const PRIV = SIGNING.privateKey;
process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = SIGNING.pubKeyB64;

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = SIGNING.pubKeyB64;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
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

test('parseCoreProtocol normalizes integers and ranges, null otherwise', () => {
  assert.deepEqual(proto.parseCoreProtocol(3), { min: 3, max: 3 });
  assert.deepEqual(proto.parseCoreProtocol({ min: 2, max: 4 }), { min: 2, max: 4 });
  assert.equal(proto.parseCoreProtocol('3'), null, 'a string is malformed');
  assert.equal(proto.parseCoreProtocol({ min: 4, max: 2 }), null, 'inverted range is malformed');
  assert.equal(proto.parseCoreProtocol({ min: 2 }), null, 'half a range is malformed');
  assert.equal(proto.parseCoreProtocol(null), null, 'absent is legacy');
});

test('readCorePackageProtocol reads declared ranges, null otherwise', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proto-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ nexusDesktopProtocol: 3 }));
  assert.deepEqual(proto.readCorePackageProtocol(path.join(dir, 'package.json')), { min: 3, max: 3 });

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ nexusDesktopProtocol: { min: 2, max: 4 } }));
  assert.deepEqual(proto.readCorePackageProtocol(path.join(dir, 'package.json')), { min: 2, max: 4 });

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  assert.equal(proto.readCorePackageProtocol(path.join(dir, 'package.json')), null);

  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ nexusDesktopProtocol: '3' }));
  assert.equal(proto.readCorePackageProtocol(path.join(dir, 'package.json')), null);

  assert.equal(proto.readCorePackageProtocol(path.join(dir, 'nope.json')), null);
});

test('isProtocolCompatible: legacy null is always allowed; ranges use containment', () => {
  // desktopProtocol() is DESKTOP_PROTOCOL_FALLBACK (4) unless the env override is set.
  assert.equal(proto.isProtocolCompatible(null), true, 'undeclared core predates the gate');
  assert.equal(proto.isProtocolCompatible({ min: 4, max: 4 }), true, 'collapsed range matches');
  assert.equal(proto.isProtocolCompatible({ min: 2, max: 4 }), true, 'desktop inside the range');
  assert.equal(proto.isProtocolCompatible({ min: 2, max: 3 }), false, 'core too old');
  assert.equal(proto.isProtocolCompatible({ min: 5, max: 6 }), false, 'core too new');
});

test('protocolRangeFromManifest folds partial or inverted pairs to null', () => {
  assert.deepEqual(proto.protocolRangeFromManifest(2, 4), { min: 2, max: 4 });
  assert.deepEqual(proto.protocolRangeFromManifest(3, 3), { min: 3, max: 3 });
  assert.equal(proto.protocolRangeFromManifest(null, null), null, 'unstamped entry stays legacy');
  assert.equal(proto.protocolRangeFromManifest(2, null), null, 'one-sided pair is malformed');
  assert.equal(proto.protocolRangeFromManifest(4, 2), null, 'inverted pair is malformed');
});

test('protocolMismatch names the two failure directions', () => {
  assert.equal(proto.protocolMismatch(null, '9.0.0'), null, 'legacy has no mismatch');
  assert.equal(proto.protocolMismatch({ min: 2, max: 4 }, '9.0.0'), null, 'compatible has no mismatch');
  assert.match(proto.protocolMismatch({ min: 2, max: 3 }, '9.0.0'), /too old/);
  assert.match(proto.protocolMismatch({ min: 5, max: 6 }, '9.0.0'), /too new/);
});

function signedManifest(version, { protocolMin, protocolMax, protocol } = {}) {
  let protocolLines = '';
  if (protocolMin != null) protocolLines += `protocolMin: ${protocolMin}\n`;
  if (protocolMax != null) protocolLines += `protocolMax: ${protocolMax}\n`;
  if (protocol != null) protocolLines += `protocol: ${protocol}\n`;
  const yml = `version: ${version}\nsha512: ${'a'.repeat(128)}\nsize: 10\n` +
    `url: https://example.com/core-${version}.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n${protocolLines}`;
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

test('check() rejects a core whose range does not cover this desktop (too new)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.0.0', { protocolMin: 5, protocolMax: 6 }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(result.available, false, 'incompatible core is not offered');
  assert.equal(mgr.getState().status, 'incompatible');
  assert.match(String(mgr.getState().error), /too new/);
});

test('check() offers a core whose range covers this desktop', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.0.0', { protocolMin: 2, protocolMax: 4 }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(result.available, true);
  assert.equal(mgr.getState().status, 'available');
});

test('check() offers a legacy manifest (protocol line only) when it matches', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.0.0', { protocol: proto.DESKTOP_PROTOCOL_FALLBACK }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(result.available, true, 'legacy exact-match line folds into a min=max range');
  assert.equal(mgr.getState().status, 'available');
});

test('check() rejects a legacy manifest older than this desktop', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.0.0', { protocol: proto.DESKTOP_PROTOCOL_FALLBACK - 1 }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const result = await mgr.check(root);
  assert.equal(result.available, false, 'legacy core too old is not offered');
  assert.equal(mgr.getState().status, 'incompatible');
  assert.match(String(mgr.getState().error), /too old/);
});

test('download() refuses a core whose range does not cover this desktop', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  mockFeed(signedManifest('9.1.0', { protocolMin: 5, protocolMax: 6 }));
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  await mgr.check(root);
  // Even if the state were forced to 'available', download() re-checks.
  const st = await mgr.download(root);
  assert.notEqual(st.status, 'downloaded');
});

test('activate() rejects a core whose extracted package.json declares a foreign range', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  const { execFileSync } = await import('node:child_process');
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  // Build a REAL staged tarball whose package.json declares a range outside
  // this desktop's protocol — the defense-in-depth gate on the extracted
  // bytes, independent of what the manifest claimed.
  const version = '9.2.0';
  const buildDir = mkdtempSync(path.join(tmpdir(), 'proto-build-'));
  writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name: 'nexus-coder',
    version,
    nexusDesktopProtocol: { min: 7, max: 9 },
  }));
  mkdirSync(path.join(root, 'staged'), { recursive: true });
  const zipPath = path.join(root, 'staged', `core-${version}.zip`);
  execFileSync('tar', ['-czf', zipPath, '-C', buildDir, '.'], { stdio: 'pipe' });
  // Reach into the private field the same way download() would set it.
  mgr.stagedZip = { version, zipPath };
  const st = await mgr.activate(root);
  assert.equal(st.status, 'incompatible', `activate must refuse (status=${st.status})`);
  assert.match(String(st.error), /too new/);
  assert.ok(!fs.existsSync(path.join(root, 'core', version)), 'the foreign core is not installed');
});

test('activate() rejects a compatible-range core that lacks the desktop-api facade', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  const { execFileSync } = await import('node:child_process');
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  // A range this desktop accepts, but the artifact ships no facade: without
  // the integrity gate the resolve-hook would silently fall back to the base
  // copy file-by-file and the overlay would die without any error.
  const version = '9.3.0';
  const buildDir = mkdtempSync(path.join(tmpdir(), 'proto-build-'));
  writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name: 'nexus-coder',
    version,
    nexusDesktopProtocol: { min: 2, max: 4 },
  }));
  mkdirSync(path.join(root, 'staged'), { recursive: true });
  const zipPath = path.join(root, 'staged', `core-${version}.zip`);
  execFileSync('tar', ['-czf', zipPath, '-C', buildDir, '.'], { stdio: 'pipe' });
  mgr.stagedZip = { version, zipPath };
  const st = await mgr.activate(root);
  assert.equal(st.status, 'error', `activate must refuse (status=${st.status})`);
  assert.match(String(st.error), /desktop-api\.js/);
  assert.ok(!fs.existsSync(path.join(root, 'core', version)), 'the facade-less core is not installed');
});

test('activate() accepts a compatible-range core that carries the facade', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'proto-mgr-'));
  const { execFileSync } = await import('node:child_process');
  const { CoreUpdateManager } = await import(managerUrl);
  const mgr = new CoreUpdateManager('https://example.com/feed');
  mgr.init();
  const version = '9.4.0';
  const buildDir = mkdtempSync(path.join(tmpdir(), 'proto-build-'));
  writeFileSync(path.join(buildDir, 'package.json'), JSON.stringify({
    name: 'nexus-coder',
    version,
    nexusDesktopProtocol: { min: 2, max: 4 },
  }));
  const facadeDir = path.join(buildDir, 'dist', 'src');
  mkdirSync(facadeDir, { recursive: true });
  writeFileSync(path.join(facadeDir, 'desktop-api.js'), 'export {};\n');
  mkdirSync(path.join(root, 'staged'), { recursive: true });
  const zipPath = path.join(root, 'staged', `core-${version}.zip`);
  execFileSync('tar', ['-czf', zipPath, '-C', buildDir, '.'], { stdio: 'pipe' });
  mgr.stagedZip = { version, zipPath };
  const st = await mgr.activate(root);
  assert.equal(st.status, 'idle', `activate must succeed (status=${st.status}): ${st.error}`);
  assert.equal(st.active, version);
});

test('publish-core stamps the protocol range into latest-core.yml', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = path.join(tmpdir(), `publish-core-test-${Date.now()}`);
  execFileSync(process.execPath, ['scripts/publish-core.mjs', '--out', out], {
    stdio: 'pipe',
    env: { ...process.env, CORE_SIGNING_KEY: SIGNING.pem },
  });
  const yml = fs.readFileSync(path.join(out, 'latest-core.yml'), 'utf8');
  // The range stamped into the manifest comes from the local core copy's
  // own declaration (publish-core no longer falls back to the desktop).
  const nodeModPkg = JSON.parse(fs.readFileSync('node_modules/nexus-coder/package.json', 'utf8'));
  const range = proto.parseCoreProtocol(nodeModPkg.nexusDesktopProtocol);
  assert.ok(range, 'the local core copy must declare a protocol range');
  assert.match(yml, new RegExp(`^protocolMin: ${range.min}$`, 'm'), 'manifest carries protocolMin');
  assert.match(yml, new RegExp(`^protocolMax: ${range.max}$`, 'm'), 'manifest carries protocolMax');
  if (range.min === range.max) {
    assert.match(yml, new RegExp(`^protocol: ${range.min}$`, 'm'), 'collapsed range keeps the legacy line');
  } else {
    assert.doesNotMatch(yml, /^protocol:/m, 'a true range omits the legacy exact-match line');
  }
  // And the signature covers the stamped manifest.
  assert.ok(fs.existsSync(path.join(out, 'latest-core.yml.sig')), 'signature written');
  // The artifact's own package.json must carry the range too, so the
  // activation and boot gates (which read the extracted files) are effective.
  const tarball = fs.readdirSync(out).find((f) => f.endsWith('.tar.gz'));
  const extract = mkdtempSync(path.join(tmpdir(), 'publish-artifact-'));
  execFileSync('tar', ['xzf', path.join(out, tarball), '-C', extract]);
  const artifactPkg = JSON.parse(fs.readFileSync(path.join(extract, 'package.json'), 'utf8'));
  assert.deepEqual(artifactPkg.nexusDesktopProtocol, { min: range.min, max: range.max },
    'artifact package.json must carry the declared range');
});