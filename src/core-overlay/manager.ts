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

export interface CheckResult {
  available: boolean;
  latest: CoreUpdateInfo | null;
  staged: CoreUpdateInfo | null;
  active: string | null;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
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
          }
        : null;
      const result = this.checkResult(root, latest);
      if (!latest) {
        this.setState({ status: 'not-available', latest: null, active: result.active, staged: result.staged });
      } else if (result.available) {
        this.setState({ status: 'available', latest, active: result.active, staged: result.staged });
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
    if (!this.stagedZip) return this.state;
    const { version, zipPath } = this.stagedZip;
    if (!fs.existsSync(zipPath)) {
      return this.setState({ status: 'error', error: `staged zip missing: ${zipPath}` });
    }
    const targetDir = coreDirFor(root, version);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    try {
      const { x: tarExtract } = await import('tar');
      await tarExtract({ cwd: path.dirname(targetDir), file: zipPath, sync: false });
    } catch (e) {
      return this.setState({
        status: 'error',
        error: `failed to unpack core ${version}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    const pkgJson = path.join(targetDir, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      return this.setState({ status: 'error', error: `core ${version} missing package.json after extraction` });
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

  private activeVersion(root: string): string | null {
    try { return readState(root).activeCore ?? null; } catch { return null; }
  }

  private checkResult(root: string, latest: CoreUpdateInfo | null): CheckResult {
    let staged: CoreUpdateInfo | null = null;
    try {
      const meta = readStagedMeta(root, latest?.version ?? '');
      if (meta) staged = { version: meta.version, sha512: meta.sha512, size: meta.size, url: meta.url, timestamp: meta.timestamp };
    } catch {}
    let active: string | null = null;
    try { active = readState(root).activeCore ?? null; } catch {}
    const available = latest !== null
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
