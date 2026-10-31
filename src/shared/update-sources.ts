/**
 * Shared update-feed table + manifest/version helpers.
 *
 * Used by BOTH update paths:
 *   - the app installer feed (electron-updater, src/main/updater.ts)
 *   - the core overlay feed (src/core-overlay/download.ts, manager.ts)
 *
 * Browser-safe: no node imports, so the renderer can use formatSpeed().
 *
 * The mirror table is ordered by measured large-file throughput from CN
 * networks (2026-10, 2 MiB Range probe):
 *
 *   ghproxy.imciel.com  ~402 KB/s
 *   gh-proxy.org        ~317–335 KB/s
 *   v6.gh-proxy.com     ~247 KB/s
 *   gh-proxy.com        ~147–197 KB/s
 *   ghfile.geekertao.top ~126–153 KB/s
 *   ghproxy.net         ~21 KB/s
 *   ghfast.top          manifest reachable but STALLS on large files —
 *                       kept only as the very last hope.
 *
 * GitHub direct is kept first in candidate lists (it is the fastest outside
 * CN and the authoritative source), but the two-stage selection in
 * src/main/updater.ts always re-ranks by a live 256 KiB Range probe before
 * any real download, so list order only matters for the fallbacks.
 */

export const GITHUB_REPO = 'jsws9517/nexus-desktop';
export const GITEE_REPO = 'cict_1_0/nexus-desktop';

export interface FeedSource {
  label: string;
  url: string;
}

export interface Mirror {
  label: string;
  /** Prefix form: `${prefix}${githubUrl}` yields the mirrored URL. */
  prefix: string;
}

