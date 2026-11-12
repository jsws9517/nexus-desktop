/**
 * Document tab strip ("dock") for the 文件 tab of the right sidebar.
 *
 * The dock owns up to MAX_DOC_TABS live document tabs. Each tab holds the
 * SAME persistent viewer element the kernel creates (core.mountViewer), so
 * switching tabs moves the node between the visible stage and a hidden stash
 * instead of re-mounting — zoom / scroll / playback position survive.
 *
 * - LRU eviction: opening a 9th document disposes the least-recently-used tab
 *   (viewer node removed + token revoked in the main process).
 * - Close: middle-click a chip, or Ctrl/Cmd+W while the 文件 panel is active.
 * - Fullscreen: the active viewer's node moves into #preview-overlay-root
 *   with a toolbar (zoom/fit/close); Esc exits and focus is restored to the
 *   triggering element (PR2 E3).
 *
 * openPath() in ./open.js delegates to this dock, so the legacy single-panel
 * state machine (toolbar button, F/+/-/Esc shortcuts, FileBrowser context)
 * keeps working unchanged.
 */

import { classify, type PreviewKind } from '../../shared/preview.js';
import { fetchPreview, mountViewer, type MountedViewer, type PreviewState } from './core.js';
import { STR } from '../i18n.js';

export const MAX_DOC_TABS = 8;

export interface DocTab {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: PreviewKind;
  /** Kernel state (token/url/mime/size). null while still loading. */
  readonly state: PreviewState | null;
  /** Live viewer node (also the control surface). null while still loading. */
  readonly viewer: MountedViewer | null;
  readonly loading: boolean;
  readonly error?: string;
  close(): void;
}

export interface DocDockOptions {
  /** Horizontal chip strip element (#doc-tabs). */
  readonly strip: HTMLElement;
  /** Visible stage the ACTIVE tab's viewer mounts into (#doc-tab-stage). */
  readonly stage: HTMLElement;
  /** Hidden stash for inactive viewers (must stay in the document). */
  readonly stash: HTMLElement;
  /** Fullscreen overlay root (#preview-overlay-root). */
  readonly overlay: HTMLElement;
  /** Live UI language for dock labels. */
  readonly getLang: () => string;
  /** Called when the user triggers an open from outside the panel (e.g. the
   *  inline card's "在侧栏打开") so the host can switch to the 文件 tab. */
  readonly onNeedPanel?: () => void;
}

