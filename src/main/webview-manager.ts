/**
 * PR2 browser tab — WebContentsView manager (main process).
 *
 * External URLs in the 浏览器 tab render in a `WebContentsView` attached to
 * the app window's content view (positioned over the right-sidebar panel rect,
 * which the renderer syncs via `webviewBounds`). Isolation rules:
 *
 *   - The view's webContents is moved to its OWN non-persistent session
 *     partition, so external content never shares origin/cookies/storage
 *     with the app renderer (no same-origin leakage in either direction).
 *   - In-app window.open is denied; http(s) requests are routed to the
 *     system browser instead.
 *   - Load failures fall back to `shell.openExternal` and the view is
 *     destroyed; the renderer is told via a `fallback` event so it can drop
 *     the tab.
 *
 * Local files never use this manager — they stream through the
 * `nexus-preview://` protocol into a sandboxed iframe in the renderer.
 */

import { WebContentsView, ipcMain, shell, session, type BrowserWindow, type WebContents } from 'electron';
import { CHANNELS } from '../ipc/channels.js';
import { logger } from '../shared/logger.js';

export interface WebviewBoundsLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** main → renderer push payload (see preload onWebviewEvent). */
export interface WebviewEventPayload {
  readonly viewId: string;
  readonly type: 'loading' | 'loaded' | 'navigated' | 'title' | 'fallback';
  readonly url?: string;
  readonly title?: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly error?: string;
}

interface LiveView {
  viewId: string;
  view: WebContentsView;
  /** Set true once the fallback (external open + destroy) has started so
   *  late `did-fail-load` echoes can't re-trigger it. */
  fallbackArmed: boolean;
  /** wc event listeners wired exactly once per view (the view object is
   *  reused across re-navigation; re-attaching must not re-add them). */
  wired: boolean;
}

const PARTITION = 'nexus-browser'; // non-persistent → no cookie storage leak
let views: Map<string, LiveView> | null = null;
let seq = 0;

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export interface WebviewManagerDeps {
  readonly getWin: () => BrowserWindow | null;
  readonly pushEvent: (payload: WebviewEventPayload) => void;
}

let deps: WebviewManagerDeps | null = null;

function store(): Map<string, LiveView> {
  if (!views) views = new Map();
  return views;
}

/** Attach one WebContentsView to the window; wire its lifecycle events. */
function attachView(lv: LiveView, bounds: WebviewBoundsLike, hidden: boolean): void {
  const win = deps?.getWin();
  if (!win || win.isDestroyed()) throw new Error('window unavailable');
  const wc = lv.view.webContents;
  wc.setZoomFactor(1);
  // New windows never open inside the app; hand off to the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  wireEvents(lv);
  // Re-attaching a view that is already a child reorders it to the topmost
  // slot; detach first so bounds/visibility always apply to a fresh slot.
  // (removeChildView on a non-child is a documented no-op.)
  win.contentView.removeChildView(lv.view);
  win.contentView.addChildView(lv.view);
  lv.view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  lv.view.setVisible(!hidden);
}

/** Wire the WebContents event → renderer pushes. The view object outlives
 *  re-navigation, so this must run exactly once per view (guarded by the
 *  `wired` flag) — re-navigation only re-attaches and re-loads. */
function wireEvents(lv: LiveView): void {
  if (lv.wired) return;
  lv.wired = true;
  const wc = lv.view.webContents;
  const navState = (): { canGoBack: boolean; canGoForward: boolean } => ({
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  });
  wc.on('did-start-loading', () => {
    deps?.pushEvent({ viewId: lv.viewId, type: 'loading' });
  });
  wc.on('did-stop-loading', () => {
    deps?.pushEvent({ viewId: lv.viewId, type: 'loaded', url: wc.getURL(), ...navState() });
  });
  wc.on('did-navigate', (_e, url) => {
    deps?.pushEvent({ viewId: lv.viewId, type: 'navigated', url, ...navState() });
  });
  wc.on('did-navigate-in-page', (_e, url) => {
    deps?.pushEvent({ viewId: lv.viewId, type: 'navigated', url, ...navState() });
  });
  wc.on('page-title-updated', (_e, title) => {
    deps?.pushEvent({ viewId: lv.viewId, type: 'title', title });
  });
  wc.on('did-fail-load', (_e, code, description, failedUrl) => {
    // -3 ERR_ABORTED / -2 aborts are cancel noise (navigating away, reloads,
    // tab switches) — never a user-facing failure.
    if (code === -3 || code === -2) return;
    if (lv.fallbackArmed) return;
    lv.fallbackArmed = true;
    logger.warn(`webview load failed (${code} ${description}) — falling back to system browser: ${failedUrl}`);
    const target = isHttpUrl(failedUrl) ? failedUrl : '';
    if (target) void shell.openExternal(target).catch(() => {});
    destroyView(lv.viewId);
    deps?.pushEvent({
      viewId: lv.viewId,
      type: 'fallback',
      url: failedUrl,
      error: `${code} ${description}`.trim(),
    });
  });
}

function destroyView(viewId: string, skipChildRemove = false): void {
  const s = store();
  const lv = s.get(viewId);
  if (!lv) return;
  s.delete(viewId);
  const win = deps?.getWin();
  try {
    if (win && !win.isDestroyed() && !skipChildRemove) win.contentView.removeChildView(lv.view);
  } catch {
    /* window already gone */
  }
  try {
    lv.view.webContents.close();
  } catch {
    /* already destroyed */
  }
}

