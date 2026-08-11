import { app } from 'electron';
import updaterModule from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';

// 更新源候选：GitHub Release 直连优先，再回退到 gh-proxy 类 CDN。
// 每个候选在 check() 时并行探测 latest.yml，取第一个可达的作为本次 feed。
const FEED_DIRECT =
  'https://github.com/jsws9517/nexus-desktop/releases/latest/download';
const FEED_MIRRORS = [
  'https://gh-proxy.com/https://github.com/jsws9517/nexus-desktop/releases/latest/download',
  'https://ghfast.top/https://github.com/jsws9517/nexus-desktop/releases/latest/download',
];
const PROBE_TIMEOUT_MS = 6000;

// electron-updater v6 exposes `autoUpdater` as a lazy getter on the CJS default
// export; the named import (`import { autoUpdater }`) fails under NodeNext ESM
// resolution and the getter instantiates an NsisUpdater (needs Electron's app),
// so resolve it lazily inside init() — never at module load.
function getAutoUpdater(): typeof import('electron-updater')['autoUpdater'] {
  return (updaterModule as unknown as { autoUpdater: typeof import('electron-updater')['autoUpdater'] })
    .autoUpdater;
}

/**
 * Opt-in update manager (方案①): nothing happens automatically.
 *
 *  - checkForUpdates() only reports whether a newer release exists.
 *  - downloadUpdate() runs only after the user asks for it.
 *  - quitAndInstall() runs only after the user clicks "restart & install".
 *
 * autoDownload and autoInstallOnAppQuit are both forced OFF, so the running
 * version keeps working indefinitely until the user completes all three steps.
 * Only initialized in the packaged exe (dev/npm runs skip it entirely).
 */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | { status: 'not-available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string };

export class Updater {
  private enabled = false;
  private state: UpdateState = { status: 'idle' };
  private availableInfo: UpdateInfo | null = null;

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
      this.setState({ status: 'downloading', percent: Math.round(p.percent) });
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
  async check(): Promise<UpdateState> {
    if (!this.enabled) {
      this.setState({ status: 'error', message: 'Update checks are only available in the packaged app' });
      return this.state;
    }
    try {
      const autoUpdater = getAutoUpdater();
      const feedUrl = await this.resolveFeedUrl();
      autoUpdater.setFeedURL(feedUrl);
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return this.state;
  }

  /** Step 2 — download the available update. Only valid after check() found one. */
  async download(): Promise<UpdateState> {
    if (!this.enabled) return this.state;
    if (this.state.status !== 'available') return this.state;
    try {
      await getAutoUpdater().downloadUpdate();
    } catch (e) {
      this.setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return this.state;
  }

  /** Step 3 — quit the app and install the downloaded update. */
  install(): void {
    if (!this.enabled || this.state.status !== 'downloaded') return;
    getAutoUpdater().quitAndInstall(false, true);
  }

  private feedCandidates(): string[] {
    return [FEED_DIRECT, ...FEED_MIRRORS];
  }

  private async resolveFeedUrl(): Promise<string> {
    const override = process.env.NEXUS_UPDATE_MIRROR;
    if (override) return override;
    const results = await Promise.all(
      this.feedCandidates().map(async (url) => ((await this.probe(url)) ? url : null)),
    );
    return results.find((url) => url !== null) ?? FEED_DIRECT;
  }

  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/latest.yml`, { signal: controller.signal });
      await res.arrayBuffer().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
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
