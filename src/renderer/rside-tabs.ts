/**
 * Right-sidebar tab strip controller (PR2).
 *
 * Drives the horizontal #rside-tabs strip and the four .rside-tab-panel
 * containers (信息 / 文件 / 浏览器 / 侧边对话). Panels keep their DOM while
 * inactive (state preservation), and the incoming panel fades in over 200ms
 * (`.panel-in`).
 *
 * The active panel always starts at 信息 on load. The earlier cross-restart
 * persistence of the panel choice was dropped deliberately: a sticky 文件
 * choice from a previous session made the app boot into the wrong panel;
 * in-session switches simply are not persisted.
 *
 * The activation callback is the hook the renderer uses to re-arm the
 * FileBrowser idle timer (files tab), sync auto-hide hints, and pause the
 * browser tab's WebContentsView when its panel goes invisible.
 */

export type RsidePanelId = 'info' | 'files' | 'browser' | 'sidechat';

export const RSIDE_PANELS: readonly RsidePanelId[] = ['info', 'files', 'browser', 'sidechat'];

/** Legacy persistence key — removed on mount so older sessions' sticky
 *  panel choice (e.g. 文件) stops leaking into every new launch. */
const LEGACY_PANE_KEY = 'nexus.right-sidebar.panel';

export interface RsideTabsOptions {
  /** Fired whenever a panel becomes active (including the initial load). */
  readonly onActivate?: (panel: RsidePanelId, prev: RsidePanelId | null) => void;
}

export interface RsideTabsHandle {
  /** Switch to a panel (activation callback; the choice is not persisted). */
  set(id: RsidePanelId): void;
  /** The active panel id. */
  get(): RsidePanelId;
  /** True when the given panel is active. */
  is(id: RsidePanelId): boolean;
}

export function mountRsideTabs(
  nav: HTMLElement,
  panels: HTMLElement,
  opts: RsideTabsOptions = {},
): RsideTabsHandle {
  const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('.rside-tab[data-panel]'));
  const panelEls = new Map<string, HTMLElement>();
  for (const p of Array.from(panels.querySelectorAll<HTMLElement>('.rside-tab-panel[data-panel]'))) {
    panelEls.set(p.dataset.panel ?? '', p);
  }
  let current: RsidePanelId = 'info';

  // Always load into 信息 — the panel choice is not persisted across
  // restarts; drop any stale value written by older builds.
  try {
    localStorage.removeItem(LEGACY_PANE_KEY);
  } catch {
    /* storage unavailable */
  }
  const initial: RsidePanelId = 'info';
  // Align the DOM to `initial` without a visible flash: hide every other
  // panel, mark buttons, then fire activation.

  function set(id: RsidePanelId): void {
    const target = RSIDE_PANELS.includes(id) ? id : 'info';
    const prev = current;
    if (target === prev) {
      // Still fire activation (callers re-arm timers idempotently).
      opts.onActivate?.(target, prev);
      return;
    }
    const outEl = panelEls.get(prev);
    const inEl = panelEls.get(target);
    for (const b of buttons) {
      const on = b.dataset.panel === target;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (outEl) outEl.hidden = true;
    if (inEl) {
      inEl.hidden = false;
      // Re-trigger the 200ms fade-in even when re-selecting the same panel.
      inEl.classList.remove('panel-in');
      void inEl.offsetWidth; // force reflow
      inEl.classList.add('panel-in');
    }
    current = target;
    opts.onActivate?.(target, prev);
  }

  function get(): RsidePanelId {
    return current;
  }

  function is(id: RsidePanelId): boolean {
    return current === id;
  }

  // ── wire clicks ──────────────────────────────────────────────────────
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const id = b.dataset.panel;
      if (id) set(id as RsidePanelId);
    });
  }

  // Fire the first activation so idle timers / pause hooks arm on load.
  // Align the DOM to `initial` without a visible flash: hide every other
  // panel, mark buttons, then fire activation.
  for (const b of buttons) {
    const on = b.dataset.panel === initial;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const [id, el] of panelEls) {
    el.hidden = id !== initial;
  }
  current = initial;
  opts.onActivate?.(initial, null);

  return { set, get, is };
}
