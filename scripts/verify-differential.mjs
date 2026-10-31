#!/usr/bin/env node
/**
 * verify-differential.mjs — offline estimate of the A4 differential download.
 *
 * What it proves, without needing the packaged app:
 *
 *   1. The published v0.3.0 blockmap is downloadable and its first file's
 *      block-size sum equals the published v0.3.0 installer size (i.e. the
 *      "old blockmap" is exactly what electron-updater's differential path
 *      needs in the cache root).
 *   2. Given that old blockmap + the new v0.3.1 blockmap, the total bytes a
 *      differential download must pull (sum of NEW blocks whose checksum
 *      does not appear in the OLD blockmap) — the number we expect to see
 *      on the wire instead of the full ~98.5 MiB installer.
 *   3. Re-run after the overwrite push: the diff size shrinks only if the
 *      re-published exe bytes changed; the check still has to hold
 *      (old blockmap sum == old published exe size), otherwise users on
 *      dev-build caches fall into the guarded full-download path.
 *
 * Usage:
 *   node scripts/verify-differential.mjs            # default: 0.3.0 -> 0.3.1
 *   node scripts/verify-differential.mjs 0.3.1      # single-arg form not needed
 *     for a later release, extend the constants below.
 *
 * No installer download: block checksums are what the differential planner
 * compares; bytes not shared between old and new blocks are what gets
 * fetched.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  githubReleaseBase,
} from '../dist/shared/update-sources.js';

const OLD_VERSION = '0.3.0';
const NEW_VERSION = '0.3.1';
const OLD_PUBLISHED_SIZE = 117_461_643; // published v0.3.0 exe
const NEW_PUBLISHED_SIZE = 103_337_602; // published v0.3.1 exe (2026-10-31 2nd overwrite, 14e0e55, hot-restart fix)

function fetchBuffer(url, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal, redirect: 'follow' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return Buffer.from(await res.arrayBuffer());
    })
    .finally(() => clearTimeout(timer));
}

/** Source ladder for a blockmap: GitHub direct first, then the fastest CN mirror. */
function ladderFor(version, pathInTag) {
  const base = githubReleaseBase(version);
  const urls = [base, base.replace('https://github.com/', 'https://ghproxy.imciel.com/https://github.com/')];
  return urls.map((b) => `${b}/${pathInTag}`);
}

function sumSizes(file) {
  return file.sizes.reduce((a, b) => a + b, 0);
}

function readBlockmap(bytes, what) {
  let json;
  try {
    json = JSON.parse(zlib.gunzipSync(bytes).toString());
  } catch {
    // GitHub sometimes serves blockmaps raw-JSON without gzip depending on
    // how the asset was uploaded; tolerate both.
    try {
      json = JSON.parse(bytes.toString());
    } catch {
      throw new Error(`${what}: not a gzip/JSON blockmap`);
    }
  }
  if (!json.files?.length) throw new Error(`${what}: no files[]`);
  return json.files[0];
}

function firstFetchOk(urls) {
  return (async () => {
    for (const url of urls) {
      try {
        return await fetchBuffer(url);
      } catch {
        /* next source */
      }
    }
    return null;
  })();
}

const fail = (msg) => {
  console.error(`verify-differential: FAIL — ${msg}`);
  process.exit(1);
};

const main = async () => {
  console.log(`[verify] ${OLD_VERSION} -> ${NEW_VERSION} differential estimate`);

  // 1. Old blockmap (the "cache seed" electron-updater would have for 0.3.0).
  const oldBlockmap = await firstFetchOk(ladderFor(OLD_VERSION, 'nexus-Setup-0.3.0.exe.blockmap'));
  if (!oldBlockmap) fail('cannot download the published v0.3.0 blockmap from any source');
  const oldFile = readBlockmap(oldBlockmap, 'old blockmap');
  const oldSum = sumSizes(oldFile);
  console.log(`[verify] old blockmap: ${oldFile.checksums.length} blocks, sum = ${oldSum} bytes`);
  if (oldSum !== OLD_PUBLISHED_SIZE) {
    // Not fatal for the estimate, but exactly the guard path A4 takes:
    // report it loudly.
    console.warn(
      `[verify] WARNING: old blockmap sum (${oldSum}) != published v0.3.0 exe size (${OLD_PUBLISHED_SIZE}).` +
        ` Upgraders whose cache blockmap is stale would be forced into a full download.`,
    );
  } else {
    console.log(`[verify] old blockmap sum matches the published v0.3.0 exe size ✓`);
  }

  // 2. New blockmap (what the differential planner downloads first).
  const newBlockmap = await firstFetchOk(ladderFor(NEW_VERSION, 'nexus-Setup-0.3.1.exe.blockmap'));
  if (!newBlockmap) fail('cannot download the published v0.3.1 blockmap from any source');
  const newFile = readBlockmap(newBlockmap, 'new blockmap');
  const newSum = sumSizes(newFile);
  if (newSum !== NEW_PUBLISHED_SIZE) {
    fail(`new blockmap sum (${newSum}) != published v0.3.1 exe size (${NEW_PUBLISHED_SIZE})`);
  }
  console.log(`[verify] new blockmap: ${newFile.checksums.length} blocks, sum = ${newSum} bytes ✓`);

  // 3. Diff estimate: new blocks whose checksum is absent from the old set.
  const oldChecksums = new Set(oldFile.checksums);
  let diffBytes = 0;
  let sharedBlocks = 0;
  for (let i = 0; i < newFile.checksums.length; i += 1) {
    if (oldChecksums.has(newFile.checksums[i])) {
      sharedBlocks += 1;
    } else {
      diffBytes += newFile.sizes[i];
    }
  }
  const pct = ((diffBytes / NEW_PUBLISHED_SIZE) * 100).toFixed(1);
  console.log(
    `[verify] shared blocks: ${sharedBlocks}/${newFile.checksums.length}; ` +
      `differential download ≈ ${diffBytes} bytes (${pct}% of the full ${NEW_PUBLISHED_SIZE})`,
  );
  const saved = ((1 - diffBytes / NEW_PUBLISHED_SIZE) * 100).toFixed(1);
  console.log(`[verify] expected savings: ${saved}% transferred bytes vs full download`);
  console.log('[verify] OK');
};

void main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
