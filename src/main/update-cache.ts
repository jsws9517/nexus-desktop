/**
 * Differential-update cache helpers (A4).
 *
 * electron-updater's NSIS differential download (v6 `differentialDownloadInstaller`):
 *
 *   1. downloads the NEW blockmap (`blockmapFileUrls[1]`, served by the
 *      version-pinned feed) into `pending/current.blockmap`;
 *   2. reads the OLD blockmap from the cache root `current.blockmap`
 *      (`getBlockMapFromCacheDir`), falling back to downloading
 *      `blockmapFileUrls[0]` — which under a version-pinned feed points at
 *      the OLD version's blockmap *inside the NEW tag* and 404s;
 *   3. on success, the pending blockmap is copied back to the cache root.
 *
 * Because step 2's fallback is dead under pinned feeds, we pre-seed the
 * cache root with the blockmap of the version the user is currently running,
 * verified against the cached `installer.exe` that NSIS copied into the
 * cache dir at install time:
 *
 *   sum(blockmap.files[0].sizes) === stat(cacheDir/installer.exe).size
 *
 * Any mismatch (dev-build installer, tampered cache, …) disables
 * differential download for this session and forces a full download rather
 * than risk building a corrupt installer. We deliberately do NOT re-hash
 * the blocks: electron-builder's blockmap checksums are 24-char base64
 * digests of variable-size (8–32 KiB) blocks — neither md5 nor sha256 —
 * so a size-sum check is the strongest verification that is computable
 * without duplicating electron-builder's checksum scheme.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { appVersionFeeds, assetCandidates, parseUpdateYml, type FeedSource } from '../shared/update-sources.js';

/** Must mirror `updaterCacheDirName` in the packaged `app-update.yml`. */
export const UPDATER_CACHE_DIR_NAME = 'nexus-desktop-updater';
/** The file NSIS copies itself to (`copyFile "$EXEPATH"`) at install time. */
export const INSTALLER_FILE_NAME = 'installer.exe';
const CURRENT_BLOCKMAP_FILE = 'current.blockmap';
const PENDING_DIR = 'pending';

/**
 * The updater cache dir electron-updater uses:
 * `<app cache path>/<updaterCacheDirName>` (= %LOCALAPPDATA%\nexus-desktop-updater
 * on Windows). `cachePath` is `app.getPath('cache')`, passed in by the caller
 * so this module stays free of electron imports (unit-testable in plain node).
 */
export function updaterCacheDir(cachePath: string): string {
  return path.join(cachePath, UPDATER_CACHE_DIR_NAME);
}

/**
 * Sum the block sizes of the first file in a blockmap document
 * (electron-builder's blockMap JSON: `{ version, files: [{ name, sizes, checksums }] }`).
 * Returns null when no sizes are present.
 */
export function sumBlockmapSizes(blockmapJson: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blockmapJson);
  } catch {
    return null;
  }
  const files = (parsed as { files?: Array<{ sizes?: Array<number> }> }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const sizes = files[0]?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  let sum = 0;
  for (const s of sizes) sum += s;
  return sum;
}

