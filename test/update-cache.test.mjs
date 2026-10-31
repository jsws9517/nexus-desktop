import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  sumBlockmapSizes,
  readBlockmapSum,
  updaterCacheDir,
  ensureOldBlockmap,
  clearStalePendingTemps,
  fetchFirstBuffer,
  INSTALLER_FILE_NAME,
  UPDATER_CACHE_DIR_NAME,
} from '../dist/main/update-cache.js';

function blockmapGzip(sizes) {
  const json = JSON.stringify({ version: 2, files: [{ name: 'x.exe', sizes, checksums: [] }] });
  return zlib.gzipSync(Buffer.from(json, 'utf8'));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'update-cache-test-'));
}

// ── sumBlockmapSizes ──────────────────────────────────────────────────────────

test('sumBlockmapSizes sums the first file sizes', () => {
  const json = JSON.stringify({ version: 2, files: [{ name: 'a', sizes: [10, 20, 30] }, { name: 'b', sizes: [999] }] });
  assert.equal(sumBlockmapSizes(json), 60);
});

test('sumBlockmapSizes returns null on garbage / empty input', () => {
  assert.equal(sumBlockmapSizes('not json'), null);
  assert.equal(sumBlockmapSizes(JSON.stringify({ files: [] })), null);
  assert.equal(sumBlockmapSizes(JSON.stringify({ files: [{ name: 'a' }] })), null);
});

// ── readBlockmapSum ───────────────────────────────────────────────────────────

test('readBlockmapSum reads gzip blockmap from the cache', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'current.blockmap');
  fs.writeFileSync(p, blockmapGzip([100, 200]));
  assert.equal(readBlockmapSum(p), 300);
  fs.unlinkSync(p);
  assert.equal(readBlockmapSum(p), null);
  fs.rmdirSync(dir);
});

test('updaterCacheDir joins the cache path with the updater dir name', () => {
  assert.equal(
    updaterCacheDir('C:\\cache'),
    path.join('C:\\cache', UPDATER_CACHE_DIR_NAME),
  );
});

// ── ensureOldBlockmap ─────────────────────────────────────────────────────────

test('ensureOldBlockmap keeps a cache-valid blockmap without network', async () => {
  const dir = tmpDir();
  const installer = path.join(dir, INSTALLER_FILE_NAME);
  fs.writeFileSync(installer, Buffer.alloc(300, 7)); // any content, size matters
  fs.writeFileSync(path.join(dir, 'current.blockmap'), blockmapGzip([100, 200]));
  const res = await ensureOldBlockmap({
    cacheDir: dir,
    oldVersion: '0.3.0',
    // A deliberately unreachable feed proves no network is attempted.
    feeds: [{ label: 'dead', url: 'http://127.0.0.1:1/feed' }],
    manifestTimeoutMs: 500,
  });
  assert.deepEqual(res, { ok: true, source: 'cache' });
  fs.rmSync(dir, { recursive: true });
});

test('ensureOldBlockmap fails without a cached installer', async () => {
  const dir = tmpDir();
  const res = await ensureOldBlockmap({
    cacheDir: dir,
    oldVersion: '0.3.0',
    feeds: [{ label: 'dead', url: 'http://127.0.0.1:1/feed' }],
    manifestTimeoutMs: 500,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no cached installer/);
  fs.rmSync(dir, { recursive: true });
});

test('ensureOldBlockmap downloads + verifies the old blockmap when cache is stale', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.yml') {
      res.setHeader('content-type', 'text/plain');
      res.end('version: 0.3.0\nfiles:\n- url: x.exe\n  size: 300\n');
      return;
    }
    if (req.url === '/x.exe.blockmap') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(blockmapGzip([100, 200]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, INSTALLER_FILE_NAME), Buffer.alloc(300, 7));
  // Stale cache blockmap (wrong sum) must NOT win.
  fs.writeFileSync(path.join(dir, 'current.blockmap'), blockmapGzip([999]));
  const res = await ensureOldBlockmap({
    cacheDir: dir,
    oldVersion: '0.3.0',
    feeds: [{ label: 'local', url: `http://127.0.0.1:${port}` }],
  });
  assert.deepEqual(res, { ok: true, source: 'downloaded' });
  assert.equal(readBlockmapSum(path.join(dir, 'current.blockmap')), 300);

  server.close();
  fs.rmSync(dir, { recursive: true });
});

test('ensureOldBlockmap rejects a blockmap whose size sum mismatches the installer', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/latest.yml') {
      res.end('version: 0.3.0\nfiles:\n- url: x.exe\n  size: 300\n');
      return;
    }
    if (req.url === '/x.exe.blockmap') {
      // Blockmap claims 400 bytes, installer is 300 — dev-build cache scenario.
      res.end(blockmapGzip([400]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, INSTALLER_FILE_NAME), Buffer.alloc(300, 7));
  // A stale cache blockmap sits here: the mismatched download must NOT clobber it.
  const staleBlockmap = blockmapGzip([999]);
  fs.writeFileSync(path.join(dir, 'current.blockmap'), staleBlockmap);
  const res = await ensureOldBlockmap({
    cacheDir: dir,
    oldVersion: '0.3.0',
    feeds: [{ label: 'local', url: `http://127.0.0.1:${port}` }],
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /blockmap sum \(400\) != cached installer size \(300\)/);
  // The stale cache file must be left untouched (differential is disabled
  // instead, never with a blockmap that doesn't match the installer).
  assert.equal(readBlockmapSum(path.join(dir, 'current.blockmap')), 999);

  server.close();
  fs.rmSync(dir, { recursive: true });
});

// ── fetchFirstBuffer ──────────────────────────────────────────────────────────

test('fetchFirstBuffer resolves the first successful body', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.end('payload');
      return;
    }
    res.statusCode = 500;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const buf = await fetchFirstBuffer(
    [`http://127.0.0.1:${port}/broken`, `http://127.0.0.1:${port}/ok`],
    5000,
  );
  assert.equal(buf?.toString(), 'payload');
  assert.equal(await fetchFirstBuffer([`http://127.0.0.1:${port}/nope`], 1000), null);
  server.close();
});

// ── clearStalePendingTemps ────────────────────────────────────────────────────

test('clearStalePendingTemps removes zero-byte temps only', () => {
  const dir = tmpDir();
  const pending = path.join(dir, 'pending');
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, 'temp-a.exe'), '');
  fs.writeFileSync(path.join(pending, 'temp-b.exe'), 'partial');
  fs.writeFileSync(path.join(pending, 'nexus-Setup-0.3.0.exe'), 'real');
  clearStalePendingTemps(dir);
  assert.equal(fs.existsSync(path.join(pending, 'temp-a.exe')), false);
  assert.equal(fs.existsSync(path.join(pending, 'temp-b.exe')), true);
  assert.equal(fs.existsSync(path.join(pending, 'nexus-Setup-0.3.0.exe')), true);
  fs.rmSync(dir, { recursive: true });
});
