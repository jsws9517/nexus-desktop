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
 * Authoritative (non-mirror) manifest sources for a concrete version.
 *
 * Mirrors exist to make the *binary* download fast, but they are untrusted
 * transport: each one could serve a different `latest.yml`. The update client
 * therefore cross-checks the discovered manifest against these two official
 * hosts (GitHub direct + Gitee) before downloading anything. Both serve tiny
 * files, so this stays cheap even on networks where only mirrors are fast.
 */
export function appAuthoritativeFeeds(version: string): FeedSource[] {
  return [
    { label: GITHUB_SOURCE.label, url: githubReleaseBase(version) },
    { label: 'Gitee', url: giteeReleaseBase(version) },
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

// ── Platform-specific manifest names ─────────────────────────────────────────

/**
 * The electron-builder update manifest file name for a given platform.
 *
 * electron-builder's `getUpdateInfoFileName()` (app-builder-lib) is:
 *   - Windows: `latest.yml`
 *   - Linux:   `latest-linux.yml`   (x64 has no arch suffix)
 *   - macOS:   `latest-mac.yml`
 *
 * We only support Windows + Linux, but the helper accepts any platform key
 * and falls back to the Windows name for unknowns. Browser-safe.
 */
export function appManifestFileName(platform: string): string {
  switch (platform) {
    case 'win32':
      return 'latest.yml';
    case 'darwin':
      return 'latest-mac.yml';
    default:
      // Linux and anything unknown → the Linux name; Linux is the only
      // non-Windows platform we ship today.
      return 'latest-linux.yml';
  }
}

/**
 * Pick the installer entry from a parsed manifest's `files[]` that matches
 * the platform + package kind the app is currently running.
 *
 * A Linux release ships BOTH `.AppImage` and `.deb` in the same `files[]`
 * (electron-builder merges the two target entries). The Windows release has
 * a single `.exe`. Which one we care about depends on how the running app
 * was installed:
 *   - Windows / NSIS        → `.exe`
 *   - Linux / AppImage      → `.AppImage`
 *   - Linux / deb install    → `.deb`
 *
 * The chosen entry's `url` / `size` are what the app will actually download
 * (electron-updater's `findFile` does the same selection by extension).
 *
 * `preferred` is a list of extensions in priority order. First match wins.
 * Returns the first file when nothing matches (defensive: the manifest
 * always has at least one entry, and electron-updater's own selection is
 * the authority — this helper only drives discovery/probe sizing).
 */
export function pickUpdateFile(files: UpdateYmlFile[], preferred: Array<string>): UpdateYmlFile | null {
  if (files.length === 0) return null;
  for (const ext of preferred) {
    const found = files.find((f) => f.url.toLowerCase().endsWith(ext.toLowerCase()));
    if (found) return found;
  }
  return files[0];
}

/**
 * How the currently-running app was installed / how its self-update runs.
 * Shared by `Updater.packageKind()` (main) and the settings UI (renderer),
 * which reads it from state updates so it can show deb-specific install hints.
 *
 *   - `nsis`      — Windows: NsisUpdater, silent differential install on quit.
 *   - `appimage`  — Linux: AppImageUpdater. Diff read from the running
 *                    $APPIMAGE; install is a file-swap on quit.
 *   - `deb`       — Linux: DebUpdater. Full .deb download; install requires
 *                    system authorization (polkit/pkexec), never silent.
 *   - `unsupported` — packaged but not a recognized install shape (an
 *                    extracted AppImage, an rpm/pacman build, or a run from
 *                    linux-unpacked). Discovery still works; no in-app
 *                    install path is safe.
 */
export type AppPackageKind = 'nsis' | 'appimage' | 'deb' | 'unsupported';

// ── Manifest parsing ─────────────────────────────────────────────────────────

export interface UpdateYmlFile {
  url: string;
  size: number | null;
  sha512: string | null;
  blockmapUrl: string | null;
  /**
   * AppImage (Linux) only: electron-builder embeds the differential blockmap
   * into the AppImage binary and writes its size here. electron-updater's
   * AppImageUpdater reads `blockMapSize` from the running $APPIMAGE at
   * download time — without it, differential updates silently fall back to
   * a full download.
   */
  blockMapSize?: number | null;
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
    else if (key === 'blockMapSize') f.blockMapSize = Number(val) || null;
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

/**
 * Parse a dotted version into comparable fields.
 *
 * Recognizes:
 *   - `0.3.1` / `v0.3.1`        → [0, 3, 1, '']
 *   - `1.1.26-3` (numeric)      → [1, 1, 26, '3']
 *   - `0.3.4-beta.2` (named)    → [0, 3, 4, 'beta.2']
 *
 * The prerelease id is kept as the raw string so named suffixes (`-beta`,
 * `-alpha`) and numeric ones (`-3`) both round-trip. `''` means release.
 */
function parseVersion(v: string): [number, number, number, string] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(\S+))?/.exec(v.trim());
  if (!m) return [0, 0, 0, ''];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''];
}