/** Read a gzip-compressed blockmap file (cache format) and sum its block sizes. */
export function readBlockmapSum(blockmapPath: string): number | null {
  try {
    const raw = fs.readFileSync(blockmapPath);
    return sumBlockmapSizes(zlib.gunzipSync(raw).toString());
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'follow', ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire every URL in parallel; resolve with the body of the first one that
 * returns 2xx, aborting the rest. Resolves null when none succeeds in time.
 */
export async function fetchFirstBuffer(urls: string[], timeoutMs: number): Promise<Buffer | null> {
  if (urls.length === 0) return null;
  let winner: Buffer | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await Promise.all(
      urls.map(async (url) => {
        if (winner) return;
        try {
          const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
          if (!res.ok || winner) return;
          const body = Buffer.from(await res.arrayBuffer());
          if (body.length === 0) return;
          winner = body;
          controller.abort(); // stop the losers
        } catch {
          /* aborted or unreachable — the next candidate carries on */
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
  return winner;
}

/**
 * Resolve the URL of the blockmap asset for a released desktop version:
 * read the version's `latest.yml` from the fastest feed that answers, take
 * `files[0].url` and append `.blockmap` (electron-builder's naming).
 */
async function resolveOldBlockmapUrls(
  oldVersion: string,
  feeds: FeedSource[],
  manifestTimeoutMs: number,
): Promise<string[]> {
  const manifests = await Promise.allSettled(
    feeds.map(async (feed) => {
      const res = await fetchWithTimeout(`${feed.url.replace(/\/$/, '')}/latest.yml`, manifestTimeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseUpdateYml(await res.text());
    }),
  );
  for (const r of manifests) {
    if (r.status !== 'fulfilled' || !r.value || r.value.version !== oldVersion) continue;
    const fileUrl = r.value.files[0]?.url ?? '';
    if (!fileUrl) continue;
    if (fileUrl.startsWith('http')) {
      // Gitee's manifest pins the asset at a GitHub absolute URL: expand it
      // through the mirror candidates instead.
      return assetCandidates(fileUrl).map((c) => `${c.url}.blockmap`);
    }
    return feeds.map((feed) => `${feed.url.replace(/\/$/, '')}/${fileUrl}.blockmap`);
  }
  return [];
}

export interface EnsureOldBlockmapOptions {
  cacheDir: string;
  /** The desktop version the user is currently running (its blockmap is needed). */
  oldVersion: string;
  /** Pinned feeds serving the old version's release assets (mirrors in speed order). */
  feeds: FeedSource[];
  /** Per-manifest-fetch budget. */
  manifestTimeoutMs?: number;
  /** Overall budget for the blockmap download. */
  blockmapTimeoutMs?: number;
}

export type EnsureOldBlockmapResult =
  | { ok: true; source: 'cache' | 'downloaded' }
  | { ok: false; reason: string };

/**
 * Make sure `cacheDir/current.blockmap` holds the blockmap of the OLD
 * (currently installed) version so electron-updater's differential download
 * can skip its (dead under pinned feeds) old-blockmap download.
 *
 * - already valid in cache → keep it;
 * - missing/stale → download the old blockmap and verify its block-size sum
 *   against the cached installer before installing it;
 * - anything we cannot verify → ok:false (caller disables differential).
 */
export async function ensureOldBlockmap(opts: EnsureOldBlockmapOptions): Promise<EnsureOldBlockmapResult> {
  const { cacheDir, oldVersion, feeds } = opts;
  const installerPath = path.join(cacheDir, INSTALLER_FILE_NAME);
  if (!fs.existsSync(installerPath)) {
    return { ok: false, reason: 'no cached installer (first install — differential unavailable)' };
  }
  let installerSize = 0;
  try {
    installerSize = fs.statSync(installerPath).size;
  } catch {
    return { ok: false, reason: 'cannot stat cached installer' };
  }

  const cachedPath = path.join(cacheDir, CURRENT_BLOCKMAP_FILE);
  const cachedSum = readBlockmapSum(cachedPath);
  if (cachedSum !== null && cachedSum === installerSize) {
    return { ok: true, source: 'cache' };
  }

  const urls = await resolveOldBlockmapUrls(
    oldVersion,
    feeds,
    opts.manifestTimeoutMs ?? 6000,
  );
  if (urls.length === 0) {
    return { ok: false, reason: `no feed serves the v${oldVersion} blockmap` };
  }
  const bytes = await fetchFirstBuffer(urls, opts.blockmapTimeoutMs ?? 60_000);
  if (!bytes) {
    return { ok: false, reason: 'old blockmap download failed' };
  }
  let json = '';
  try {
    json = zlib.gunzipSync(bytes).toString();
  } catch {
    return { ok: false, reason: 'old blockmap is not gzip JSON' };
  }
  const sum = sumBlockmapSizes(json);
  if (sum !== installerSize) {
    return {
      ok: false,
      reason: `blockmap sum (${sum ?? 'invalid'}) != cached installer size (${installerSize})`,
    };
  }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    // electron-updater writes the cache blockmap as gzip(JSON); keep the
    // canonical raw bytes rather than re-serializing the parsed object.
    fs.writeFileSync(cachedPath, bytes);
  } catch (e) {
    return { ok: false, reason: `cannot write cache blockmap: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, source: 'downloaded' };
}

/**
 * Remove zero-byte `pending/temp-*` files — stuck-download residue (e.g. a
 * full download that died after the differential attempt left a 0-byte
 * temp). electron-updater recreates temps on each download, so this only
 * clears dead weight.
 */
export function clearStalePendingTemps(cacheDir: string): void {
  const pending = path.join(cacheDir, PENDING_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(pending);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('temp-')) continue;
    try {
      const p = path.join(pending, name);
      if (fs.statSync(p).size === 0) fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
}

export interface SeedResult {
  /** True when differential download can proceed (cache valid / seeded). */
  differential: boolean;
  /** Human-readable outcome, for logs. */
  detail: string;
}

/**
 * One-call helper used by the Updater before each download: seed the cache
 * blockmap for the running version and clean stuck temps.
 */
export async function seedOldBlockmapFor(version: string, cachePath: string): Promise<SeedResult> {
  const cacheDir = updaterCacheDir(cachePath);
  if (!cacheDir) {
    return { differential: false, detail: 'cannot resolve updater cache dir' };
  }
  clearStalePendingTemps(cacheDir);
  const res = await ensureOldBlockmap({
    cacheDir,
    oldVersion: version,
    feeds: appVersionFeeds(version),
  });
  if (res.ok) return { differential: true, detail: `blockmap ${res.source}` };
  return { differential: false, detail: res.reason };
}
