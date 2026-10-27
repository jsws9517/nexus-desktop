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
import type { CoreUpdateInfo, ManifestEntry, DownloadResult } from './download.js';
import { fetchCoreManifest, downloadCoreUpdate, readStagedMeta, releaseStaged } from './download.js';
import { isProtocolCompatible, desktopProtocol, readCoreDirProtocol } from './protocol.js';

export interface CheckResult {
  available: boolean;
  latest: CoreUpdateInfo | null;
  staged: CoreUpdateInfo | null;
  active: string | null;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'incompatible' | 'downloading' | 'downloaded' | 'error';
  latest?: CoreUpdateInfo | null;
  staged?: CoreUpdateInfo | null;
  active?: string | null;
  error?: string;
  percent?: number;
}

interface StagedZipMeta {
  version: string;
  zipPath: string;
}

function resolveFeedUrl(base: string): string {
  return process.env.NEXUS_CORE_UPDATE_MIRROR ?? base;
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

  constructor(baseFeedUrl: string) {
    this.baseFeedUrl = baseFeedUrl;
  }

  init(): void {
    if (process.env.NEXUS_DISABLE_CORE_UPDATE !== '1') this.enabled = true;
  }

  getState(): UpdateState {
    return this.state;
  }

  /** Step 1: fetch latest manifest, compare against staged/active. No mutations. */
  async check(root: string): Promise<CheckResult> {
    if (!this.enabled) {
      this.setState({ status: 'error', error: 'Core update checks are disabled' });
      return this.checkResult(root, null);
    }
    this.setState({ status: 'checking', error: undefined });
    try {
      const entries = await fetchCoreManifest(resolveFeedUrl(this.baseFeedUrl));
      const latestEntry = entries[0] ?? null;
      const latest = latestEntry
        ? {
            version: latestEntry.version,
            sha512: latestEntry.sha512,
            size: latestEntry.size,
            url: latestEntry.url,
            timestamp: latestEntry.timestamp,
            protocol: latestEntry.protocol,
          }
        : null;
      // Protocol gate: a core built against a different desktop protocol must
      // not be installed as an overlay (it could silently break IPC).
      if (latest && !isProtocolCompatible(latest.protocol)) {
        this.setState({
          status: 'incompatible',
          latest,
          active: this.activeVersion(root),
          error: `core ${latest.version} speaks protocol ${latest.protocol}, this desktop speaks ${desktopProtocol()}`,
        });
        return this.checkResult(root, null, false);
      }
      const result = this.checkResult(root, latest);
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
      return this.checkResult(root, null);
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
    this.setState({ status: 'downloading' });
    try {
      const result = await downloadCoreUpdate(root, this.state.latest);
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

  private checkResult(root: string, latest: CoreUpdateInfo | null, gateProtocol = true): CheckResult {
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
    return { available, latest, staged, active };
  }

  private setState(next: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...next } as UpdateState;
    this.onState?.(this.state);
    return this.state;
  }
}
