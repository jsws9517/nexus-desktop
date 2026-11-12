/**
 * Preview subsystem — renderer-side entry point + state machine (PR2).
 *
 * The legacy right-sidebar accordion (#preview-section / #preview-host) was
 * retired in PR2: document previews now live in the 文件 tab's document strip
 * (./dock.ts). This module is the stable façade the rest of the app calls:
 *
 *   - openPath(path)        → dock.open(path): creates/activates a doc tab and
 *                             switches to the 文件 panel. Returns the real
 *                             success flag FileBrowser's fallback relies on.
 *   - close()              → close the active doc tab (Esc from the dock).
 *   - toggleFullscreen()   → move the active viewer into #preview-overlay-root
 *                             with a zoom/fit/close toolbar (Esc + focus return).
 *   - getLiveHandle()      → the active viewer's control surface so the global
 *                             +/-/F shortcuts and the toolbar drive it.
 *
 * Inline chat cards (./inline.ts) and the dock itself use the kernel
 * (./core.ts) directly — they never go through this façade.
 */

import type { PreviewState, MountedViewer } from './core.js';
import type { DocDock } from './dock.js';

let dock: DocDock | null = null;

/** Wire the dock (call once when #doc-tabs/#doc-tab-stage/#preview-overlay-root exist). */
export function bindDock(d: DocDock): void {
  dock = d;
}

/** The bound dock (for direct queries, e.g. tests / renderer glue). */
export function getDock(): DocDock | null {
  return dock;
}

export function getState(): PreviewState | null {
  return dock?.active()?.state ?? null;
}

export function isFullscreen(): boolean {
  return !document.getElementById('preview-overlay-root')?.classList.contains('hidden');
}

/**
 * Open a file in the document strip. @returns true when a tab now shows it.
 * Unsupported kinds return false so the caller's external-open fallback runs.
 */
export async function openPath(path: string): Promise<boolean> {
  if (!path || typeof path !== 'string' || !dock) return false;
  return dock.open(path);
}

/** Close the active document tab. No-op when none is open. */
export function close(): void {
  dock?.closeActive();
}

/** Toggle the active viewer into/out of the fullscreen overlay. */
export function toggleFullscreen(): void {
  dock?.toggleFullscreen();
}

/** Zoom/fit surface for the toolbar + global shortcuts. */
export function getLiveHandle(): MountedViewer | null {
  return dock?.active()?.viewer ?? null;
}

// ── Toolbar button helpers ─────────────────────────────────────────────────

/**
 * Update the global "preview" toolbar button. The PR2 overlay carries its own
 * zoom/fit/close controls, so this only tracks whether a document is open.
 */
export function updateToolbarButton(el: HTMLElement | null): void {
  if (!el) return;
  const open = !!dock?.active();
  el.classList.toggle('active', open);
  el.title = open ? 'Preview (F: fullscreen)' : 'Preview media files';
}

// ── Toolbar control wiring ────────────────────────────────────────────────

/**
 * Bind the fullscreen overlay's zoom/fit/close buttons to the live viewer.
 * The overlay re-creates its bar on every fullscreen entry, so these ids
 * (ovl-*) are resolved lazily at call time — idempotent by design.
 */
export function wirePreviewToolbar(): void {
  // No-op anchor: the dock installs its own bar handlers on entry; this export
  // exists for call-site compatibility (the PR1 renderer wiring).
}
