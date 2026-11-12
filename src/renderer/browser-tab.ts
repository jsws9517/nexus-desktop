/**
 * PR2 浏览器 tab — right-sidebar browser panel (≤4 tabs, LRU).
 *
 * Two content kinds coexist:
 *   - LOCAL files (html routed from the 文件 tab / inline cards): streamed
 *     through the `nexus-preview://` token protocol into a sandboxed iframe
 *     (sandbox="allow-scripts allow-popups allow-forms" — deliberately NO
 *     allow-same-origin, so page content can never reach the app DOM).
 *   - EXTERNAL http(s) URLs: rendered by a main-process WebContentsView
 *     attached to the window over this panel's rect (isolated, non-persistent
 *     session partition → no same-origin/cookie leakage with the renderer).
 *     Load failures fall back to the system browser (main side) and the tab
 *     is dropped with a toast.
 *
 * Toolbar: back / forward / reload / address / close-tab. Esc closes the
 * active tab (wired by the host). The progress bar is indeterminate — it is
 * driven by the main process's webviewEvent pushes ('loading'/'loaded');
 * local iframes drive it from their own load events.
 */

import { fetchPreview, revokePreview, type PreviewState } from './preview/core.js';
import { STR } from './i18n.js';

export const MAX_BROWSER_TABS = 4;

