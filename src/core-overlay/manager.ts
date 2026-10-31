/**
 * Core update manager: checks latest release, downloads and stages, promotes to active.
 *
 * Coordinates between `download.ts` (network / checksum) and `bootstrap/overlay.ts`
 * (boot-state management). Designed so the UI can drive the full workflow:
 *   check() → download() → activate()  (next boot applies).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OverlayState } from '../bootstrap/overlay.js';
import { readState, writeState, activateCore, coreDirFor } from '../bootstrap/overlay.js';
import type { CoreUpdateInfo, ManifestEntry, DownloadResult, CoreDownloadProgress } from './download.js';
import {
  fetchCoreManifest,
  downloadCoreUpdate,
  readStagedMeta,
  releaseStaged,
  mergeCoreManifestEntries,
  CoreManifestSignatureError,
} from './download.js';
import { GITHUB_MIRRORS } from '../shared/update-sources.js';
import { isProtocolCompatible, desktopProtocol, readCoreDirProtocol } from './protocol.js';

export interface CheckResult {
  available: boolean;
  latest: CoreUpdateInfo | null;
  staged: CoreUpdateInfo | null;
  active: string | null;
  /** Label of the feed that announced the latest version (null when unknown). */
  source: string | null;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'incompatible' | 'downloading' | 'downloaded' | 'error';
  latest?: CoreUpdateInfo | null;
  staged?: CoreUpdateInfo | null;
  active?: string | null;
  error?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** Label of the source currently leading the download. */
  source?: string;
}

interface StagedZipMeta {
  version: string;
  zipPath: string;
}

export class CoreUpdateManager {
  private enabled = false;
  private state: UpdateState = { status: 'idle' };
  private stagedZip: StagedZipMeta | null = null;
  private baseFeedUrl: string;

  onState?: (state: UpdateState) => void;

  /**
   * Supplies the version the worker is actually running (active overlay, else
   * the bundled nexus-coder). Without it, a base-copy install reports
   * `active=null` and the latest core is always offered as an "update", even
   * when it is byte-for-byte the core already bundled. Wired by main/index.ts.
   */
  currentVersionProvider?: () => string | undefined;

  /**
   * Extra feed candidates resolved at check time, e.g. the Gitee release
   * matching the running desktop version (Gitee has no `latest/download`
   * alias, so the URL must be tag-based). Wired by main/index.ts.
   */
  extraFeeds?: () => string[];

  constructor(baseFeedUrl: string, extraFeeds?: () => string[]) {
    this.baseFeedUrl = baseFeedUrl;
    this.extraFeeds = extraFeeds;
  }

  init(): void {
    if (process.env.NEXUS_DISABLE_CORE_UPDATE !== '1') this.enabled = true;
  }

  getState(): UpdateState {
    return this.state;
  }

  /**
   * All feeds to read `latest-core.yml` from, in parallel: the base GitHub
   * feed, every CN mirror of it (speed-ordered), and the caller-supplied
   * extras (Gitee tag feed). Mirrors are only expanded for a github.com
   * base — a non-GitHub base (tests, self-hosted feeds) is used as-is,
   * because a `gh-proxy` prefix on a non-GitHub URL is meaningless and the
   * extra candidates just mask the real failure. `NEXUS_CORE_UPDATE_MIRROR`
   * overrides the lot.
   */
  private manifestFeeds(): string[] {
    const override = process.env.NEXUS_CORE_UPDATE_MIRROR;
    if (override) return [override];
    const base = this.baseFeedUrl.replace(/\/$/, '');
    const feeds = [base];
    if (base.startsWith('https://github.com/')) {
      for (const m of GITHUB_MIRRORS) feeds.push(`${m.prefix}${base}`);
    }
    for (const extra of this.extraFeeds?.() ?? []) feeds.push(extra);
    return feeds;
  }

