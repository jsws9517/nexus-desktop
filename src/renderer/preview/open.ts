/**
 * Preview subsystem — renderer-side entry point + state machine.
 *
 * The panel owns a single live viewer instance so switching between files keeps
 * playback position / scroll / zoom state intact. It can render in two modes:
 *   - inline: mounted inside #preview-host (right sidebar accordion)
 *   - fullscreen: moved into #preview-overlay-root (fixed, covers #layout)
 *
 * All file I/O goes through the shared kernel (./core.ts) — `openPath` here is
 * the panel-level wrapper that keeps the legacy accordion + toolbar behaviour.
 * Inline chat cards and the sidebar document tabs call `fetchPreview` /
 * `mountViewer` from core.ts directly instead.
 *
 * The viewer element is created ONCE per open and the same node is moved
 * between hosts when the mode changes (state survives); `close()` disposes it
 * and revokes the token.
 */

import type { PreviewState, ViewerHandle, MountedViewer } from './core.js';
import { fetchPreview, mountViewer, revokePreview } from './core.js';
import { formatBytes } from '../../shared/preview.js';

let state: PreviewState | null = null;
let mode: 'inline' | 'fullscreen' = 'inline';
let liveHandle: MountedViewer | null = null;

export function getState(): PreviewState | null { return state; }
export function isFullscreen(): boolean { return mode === 'fullscreen'; }
/** The live viewer element (with its zoom/fit control surface), if any. */
export function getLiveHandle(): MountedViewer | null { return liveHandle; }

/**
 * Open a file in the panel (legacy accordion host).
 * @returns whether the preview actually mounted. Callers that need a fallback
 *   path (e.g. FileBrowser's external-open guard) rely on this flag — a silent
 *   failure used to make the fallback branch unreachable.
 */
export async function openPath(path: string): Promise<boolean> {
  if (!path || typeof path !== 'string') return false;
  // Await close so the previous viewer is fully disposed before we mount.
  await close();
  const fetched = await fetchPreview(path);
  if (!fetched || !fetched.token) return false;
  state = fetched;
  liveHandle = mountViewer(fetched);
  renderMode();
  updateToolbarButton(document.getElementById('btn-preview') as HTMLElement | null);
  return true;
}

export async function toggleFullscreen(): Promise<void> {
  if (!state) return;
  mode = mode === 'fullscreen' ? 'inline' : 'fullscreen';
  renderMode();
  updateToolbarButton(document.getElementById('btn-preview') as HTMLElement | null);
}

export async function close(): Promise<void> {
  const token = state?.token;
  const handle = liveHandle;
  liveHandle = null;
  state = null;
  mode = 'inline';
  // Remove the live node from wherever it currently sits and revoke the token.
  handle?.dispose();
  // Clear both hosts so no stale DOM survives between sessions.
  const inlineHost = document.getElementById('preview-host');
  const overlayRoot = document.getElementById('preview-overlay-root');
  if (inlineHost) inlineHost.replaceChildren();
  if (overlayRoot) {
    overlayRoot.replaceChildren();
    overlayRoot.classList.remove('visible');
    overlayRoot.classList.add('hidden');
  }
  // Re-hide the section toolbar and collapse the accordion so the panel
  // returns to its empty state (it is shown only while a preview is live).
  const sec = document.getElementById('preview-section');
  if (sec) sec.classList.add('hidden');
  const toolbar = document.getElementById('preview-toolbar');
  if (toolbar) toolbar.classList.add('hidden');
  updateToolbarButton(document.getElementById('btn-preview') as HTMLElement | null);
  if (token) void revokePreview(token);
}

function renderMode(): void {
  if (!liveHandle || !state) return;
  const body = liveHandle; // the handle IS the element (ViewerHandle extends HTMLElement)
  const inlineHost = document.getElementById('preview-host');
  const overlayRoot = document.getElementById('preview-overlay-root');
  if (!inlineHost && !overlayRoot) return;
  if (mode === 'fullscreen' && overlayRoot) {
    // Move the live DOM node into the overlay so playback/scroll/zoom survive.
    overlayRoot.replaceChildren(body);
    // `hidden` class is the master gate; `visible` mirrors it for the CSS anim.
    overlayRoot.classList.remove('hidden');
    overlayRoot.classList.add('visible');
    // Fit-to-container is meaningful in the bigger space.
    liveHandle.fit?.();
  } else if (inlineHost) {
    inlineHost.replaceChildren(body);
    // Clear any stale overlay content from a previous fullscreen session.
    if (overlayRoot) {
      overlayRoot.replaceChildren();
      overlayRoot.classList.remove('visible');
      overlayRoot.classList.add('hidden');
    }
  }
}

// ── Toolbar button helpers ─────────────────────────────────────────────────

export function updateToolbarButton(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.toggle('active', !!state);
  el.title = state
    ? (mode === 'fullscreen' ? 'Exit fullscreen (ESC)' : 'Preview (click for fullscreen)')
    : 'Preview media files';
  // Also update the section toolbar (name + meta badge + buttons).
  if (state) {
    const sec = document.getElementById('preview-section');
    if (sec) sec.classList.remove('hidden');
    const nameEl = document.getElementById('preview-name');
    if (nameEl) { nameEl.textContent = state.name; nameEl.title = state.name; }
    const metaEl = document.getElementById('preview-meta');
    if (metaEl) {
      metaEl.textContent = state.mime ? `${state.mime} · ${formatBytes(state.size)}` : '';
    }
    // Enable the section toolbar buttons.
    const toolbar = document.getElementById('preview-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');
  }
}

// ── Toolbar control wiring (zoom / fit / fullscreen / close) ──────────────

/**
 * Bind the panel toolbar's zoom/fit/fullscreen/close buttons to the live
 * viewer. Safe to call repeatedly (idempotent per element via `data-bound`).
 */
export function wirePreviewToolbar(): void {
  const bind = (id: string, fn: (e: Event) => void) => {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('click', fn);
  };
  bind('btn-preview-zoom-in', () => getLiveHandle()?.zoomIn?.());
  bind('btn-preview-zoom-out', () => getLiveHandle()?.zoomOut?.());
  bind('btn-preview-fit', () => getLiveHandle()?.fit?.());
  bind('btn-preview-fullscreen', () => { void toggleFullscreen(); });
  bind('btn-preview-close', () => { void close(); });
}
