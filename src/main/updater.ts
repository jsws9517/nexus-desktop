import { app } from 'electron';
import updaterModule from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import {
  GITEE_REPO,
  appManifestFeeds,
  appVersionFeeds,
  compareVersions,
  giteeReleaseBase,
  parseUpdateYml,
  type FeedSource,
} from '../shared/update-sources.js';
import { seedOldBlockmapFor } from './update-cache.js';
import { logger } from '../shared/logger.js';

/**
 * Two-stage source selection (A1 + A3) with differential downloads (A4).
 *
 * 1. DISCOVERY — fetch `latest.yml` in parallel from every candidate feed
 *    (GitHub direct + CN mirrors; Gitee tag feed as a manifest-only
 *    fallback). When no discovered version is newer than the running app we
 *    report that directly — no speed test, no electron-updater round-trip.
 * 2. RACE — pin every candidate to the newest version's tag URL and probe
 *    each with a 256 KiB Range request. Rank by measured throughput, pick
 *    the winner, retry on the next-ranked source if the download fails.
 *
 * The winner is applied to electron-updater via
 * `setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false })`
 * BEFORE `checkForUpdates()`: electron-updater resolves `files[].url` to
 * absolute URLs against the active feed at check time, so switching feeds
 * after a check would have no effect on the download.
 *
 * A4: the generic provider is forced to single-Range mode (multiple-Range
 * requests are the historical reason differential downloads were rejected)
 * and the OLD version's blockmap is pre-seeded into the updater cache, so
 * electron-updater never has to fetch it from a URL that 404s under the
 * new version's tag. When the cache cannot be verified, differential
 * download is disabled for the session (full download instead).
 */
const MANIFEST_TIMEOUT_MS = 6000;
/** 256 KiB Range probe per candidate feed (A1). */
const RANGE_PROBE_BYTES = 256 * 1024;
/** Hard cap on probe bytes even when a server ignores the Range header. */
const PROBE_BYTE_CAP = 1024 * 1024;
const PROBE_TIMEOUT_MS = 8000;
/** After the initial attempt, retry the download on at most this many next-ranked sources. */
const MAX_SOURCE_RETRIES = 2;

export interface DiscoveredUpdate {
  /** The feed that produced this manifest. */
  feed: FeedSource;
  version: string;
  /** `files[0].url` of the manifest: a relative asset name, or an absolute
   * URL when the feed (Gitee) pins the asset at a GitHub address. */
  fileUrl: string;
  fileSize: number;
}

/** electron-updater's autoUpdater resolved lazily (see getAutoUpdater). */
type AutoUpdater = (typeof import('electron-updater'))['autoUpdater'];

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | { status: 'not-available'; version: string }
  | {
      status: 'downloading';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
      /** True when the bytes on the wire are a diff, not the full installer. */
      differential?: boolean;
    }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

export type UpdateStateWithSource = UpdateState & {
  source: FeedSource | null;
  /** True when the check never ran (unpackaged dev build): no probe was made. */
  devMode?: boolean;
};

export class Updater {
  private enabled = false;
  private state: UpdateState = { status: 'idle' };
  private availableInfo: UpdateInfo | null = null;
  private source: FeedSource | null = null;
  /** Speed-ranked pinned feeds for the discovered update (winner first). */
  private rankedFeeds: FeedSource[] = [];
  /** `files[0].size` of the discovered update, 0 when unknown. */
  private expectedFullSize = 0;
  /**
   * 'diff' when the old blockmap cache was verified (seeded), 'full' when
   * differential is disabled for this session, null before any download.
   */
  private differentialMode: 'diff' | 'full' | null = null;

  onState?: (state: UpdateState) => void;

  /** Current app version (for the settings UI). */
  static currentVersion(): string {
    return app.getVersion();
  }

