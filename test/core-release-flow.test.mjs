/**
 * Release-flow integration: publish-core artifact -> feed -> check/download/activate.
 *
 * This is the path the shipped app takes for a core overlay update. It used to
 * be untested end to end, which hid two release blockers:
 *   - download() hashed nothing, so every payload failed its SHA-512 check;
 *   - activate() unpacked the tar root into core/ instead of core/<version>/.
 * It also pins the manifest URL to the desktop release tag that carries the
 * asset, and that a base-copy install is not offered its own bundled version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadSigningKey } from './helpers/signing.mjs';

const SIGNING = loadSigningKey();
// download.js reads the trusted key at call time; trust the test key instead of
// the bundled release key so this works with an ephemeral CI key too.
process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX = SIGNING.pubKeyB64;

const REPO = path.resolve('.');
const DIST = path.join(REPO, 'dist');

function publish(outDir, tag) {
  execFileSync(process.execPath, ['scripts/publish-core.mjs', '--out', outDir], {
    cwd: REPO,
    env: { ...process.env, CORE_SIGNING_KEY: SIGNING.pem, GITHUB_REF_NAME: tag },
    stdio: 'pipe',
  });
  const tarball = fs.readdirSync(outDir).find((f) => f.endsWith('.tar.gz'));
  assert.ok(tarball, 'publish-core must emit a core tarball');
  return tarball;
}

/** Serve `dir`, rewriting the manifest so its artifact URL points at the server. */
function serveFeed(dir, tarball, { dropSig = false } = {}) {
  return new Promise((resolve) => {
    let base = '';
    const manifest = () => fs.readFileSync(path.join(dir, 'latest-core.yml'), 'utf8')
      .replace(/^url: .*$/m, () => `url: ${base}/${tarball}`);
    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\//, ''));
      if (name === 'latest-core.yml') {
        res.writeHead(200, { 'content-type': 'text/yaml' }).end(manifest());
        return;
      }
      if (name === 'latest-core.yml.sig') {
        if (dropSig) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200).end(sign(null, Buffer.from(manifest()), SIGNING.privateKey).toString('hex'));
        return;
      }
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-length': String(fs.statSync(file).size) });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, close: () => server.close() });
    });
  });
}

async function loadManager() {
  return (await import(pathToFileURL(path.join(DIST, 'core-overlay', 'manager.js')).href)).CoreUpdateManager;
}

function newRoot() {
  return fs.mkdtempSync(path.join(tmpdir(), 'core-release-'));
}

test('published artifact installs end to end through the update feed', async () => {
  const out = fs.mkdtempSync(path.join(tmpdir(), 'core-feed-'));
  const tarball = publish(out, 'v9.9.9');
  const version = tarball.replace(/^core-/, '').replace(/\.tar\.gz$/, '');

  // The manifest must point at the desktop release tag that hosts the asset.
  const manifest = fs.readFileSync(path.join(out, 'latest-core.yml'), 'utf8');
  assert.match(manifest, new RegExp(`releases/download/v9\\.9\\.9/${tarball.replace(/[.]/g, '\\.')}`));
  assert.match(manifest, /^protocol: \d+$/m, 'manifest carries the protocol stamp');
  assert.ok(fs.existsSync(path.join(out, 'latest-core.yml.sig')), 'manifest is signed');

  const feed = await serveFeed(out, tarball);
  try {
    const CoreUpdateManager = await loadManager();
    const root = newRoot();
    const mgr = new CoreUpdateManager(feed.base);
    mgr.init();
    // Pretend the bundled core is older than the published one.
    mgr.currentVersionProvider = () => '1.0.0';

    const checked = await mgr.check(root);
    assert.equal(checked.available, true);
    assert.equal(checked.latest?.version, version);

    const dl = await mgr.download(root);
    assert.equal(dl.status, 'downloaded', dl.error ?? '');
    assert.ok(fs.existsSync(path.join(root, 'staged', `core-${version}.zip`)));

    const installed = await mgr.activate(root);
    assert.equal(installed.status, 'idle', installed.error ?? '');
    assert.equal(installed.active, version);

    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    assert.equal(state.activeCore, version, 'state.json points at the overlay');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'core', version, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    assert.equal(typeof pkg.nexusDesktopProtocol, 'number');
    assert.equal(fs.existsSync(path.join(root, 'staged', `core-${version}.zip`)), false,
      'staged payload is released after activation');
  } finally {
    feed.close();
  }
});

