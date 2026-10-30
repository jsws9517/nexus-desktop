import { app } from 'electron';
import updaterModule from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';

// 更新源候选：GitHub Release 直连优先，再回退到 gh-proxy 类 CDN，最后 Gitee。
// 每个候选在 check() 时并行探测 latest.yml，取第一个可达的作为本次 feed。
export interface FeedSource {
  label: string;
  url: string;
}

const FEED_DIRECT: FeedSource = {
  label: 'GitHub',
  url: 'https://github.com/jsws9517/nexus-desktop/releases/latest/download',
};
const FEED_MIRRORS: FeedSource[] = [
  {
    label: 'gh-proxy.com',
    url: 'https://gh-proxy.com/https://github.com/jsws9517/nexus-desktop/releases/latest/download',
  },
  {
    label: 'ghfast.top',
    url: 'https://ghfast.top/https://github.com/jsws9517/nexus-desktop/releases/latest/download',
  },
];
const GITEE_REPO = 'cict_1_0/nexus-desktop';
const PROBE_TIMEOUT_MS = 6000;

function parseTagVersion(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

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

export type UpdateStateWithSource = UpdateState & { source: FeedSource | null };

export class Updater {
  private enabled = false;
  private state: UpdateState = { status: 'idle' };
  private availableInfo: UpdateInfo | null = null;
  private source: FeedSource | null = null;

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
  async check(): Promise<UpdateStateWithSource> {
    if (!this.enabled) {
      this.setState({ status: 'error', message: 'Update checks are only available in the packaged app' });
      return this.withSource();
    }
    try {
      const autoUpdater = getAutoUpdater();
      const feed = await this.resolveFeedUrl();
      this.source = feed;
      autoUpdater.setFeedURL((feed ?? FEED_DIRECT).url);
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

  private feedCandidates(): FeedSource[] {
    return [FEED_DIRECT, ...FEED_MIRRORS];
  }

  private async resolveFeedUrl(): Promise<FeedSource | null> {
    const override = process.env.NEXUS_UPDATE_MIRROR;
    if (override) return { label: 'NEXUS_UPDATE_MIRROR', url: override };
    // Gitee is the last-resort CN fallback and is resolved dynamically (it
    // has no static feed URL), so probe it in parallel with the static
    // GitHub candidates.
    const results = await Promise.all([
      ...this.feedCandidates().map(async (src) => ((await this.probe(src.url)) ? src : null)),
      this.resolveGiteeFeed(),
    ]);
    return results.find((src): src is FeedSource => src !== null) ?? null;
  }

  /**
   * Gitee does not implement GitHub's `releases/latest/download` alias — that
   * path 404s even when assets are attached — and pinning the feed to the
   * app's own version tag would defeat the point of an update check (the new
   * tag is exactly what we are trying to discover). So query Gitee's public
   * releases API, pick the newest stable tag, and return its tag-based
   * download base, trusted only after probing that `latest.yml` is attached.
   * Returns null when the API or the manifest probe fails.
   */
  private async resolveGiteeFeed(): Promise<FeedSource | null> {
    let releases: Array<{ tag_name?: string; prerelease?: boolean }> = [];
    {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
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
      .map((r) => {
        const tag = r.tag_name ?? '';
        return { tag, prerelease: r.prerelease === true, version: parseTagVersion(tag) };
      })
      .filter((r): r is { tag: string; prerelease: boolean; version: [number, number, number] } =>
        r.version !== null,
      );
    const stable = tagged.filter((r) => !r.prerelease);
    const pool = stable.length > 0 ? stable : tagged;
    if (pool.length === 0) return null;
    pool.sort((a, b) => compareVersions(a.version, b.version));
    const base = `https://gitee.com/${GITEE_REPO}/releases/download/${pool[pool.length - 1].tag}`;
    return (await this.probe(base)) ? { label: 'Gitee', url: base } : null;
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
