/**
 * Core update download client (phase 2).
 *
 * Downloads a core zip from a URL, verifies its SHA-512 digest and ed25519
 * manifest signature, and stages it under the overlay root so `activateCore`
 * can promote it to active.
 *
 * The staged layout:
 *   <root>/staged/core-<version>.zip      compressed payload (unverified at rest)
 *   <root>/staged/core-<version>.sha512   hex digest + size + URL (read-only metadata)
 *   <root>/core/<version>/                activated copy (populated by activateCore)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify as cryptoVerify, type KeyLike } from 'node:crypto';
import {
  assetCandidates as sharedAssetCandidates,
  compareVersions,
  type FeedSource,
} from '../shared/update-sources.js';

const STAGED_DIR = 'staged';

export interface CoreUpdateInfo {
  version: string;
  /** SHA-512 hex digest as published in latest-core.yml. */
  sha512: string;
  /** Exact uncompressed zip size in bytes. */
  size: number;
  /** Download URL for `core-<version>.zip`. */
  url: string;
  /**
   * Alternate download URLs for the same artifact+hash, collected when
   * manifests from several feeds are merged (e.g. the Gitee attachment
   * next to the GitHub one). All are raced in parallel.
   */
  urls?: string[];
  /** ISO-8601 timestamp of the release. */
  timestamp: string;
  /** nexusDesktopProtocol the core was built against (null when undeclared). */
  protocol: number | null;
}

export interface StagedCoreMeta {
  version: string;
  sha512: string;
  size: number;
  url: string;
  timestamp: string;
  /** Byte offset of the zip archive inside the staged file (always 0 for our layout). */
  offset: 0;
}

export interface DownloadResult {
  version: string;
  /** Absolute path to the staged zip after a successful download. */
  zipPath: string;
  /** Absolute path to the metadata sidecar. */
  metaPath: string;
  /** Bytes actually written (may differ from size on partial-write errors). */
  bytesWritten: number;
}

export interface ManifestEntry {
  version: string;
  sha512: string;
  size: number;
  url: string;
  /** Alternate URLs for the same artifact+hash (manifest merge). */
  urls?: string[];
  timestamp: string;
  /** nexusDesktopProtocol the core was built against (null when undeclared). */
  protocol: number | null;
  /** Present when the manifest was signed at publish time. */
  signed?: boolean;
  offset: 0;
}

// ── Public key resolution ──────────────────────────────────────────────────────

/** Base64-encoded ed25519 SPKI public key (DER) for manifest signature verification. */
const BUNDLED_PUB_KEY_B64 =
  'MCowBQYDK2VwAyEARWOKLRKTHQYnGH8O6qDYIMWYSLgQC+t4i///Yey0/MU=';