/**
 * Extract the numeric tail of a prerelease id for ordering.
 * `beta.10` → 10, `beta.2` → 2, `3` → 3, `alpha` → null.
 * This makes `beta.10 > beta.9` compare as 10 > 9 (numeric, not lexicographic).
 */
function prereleaseNum(pre: string): number | null {
  const m = /(\d+)$/.exec(pre);
  return m ? Number(m[1]) : null;
}

/**
 * Compare two prerelease ids (both non-empty, both different).
 * Returns a negative / zero / positive int like compareVersions.
 *
 * Ordering rules (semver-aligned):
 *   1. numeric id (`3`) < named id (`beta.2`) — semver ranks a bare number
 *      below an alphanumeric identifier.
 *   2. same family (both numeric, or both `beta.*` / same named prefix):
 *      compare the numeric tail numerically (`beta.10` > `beta.9`).
 *   3. same family with no numeric tail: lexicographic.
 *   4. different named prefixes: lexicographic (`alpha` < `beta`).
 */
function comparePrereleaseIds(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1; // numeric < named
  if (bNum) return 1;
  // Both named: same family? (prefix before the last dot, or the whole id)
  const aPrefix = a.includes('.') ? a.slice(0, a.lastIndexOf('.')) : a;
  const bPrefix = b.includes('.') ? b.slice(0, b.lastIndexOf('.')) : b;
  if (aPrefix !== bPrefix) {
    return aPrefix < bPrefix ? -1 : aPrefix > bPrefix ? 1 : 0;
  }
  // Same family: compare the numeric tail if both have one, else lexicographic.
  const aTail = prereleaseNum(a);
  const bTail = prereleaseNum(b);
  if (aTail !== null && bTail !== null) return aTail - bTail;
  if (aTail !== null) return 1;
  if (bTail !== null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare dotted versions with an optional prerelease suffix.
 * Semver-like ordering:
 *   - `1.1.26` > `1.1.26-3` (a release outranks its own prerelease)
 *   - `1.1.26-10` > `1.1.26-9` (numeric prereleases compare numerically)
 *   - `1.1.26-beta.2` < `1.1.26` (named prereleases rank below the release)
 *   - `0.3.4-beta.10` > `0.3.4-beta.9` (numeric tail of named pre compared numerically)
 */
export function compareVersions(a: string, b: string): number {
  const [majA, minA, patA, preA] = parseVersion(a);
  const [majB, minB, patB, preB] = parseVersion(b);
  if (majA !== majB) return majA - majB;
  if (minA !== minB) return minA - minB;
  if (patA !== patB) return patA - patB;
  if (preA === preB) return 0;
  if (preA === '') return 1; // release > prerelease
  if (preB === '') return -1;
  return comparePrereleaseIds(preA, preB);
}

/**
 * True when `candidate` should be offered to a user currently on `current`.
 *
 * Normal case: strictly newer under {@link compareVersions}.
 * Beta-channel case (`allowBeta=true`): a prerelease of the SAME baseline is
 * also offered — this is the cross-class move the beta channel exists to
 * enable:
 *   - `0.3.4-beta.2` when running `0.3.4` (stable → beta)
 *   - `0.3.4-beta.2` when running `0.3.4-beta.1` (beta → newer beta)
 *   - `0.3.5` when running `0.3.4-beta.2` (beta → newer stable)
 * Without `allowBeta` a stable install never sees same-baseline prereleases.
 */
export function isNewer(candidate: string, current: string, allowBeta: boolean = false): boolean {
  const c = compareVersions(candidate, current);
  if (c > 0) {
    // Strictly newer under normal semver ranking. Exception: when the
    // candidate is a RELEASE and the current is a PRERELEASE of the same
    // [major, minor, patch] (e.g. 0.3.4 vs 0.3.4-beta.1), that is a
    // downgrade to the user's own stable baseline — never offered.
    const [cmaj, cmin, cpat, cPre] = parseVersion(candidate);
    const [umaj, umin, upat, uPre] = parseVersion(current);
    if (
      cPre === '' && uPre !== '' &&
      cmaj === umaj && cmin === umin && cpat === upat
    ) {
      return false; // same-baseline release vs own beta → downgrade, no offer
    }
    return true;
  }
  if (!allowBeta) return false; // c <= 0 and no beta channel → not offered
  // c <= 0 with allowBeta: legitimate beta-channel offers only when
  // candidate and current share the same [major, minor, patch] baseline.
  const [cmaj, cmin, cpat] = parseVersion(candidate);
  const [umaj, umin, upat] = parseVersion(current);
  if (cmaj !== umaj || cmin !== umin || cpat !== upat) return false;
  const cPre = parseVersion(candidate)[3];
  const uPre = parseVersion(current)[3];
  if (cPre === uPre) return false; // identical prerelease id → same version
  if (uPre === '' && cPre !== '') return true; // stable → beta (same baseline)
  if (cPre !== '' && uPre !== '') return true;  // newer same-baseline beta
  return false; // candidate is release, current is beta → downgrade
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