/** Shape of the IPC slice this module needs (window.nexusDesktop or a fake). */
export interface BrowserTabsIpc {
  webviewOpen(url: string, bounds: Bounds, viewId?: string, hidden?: boolean): Promise<{ ok: boolean; viewId?: string; error?: string }>;
  webviewBack(viewId: string): Promise<{ ok: boolean; error?: string }>;
  webviewForward(viewId: string): Promise<{ ok: boolean; error?: string }>;
  webviewReload(viewId: string): Promise<{ ok: boolean; error?: string }>;
  webviewClose(viewId: string): Promise<{ ok: boolean; error?: string }>;
  webviewBounds(bounds: Bounds, hidden?: boolean): Promise<{ ok: boolean }>;
  onWebviewEvent(cb: (ev: WebviewEvent) => void): void;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WebviewEvent {
  readonly viewId: string;
  readonly type: 'loading' | 'loaded' | 'navigated' | 'title' | 'fallback';
  readonly url?: string;
  readonly title?: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly error?: string;
}

export interface BrowserTabInfo {
  readonly id: string;
  readonly name: string;
  /** External URL, or the local file path. */
  readonly url: string;
  readonly kind: 'local' | 'external';
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly viewId?: string;
  close(): void;
}

export interface BrowserTabsOptions {
  /** #browser-tab-root — the module builds its own DOM inside it. */
  readonly root: HTMLElement;
  /** Live UI language for toolbar labels. */
  readonly getLang?: () => string;
  /** IPC slice (defaults to window.nexusDesktop). */
  readonly ipc?: BrowserTabsIpc;
  /** Toast hook for fallback notices. */
  readonly notify?: (message: string) => void;
  /** Fired after the active tab changes (or all tabs close). */
  readonly onActiveChanged?: () => void;
}

export interface BrowserTabs {
  /** Open a URL (or a local file path) in a new tab. Resolves when attached. */
  openUrl(value: string): Promise<void>;
  /** Open a local file as an html iframe tab. False on fetch failure —
   *  the caller's external-app fallback should run then. */
  openLocalFile(path: string): Promise<boolean>;
  /** Navigate the ACTIVE tab to the value (address-bar Enter). */
  navigateActive(value: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): void;
  /** Close the active tab. No-op when none. */
  closeActive(): void;
  closeAll(): void;
  active(): BrowserTabInfo | null;
  /** All tabs, least-recently-used first. */
  list(): readonly BrowserTabInfo[];
  /** Panel visibility (rside tab switch / sidebar collapse) — hides the
   *  main-side views when the browser panel is not on screen. */
  setPanelVisible(visible: boolean): void;
  /** Re-sync the main-side view bounds to the panel rect (resize). */
  syncBounds(): void;
  /** Remove DOM + unsubscribe. */
  dispose(): void;
}

// ── internal record ────────────────────────────────────────────────────────

interface BTab {
  id: string;
  name: string;
  url: string;
  kind: 'local' | 'external';
  viewId?: string;
  iframe: HTMLIFrameElement | null;
  state: PreviewState | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  chip: HTMLElement;
}

function tr(lang: string) {
  return (key: string): string => STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** Normalize an address-bar value: URL → url, bare word → https://word,
 *  local path shape → local file. */
export function normalizeAddress(value: string): { kind: 'url' | 'local'; target: string } | null {
  const v = value.trim();
  if (!v) return null;
  // Scheme (URL) detection: a real scheme has ≥2 chars before ':' (http, https,
  // file, ftp, mailto …). A single drive letter (C:) must NOT match, or Windows
  // paths like C:\work\page.html would be misrouted as URLs.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(v);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return { kind: 'url', target: v };
    // file: / ftp: / mailto: — main side decides (webview rejects non-web).
    return { kind: 'url', target: v };
  }
  if (v.includes('\\') || v.includes('/')) return { kind: 'local', target: v };
  // bare domain: example.com → https://example.com
  return { kind: 'url', target: `https://${v}` };
}

export function mountBrowserTabs(opts: BrowserTabsOptions): BrowserTabs {
  const root = opts.root;
  const ipc = opts.ipc ?? (typeof window !== 'undefined' ? (window as unknown as { nexusDesktop?: BrowserTabsIpc }).nexusDesktop : undefined);
  const lang = (): string => opts.getLang?.() ?? 'zh-CN';
  const L = (key: string): string => tr(lang())(key);

  // LRU order: index 0 = least recently used.
  let tabs: BTab[] = [];
  let activeId: string | null = null;
  let panelVisible = true;
  let disposed = false;
  let seq = 0;

  // ── DOM scaffold ───────────────────────────────────────────────────────
  const strip = document.createElement('div');
  strip.className = 'browser-tab-strip';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', L('rsideTabBrowser'));

  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';
  const btnBack = document.createElement('button');
  btnBack.type = 'button';
  btnBack.className = 'btn ghost icon tiny browser-toolbar-btn';
  btnBack.textContent = '←';
  btnBack.title = L('browserBackLabel');
  const btnForward = document.createElement('button');
  btnForward.type = 'button';
  btnForward.className = 'btn ghost icon tiny browser-toolbar-btn';
  btnForward.textContent = '→';
  btnForward.title = L('browserForwardLabel');
  const btnReload = document.createElement('button');
  btnReload.type = 'button';
  btnReload.className = 'btn ghost icon tiny browser-toolbar-btn';
  btnReload.textContent = '⟳';
  btnReload.title = L('browserReloadLabel');
  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'btn ghost icon tiny browser-toolbar-btn';
  btnClose.textContent = '✕';
  btnClose.title = L('browserCloseLabel');
  const address = document.createElement('input');
  address.type = 'text';
  address.className = 'browser-address';
  address.spellcheck = false;
  address.autocapitalize = 'off';
  address.placeholder = L('browserAddressPlaceholder');

  const progress = document.createElement('div');
  progress.className = 'browser-progress hidden';

  // The stage is the RECT the main-side WebContentsView is positioned over
  // (external tabs); local iframes mount into it directly.
  const stage = document.createElement('div');
  stage.className = 'browser-tab-stage';
  const stash = document.createElement('div');
  stash.className = 'browser-tab-stash';
  stash.setAttribute('aria-hidden', 'true');

  root.append(strip, toolbar, progress, stage, stash);
  toolbar.append(btnBack, btnForward, btnReload, address, btnClose);

  // ── helpers ────────────────────────────────────────────────────────────
  const find = (id: string | null) => (id ? tabs.find((t) => t.id === id) ?? null : null);

  function tabRect(): Bounds {
    const r = stage.getBoundingClientRect();
    // Viewport coords == window-content-view DIPs (the app never scrolls).
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  function renderStrip(): void {
    strip.replaceChildren();
    strip.classList.toggle('hidden', tabs.length === 0);
    for (const t of tabs) {
      t.chip.className = 'browser-tab' + (t.id === activeId ? ' active' : '') + (t.loading ? ' loading' : '');
      t.chip.replaceChildren();
      const label = document.createElement('span');
      label.className = 'browser-tab-name';
      label.textContent = t.name;
      label.title = t.url;
      const kindDot = document.createElement('span');
      kindDot.className = 'browser-tab-kind' + (t.kind === 'local' ? ' local' : '');
      kindDot.textContent = t.kind === 'local' ? '📄' : '🌐';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'browser-tab-close';
      close.textContent = '✕';
      close.title = L('browserCloseLabel');
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      t.chip.append(kindDot, label, close);
      t.chip.addEventListener('click', () => activate(t.id));
      t.chip.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(t.id); }
      });
      strip.appendChild(t.chip);
    }
    syncToolbar();
  }

  function syncToolbar(): void {
    const a = find(activeId);
    const ext = !!a?.viewId;
    btnBack.disabled = !(a && a.kind === 'external' && a.canGoBack);
    btnForward.disabled = !(a && a.kind === 'external' && a.canGoForward);
    btnReload.disabled = !a;
    btnClose.disabled = !a;
    address.value = a ? (a.kind === 'local' ? a.name : a.url) : '';
    progress.classList.toggle('hidden', !a || !a.loading);
  }

  /** Move nodes: active local iframe → stage; inactive → stash. External
   *  tabs contribute nothing to the DOM (the view paints over the rect). */
  function syncNodes(): void {
    for (const t of tabs) {
      if (!t.iframe) continue;
      if (t.id === activeId && t.iframe.parentElement !== stage) {
        if (t.iframe.parentElement === stash) stash.removeChild(t.iframe);
        else t.iframe.parentElement?.removeChild(t.iframe);
        stage.replaceChildren(t.iframe);
      } else if (t.iframe.parentElement !== stash) {
        stash.appendChild(t.iframe);
      }
    }
    if (!find(activeId)) stage.replaceChildren(externalPlaceholder());
    else if (find(activeId)?.kind === 'external') {
      // The WebContentsView covers the stage; show a neutral backdrop.
      if (!stage.querySelector('.browser-external-holder')) stage.replaceChildren(externalPlaceholder());
    }
    syncBounds();
  }

  function externalPlaceholder(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'browser-external-holder';
    return d;
  }

  function disposeRec(t: BTab): void {
    if (t.iframe) t.iframe.remove();
    if (t.state) revokePreview(t.state.token);
    if (t.viewId && ipc) void ipc.webviewClose(t.viewId).catch(() => {});
  }

  function touch(t: BTab): void {
    const i = tabs.findIndex((x) => x.id === t.id);
    if (i < 0) return;
    tabs.splice(i, 1);
    tabs.push(t);
  }

  function closeTab(id: string): void {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const rec = tabs[i];
    disposeRec(rec);
    tabs.splice(i, 1);
    if (activeId === id) {
      activeId = null;
      activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    }
    renderStrip();
    syncNodes();
    opts.onActiveChanged?.();
  }

  function activate(id: string): void {
    const t = find(id);
    if (!t || t.id === activeId) return;
    touch(t);
    activeId = t.id;
    renderStrip();
    syncNodes();
    opts.onActiveChanged?.();
  }

  function closeActive(): void {
    closeTab(activeId ?? '');
  }

  function closeAll(): void {
    for (const t of [...tabs]) disposeRec(t);
    tabs = [];
    activeId = null;
    renderStrip();
    syncNodes();
    opts.onActiveChanged?.();
  }

  /** New tab, evicting LRU beyond MAX_BROWSER_TABS. */
  function makeTab(partial: Partial<BTab> & { name: string; url: string; kind: 'local' | 'external' }): BTab {
    const t: BTab = {
      id: `bt-${++seq}`,
      name: partial.name,
      url: partial.url,
      kind: partial.kind,
      viewId: partial.viewId,
      iframe: partial.iframe ?? null,
      state: partial.state ?? null,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      chip: document.createElement('div'),
    };
    tabs.push(t);
    while (tabs.length > MAX_BROWSER_TABS) {
      const victim = tabs[0];
      if (victim.id === activeId) activeId = null;
      disposeRec(victim);
      tabs.shift();
    }
    return t;
  }

  // ── public actions ─────────────────────────────────────────────────────

  async function openUrl(raw: string): Promise<void> {
    const norm = normalizeAddress(raw);
    if (!norm) return;
    if (norm.kind === 'local') {
      // Local files reuse an already-open tab; otherwise a fresh one.
      await openLocalFile(norm.target);
      return;
    }
    // openUrl = always a NEW external tab (LRU caps the strip at 4); only
    // address-bar navigation reuses the active tab in place.
    await ensureExternalTab(norm.target, false);
  }

  /** Attach an external view to a tab. `inPlace` (address-bar Enter) reuses
   *  the active tab — navigating an active external tab, or converting an
   *  active local tab (iframe/token dropped); otherwise a fresh tab is made. */
  async function ensureExternalTab(url: string, inPlace: boolean): Promise<void> {
    const a = inPlace ? find(activeId) : null;
    let rec: BTab;
    if (a && a.kind === 'external') {
      // Navigate the active tab in place (address-bar semantics).
      rec = a;
      rec.url = url;
      rec.name = url.replace(/^https?:\/\//, '');
      rec.loading = true;
      touch(rec);
    } else if (a && a.kind === 'local') {
      // Convert the active tab from local → external (drop the iframe/token).
      if (a.iframe) a.iframe.remove();
      if (a.state) revokePreview(a.state.token);
      a.iframe = null;
      a.state = null;
      a.kind = 'external';
      a.url = url;
      a.name = url.replace(/^https?:\/\//, '');
      a.loading = true;
      a.viewId = undefined;
      rec = a;
      touch(rec);
    } else {
      rec = makeTab({ kind: 'external', url, name: url.replace(/^https?:\/\//, '') });
      activeId = rec.id;
    }
    renderStrip();
    syncNodes();
    if (!ipc) {
      rec.loading = false;
      opts.notify?.(L('browserNavFailed'));
      renderStrip();
      return;
    }
    const res = await ipc.webviewOpen(url, tabRect(), rec.viewId, !panelVisible);
    if (disposed || find(rec.id) !== rec) return; // tab evicted/closed meanwhile
    if (!res.ok || !res.viewId) {
      // Main side already opened the system browser (fallback event follows
      // for created views; scheme rejects report here). Drop the dead tab.
      closeTab(rec.id);
      opts.notify?.(L('browserOpenedExternally'));
      return;
    }
    rec.viewId = res.viewId;
    if (find(rec.id) === rec) rec.loading = true;
  }

  async function openLocalFile(path: string): Promise<boolean> {
    // Reuse an open local tab for the same file.
    const existing = tabs.find((t) => t.kind === 'local' && t.url === path);
    if (existing) {
      activeId = existing.id;
      touch(existing);
      renderStrip();
      syncNodes();
      opts.onActiveChanged?.();
      return true;
    }
    const st = await fetchPreview(path);
    if (disposed) return false;
    if (!st || st.error || !st.url) {
      // Caller's two-layer fallback (system app) takes over.
      return false;
    }
    const iframe = document.createElement('iframe');
    iframe.className = 'browser-local-frame';
    iframe.src = st.url;
    // Sandboxed: scripts run, but NO same-origin with the app (opaque origin),
    // no downloads, no plugins. The token protocol stays readable (ACAO *).
    iframe.sandbox = 'allow-scripts allow-popups allow-forms';
    iframe.title = st.name;
    iframe.onload = () => {
      if (find(iframe.dataset.tabId ?? '')?.iframe === iframe) {
        const t = find(iframe.dataset.tabId ?? '');
        if (t) { t.loading = false; syncToolbar(); }
      }
    };
    iframe.dataset.tabId = ''; // set after the tab record exists
    const rec = makeTab({ kind: 'local', url: path, name: basenameOf(path), iframe, state: st });
    iframe.dataset.tabId = rec.id;
    activeId = rec.id;
    renderStrip();
    syncNodes();
    opts.onActiveChanged?.();
    return true;
  }

  async function navigateActive(value: string): Promise<void> {
    const norm = normalizeAddress(value);
    if (!norm) return;
    if (norm.kind === 'local') {
      await openLocalFile(norm.target);
      return;
    }
    // Address-bar Enter: navigate the active external tab in place, or
    // convert the active local tab; no new tab is created.
    await ensureExternalTab(norm.target, true);
  }

  async function back(): Promise<void> {
    const a = find(activeId);
    if (!a?.viewId || !ipc) return;
    await ipc.webviewBack(a.viewId); // 'navigated' event updates history flags
  }

  async function forward(): Promise<void> {
    const a = find(activeId);
    if (!a?.viewId || !ipc) return;
    await ipc.webviewForward(a.viewId);
  }

  function reload(): void {
    const a = find(activeId);
    if (!a) return;
    if (a.viewId && ipc) {
      void ipc.webviewReload(a.viewId);
      return;
    }
    if (a.iframe && a.state) {
      a.loading = true;
      syncToolbar();
      a.iframe.src = a.state.url;
    }
  }

  function setPanelVisible(visible: boolean): void {
    panelVisible = visible;
    syncBounds();
  }

  function syncBounds(): void {
    if (!ipc) return;
    const a = find(activeId);
    const hidden = !panelVisible || !(a && a.kind === 'external' && a.viewId);
    void ipc.webviewBounds(tabRect(), hidden).catch(() => {});
  }

  // ── toolbar wiring ────────────────────────────────────────────────────
  btnBack.addEventListener('click', () => { void back(); });
  btnForward.addEventListener('click', () => { void forward(); });
  btnReload.addEventListener('click', () => { reload(); });
  btnClose.addEventListener('click', () => { closeActive(); });
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void navigateActive(address.value);
    }
  });

  // ── resize sync ───────────────────────────────────────────────────────
  // The main-side WebContentsView is positioned over the stage rect; any
  // change to the panel's pixel size (window resize, sidebar width drag,
  // tab strip wrapping) must re-sync the bounds so the view tracks it.
  let resizeObs: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => {
      if (!disposed) syncBounds();
    });
    resizeObs.observe(root);
  }

  // ── main-side event routing (progress / title / nav state / fallback) ─
  if (ipc?.onWebviewEvent) {
    // The preload subscription has no unsubscribe; we gate on `disposed` so a
    // re-mount simply ignores stale callbacks.
    ipc.onWebviewEvent((ev) => {
      if (disposed) return;
      const rec = tabs.find((t) => t.viewId === ev.viewId);
      if (!rec) return; // view unknown (open raced or tab already closed)
      switch (ev.type) {
        case 'loading':
          rec.loading = true;
          break;
        case 'loaded':
          rec.loading = false;
          rec.url = ev.url ?? rec.url;
          if (typeof ev.canGoBack === 'boolean') rec.canGoBack = ev.canGoBack;
          if (typeof ev.canGoForward === 'boolean') rec.canGoForward = ev.canGoForward;
          break;
        case 'navigated':
          rec.url = ev.url ?? rec.url;
          if (typeof ev.canGoBack === 'boolean') rec.canGoBack = ev.canGoBack;
          if (typeof ev.canGoForward === 'boolean') rec.canGoForward = ev.canGoForward;
          break;
        case 'title':
          if (ev.title && ev.title.trim()) rec.name = ev.title;
          break;
        case 'fallback':
          // Main opened the system browser and destroyed the view.
          closeTab(rec.id);
          opts.notify?.(L('browserOpenedExternally'));
          return;
      }
      if (rec.id === activeId) renderStrip();
    });
  }

  // initial render (no tabs yet)
  renderStrip();
  syncNodes();

  return {
    openUrl,
    openLocalFile,
    navigateActive,
    back,
    forward,
    reload,
    closeActive,
    closeAll,
    active: () => {
      const t = find(activeId);
      if (!t) return null;
      return {
        id: t.id, name: t.name, url: t.url, kind: t.kind,
        loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
        viewId: t.viewId,
        close: () => closeTab(t.id),
      };
    },
    list: () => tabs.map((t) => ({
      id: t.id, name: t.name, url: t.url, kind: t.kind,
      loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
      viewId: t.viewId,
      close: () => closeTab(t.id),
    })),
    setPanelVisible,
    syncBounds,
    dispose: () => {
      disposed = true;
      resizeObs?.disconnect();
      resizeObs = null;
      closeAll();
      strip.remove();
      toolbar.remove();
      progress.remove();
      stage.remove();
      stash.remove();
    },
  };
}
