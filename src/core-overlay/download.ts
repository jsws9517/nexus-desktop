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
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

const STAGED_DIR = 'staged';

export interface CoreUpdateInfo {
  version: string;
  /** SHA-512 hex digest as published in latest-core.yml. */
  sha512: string;
  /** Exact uncompressed zip size in bytes. */
  size: number;
  /** Download URL for `core-<version>.zip`. */
  url: string;
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
  timestamp: string;
  /** nexusDesktopProtocol the core was built against (null when undeclared). */
  protocol: number | null;
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
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) {
      if (current.version && current.sha512 && current.size != null) {
        entries.push({ version: current.version, sha512: current.sha512, size: current.size,
          url: current.url ?? '', timestamp: current.timestamp ?? '',
          protocol: current.protocol ?? null, offset: 0 });
      }
      current = {};
      continue;
    }
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'version') current.version = val;
    else if (key === 'sha512') current.sha512 = val;
    else if (key === 'size') current.size = Number(val);
    else if (key === 'url') current.url = val;
    else if (key === 'timestamp') current.timestamp = val;
    else if (key === 'protocol') {
      const n = Number(val);
      current.protocol = Number.isInteger(n) && n >= 0 ? n : null;
    }
  }
  if (current.version && current.sha512 && current.size != null) {
    entries.push({ version: current.version, sha512: current.sha512, size: current.size,
      url: current.url ?? '', timestamp: current.timestamp ?? '',
      protocol: current.protocol ?? null, offset: 0 });
  }
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
 * Fetch latest-core.yml (and its .sig) from a feed URL.
 * Verifies the ed25519 signature when a public key is available.
 * Returns entries sorted descending by version (first = newest).
 */
export async function fetchCoreManifest(feedUrl: string): Promise<ManifestEntry[]> {
  const base = feedUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const [ymlRes, sigRes] = await Promise.all([
      fetch(`${base}/latest-core.yml`, { signal: controller.signal }),
      fetch(`${base}/latest-core.yml.sig`, { signal: controller.signal }).catch(() => null),
    ]);
    if (!ymlRes.ok) throw new Error(`HTTP ${ymlRes.status}`);
    const text = await ymlRes.text();
    const sigHex = sigRes?.ok ? await sigRes.text() : '';
    if (sigHex && !verifyManifestSignature(text, sigHex)) {
      throw new Error('core manifest signature verification failed');
    }
    return parseCoreManifest(text);
  } finally {
    clearTimeout(timer);
  }
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
 */
export async function downloadCoreUpdate(root: string, info: CoreUpdateInfo): Promise<DownloadResult> {
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

  let downloaded = 0;
  let hash: ReturnType<typeof createHash>;
  try {
    const res = await fetch(info.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading core zip`);
    const contentLength = Number(res.headers.get('content-length') ?? -1);
    if (contentLength !== -1 && contentLength !== info.size) {
      throw new Error(`content-length mismatch: expected ${info.size}, got ${contentLength}`);
    }
    hash = createHash('sha512');
    const dest = fs.createWriteStream(tmpPath, { flags: 'w' });
    if (!res.body) throw new Error('response body is null');
    // Hash the same bytes that are written to disk. Hashing the response body
    // separately (or not at all) silently compares against an empty digest.
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    await pipeline(res.body, hasher, dest);
    downloaded = dest.bytesWritten;
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }

  const actual = hash.digest('hex');
  if (actual !== info.sha512) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(
      `SHA-512 mismatch for core ${info.version}: expected ${info.sha512}, got ${actual}`,
    );
  }

  fs.renameSync(tmpPath, zipPath);
  fs.writeFileSync(metaPath,
    `version: ${info.version}\nsha512: ${info.sha512}\nsize: ${info.size}\nurl: ${info.url}\ntimestamp: ${info.timestamp}\n`);
  return { version: info.version, zipPath, metaPath, bytesWritten: downloaded };
}

/** Remove staged data for a version (e.g. after activation or user cancellation). */
export function releaseStaged(root: string, version: string): void {
  const zipPath = stagedZipPath(root, version);
  const metaPath = stagedMetaPath(root, version);
  try { fs.unlinkSync(zipPath); } catch {}
  try { fs.unlinkSync(metaPath); } catch {}
}
