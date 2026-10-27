/**
 * Signature verification tests for core-overlay/download.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadSigningKey } from './helpers/signing.mjs';

const DIST_DIR = path.resolve('dist');
const MOD_URL = pathToFileURL(path.join(DIST_DIR, 'core-overlay', 'download.js')).href;
// CI has no release key; sign with whichever key is available and trust it.
const SIGNING = loadSigningKey();
const PRIV = SIGNING.privateKey;
const PUB_B64 = SIGNING.pubKeyB64;

// Re-import helper that forces a fresh load by using a cache-busting query param.
async function reimportDownload() {
  // ESM dynamic imports are cached; we clear by using a unique URL.
  const freshUrl = `${MOD_URL}?t=${Date.now()}`;
  return import(freshUrl);
}

async function withPubKey(pubKeyHex, fn) {
  const orig = process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX;
  process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = pubKeyHex;
  try {
    const mod = await reimportDownload();
    return await fn(mod);
  } finally {
    if (orig !== undefined) process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = orig;
    else delete process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX;
  }
}

test('verifyManifestSignature accepts valid signature', async () => {
  await withPubKey(PUB_B64, async (mod) => {
    const data = 'version: 1.0.0\nsha512: aaa\nsize: 100\nurl: https://example.com/core.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n';
    const sig = cryptoSign(null, Buffer.from(data), PRIV).toString('hex');
    assert.equal(mod.verifyManifestSignature(data, sig), true);
  });
});

test('verifyManifestSignature rejects tampered manifest', async () => {
  await withPubKey(PUB_B64, async (mod) => {
    const data = 'version: 1.0.0\nsha512: aaa\nsize: 100\nurl: https://example.com/core.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n';
    const sig = cryptoSign(null, Buffer.from(data), PRIV).toString('hex');
    assert.equal(mod.verifyManifestSignature(data + ' tampered', sig), false);
  });
});

test('verifyManifestSignature returns true when no public key is configured', async () => {
  const orig = process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX;
  // Set to empty string so getPubKey() falls through to null (no bundled key in test env)
  process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = '';
  try {
    const mod = await reimportDownload();
    assert.equal(mod.verifyManifestSignature('any text', 'deadbeef'), true);
  } finally {
    if (orig !== undefined) process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = orig;
    else delete process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX;
  }
});

test('verifyManifestSignature returns true when no signature provided', async () => {
  await withPubKey(PUB_B64, async (mod) => {
    assert.equal(mod.verifyManifestSignature('any text', ''), true);
  });
});

test('parseCoreManifest parses multi-version YAML', async () => {
  const mod = await reimportDownload();
  const yml = 'version: 2.0.0\nsha512: abc\nsize: 500000\nurl: https://example.com/core-2.0.0.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n\n' +
              'version: 1.0.0\nsha512: def\nsize: 400000\nurl: https://example.com/core-1.0.0.tar.gz\ntimestamp: 2025-06-01T00:00:00Z\n';
  const entries = mod.parseCoreManifest(yml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '2.0.0');
  assert.equal(entries[1].version, '1.0.0');
});

test('readStagedMeta returns null when sidecar missing', async () => {
  const mod = await reimportDownload();
  const root = mkdtempSync(path.join(tmpdir(), 'smoke-staged-'));
  assert.equal(mod.readStagedMeta(root, '9.9.9'), null);
});

test('readStagedMeta parses valid sidecar', async () => {
  const mod = await reimportDownload();
  const root = mkdtempSync(path.join(tmpdir(), 'smoke-staged-'));
  mkdirSync(path.join(root, 'staged'), { recursive: true });
  writeFileSync(
    path.join(root, 'staged', 'core-1.2.3.sha512'),
    'version: 1.2.3\nsha512: aaa\nsize: 12345\nurl: https://example.com/core-1.2.3.tar.gz\ntimestamp: 2026-01-01T00:00:00Z\n',
  );
  const meta = mod.readStagedMeta(root, '1.2.3');
  assert.equal(meta?.version, '1.2.3');
  assert.equal(meta?.sha512, 'aaa');
  assert.equal(meta?.size, 12345);
});

test('releaseStaged removes staged files', async () => {
  const mod = await reimportDownload();
  const root = mkdtempSync(path.join(tmpdir(), 'smoke-release-'));
  mkdirSync(path.join(root, 'staged'), { recursive: true });
  writeFileSync(path.join(root, 'staged', 'core-1.0.0.zip'), 'fake');
  writeFileSync(path.join(root, 'staged', 'core-1.0.0.sha512'), 'meta');
  mod.releaseStaged(root, '1.0.0');
  assert.equal(fs.existsSync(path.join(root, 'staged', 'core-1.0.0.zip')), false);
  assert.equal(fs.existsSync(path.join(root, 'staged', 'core-1.0.0.sha512')), false);
});
