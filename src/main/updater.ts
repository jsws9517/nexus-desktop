import { app } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import updaterModule from 'electron-updater';
import type { UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import {
  GITEE_REPO,
  appAuthoritativeFeeds,
  appManifestFileName,
  appManifestFeeds,
  appVersionFeeds,
  compareVersions,
  giteeReleaseBase,
  parseUpdateYml,
  pickUpdateFile,
  type AppPackageKind,
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
  /**
   * Base64 SHA-512 of the selected installer as declared by the manifest.
   * Cross-checked against the authoritative GitHub/Gitee manifest and then
   * re-verified against the downloaded bytes.
   */
  sha512: string | null;
}

/** electron-updater's autoUpdater resolved lazily (see getAutoUpdater). */
type AutoUpdater = (typeof import('electron-updater'))['autoUpdater'];

export type { AppPackageKind } from '../shared/update-sources.js';

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
  | { status: 'error'; message: string }
  | { status: 'unsupported' };

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
   * SHA-512 (base64) of the selected installer, taken from the AUTHORITATIVE
   * manifest (GitHub/Gitee), never from the mirror that won the download race.
   * Null when verification is impossible (dev-only NEXUS_UPDATE_MIRROR).
   */
  private trustedSha512: string | null = null;
  /** Pending post-download integrity check for the current attempt. */
  private verification: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;
  /**
   * 'diff' when the old blockmap cache was verified (seeded), 'full' when
   * differential is disabled for this session, null before any download.
   */
  private differentialMode: 'diff' | 'full' | null = null;
  /**
   * How the running app was installed. Resolved lazily on first access;
   * cached. Drives the manifest file name, which `files[]` entry we probe,
   * whether `seedOldBlockmapFor` is called, and whether install-on-quit
   * is safe (deb installs require polkit/pkexec, never silent).
   */
  private cachedKind: AppPackageKind | null = null;
  /** Guards concurrent check()/download()/autoCheck() invocations. */
  private busy = false;

  onState?: (state: UpdateState & { packageKind?: AppPackageKind }) => void;

  /** Current app version (for the settings UI). */
  static currentVersion(): string {
    return app.getVersion();
  }

  /**
   * How the running app was installed (and which electron-updater branch
   * applies). See {@link AppPackageKind}.
   *
   * Detected from two signals, checked in order:
   *   1. `resources/package-type` — written only by the FpmTarget when
   *      packaging a deb/rpm/pacman; the AppImage target does NOT write
   *      it (build order is AppImage → deb). Its presence and value is
   *      the authoritative signal for deb.
   *   2. `process.env.APPIMAGE` — set by the AppImage runtime; when
   *      running an AppImage this is the absolute path of the file.
   */
  packageKind(): AppPackageKind {
    if (this.cachedKind) return this.cachedKind;
    this.cachedKind = resolvePackageKind();
    return this.cachedKind;
  }

  init(): void {
    if (!app.isPackaged) return; // npm/dev distribution: no packaged updater
    this.enabled = true;
    const autoUpdater = getAutoUpdater();
    autoUpdater.autoDownload = false;
    // Never accept a manifest that advertises an older version: a hostile
    // mirror could otherwise force a downgrade to a vulnerable build.
    autoUpdater.allowDowngrade = false;
    //
    // Install-on-quit policy:
    //   - Windows NSIS and Linux AppImage: silent, no system prompt → allow.
    //   - Linux deb: dpkg needs polkit/pkexec, which must happen WITH the
    //     user present → disable; the "Restart & Install" button is the
    //     only path, and the error text surfaces pkexec failures.
    //
    // electron-updater's default is `autoInstallOnAppQuit = true` on every
    // platform; the previous `= false` here was set to keep Windows
    // install behavior explicit. Restoring the default for the two
    // silent-safe kinds while keeping deb explicit.
    autoUpdater.autoInstallOnAppQuit = this.packageKind() !== 'deb';

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
      // Hashing a large installer is async: keep the public state at
      // 'downloading' until the bytes match the authoritative manifest, so
      // the UI can never offer "Restart & Install" for an unverified file.
      void this.handleDownloaded(info);
    });
    autoUpdater.on('error', (err) => {
      this.setState({ status: 'error', message: err?.message ?? String(err) });
    });
  }

  /**
   * Verify the freshly downloaded installer against the authoritative
   * SHA-512 before exposing the 'downloaded' state. Mirrors are untrusted
   * transport, so this is the last line of defence after the manifest
   * cross-check in {@link check}.
   */
  private async handleDownloaded(info: UpdateDownloadedEvent): Promise<void> {
    let ok = true;
    let message = '';
    const expected = this.trustedSha512;
    if (expected) {
      if (!info.downloadedFile) {
        ok = false;
        message = 'Downloaded update is missing its file path';
      } else {
        try {
          const actual = await sha512File(info.downloadedFile);
          if (actual !== expected) {
            ok = false;
            message = 'Downloaded update failed integrity verification';
            logger.error('update download: sha512 mismatch, discarding installer');
          }
        } catch (e) {
          ok = false;
          message = `Could not verify the downloaded update: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    if (!ok) {
      // Remove the tampered/corrupt installer so a later install-on-quit can
      // never pick it up.
      if (info.downloadedFile) {
        await rm(info.downloadedFile, { force: true }).catch(() => undefined);
      }
      this.setState({ status: 'error', message });
    } else {
      this.setState({ status: 'downloaded', version: info.version });
    }
    const pending = this.verification;
    this.verification = null;
    pending?.resolve(ok);
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
    if (this.busy) return this.withSource();
    this.busy = true;
    try {
      // Unsupported package kinds (extracted AppImage, rpm/pacman, …) can
      // still discover a newer release, but electron-updater has no install
      // path for them. Surface the state without touching electron-updater.
      if (this.packageKind() === 'unsupported') {
        this.setState({ status: 'unsupported' });
        return this.withSource();
      }
      this.setState({ status: 'checking' });
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
        this.trustedSha512 = null;
        this.setState({ status: 'not-available', version: latest.version });
        return this.withSource();
      }
      // H1: a mirror may be the fastest (or only reachable) host, but it is
      // untrusted transport. Cross-check the winning manifest against the
      // official GitHub/Gitee release before downloading: the version and
      // the installer SHA-512 must match exactly. Without this, a single
      // compromised mirror could serve both a poisoned latest.yml and a
      // matching installer.
      if (process.env.NEXUS_UPDATE_MIRROR) {
        // Explicit dev/test override: the mirror is the trust root by design.
        logger.warn('update check: NEXUS_UPDATE_MIRROR set; skipping authoritative manifest cross-check');
        this.trustedSha512 = latest.sha512;
      } else {
        const authoritative = await this.fetchAuthoritative(latest.version, this.manifestName());
        if (!authoritative) {
          this.source = latest.feed;
          this.rankedFeeds = [];
          this.trustedSha512 = null;
          this.setState({
            status: 'error',
            message: 'Could not verify the update manifest against GitHub or Gitee',
          });
          return this.withSource();
        }
        if (
          compareVersions(authoritative.version, latest.version) !== 0 ||
          !latest.sha512 ||
          !authoritative.sha512 ||
          latest.sha512 !== authoritative.sha512
        ) {
          this.source = latest.feed;
          this.rankedFeeds = [];
          this.trustedSha512 = null;
          this.setState({
            status: 'error',
            message: 'Update manifest does not match the authoritative GitHub/Gitee release',
          });
          return this.withSource();
        }
        this.trustedSha512 = authoritative.sha512;
      }
      const ranked = await this.raceFeeds(latest);
      this.rankedFeeds = ranked;
      this.expectedFullSize = latest.fileSize;
      this.source = ranked[0];
      const autoUpdater = getAutoUpdater();
      this.applyFeed(autoUpdater, ranked[0]);
      const result = await autoUpdater.checkForUpdates();
      // electron-updater returns null when its updater is inactive (e.g. the
      // AppImage was launched in a way that does not set APPIMAGE, or the
      // autoUpdater was constructed without a usable feed). No 'update-available'
      // / 'update-not-available' event will fire in that case, so without
      // this the state would stay stuck at 'checking'.
      if (result === null && this.getState().status === 'checking') {
        this.setState({ status: 'unsupported' });
      }
      // Defensive: even with a live updater, events are async — if the check
      // completed without ever reaching 'available' / 'not-available' / 'error',
      // resolve the hang with a not-available marker so the UI never stalls.
      if (this.getState().status === 'checking') {
        this.setState({ status: 'not-available', version: latest.version });
      }
      return this.withSource();
    } catch (e) {
      this.setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
    return this.withSource();
  }

  /**
   * Auto-update entry point used by the startup timer in `src/main/index.ts`.
   *
   * Silently checks for a newer release and, when one is found, immediately
   * starts the download. Errors are logged, not surfaced — the user only
   * notices via the settings panel / badge once the download has finished.
   *
   * No-op on `unsupported` package kinds: an extracted AppImage / rpm /
   * pacman install cannot self-update in-app, and there is nothing to do
   * here.
   */
  async autoCheck(): Promise<void> {
    if (!this.enabled || this.busy) return;
    if (this.packageKind() === 'unsupported') return;
    const s = await this.check();
    if (s.status === 'available') {
      try {
        await this.download();
      } catch (e) {
        logger.error(`autoCheck: download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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
    if (this.busy) return this.withSource();
    this.busy = true;
    try {
      if (this.state.status !== 'available') return this.withSource();
      if (this.rankedFeeds.length === 0) {
        this.setState({ status: 'error', message: 'No update source resolved; check for updates first' });
        return this.withSource();
      }
      const autoUpdater = getAutoUpdater();
      const kind = this.packageKind();
      if (kind === 'unsupported') {
        this.setState({ status: 'unsupported' });
        return this.withSource();
      }
      //
      // Differential setup differs per install kind:
      //
      //   nsis      — seed the old blockmap cache (verified against the
      //               cached installer.exe) so the diff can run; otherwise
      //               fall back to a full download this session.
      //   appimage  — differential is read from the running $APPIMAGE's
      //               embedded blockmap; nothing to seed. Keep diff on.
      //   deb       — no differential (deb packages are replaced, not
      //               patched); disable and label the download "full".
      if (kind === 'nsis') {
        const seed = await seedOldBlockmapFor(this.currentVersion(), this.cachePath());
        autoUpdater.disableDifferentialDownload = !seed.differential;
        this.differentialMode = seed.differential ? 'diff' : 'full';
        logger.info(`update download: differential=${seed.differential} (${seed.detail})`);
      } else if (kind === 'appimage') {
        autoUpdater.disableDifferentialDownload = false;
        this.differentialMode = 'diff';
        logger.info('update download: appimage differential (embedded blockmap)');
      } else {
        autoUpdater.disableDifferentialDownload = true;
        this.differentialMode = 'full';
      }
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
          this.startVerification();
          await autoUpdater.downloadUpdate();
          // update-downloaded fired before downloadUpdate() resolved; wait for
          // the async SHA-512 check before treating the attempt as a success.
          if (await this.awaitVerification()) return this.withSource();
          // Verification failed: the handler already deleted the bad file and
          // set the error state. Fall through to the next-ranked mirror.
        } catch {
          // The 'error' event set the state; try the next-ranked source.
          this.settleVerification(false);
        }
      }
      if ((this.getState() as UpdateState).status !== 'downloaded') {
        this.setState({ status: 'error', message: 'Download failed on all update sources' });
      }
      return this.withSource();
    } finally {
      this.busy = false;
    }
  }

  /** Step 3 — quit the app and install the downloaded update. */
  install(): void {
    if (!this.enabled || this.state.status !== 'downloaded') return;
    // Unsupported kinds never reach 'downloaded' (download() guards), so
    // this is only reached for nsis/appimage/deb. Deb's pkexec/prompt is
    // surfaced via the 'error' event on failure.
    getAutoUpdater().quitAndInstall(false, true);
  }

  private startVerification(): void {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.verification = { promise, resolve };
  }

  private settleVerification(ok: boolean): void {
    const pending = this.verification;
    this.verification = null;
    pending?.resolve(ok);
  }

  private async awaitVerification(): Promise<boolean> {
    const pending = this.verification;
    if (!pending) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 5 * 60_000);
    });
    const ok = await Promise.race([pending.promise, timeout]);
    if (timer) clearTimeout(timer);
    if (this.verification === pending) this.verification = null;
    if (!ok && (this.state as UpdateState).status === 'downloading') {
      this.setState({ status: 'error', message: 'Timed out verifying the downloaded update' });
    }
    return ok;
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
   * Parallel update-manifest fetch across all candidate feeds; returns the
   * newest discovered version (with the feed that announced it) or null
   * when nothing was reachable. The manifest file name is chosen per
   * platform (Windows `latest.yml`, Linux `latest-linux.yml`).
   */
  private async discoverLatest(): Promise<DiscoveredUpdate | null> {
    const manifest = this.manifestName();
    const override = process.env.NEXUS_UPDATE_MIRROR;
    const feeds = override ? [{ label: 'NEXUS_UPDATE_MIRROR', url: override }] : appManifestFeeds();
    const results = await Promise.allSettled(
      feeds.map(async (feed) => this.fetchManifest(feed.url, feed.label, manifest)),
    );
    const found: DiscoveredUpdate[] = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    if (!override) {
      // Gitee is a manifest-only fallback (never enters the download race —
      // its published manifest pins the installer at a GitHub absolute URL),
      // but it keeps discovery alive when GitHub and every mirror are
      // unreachable from the user's network.
      const gitee = await this.fetchGiteeManifest(manifest);
      if (gitee) found.push(gitee);
    }
    if (found.length === 0) return null;
    found.sort((a, b) => compareVersions(b.version, a.version));
    return found[0];
  }

  private async fetchManifest(feedBase: string, label: string, manifest: string): Promise<DiscoveredUpdate | null> {
    const url = `${feedBase.replace(/\/$/, '')}/${manifest}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) return null;
      const parsed = parseUpdateYml(await res.text());
      if (!parsed || !parsed.version) return null;
      // Pick the `files[]` entry that matches this install kind so the
      // probe and the expected-download size line up with what
      // electron-updater will actually download.
      const picked = pickUpdateFile(parsed.files, this.preferredExtensions());
      if (!picked) return null;
      return {
        feed: { label, url: feedBase },
        version: parsed.version,
        fileUrl: picked.url,
        fileSize: picked.size ?? 0,
        sha512: picked.sha512 ?? null,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the same manifest from the two authoritative release hosts
   * (GitHub direct + Gitee). Mirrors are excluded on purpose: they are the
   * untrusted party this check is meant to catch. Returns the first manifest
   * that announces the expected version (preferring one that carries a
   * SHA-512), or null when neither official host is reachable.
   */
  private async fetchAuthoritative(version: string, manifest: string): Promise<DiscoveredUpdate | null> {
    const results = await Promise.allSettled(
      appAuthoritativeFeeds(version).map((feed) => this.fetchManifest(feed.url, feed.label, manifest)),
    );
    const candidates = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    const matching = candidates.filter((c) => compareVersions(c.version, version) === 0);
    return matching.find((c) => c.sha512) ?? matching[0] ?? null;
  }

  /** The update-manifest file name for this platform. */
  private manifestName(): string {
    return appManifestFileName(process.platform);
  }

  /**
   * Preferred `files[]` entry extensions, in order, for this install kind.
   * electron-updater's own `findFile()` resolves the same selection at
   * download time; this only drives discovery probing and size estimation.
   */
  private preferredExtensions(): string[] {
    switch (this.packageKind()) {
      case 'deb':
        // A deb install downloads the .deb; the AppImage entry is unused.
        return ['.deb', '.AppImage'];
      case 'appimage':
        // An AppImage downloads the .AppImage; the .deb entry is unused.
        return ['.AppImage', '.deb'];
      case 'nsis':
      case 'unsupported':
      default:
        // Windows: single .exe entry. For unsupported Linux kinds we still
        // report the .AppImage entry (the larger, self-contained one).
        return [this.packageKind() === 'nsis' ? '.exe' : '.AppImage'];
    }
  }

  /**
   * Gitee does not implement GitHub's `releases/latest/download` alias, so
   * query the public releases API, pick the newest stable tag, and read that
   * tag's update manifest. Returns null when the API or the manifest fails.
   */
  private async fetchGiteeManifest(manifest: string): Promise<DiscoveredUpdate | null> {
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
    return this.fetchManifest(base, 'Gitee', manifest);
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
    // Tag deb-install states so the settings UI can render install hints
    // (deb installs prompt for system authorization; AppImage/NSIS do not).
    if (state.status === 'available' || state.status === 'downloaded') {
      this.onState?.({ ...state, packageKind: this.packageKind() });
      return;
    }
    this.onState?.(state);
  }
}

/** Parse a release tag into its dotted version, or null. */
function parseTagVersion(tag: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/** Streaming SHA-512 as base64, matching electron-builder's `latest.yml`. */
function sha512File(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

// electron-updater v6 exposes `autoUpdater` as a lazy getter on the CJS
// default export; the named import (`import { autoUpdater }`) fails under
// NodeNext ESM resolution and the getter instantiates an NsisUpdater (needs
// Electron's app), so resolve it lazily inside init() — never at module load.
function getAutoUpdater(): AutoUpdater {
  return (updaterModule as unknown as { autoUpdater: AutoUpdater }).autoUpdater;
}

/**
 * Resolve the install kind of the running app.
 *
 * See {@link AppPackageKind}. Only meaningful when `app.isPackaged`; in an
 * unpackaged build the calling code does not call `packageKind()` (the
 * `enabled` flag is false), so this may assume the packaged layout.
 */
function resolvePackageKind(): AppPackageKind {
  if (process.platform === 'win32') return 'nsis';
  if (process.platform !== 'linux') return 'unsupported';

  // 1) resources/package-type — written only by FpmTarget (deb/rpm/pacman).
  // The AppImage target does not write it, so its presence is a deb/rpm
  // marker. We ship only deb, so any value other than 'deb' is
  // 'unsupported' (e.g. a user-built rpm we cannot self-update).
  const packageTypePath = join(process.resourcesPath ?? '', 'package-type');
  if (existsSync(packageTypePath)) {
    try {
      const value = readFileSync(packageTypePath, 'utf8').trim();
      return value === 'deb' ? 'deb' : 'unsupported';
    } catch {
      return 'unsupported';
    }
  }

  // 2) The AppImage runtime sets APPIMAGE to the running file's absolute
  // path. When the user extracted the AppImage and ran `AppDir/nexus` by
  // hand, the variable is unset and AppImageUpdater's isUpdaterActive()
  // returns false — which we surface as 'unsupported'.
  return process.env.APPIMAGE ? 'appimage' : 'unsupported';
}