// ── IPC handlers (registered once at startup) ───────────────────────────

export function installWebviewHandlers(d: WebviewManagerDeps): void {
  deps = d;
  views = new Map();

  ipcMain.handle(CHANNELS.webviewOpen, async (_e, params: unknown) => {
    const p = params as { url?: unknown; viewId?: unknown; bounds?: unknown; hidden?: unknown } | undefined;
    if (!p || typeof p.url !== 'string' || p.url.length > 4096) return { ok: false, error: 'missing url' };
    if (!isHttpUrl(p.url)) {
      // Non-web scheme (ftp:, mailto:, …): hand off to the OS handler so the
      // user still lands somewhere; the renderer drops the tab with a toast.
      void shell.openExternal(p.url).catch(() => {});
      return { ok: false, error: 'unsupported scheme — opened in system handler' };
    }
    const win = d.getWin();
    if (!win || win.isDestroyed()) return { ok: false, error: 'window unavailable' };

    // Reuse an existing view (address-bar re-navigation) or create one.
    let lv: LiveView | null = null;
    if (typeof p.viewId === 'string') {
      const existing = store().get(p.viewId);
      if (existing && !existing.view.webContents.isDestroyed()) lv = existing;
    }
    if (!lv) {
      const viewId = `webview-${++seq}`;
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // Isolated non-persistent partition: external content never shares
          // origin/cookies/storage with the app renderer.
          session: session.fromPartition(PARTITION),
        },
      });
      lv = { viewId, view, fallbackArmed: false, wired: false };
      store().set(viewId, lv);
    }
    const b = p.bounds as WebviewBoundsLike | undefined;
    const bounds: WebviewBoundsLike =
      b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0
        ? b
        : { x: 0, y: 0, width: 400, height: 400 };
    lv.fallbackArmed = false;
    try {
      // attachView detaches any previous slot itself (no-op when fresh) and
      // wires the event listeners exactly once per view.
      attachView(lv, bounds, p.hidden === true);
      await lv.view.webContents.loadURL(p.url);
    } catch (err) {
      if (lv) {
        // Creation itself failed (e.g. session partition unavailable): the
        // renderer falls back to the system browser with ok:false.
        store().delete(lv.viewId);
        logger.warn(`webview open failed: ${(err as Error).message}`);
        try { void shell.openExternal(p.url).catch(() => {}); } catch { /* ignore */ }
        d.pushEvent({ viewId: lv.viewId, type: 'fallback', url: p.url, error: (err as Error).message });
        return { ok: false, error: (err as Error).message };
      }
      return { ok: false, error: 'attach failed' };
    }
    return { ok: true, viewId: lv.viewId };
  });

  ipcMain.handle(CHANNELS.webviewBack, async (_e, params: unknown) => {
    const p = params as { viewId?: unknown } | undefined;
    if (!p || typeof p.viewId !== 'string') return { ok: false, error: 'missing viewId' };
    const lv = store().get(p.viewId);
    if (!lv || lv.view.webContents.isDestroyed()) return { ok: false, error: 'unknown view' };
    if (!lv.view.webContents.navigationHistory.canGoBack()) return { ok: true };
    lv.view.webContents.navigationHistory.goBack();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.webviewForward, async (_e, params: unknown) => {
    const p = params as { viewId?: unknown } | undefined;
    if (!p || typeof p.viewId !== 'string') return { ok: false, error: 'missing viewId' };
    const lv = store().get(p.viewId);
    if (!lv || lv.view.webContents.isDestroyed()) return { ok: false, error: 'unknown view' };
    if (!lv.view.webContents.navigationHistory.canGoForward()) return { ok: true };
    lv.view.webContents.navigationHistory.goForward();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.webviewReload, async (_e, params: unknown) => {
    const p = params as { viewId?: unknown } | undefined;
    if (!p || typeof p.viewId !== 'string') return { ok: false, error: 'missing viewId' };
    const lv = store().get(p.viewId);
    if (!lv || lv.view.webContents.isDestroyed()) return { ok: false, error: 'unknown view' };
    lv.fallbackArmed = false;
    lv.view.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.webviewClose, async (_e, params: unknown) => {
    const p = params as { viewId?: unknown } | undefined;
    if (!p || typeof p.viewId !== 'string') return { ok: false, error: 'missing viewId' };
    destroyView(p.viewId);
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.webviewBounds, async (_e, params: unknown) => {
    const p = params as { bounds?: unknown; hidden?: unknown } | undefined;
    const b = p?.bounds as WebviewBoundsLike | undefined;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width >= 0 && b.height >= 0) {
      for (const lv of store().values()) {
        try {
          lv.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
          if (typeof p?.hidden === 'boolean') lv.view.setVisible(!p.hidden);
        } catch {
          /* view mid-destroy */
        }
      }
    }
    return { ok: true };
  });
}

/** Drop every live view (window close / app quit). */
export function destroyAllWebviews(): void {
  if (!views) return;
  for (const id of [...views.keys()]) destroyView(id, true);
  views.clear();
  views = null;
}
