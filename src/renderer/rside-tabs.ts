/**
 * Right-sidebar tab strip controller (PR2).
 *
 * Drives the horizontal #rside-tabs strip and the four .rside-tab-panel
 * containers (信息 / 文件 / 浏览器 / 侧边对话). Panels keep their DOM while
 * inactive (state preservation), the incoming panel fades in over 200ms
 * (`.panel-in`), and the active id persists to localStorage so a panel
 * choice survives restarts.
 *
 * The activation callback is the hook the renderer uses to re-arm the
 * FileBrowser idle timer (files tab), sync auto-hide hints, and pause the
 * browser tab's WebContentsView when its panel goes invisible.
 */

export type RsidePanelId = 'info' | 'files' | 'browser' | 'sidechat';

export const RSIDE_PANELS: readonly RsidePanelId[] = ['info', 'files', 'browser', 'sidechat'];

const PANE_KEY = 'nexus.right-sidebar.panel';

export interface RsideTabsOptions {
  /** Fired whenever a panel becomes active (including the initial restore). */
  readonly onActivate?: (panel: RsidePanelId, prev: RsidePanelId | null) => void;
}

export interface RsideTabsHandle {
  /** Switch to a panel (persisted + activation callback). */
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

  function restore(): RsidePanelId {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(PANE_KEY);
    } catch {
      /* storage unavailable */
    }
    return RSIDE_PANELS.includes(saved as RsidePanelId) ? (saved as RsidePanelId) : 'info';
  }

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
    try {
      localStorage.setItem(PANE_KEY, target);
    } catch {
      /* storage unavailable */
    }
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

  // Restore the persisted panel (or default 信息) and fire the first
  // activation so idle timers / pause hooks arm on load.
  const initial = restore();
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