export interface DocDock {
  /** Open (or activate) a document. Resolves true when a tab now shows it. */
  open(path: string, opts?: { activate?: boolean }): Promise<boolean>;
  /** Close the active tab. No-op when none. */
  closeActive(): void;
  /** Close every tab (dispose all viewers + revoke tokens). */
  closeAll(): void;
  /** The active tab, or null. */
  active(): DocTab | null;
  /** All tabs, most-recently-used last. */
  list(): readonly DocTab[];
  /** Toggle the active viewer into/out of the fullscreen overlay. */
  toggleFullscreen(): void;
  /** Force the overlay back to the stage (called on panel switch). */
  exitFullscreen(): void;
  /** Zoom/fit controls for the active viewer (toolbar wiring). */
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

interface TabRec {
  id: string;
  path: string;
  name: string;
  kind: PreviewKind;
  state: PreviewState | null;
  viewer: MountedViewer | null;
  loading: boolean;
  error: string | undefined;
  chip: HTMLElement;
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function tr(lang: string) {
  return (key: string): string => STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
}

export function mountDocDock(opts: DocDockOptions): DocDock {
  const { strip, stage, stash, overlay } = opts;
  // LRU order: index 0 = least recently used, last = active candidate.
  let tabs: TabRec[] = [];
  let activeId: string | null = null;
  let fullscreen = false;
  let overlayEl: HTMLElement | null = null;

  const find = (id: string | null) => (id ? tabs.find((t) => t.id === id) ?? null : null);

  // ── DOM helpers ────────────────────────────────────────────────────────

  function renderStrip(): void {
    strip.replaceChildren();
    strip.classList.toggle('hidden', tabs.length === 0);
    stage.classList.toggle('hidden', !activeTabHasViewer());
    for (const t of tabs) {
      t.chip.className = 'doc-tab' + (t.id === activeId ? ' active' : '') + (t.loading ? ' loading' : '');
      t.chip.replaceChildren();
      const label = document.createElement('span');
      label.className = 'doc-tab-name';
      label.textContent = t.name;
      label.title = t.path;
      const kindIcon = document.createElement('span');
      kindIcon.className = 'doc-tab-kind';
      kindIcon.textContent = t.loading ? '…' : kindGlyph(t.kind);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'doc-tab-close';
      close.textContent = '✕';
      close.title = str_('previewCloseLabel');
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      t.chip.append(kindIcon, label, close);
      // Middle-click closes the tab (standard desktop convention).
      t.chip.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(t.id); }
      });
      t.chip.addEventListener('click', () => activate(t.id));
      strip.appendChild(t.chip);
    }
  }

  function activeTabHasViewer(): boolean {
    const t = find(activeId);
    return !!t?.viewer && !t.loading;
  }

  /** Move the node that should be VISIBLE now; everything else to stash. */
  function syncNodes(): void {
    for (const t of tabs) {
      if (!t.viewer) continue;
      const v = t.viewer;
      const detach = (): void => {
        // Defensive: the node may be unattached (overlay just cleared) or in
        // another host — never assume the stash.
        v.parentElement?.removeChild(v);
      };
      if (t.id === activeId && !fullscreen) {
        if (v.parentElement !== stage) {
          detach();
          stage.replaceChildren(v);
        }
      } else if (t.id === activeId && fullscreen && overlayEl) {
        const holder = overlayEl.querySelector('.preview-overlay-stage');
        if (holder && v.parentElement !== holder) {
          detach();
          holder.replaceChildren(v);
        }
      } else {
        if (v.parentElement !== stash) {
          detach();
          stash.appendChild(v);
        }
      }
    }
  }

  // ── tab lifecycle ─────────────────────────────────────────────────────

  function tabIdFor(path: string): string {
    return `doc-${path.replace(/[\\/:*?"<>|]/g, '_').slice(-120)}`;
  }

  /** MRU bookkeeping: ensure `rec` is the most-recently-used tab (front). */
  function touch(rec: TabRec): void {
    const idx = tabs.findIndex((t) => t.id === rec.id);
    if (idx < 0) return;
    tabs.splice(idx, 1);
    tabs.push(rec);
  }

  async function open(path: string, o: { activate?: boolean } = {}): Promise<boolean> {
    if (!path || typeof path !== 'string') return false;
    const id = tabIdFor(path);
    let rec = find(id);
    if (!rec) {
      const kind = classify(path);
      if (kind === 'unsupported') return false; // caller falls back to external open
      rec = {
        id, path,
        name: basenameOf(path),
        kind,
        state: null,
        viewer: null,
        loading: true,
        error: undefined,
        chip: document.createElement('div'),
      };
      tabs.push(rec);
      // LRU eviction: the strip holds at most MAX_DOC_TABS documents.
      while (tabs.length > MAX_DOC_TABS) {
        const victim = tabs[0];
        if (victim.id === activeId) activeId = null;
        disposeRec(victim);
        tabs.shift();
      }
      rec = find(id);
      if (!rec) return false;
      if (o.activate !== false) activeId = rec.id;
      renderStrip();
      syncNodes();
      opts.onNeedPanel?.();
      void loadRec(rec);
    } else {
      touch(rec); // re-opening bumps LRU recency
      if (o.activate !== false) {
        activeId = rec.id;
        renderStrip();
        syncNodes();
      }
    }
    return true;
  }

  async function loadRec(rec: TabRec): Promise<void> {
    const res = await fetchPreview(rec.path);
    if (find(rec.id) !== rec) return; // tab was evicted / closed while loading
    if (!res || !res.token) {
      // Fetch failed (403 / cap / missing): drop the placeholder tab so the
      // caller's external-open fallback is the only outcome.
      closeTab(rec.id, { suppressActiveShift: true });
      return;
    }
    rec.state = res;
    rec.loading = false;
    rec.viewer = mountViewer(res);
    if (activeId === rec.id) rec.viewer.fit?.();
    renderStrip();
    syncNodes();
  }

  function disposeRec(rec: TabRec): void {
    rec.viewer?.dispose();
    rec.viewer = null;
    rec.chip.remove();
  }

  function closeTab(id: string, o: { suppressActiveShift?: boolean } = {}): void {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const rec = tabs[idx];
    disposeRec(rec);
    tabs.splice(idx, 1);
    if (activeId === id) {
      activeId = null;
      if (!o.suppressActiveShift) {
        // Nearest neighbour becomes active (LRU-last when possible).
        activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      }
    }
    if (fullscreen && find(activeId)?.viewer) exitFullscreen();
    renderStrip();
    syncNodes();
  }

  function activate(id: string): void {
    if (activeId === id) return;
    // LRU bookkeeping: move the tab to the front (most-recently-used).
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const rec = tabs[idx];
    tabs.splice(idx, 1);
    tabs.push(rec);
    activeId = id;
    if (fullscreen) exitFullscreen();
    renderStrip();
    syncNodes();
  }

  // ── fullscreen overlay ────────────────────────────────────────────────

  /** Focus captured on overlay entry, restored on exit (PR2 E3). */
  let lastFocus: HTMLElement | null = null;

  function toggleFullscreen(): void {
    if (!find(activeId)?.viewer) return;
    if (fullscreen) exitFullscreen();
    else enterFullscreen();
  }

  function enterFullscreen(): void {
    if (!find(activeId)?.viewer) return;
    fullscreen = true;
    lastFocus = (document.activeElement as HTMLElement | null) ?? null;
    overlayEl = overlay;
    overlayEl.replaceChildren();
    const t = tr(opts.getLang());
    const title = document.createElement('div');
    title.className = 'preview-overlay-title';
    title.textContent = find(activeId)?.name ?? '';
    const holder = document.createElement('div');
    holder.className = 'preview-overlay-stage';
    const bar = document.createElement('div');
    bar.className = 'preview-overlay-bar';
    const mkBtn = (glyph: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost icon tiny preview-toolbar-btn';
      b.textContent = glyph;
      b.title = label;
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    mkBtn('+', t('previewZoomInLabel'), () => zoomIn());
    mkBtn('−', t('previewZoomOutLabel'), () => zoomOut());
    mkBtn('⤢', t('previewFitLabel'), () => fit());
    mkBtn('✕', t('previewCloseLabel'), () => { exitFullscreen(); closeTab(activeId ?? ''); });
    overlayEl.append(title, bar, holder);
    overlayEl.classList.remove('hidden');
    overlayEl.classList.add('visible');
    overlayEl.addEventListener('keydown', onOverlayKey); // Esc → back to the dock stage
    // Take focus into the overlay so its Esc handler (stopPropagation) wins
    // over the global shortcut; the trigger element is restored on exit.
    overlayEl.tabIndex = -1;
    overlayEl.focus({ preventScroll: true });
    syncNodes();
    fit();
  }

  function exitFullscreen(): void {
    if (!fullscreen) return;
    fullscreen = false;
    if (overlayEl) {
      overlayEl.removeEventListener('keydown', onOverlayKey);
      overlayEl.replaceChildren();
      overlayEl.classList.remove('visible');
      overlayEl.classList.add('hidden');
      overlayEl = null;
    }
    // PR2 E3: focus returns to the element that triggered the fullscreen.
    lastFocus?.focus?.({ preventScroll: true });
    lastFocus = null;
    syncNodes();
  }

  const onOverlayKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      exitFullscreen();
    }
  };

  // ── control surface for active viewer ─────────────────────────────────

  function zoomIn(): void { find(activeId)?.viewer?.zoomIn?.(); }
  function zoomOut(): void { find(activeId)?.viewer?.zoomOut?.(); }
  function fit(): void { find(activeId)?.viewer?.fit?.(); }

  // ── i18n shim (labels resolved at chip render time) ───────────────────
  function str_(key: string): string {
    return tr(opts.getLang())(key);
  }

  renderStrip();

  return {
    open,
    closeActive: () => closeTab(activeId ?? ''),
    closeAll: () => {
      for (const t of [...tabs]) disposeRec(t);
      tabs = [];
      activeId = null;
      if (fullscreen) exitFullscreen();
      renderStrip();
      syncNodes();
    },
    active: () => {
      const t = find(activeId);
      if (!t) return null;
      return {
        id: t.id, path: t.path, name: t.name, kind: t.kind,
        state: t.state,
        viewer: t.viewer, loading: t.loading, error: t.error,
        close: () => closeTab(t.id),
      };
    },
    list: () => tabs.map((t) => ({
      id: t.id, path: t.path, name: t.name, kind: t.kind,
      state: t.state,
      viewer: t.viewer, loading: t.loading, error: t.error,
      close: () => closeTab(t.id),
    })),
    toggleFullscreen,
    exitFullscreen,
    zoomIn,
    zoomOut,
    fit,
  };
}

function kindGlyph(kind: PreviewKind): string {
  switch (kind) {
    case 'image': return '🖼';
    case 'video': return '🎬';
    case 'audio': return '🎵';
    case 'pdf': return '📕';
    case 'html': return '🌐';
    case 'markdown':
    case 'text': return '📄';
    default: return '📄';
  }
}