  /** Step 1: fetch latest manifest, compare against staged/active. No mutations. */
  async check(root: string): Promise<CheckResult> {
    if (!this.enabled) {
      this.setState({ status: 'error', error: 'Core update checks are disabled' });
      return this.checkResult(root, null);
    }
    this.setState({ status: 'checking', error: undefined });
    try {
      // Read every manifest in parallel and merge: a feed that is down for
      // the user's network never shadows a working one, and each version's
      // download URLs are unioned (GitHub + Gitee raced at download time).
      const feeds = this.manifestFeeds();
      const results = await Promise.allSettled(feeds.map((feed) => fetchCoreManifest(feed)));
      const merged = mergeCoreManifestEntries(results);
      if (merged.length === 0) {
        // A signature refusal is a hard "don't install this", not a transient
        // "can't reach the feed": if every feed rejected the manifest because
        // of its signature, surface that refusal rather than the generic
        // reachability error (which would mask it).
        const sigRejection = results.find(
          (r): r is PromiseRejectedResult =>
            r.status === 'rejected' && r.reason instanceof CoreManifestSignatureError,
        );
        if (sigRejection) {
          throw sigRejection.reason;
        }
        throw new Error(
          `no core manifest reachable (${feeds.length} feeds tried; ` +
            `${results.filter((r) => r.status === 'rejected').length} failed)`,
        );
      }
      const latestEntry = merged[0];
      const source = feeds[results.findIndex((r) => r.status === 'fulfilled')];
      const latest = {
        version: latestEntry.version,
        sha512: latestEntry.sha512,
        size: latestEntry.size,
        url: latestEntry.url,
        urls: latestEntry.urls,
        timestamp: latestEntry.timestamp,
        protocol: latestEntry.protocol,
      };
      // Protocol gate: a core built against a different desktop protocol must
      // not be installed as an overlay (it could silently break IPC).
      if (latest && !isProtocolCompatible(latest.protocol)) {
        this.setState({
          status: 'incompatible',
          latest,
          active: this.activeVersion(root),
          error: `core ${latest.version} speaks protocol ${latest.protocol}, this desktop speaks ${desktopProtocol()}`,
        });
        return this.checkResult(root, null, false, source ?? null);
      }
      const result = this.checkResult(root, latest, true, source ?? null);
      const stagedIsLatest = !!(latest && result.staged
        && result.staged.version === latest.version
        && result.staged.sha512 === latest.sha512
        && result.active !== latest.version);
      if (!latest) {
        this.setState({ status: 'not-available', latest: null, active: result.active, staged: result.staged });
      } else if (result.available) {
        this.setState({ status: 'available', latest, active: result.active, staged: result.staged });
      } else if (stagedIsLatest) {
        // Downloaded but not installed yet. This can also be reached after an
        // app restart (the staged file survives, the in-memory zip handle does
        // not), so keep offering the install action instead of hiding it.
        this.setState({ status: 'downloaded', latest, active: result.active, staged: result.staged });
      } else {
        this.setState({ status: 'not-available', latest, active: result.active, staged: result.staged });
      }
      return result;
    } catch (e) {
      this.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      return this.checkResult(root, null, true, null);
    }
  }

  /** Step 2: download the available update and stage it under <root>/staged/. */
  async download(root: string): Promise<UpdateState> {
    if (!this.enabled) return this.state;
    if (this.state.status !== 'available' || !this.state.latest) return this.state;
    if (!isProtocolCompatible(this.state.latest.protocol)) {
      return this.setState({
        status: 'incompatible',
        error: `core ${this.state.latest.version} speaks protocol ${this.state.latest.protocol}, ` +
          `this desktop speaks ${desktopProtocol()}`,
      });
    }
    const info = this.state.latest;
    const onProgress = (p: CoreDownloadProgress): void => {
      this.setState({
        status: 'downloading',
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
        source: p.source,
      });
    };
    this.setState({
      status: 'downloading',
      percent: 0,
      transferred: 0,
      total: info.size,
      bytesPerSecond: 0,
    });
    try {
      const result = await downloadCoreUpdate(root, info, { onProgress });
      this.stagedZip = { version: result.version, zipPath: result.zipPath };
      this.setState({
        status: 'downloaded',
        latest: this.state.latest,
        staged: this.state.latest,
        active: this.activeVersion(root),
      });
      return this.state;
    } catch (e) {
      this.setState({
        status: 'error',
        latest: this.state.latest,
        error: e instanceof Error ? e.message : String(e),
      });
      return this.state;
    }
  }