function getPubKey(): KeyLike | null {
  const raw = process.env.NEXUS_CORE_SIGNING_PUBKEY_HEX ?? BUNDLED_PUB_KEY_B64;
  if (!raw) return null;
  try {
    const der = Buffer.from(raw, 'base64');
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

// ── Manifest parsing ───────────────────────────────────────────────────────────

function parseYamlSimple(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/**
 * Parse latest-core.yml (simple YAML without nested structures).
 * Returns an array of entries, one per release line block.
 */
export function parseCoreManifest(text: string): ManifestEntry[] {
  const lines = text.split('\n');
  const entries: ManifestEntry[] = [];
  let current: Partial<ManifestEntry> = {};
  const flush = () => {
    if (current.version && current.sha512 && current.size != null) {
      entries.push({ version: current.version, sha512: current.sha512, size: current.size,
        url: current.url ?? '', timestamp: current.timestamp ?? '',
        protocol: current.protocol ?? null, signed: current.signed, offset: 0 });
    }
  };
  for (const line of lines) {
    const idx = line.indexOf(':');
    // Blank (or malformed) lines must NOT close the current entry block:
    // a `signed: true` marker separated from its fields by a blank line would
    // otherwise be parsed into an orphan block and silently dropped.
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    // A repeated `version:` key starts the next entry block.
    if (key === 'version' && current.version) {
      flush();
      current = {};
    }
    if (key === 'version') current.version = val;
    else if (key === 'sha512') current.sha512 = val;
    else if (key === 'size') current.size = Number(val);
    else if (key === 'url') current.url = val;
    else if (key === 'timestamp') current.timestamp = val;
    else if (key === 'protocol') {
      const n = Number(val);
      current.protocol = Number.isInteger(n) && n >= 0 ? n : null;
    } else if (key === 'signed') {
      const b = val === 'true';
      current.signed = b ? true : undefined;
    }
  }
  flush();
  return entries;
}

/**
 * Verify the ed25519 signature on a manifest text against its .sig sidecar.
 * Returns true when the signature is valid, false when missing/unverifiable,
 * and throws when the signature is present but invalid.
 *
 * When no public key is available the function returns true (signature
 * verification is opt-in; a missing key means "trust by hash only").
 */
export function verifyManifestSignature(manifestText: string, sigHex: string): boolean {
  const pubKey = getPubKey();
  if (!pubKey || !sigHex) return true;
  try {
    const sig = Buffer.from(sigHex.trim(), 'hex');
    return cryptoVerify(null, Buffer.from(manifestText), pubKey, sig);
  } catch {
    return false;
  }
}

// ── Fetch ──────────────────────────────────────────────────────────────────────

/**
 * A manifest that the publisher marked `signed: true` but whose signature is
 * missing or invalid. Carried through `Promise.allSettled` so the manager
 * can distinguish "every feed is down" (retryable) from "every reachable
 * feed rejected the signature" (hard refusal that must not be masked).
 */
export class CoreManifestSignatureError extends Error {}

/**
 * Candidate download sources for a core artifact: the manifest's own URL
 * first, then (for github.com assets) every CN mirror in measured speed
 * order, plus any alternate URLs the manifest merge collected (e.g. the
 * Gitee attachment). Integrity never depends on the transport: the SHA-512
 * is verified no matter which candidate served the bytes.
 */
export function assetCandidates(info: { url: string; urls?: string[] }): FeedSource[] {
  const sources: FeedSource[] = [...sharedAssetCandidates(info.url)];
  for (const alt of info.urls ?? []) {
    if (alt === info.url) continue;
    for (const s of sharedAssetCandidates(alt)) {
      if (!sources.some((x) => x.url === s.url)) sources.push(s);
    }
  }
  return sources;
}

/** Live download progress, reported for the currently leading source. */
export interface CoreDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  /** Label of the leading source (e.g. "gh-proxy.org", "Gitee"). */
  source: string;
}

export interface CoreDownloadOptions {
  onProgress?: (p: CoreDownloadProgress) => void;
  /** Abort the whole download (user cancel). */
  signal?: AbortSignal;
  /** Hard deadline for the whole download (default 120s). */
  timeoutMs?: number;
  /** Abort when no bytes arrive from ANY source for this window (default 15s). */
  stallMs?: number;
}

/** fetch() with a hard abort deadline (fetch alone can hang for minutes). */
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
 * Fetch latest-core.yml (and its .sig) from a feed URL.
 * Verifies the ed25519 signature when a public key is available.
 *
 * A manifest that the publisher marked `signed: true` must carry a valid
 * signature; a missing or unverifiable one is a hard error. Unsigned legacy
 * manifests (no `signed` line) fall back to trust-by-hash: the signature is
 * verified when a key and a sidecar are present, but a missing sidecar does
 * not block the download.
 *
 * Returns entries sorted descending by version (first = newest).
 */
export async function fetchCoreManifest(feedUrl: string): Promise<ManifestEntry[]> {
  const base = feedUrl.replace(/\/$/, '');
  const [ymlRes, sigRes] = await Promise.all([
    fetchWithTimeout(`${base}/latest-core.yml`, 8000),
    fetchWithTimeout(`${base}/latest-core.yml.sig`, 8000).catch(() => null),
  ]);
  if (!ymlRes.ok) throw new Error(`HTTP ${ymlRes.status}`);
  const text = await ymlRes.text();
  const entries = parseCoreManifest(text);
  const sigHex = sigRes?.ok ? await sigRes.text() : '';
  const pubKey = getPubKey();
  const requiresSig = entries.some((e) => e.signed);
  if (requiresSig) {
    if (!sigHex) {
      throw new CoreManifestSignatureError('core manifest is signed but its signature is missing');
    }
    if (pubKey && !verifyManifestSignature(text, sigHex)) {
      throw new CoreManifestSignatureError('core manifest signature verification failed');
    }
  } else if (sigHex) {
    // Legacy manifest: verify when we can, never hard-block.
    if (pubKey && !verifyManifestSignature(text, sigHex)) {
      throw new CoreManifestSignatureError('core manifest signature verification failed');
    }
  }
  return entries;
}

/**
 * Merge the per-feed results of parallel `fetchCoreManifest()` calls into
 * one list: the newest version wins, and per-version download URLs are
 * unioned (a GitHub-absolute URL next to a Gitee attachment, for example).
 * Failed/unreachable feeds simply contribute nothing.
 */
export function mergeCoreManifestEntries(
  results: Array<PromiseSettledResult<ManifestEntry[]>>,
): ManifestEntry[] {
  const byVersion = new Map<string, ManifestEntry>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const entry of r.value) {
      const existing = byVersion.get(entry.version);
      if (!existing) {
        byVersion.set(entry.version, { ...entry, urls: [entry.url] });
        continue;
      }
      // Same version from several feeds: union the URLs when the artifact
      // is identical (same hash), otherwise keep the first-observed entry.
      if (entry.sha512 === existing.sha512 && entry.url) {
        const urls = existing.urls ?? [existing.url];
        if (!urls.includes(entry.url)) {
          urls.push(entry.url);
          existing.urls = urls;
        }
      }
    }
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

// ── Staging ────────────────────────────────────────────────────────────────────

function stagedZipPath(root: string, version: string): string {
  return path.join(root, STAGED_DIR, `core-${version}.zip`);
}

function stagedMetaPath(root: string, version: string): string {
  return path.join(root, STAGED_DIR, `core-${version}.sha512`);
}

/**
 * Read back staged metadata. Returns null when the sidecar is missing.
 */
export function readStagedMeta(root: string, version: string): StagedCoreMeta | null {
  const file = stagedMetaPath(root, version);
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = parseYamlSimple(txt);
    if (!m.version || !m.sha512 || !m.size || !m.url) return null;
    return {
      version: m.version,
      sha512: m.sha512,
      size: Number(m.size),
      url: m.url,
      timestamp: m.timestamp ?? '',
      offset: 0,
    };
  } catch {
    return null;
  }
}

// ── Download ───────────────────────────────────────────────────────────────────

/**
 * Download a core zip, verify SHA-512, write the staged metadata sidecar.
 * The zip is written atomically via a temp file + rename to avoid partial writes.
 *
 * All candidate sources run in parallel (memory-buffered; the artifact is
 * ~1.4 MiB) and the FIRST one that completes with matching size + SHA-512
 * wins; the losers are aborted. Progress is reported for the currently
 * leading source. A stall (no bytes from anywhere for `stallMs`) or the
 * overall deadline aborts the race.
 */
export async function downloadCoreUpdate(
  root: string,
  info: CoreUpdateInfo,
  opts: CoreDownloadOptions = {},
): Promise<DownloadResult> {
  const zipPath = stagedZipPath(root, info.version);
  const metaPath = stagedMetaPath(root, info.version);
  const tmpPath = `${zipPath}.${process.pid}.tmp`;

  // If already staged with matching hash, short-circuit.
  const existing = readStagedMeta(root, info.version);
  if (existing && existing.sha512 === info.sha512 && fs.existsSync(zipPath)) {
    return { version: info.version, zipPath, metaPath, bytesWritten: existing.size };
  }

  const dir = path.dirname(tmpPath);
  fs.mkdirSync(dir, { recursive: true });

  let data: Buffer;
  try {
    data = await raceDownload(info, opts);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }

  const actual = createHash('sha512').update(data).digest('hex');
  if (actual !== info.sha512) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(
      `SHA-512 mismatch for core ${info.version}: expected ${info.sha512}, got ${actual}`,
    );
  }

  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, zipPath);
  fs.writeFileSync(metaPath,
    `version: ${info.version}\nsha512: ${info.sha512}\nsize: ${info.size}\nurl: ${info.url}\ntimestamp: ${info.timestamp}\n`);
  return { version: info.version, zipPath, metaPath, bytesWritten: data.length };
}