  init(): void {
    if (!app.isPackaged) return; // npm/dev distribution: no packaged updater
    this.enabled = true;
    const autoUpdater = getAutoUpdater();
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking' });
    });
    autoUpdater.on('update-available', (info) => {
      this.availableInfo = info;
      this.setState({
        status: 'available',
        version: info.version,
        releaseNotes: this.normalizeNotes(info.releaseNotes),
      });
    });
    autoUpdater.on('update-not-available', (info) => {
      this.setState({ status: 'not-available', version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      let differential: boolean | undefined;
      const total = p.total ?? 0;
      if (this.differentialMode === 'diff') {
        // With single-Range requests `total` is the actual diff byte count.
        // If electron-updater fell back to a full download (differential
        // attempt failed mid-flight), `total` is the full installer size —
        // trust the wire over the session flag.
        differential = total === 0 ? undefined : total < this.expectedFullSize * 0.9;
      } else if (this.differentialMode === 'full') {
        differential = false;
      }
      this.setState({
        status: 'downloading',
        percent: Math.round(p.percent),
        transferred: p.transferred,
        total,
        bytesPerSecond: p.bytesPerSecond ?? 0,
        differential,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({ status: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err) => {
      this.setState({ status: 'error', message: err?.message ?? String(err) });
    });
  }

  getState(): UpdateState {
    return this.state;
  }

  /** Step 1 — check for a newer release. Never downloads. */
  async check(): Promise<UpdateStateWithSource> {
    if (!this.enabled) {
      this.setState({ status: 'error', message: 'Update checks are only available in the packaged app' });
      return { ...this.withSource(), devMode: true };
    }
    this.setState({ status: 'checking' });
    try {
      const current = this.currentVersion();
      const discovered = await this.discoverLatest();
      if (!discovered) {
        this.source = null;
        this.rankedFeeds = [];
        this.setState({ status: 'error', message: 'No reachable update source' });
        return this.withSource();
      }
      const latest = discovered;
      if (compareVersions(latest.version, current) <= 0) {
        // No new version: report it without touching electron-updater at all
        // (the old flow paid for a full check round-trip just to say "up to
        // date", which is why checks felt slow).
        this.source = latest.feed;
        this.rankedFeeds = [];
        this.setState({ status: 'not-available', version: latest.version });
        return this.withSource();
      }
      const ranked = await this.raceFeeds(latest);
      this.rankedFeeds = ranked;
      this.expectedFullSize = latest.fileSize;
      this.source = ranked[0];
      const autoUpdater = getAutoUpdater();
      this.applyFeed(autoUpdater, ranked[0]);
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return this.withSource();
  }

  /** The feed the last check() resolved to; null when no candidate was reachable. */
  getSource(): FeedSource | null {
    return this.source;
  }

  private withSource(): UpdateStateWithSource {
    return { ...this.state, source: this.source };
  }

  /** Step 2 — download the available update. Only valid after check() found one. */
  async download(): Promise<UpdateStateWithSource> {
    if (!this.enabled) return this.withSource();
    if (this.state.status !== 'available') return this.withSource();
    if (this.rankedFeeds.length === 0) {
      this.setState({ status: 'error', message: 'No update source resolved; check for updates first' });
      return this.withSource();
    }
    const autoUpdater = getAutoUpdater();
    // A4: seed the old version's blockmap (verified against the cached
    // installer) so the differential download can run without its own
    // old-blockmap download. Unverifiable cache ⇒ full download this session.
    const seed = await seedOldBlockmapFor(this.currentVersion(), this.cachePath());
    autoUpdater.disableDifferentialDownload = !seed.differential;
    this.differentialMode = seed.differential ? 'diff' : 'full';
    logger.info(`update download: differential=${seed.differential} (${seed.detail})`);
    this.setState({
      status: 'downloading',
      percent: 0,
      transferred: 0,
      total: this.expectedFullSize,
      bytesPerSecond: 0,
    });
    // Initial attempt + up to MAX_SOURCE_RETRIES on the next-ranked feeds.
    const maxAttempts = this.rankedFeeds.length <= 1 ? 1 : Math.min(1 + MAX_SOURCE_RETRIES, this.rankedFeeds.length);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const feed = this.rankedFeeds[attempt];
      if (!feed) break;
      if (attempt > 0) {
        // Switching feeds requires a re-check: electron-updater baked the
        // previous feed's absolute URLs into updateInfoAndProvider.
        this.source = feed;
        this.applyFeed(autoUpdater, feed);
        this.setState({ status: 'checking' });
        try {
          await autoUpdater.checkForUpdates();
        } catch {
          // the 'error' event already updated the state
        }
      }
      try {
        await autoUpdater.downloadUpdate();
        return this.withSource();
      } catch {
        // The 'error' event set the state; try the next-ranked source.
      }
    }
    if ((this.getState() as UpdateState).status !== 'downloaded') {
      this.setState({ status: 'error', message: 'Download failed on all update sources' });
    }
    return this.withSource();
  }

  /** Step 3 — quit the app and install the downloaded update. */
  install(): void {
    if (!this.enabled || this.state.status !== 'downloaded') return;
    getAutoUpdater().quitAndInstall(false, true);
  }

  private currentVersion(): string {
    return app.getVersion();
  }

  /**
   * electron-updater's base cache path (`<cache>/<updaterCacheDirName>`).
   * The installed electron typings omit 'cache' from `getPath`, so cast.
   */
  private cachePath(): string {
    return (app as unknown as { getPath: (name: string) => string }).getPath('cache');
  }

  private applyFeed(autoUpdater: AutoUpdater, feed: FeedSource): void {
    // A4: explicit single-Range mode. providerFactory's generic branch reads
    // `options.useMultipleRangeRequest !== false` — passing false is what
    // makes the differential path viable (multi-Range was the root cause of
    // differential downloads being rejected).
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: feed.url,
      useMultipleRangeRequest: false,
    });
  }

  // ── Stage 1: discovery ─────────────────────────────────────────────────────

  /**
   * Parallel `latest.yml` fetch across all candidate feeds; returns the
   * newest discovered version (with the feed that announced it) or null
   * when nothing was reachable.
   */
  private async discoverLatest(): Promise<DiscoveredUpdate | null> {
    const override = process.env.NEXUS_UPDATE_MIRROR;
    const feeds = override ? [{ label: 'NEXUS_UPDATE_MIRROR', url: override }] : appManifestFeeds();
    const results = await Promise.allSettled(
      feeds.map(async (feed) => this.fetchManifest(feed.url, feed.label)),
    );
    const found: DiscoveredUpdate[] = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    if (!override) {
      // Gitee is a manifest-only fallback (never enters the download race —
      // its published latest.yml pins the installer at a GitHub absolute
      // URL), but it keeps discovery alive when GitHub and every mirror
      // are unreachable from the user's network.
      const gitee = await this.fetchGiteeManifest();
      if (gitee) found.push(gitee);
    }
    if (found.length === 0) return null;
    found.sort((a, b) => compareVersions(b.version, a.version));
    return found[0];
  }

  private async fetchManifest(feedBase: string, label: string): Promise<DiscoveredUpdate | null> {
    const url = `${feedBase.replace(/\/$/, '')}/latest.yml`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return null;
      const parsed = parseUpdateYml(await res.text());
      if (!parsed || !parsed.version || !parsed.files[0]?.url) return null;
      return {
        feed: { label, url: feedBase },
        version: parsed.version,
        fileUrl: parsed.files[0].url,
        fileSize: parsed.files[0].size ?? 0,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gitee does not implement GitHub's `releases/latest/download` alias, so
   * query the public releases API, pick the newest stable tag, and read that
   * tag's `latest.yml`. Returns null when the API or the manifest fails.
   */
  private async fetchGiteeManifest(): Promise<DiscoveredUpdate | null> {
    let releases: Array<{ tag_name?: string; prerelease?: boolean }> = [];
    {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
      try {
        const res = await fetch(`https://gitee.com/api/v5/repos/${GITEE_REPO}/releases`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          releases = (await res.json()) as Array<{ tag_name?: string; prerelease?: boolean }>;
        }
      } catch {
        /* Gitee API unreachable: CN fallback unavailable */
      } finally {
        clearTimeout(timer);
      }
    }
    const tagged = releases
      .map((r) => ({
        tag: r.tag_name ?? '',
        prerelease: r.prerelease === true,
        version: parseTagVersion(r.tag_name ?? ''),
      }))
      .filter((r): r is { tag: string; prerelease: boolean; version: string } => r.version !== null);
    const stable = tagged.filter((r) => !r.prerelease);
    const pool = stable.length > 0 ? stable : tagged;
    if (pool.length === 0) return null;
    pool.sort((a, b) => compareVersions(b.version, a.version));
    const base = giteeReleaseBase(pool[0].tag);
    return this.fetchManifest(base, 'Gitee');
  }

  // ── Stage 2: throughput race ───────────────────────────────────────────────

  /**
   * Rank the version-pinned feeds by a live 256 KiB Range probe and return
   * them best-first. Falls back to GitHub direct when no probe gets a
   * single byte (the user may be outside CN where GitHub is fastest — or
   * every mirror is down).
   */
  private async raceFeeds(discovered: DiscoveredUpdate): Promise<FeedSource[]> {
    if (process.env.NEXUS_UPDATE_MIRROR) return [discovered.feed];
    const pinned = appVersionFeeds(discovered.version);
    const results = await Promise.all(
      pinned.map(async (feed) => ({ feed, speed: await this.probeThroughput(feed.url, discovered) })),
    );
    results.sort((a, b) => b.speed - a.speed);
    const ranked = results.filter((r) => r.speed > 0).map((r) => r.feed);
    return ranked.length > 0 ? ranked : [pinned[0]];
  }

  /**
   * Measure a candidate feed by pulling RANGE_PROBE_BYTES (256 KiB) of the
   * update installer with a `Range` header. Servers that ignore Range still
   * get capped at PROBE_BYTE_CAP, so no candidate can stall the race.
   * Returns bytes/second (0 when nothing could be read).
   */
  private async probeThroughput(feedBase: string, discovered: DiscoveredUpdate): Promise<number> {
    const url = discovered.fileUrl.startsWith('http')
      ? discovered.fileUrl
      : `${feedBase.replace(/\/$/, '')}/${discovered.fileUrl}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${RANGE_PROBE_BYTES - 1}` },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok && res.status !== 206) return 0;
      let bytes = 0;
      const reader = res.body?.getReader();
      if (reader) {
        while (bytes < PROBE_BYTE_CAP) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value?.length ?? 0;
        }
      }
      const elapsed = Date.now() - t0;
      if (elapsed <= 0 || bytes === 0) return 0;
      return (bytes * 1000) / elapsed;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeNotes(notes?: UpdateInfo['releaseNotes']): string | undefined {
    if (typeof notes === 'string') return notes;
    if (Array.isArray(notes)) {
      return notes.map((n) => n.note ?? '').filter(Boolean).join('\n');
    }
    return undefined;
  }

  private setState(state: UpdateState): void {
    this.state = state;
    this.onState?.(state);
  }
}

/** Parse a release tag into its dotted version, or null. */
function parseTagVersion(tag: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// electron-updater v6 exposes `autoUpdater` as a lazy getter on the CJS
// default export; the named import (`import { autoUpdater }`) fails under
// NodeNext ESM resolution and the getter instantiates an NsisUpdater (needs
// Electron's app), so resolve it lazily inside init() — never at module load.
function getAutoUpdater(): AutoUpdater {
  return (updaterModule as unknown as { autoUpdater: AutoUpdater }).autoUpdater;
}