  /**
   * Step 3: promote staged zip to active overlay.
   * Extracts the tar.gz archive into <root>/core/<version>/ and updates state.
   * Caller should restart the worker for the change to take effect.
   */
  async activate(root: string): Promise<UpdateState> {
    // Prefer the in-memory handle set by download(), but fall back to the
    // on-disk staged file so a downloaded core stays installable after an app
    // restart (check() re-populates state.latest before the UI shows Install).
    let version = this.stagedZip?.version ?? null;
    let zipPath = this.stagedZip?.zipPath ?? null;
    if (!version) {
      const candidate = this.state.latest?.version ?? null;
      if (candidate && readStagedMeta(root, candidate)) {
        const onDisk = path.join(root, 'staged', `core-${candidate}.zip`);
        if (fs.existsSync(onDisk)) {
          version = candidate;
          zipPath = onDisk;
        }
      }
    }
    if (!version || !zipPath) return this.state;
    if (!fs.existsSync(zipPath)) {
      return this.setState({ status: 'error', error: `staged zip missing: ${zipPath}` });
    }
    const targetDir = coreDirFor(root, version);
    const coreRoot = path.dirname(targetDir);
    fs.mkdirSync(coreRoot, { recursive: true });
    // Extract into a scratch dir, then move it into place. The tarball root is
    // the artifact root (no version prefix), and a failed unpack must never
    // leave a half-written core/ or clobber the active one.
    const extractDir = fs.mkdtempSync(path.join(coreRoot, `.extract-${version}-`));
    const cleanup = () => { try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {} };
    try {
      const { x: tarExtract } = await import('tar');
      await tarExtract({ cwd: extractDir, file: zipPath, sync: false });
    } catch (e) {
      cleanup();
      return this.setState({
        status: 'error',
        error: `failed to unpack core ${version}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const pkgJson = path.join(extractDir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      cleanup();
      return this.setState({ status: 'error', error: `core ${version} missing package.json after extraction` });
    }
    // Defense in depth: verify the protocol from the extracted artifact itself,
    // independent of what the (signed) manifest claimed.
    const coreProtocol = readCoreDirProtocol(extractDir);
    if (!isProtocolCompatible(coreProtocol)) {
      cleanup();
      return this.setState({
        status: 'incompatible',
        error: `core ${version} speaks protocol ${coreProtocol}, this desktop speaks ${desktopProtocol()}`,
      });
    }
    try {
      if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(extractDir, targetDir);
    } catch (e) {
      cleanup();
      return this.setState({
        status: 'error',
        error: `failed to install core ${version}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    try {
      activateCore(root, version);
    } catch (e) {
      return this.setState({
        status: 'error',
        error: `activateCore failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    releaseStaged(root, version);
    this.stagedZip = null;
    return this.setState({
      status: 'idle',
      latest: null,
      staged: null,
      active: version,
    });
  }

  /** Discard the currently staged zip without activating. */
  cancelDownload(root: string): UpdateState {
    if (!this.stagedZip) return this.state;
    const { version } = this.stagedZip;
    releaseStaged(root, version);
    this.stagedZip = null;
    return this.setState({ status: 'idle', staged: null });
  }

  /**
   * The version the worker is really running: the overlay's active version if
   * any, else the bundled core (when the provider is wired). Falls back to the
   * overlay state alone when no provider is set.
   */
  private activeVersion(root: string): string | null {
    const effective = this.currentVersionProvider?.();
    if (effective) return effective;
    try { return readState(root).activeCore ?? null; } catch { return null; }
  }

  private checkResult(root: string, latest: CoreUpdateInfo | null, gateProtocol = true, source: string | null = null): CheckResult {
    let staged: CoreUpdateInfo | null = null;
    try {
      const meta = readStagedMeta(root, latest?.version ?? '');
      if (meta) staged = {
        version: meta.version, sha512: meta.sha512, size: meta.size,
        url: meta.url, timestamp: meta.timestamp, protocol: null,
      };
    } catch {}
    let active: string | null = null;
    try { active = this.activeVersion(root); } catch {}
    const protocolOk = !gateProtocol || !latest || isProtocolCompatible(latest.protocol);
    const available = protocolOk
      && latest !== null
      && latest.version !== active
      && (staged === null || staged.version !== latest.version || staged.sha512 !== latest.sha512);
    return { available, latest, staged, active, source };
  }

  private setState(next: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...next } as UpdateState;
    this.onState?.(this.state);
    return this.state;
  }
}