/** CN mirrors for GitHub release assets, in measured speed order. */
export const GITHUB_MIRRORS: Mirror[] = [
  { label: 'ghproxy.imciel.com', prefix: 'https://ghproxy.imciel.com/' },
  { label: 'gh-proxy.org', prefix: 'https://gh-proxy.org/' },
  { label: 'v6.gh-proxy.com', prefix: 'https://v6.gh-proxy.com/' },
  { label: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { label: 'ghfile.geekertao.top', prefix: 'https://ghfile.geekertao.top/' },
  { label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  // Stalls on big files: last resort only.
  { label: 'ghfast.top', prefix: 'https://ghfast.top/' },
];

export const GITHUB_SOURCE: FeedSource = {
  label: 'GitHub',
  url: `https://github.com/${GITHUB_REPO}`,
};

/** GitHub `releases/latest/download` base (manifest discovery). */
export const GITHUB_LATEST_BASE = `https://github.com/${GITHUB_REPO}/releases/latest/download`;

/** Pinned release download base (used after discovery so URLs are version-fixed). */
export function githubReleaseBase(version: string): string {
  const v = version.replace(/^v/i, '');
  return `https://github.com/${GITHUB_REPO}/releases/download/v${v}`;
}

/** Gitee has no `latest/download` alias — feeds must be tag-based. */
export function giteeReleaseBase(tag: string): string {
  const t = tag.replace(/^v/i, '');
  return `https://gitee.com/${GITEE_REPO}/releases/download/v${t}`;
}

/**
 * All download candidates for a github.com release asset: direct GitHub
 * first, then every CN mirror (speed order). Non-github URLs (e.g. Gitee
 * attachment URLs referenced by a Gitee-hosted manifest) are returned as-is,
 * labeled by host. Integrity never depends on the transport: sha512/size
 * are verified no matter which candidate served the bytes.
 */
export function assetCandidates(githubUrl: string): FeedSource[] {
  if (!githubUrl.startsWith('https://github.com/')) {
    let host = githubUrl;
    try {
      host = new URL(githubUrl).host;
    } catch {
      /* keep the raw URL as the label */
    }
    return [{ label: host, url: githubUrl }];
  }
  return [
    { label: GITHUB_SOURCE.label, url: githubUrl },
    ...GITHUB_MIRRORS.map((m) => ({ label: m.label, url: `${m.prefix}${githubUrl}` })),
  ];
}

/** App manifest feeds probed in parallel for discovery (latest/download alias). */
export function appManifestFeeds(): FeedSource[] {
  return [
    { label: GITHUB_SOURCE.label, url: GITHUB_LATEST_BASE },
    ...GITHUB_MIRRORS.map((m) => ({ label: m.label, url: `${m.prefix}${GITHUB_LATEST_BASE}` })),
  ];
}

/**
 * Pinned, version-fixed app installer feeds (mirrors + GitHub direct).
 * Gitee is deliberately excluded: its published latest.yml pins the exe to
 * GitHub absolute URLs (by design), so it can only serve as a manifest
 * fallback and can never win a download race.
 */
export function appVersionFeeds(version: string): FeedSource[] {
  const base = githubReleaseBase(version);
  return [
    { label: GITHUB_SOURCE.label, url: base },
    ...GITHUB_MIRRORS.map((m) => ({ label: m.label, url: `${m.prefix}${base}` })),
  ];
}

// ── Manifest parsing ─────────────────────────────────────────────────────────

export interface UpdateYmlFile {
  url: string;
  size: number | null;
  sha512: string | null;
  blockmapUrl: string | null;
}

export interface ParsedUpdateYml {
  version: string;
  files: UpdateYmlFile[];
  path: string | null;
  sha512: string | null;
  releaseNotes: string | null;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Minimal parser for electron-builder's `latest.yml` (NSIS). No YAML
 * dependency: the format is flat `key: value` lines with a `files:` list of
 * `- url: …` items. Handles both js-yaml compact (`- url:` at column 0) and
 * 2-space-indented list items, plus relative or absolute `files[].url`.
 * Returns null when no version can be extracted.
 */
export function parseUpdateYml(text: string): ParsedUpdateYml | null {
  let version = '';
  let pathName: string | null = null;
  let sha512: string | null = null;
  let releaseNotes: string | null = null;
  const files: UpdateYmlFile[] = [];
  let current: UpdateYmlFile | null = null;

  const setFileField = (f: UpdateYmlFile, key: string, val: string): void => {
    if (key === 'url') f.url = val;
    else if (key === 'size') f.size = Number(val) || null;
    else if (key === 'sha512') f.sha512 = val;
    else if (key === 'blockmapUrl') f.blockmapUrl = val;
  };

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim().replace(/\r$/, '');
    if (trimmed === '') continue;
    const indent = raw.length - raw.trimStart().length;
    const listItem = /^-\s+([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/.exec(trimmed);
    if (listItem) {
      // A new files[] item. js-yaml's compact style puts `- url:` at column 0,
      // the block style indents it — accept both. The only list in latest.yml
      // is `files:`.
      if (current) files.push(current);
      current = { url: '', size: null, sha512: null, blockmapUrl: null };
      setFileField(current, listItem[1], unquote(listItem[2] ?? ''));
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_.-]*):\s*(.*)$/.exec(trimmed);
    if (!kv) continue; // not a key: value line (comment, folded text, …)
    const key = kv[1];
    const val = unquote(kv[2]);
    if (indent === 0) {
      // Top-level key: it ends the current files[] item.
      if (current) {
        files.push(current);
        current = null;
      }
      if (key === 'version') version = val;
      else if (key === 'path') pathName = val;
      else if (key === 'sha512') sha512 = val;
      else if (key === 'releaseNotes') releaseNotes = val;
      continue;
    }
    // Indented field of the current files[] item.
    if (current) setFileField(current, key, val);
  }
  if (current) files.push(current);

  if (!version) return null;
  return { version, files, path: pathName, sha512, releaseNotes };
}

// ── Version comparison ────────────────────────────────────────────────────────

/** Parse `0.3.1`, `v0.3.1` or `1.1.26-3` → [major, minor, patch, preRelease]. */
function parseVersion(v: string): [number, number, number, number | null] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0, null];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : null];
}

/**
 * Compare dotted versions with an optional numeric prerelease suffix.
 * Semver-like: a release outranks its own prerelease (`1.1.26` > `1.1.26-3`),
 * prereleases compare numerically (`1.1.26-10` > `1.1.26-9`).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  if (pa[2] !== pb[2]) return pa[2] - pb[2];
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === null) return 1; // release > prerelease
  if (pb[3] === null) return -1;
  return pa[3] - pb[3];
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** `312 KB/s` / `1.2 MB/s` style speed label. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}
