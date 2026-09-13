/**
 * P1 — Sidebar registry: the single `registerTab` surface.
 * See docs/dsh-plugin-adoption-plan.md §4.3 / §4.5.
 *
 * The registry owns the lifecycle of every registered page:
 *   - mount is called with the page container + context when a tab is opened
 *     (or re-opened after being collapsed);
 *   - the returned dispose function is stored and called when the tab closes,
 *     is replaced, or the registry is cleared;
 *   - dispose is guaranteed to run exactly once (idempotent).
 *
 * Framework-free: no DOM is touched by the registry itself (the container is
 * provided by the caller), so logic here is fully unit-testable under
 * `node --test` without a DOM shim.
 */

import type { SidebarContext, SidebarRegistry, SidebarTabRegistration } from './types.js';

export class SidebarRegistryImpl implements SidebarRegistry {
  private readonly tabs = new Map<string, SidebarTabRegistration>();
  private readonly disposers = new Map<string, (() => void) | null>();

  register(reg: SidebarTabRegistration): void {
    if (!reg?.id) throw new Error('Sidebar tab requires a stable id');
    if (this.tabs.has(reg.id)) {
      throw new Error(`Sidebar tab "${reg.id}" is already registered`);
    }
    this.tabs.set(reg.id, reg);
    this.disposers.set(reg.id, null);
  }

  unregister(id: string): boolean {
    if (!this.tabs.has(id)) return false;
    this.disposeMounted(id);
    this.tabs.delete(id);
    this.disposers.delete(id);
    return true;
  }

  list(): SidebarTabRegistration[] {
    return [...this.tabs.values()];
  }

  get(id: string): SidebarTabRegistration | undefined {
    return this.tabs.get(id);
  }

  clear(): number {
    const count = this.tabs.size;
    for (const id of [...this.tabs.keys()]) this.disposeMounted(id);
    this.tabs.clear();
    this.disposers.clear();
    return count;
  }

  /**
   * (Internal, used by the renderer integration) Mount a registered tab into a
   * container with a context. Every previously mounted page is disposed first —
   * the sidebar hosts a single page container, so switching tabs never leaks
   * subscriptions or DOM from the previous page (§4.5).
   */
  mount(id: string, container: HTMLElement, ctx: SidebarContext): (() => void) | undefined {
    const reg = this.tabs.get(id);
    if (!reg) return undefined;
    this.disposeAllMounted();
    container.replaceChildren();
    const dispose = reg.mount(container, ctx);
    this.disposers.set(id, typeof dispose === 'function' ? dispose : null);
    return () => this.disposeMounted(id);
  }

  /** Dispose the mounted page for a tab id without removing its registration. */
  mountDispose(id: string): void {
    this.disposeMounted(id);
  }

  private disposeMounted(id: string): void {
    const d = this.disposers.get(id);
    if (typeof d === 'function') {
      try {
        d();
      } finally {
        this.disposers.set(id, null);
      }
    }
  }

  private disposeAllMounted(): void {
    for (const id of [...this.disposers.keys()]) this.disposeMounted(id);
  }
}

/** A page that lives for the whole renderer lifetime and never unmounts. */
export function quickTab(
  id: string,
  title: string,
  icon: string | undefined,
  mount: SidebarTabRegistration['mount'],
): SidebarTabRegistration {
  return { id, title, icon, mount };
}