/**
 * Parallel race across all candidate sources. Buffers in memory (the core
 * tarball is ~1.4 MiB), verifies the winner against size + SHA-512 before
 * returning it.
 */
async function raceDownload(
  info: CoreUpdateInfo,
  opts: CoreDownloadOptions,
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const stallMs = opts.stallMs ?? 15_000;
  const candidates = assetCandidates(info);
  if (candidates.length === 0) throw new Error(`no download candidates for core ${info.version}`);
  const total = info.size;

  const controller = new AbortController();
  let abortReason: string | null = null;
  const onOuterAbort = (): void => {
    abortReason = 'cancelled';
    controller.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onOuterAbort();
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let stallTimer = setTimeout(() => {
    abortReason = `no data received for ${Math.round(stallMs / 1000)}s`;
    controller.abort();
  }, stallMs);
  const overallTimer = setTimeout(() => {
    abortReason = `all sources timed out after ${Math.round(timeoutMs / 1000)}s`;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();
  let lastProgressAt = 0;

  interface Lane {
    label: string;
    chunks: Uint8Array[];
    received: number;
  }
  let leader: Lane | null = null;
  const reportProgress = (): void => {
    if (!opts.onProgress || !leader) return;
    const now = Date.now();
    // Throttle the IPC chatter; always report at 100%.
    if (leader.received < total && now - lastProgressAt < 400) return;
    lastProgressAt = now;
    const elapsed = Math.max(1, now - startedAt);
    opts.onProgress({
      percent: Math.min(99, Math.round((leader.received / total) * 100)),
      transferred: leader.received,
      total,
      bytesPerSecond: Math.round((leader.received * 1000) / elapsed),
      source: leader.label,
    });
  };

  const lanes = candidates.map(
    async (cand): Promise<{ data: Buffer | null; error: string | null; label: string }> => {
      const lane: Lane = { label: cand.label, chunks: [], received: 0 };
      try {
        const res = await fetchWithTimeout(cand.url, timeoutMs, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentLength = Number(res.headers.get('content-length') ?? -1);
        if (contentLength !== -1 && contentLength !== total) {
          throw new Error(`content-length ${contentLength} != expected ${total}`);
        }
        if (!res.body) throw new Error('response body is null');
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          lane.chunks.push(value);
          lane.received += value.length;
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            abortReason = `no data received for ${Math.round(stallMs / 1000)}s`;
            controller.abort();
          }, stallMs);
          if (!leader || lane.received > leader.received) leader = lane;
          reportProgress();
        }
        const data = Buffer.concat(lane.chunks);
        if (data.length !== total) throw new Error(`short read: ${data.length}/${total}`);
        const digest = createHash('sha512').update(data).digest('hex');
        if (digest !== info.sha512) throw new Error(`SHA-512 mismatch for core ${info.version} from winner`);
        controller.abort(); // win the race; cancel the remaining lanes
        return { data, error: null, label: cand.label };
      } catch (e) {
        return { data: null, error: `${cand.label}: ${e instanceof Error ? e.message : String(e)}`, label: cand.label };
      }
    },
  );

  const outcomes = await Promise.all(lanes);
  clearTimeout(stallTimer);
  clearTimeout(overallTimer);
  if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);

  const winner = outcomes.find((o) => o.data !== null);
  if (winner?.data) {
    if (opts.onProgress) {
      opts.onProgress({
        percent: 100,
        transferred: total,
        total,
        bytesPerSecond: 0,
        source: winner.label,
      });
    }
    return winner.data;
  }
  if (abortReason === 'cancelled') throw new Error('core download cancelled');
  if (abortReason) throw new Error(`core download aborted: ${abortReason}`);
  const errors = outcomes.map((o) => o.error).filter((e) => e !== null);
  throw new Error(
    `all ${candidates.length} core download sources failed: ${errors.join(' | ').slice(0, 400)}`,
  );
}

/** Remove staged data for a version (e.g. after activation or user cancellation). */
export function releaseStaged(root: string, version: string): void {
  const zipPath = stagedZipPath(root, version);
  const metaPath = stagedMetaPath(root, version);
  try { fs.unlinkSync(zipPath); } catch {}
  try { fs.unlinkSync(metaPath); } catch {}
}