test('check() does not offer the core already bundled with the desktop', async () => {
  const out = fs.mkdtempSync(path.join(tmpdir(), 'core-feed-'));
  const tarball = publish(out, 'v9.9.9');
  const version = tarball.replace(/^core-/, '').replace(/\.tar\.gz$/, '');
  const feed = await serveFeed(out, tarball);
  try {
    const CoreUpdateManager = await loadManager();
    const mgr = new CoreUpdateManager(feed.base);
    mgr.init();
    mgr.currentVersionProvider = () => version;
    const checked = await mgr.check(newRoot());
    assert.equal(checked.available, false, 'bundled version equals latest');
    assert.equal(mgr.getState().status, 'not-available');
    assert.equal(checked.active, version);
  } finally {
    feed.close();
  }
});

test('a downloaded core stays installable after a restart', async () => {
  const out = fs.mkdtempSync(path.join(tmpdir(), 'core-feed-'));
  const tarball = publish(out, 'v9.9.9');
  const version = tarball.replace(/^core-/, '').replace(/\.tar\.gz$/, '');
  const feed = await serveFeed(out, tarball);
  try {
    const CoreUpdateManager = await loadManager();
    const root = newRoot();
    const first = new CoreUpdateManager(feed.base);
    first.init();
    first.currentVersionProvider = () => '1.0.0';
    await first.check(root);
    assert.equal((await first.download(root)).status, 'downloaded');

    // New process: no in-memory staged handle. The staged file + meta remain.
    const second = new CoreUpdateManager(feed.base);
    second.init();
    second.currentVersionProvider = () => '1.0.0';
    await second.check(root);
    assert.equal(second.getState().status, 'downloaded', 'staged update is still offered');

    const installed = await second.activate(root);
    assert.equal(installed.status, 'idle', installed.error ?? '');
    assert.equal(installed.active, version);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).activeCore,
      version,
    );
  } finally {
    feed.close();
  }
});

test('a manifest marked signed:true is hard-refused without its signature', async () => {
  const out = fs.mkdtempSync(path.join(tmpdir(), 'core-feed-'));
  const tarball = publish(out, 'v9.9.9');
  const feed = await serveFeed(out, tarball, { dropSig: true });
  try {
    const CoreUpdateManager = await loadManager();
    const mgr = new CoreUpdateManager(feed.base);
    mgr.init();
    mgr.currentVersionProvider = () => '1.0.0';
    const checked = await mgr.check(newRoot());
    assert.equal(checked.available, false);
    assert.equal(mgr.getState().status, 'error');
    assert.match(String(mgr.getState().error), /signed/i);
  } finally {
    feed.close();
  }
});

test('an unsigned legacy manifest is still downloadable (trust-by-hash)', async () => {
  const out = fs.mkdtempSync(path.join(tmpdir(), 'core-feed-'));
  const tarball = publish(out, 'v9.9.9');
  // Strip the signed marker: mimic a pre-gate manifest.
  const manifestPath = path.join(out, 'latest-core.yml');
  const text = fs.readFileSync(manifestPath, 'utf8').replace(/^signed: true$/m, '');
  fs.writeFileSync(manifestPath, text);
  const feed = await serveFeed(out, tarball, { dropSig: true });
  try {
    const CoreUpdateManager = await loadManager();
    const mgr = new CoreUpdateManager(feed.base);
    mgr.init();
    mgr.currentVersionProvider = () => '1.0.0';
    const root = newRoot();
    const checked = await mgr.check(root);
    assert.equal(checked.available, true, 'legacy unsigned manifest stays available');
    const dl = await mgr.download(root);
    assert.equal(dl.status, 'downloaded', dl.error ?? '');
  } finally {
    feed.close();
  }
});

test('download rejects a payload whose hash does not match the manifest', async () => {
  const out = fs.mkdtempSync(path.join(tmpdir(), 'core-feed-'));
  const tarball = publish(out, 'v9.9.9');
  const version = tarball.replace(/^core-/, '').replace(/\.tar\.gz$/, '');
  const tampered = path.join(out, tarball);
  const bytes = fs.readFileSync(tampered);
  bytes[bytes.length - 1] ^= 0xff; // same size, different hash
  fs.writeFileSync(tampered, bytes);
  const feed = await serveFeed(out, tarball);
  try {
    const CoreUpdateManager = await loadManager();
    const root = newRoot();
    const mgr = new CoreUpdateManager(feed.base);
    mgr.init();
    mgr.currentVersionProvider = () => '1.0.0';
    await mgr.check(root);
    const dl = await mgr.download(root);
    assert.equal(dl.status, 'error');
    assert.match(String(dl.error), /SHA-512 mismatch/);
    assert.equal(fs.existsSync(path.join(root, 'staged', `core-${version}.zip`)), false);
  } finally {
    feed.close();
  }
});
