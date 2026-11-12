/**
 * Preview subsystem — renderer-side entry point + state machine.
 *
 * The panel owns a single live viewer instance so switching between files keeps
 * playback position / scroll / zoom state intact. It can render in two modes:
 *   - inline: mounted inside #preview-host (right sidebar accordion)
 *   - fullscreen: moved into #preview-overlay-root (fixed, covers #layout)
 *
 * All file I/O goes through `window.nexusDesktop.previewOpen/close`.
 */

import type { PreviewKind } from '../../shared/preview.js';
import { formatBytes } from '../../shared/preview.js';
import { mountImageViewer } from './viewers/image.js';
import { mountVideoViewer } from './viewers/video.js';
import { mountPdfViewer } from './viewers/pdf.js';
import { mountHtmlViewer } from './viewers/html.js';
import { mountTextViewer } from './viewers/text.js';
import { mountFallbackView } from './viewers/fallback.js';

export interface PreviewState {
  readonly token: string;
  readonly url: string;
  readonly kind: PreviewKind;
  readonly mime: string;
  readonly size: number;
  readonly name: string;
}

let state: PreviewState | null = null;
let mode: 'inline' | 'fullscreen' = 'inline';
let disposeFn: (() => HTMLElement) | null = null;

export function getState(): PreviewState | null { return state; }
export function isFullscreen(): boolean { return mode === 'fullscreen'; }

export async function openPath(path: string): Promise<void> {
  if (!path || typeof path !== 'string') return;
  // Await close so its renderMode() settles before we mount the new viewer.
  await close();
  const res = await window.nexusDesktop.previewOpen(path);
  if (!res.ok || !res.url) return;
  state = {
    token: res.token!,
    url: res.url,
    kind: (res.kind as PreviewKind) ?? 'unsupported',
    mime: res.mime ?? '',
    size: res.size ?? 0,
    name: res.name ?? path.split(/[\\/]/).pop() ?? path,
  };
  render();
  updateToolbarButton(document.getElementById('btn-preview') as HTMLElement | null);
}

export async function toggleFullscreen(): Promise<void> {
  mode = mode === 'fullscreen' ? 'inline' : 'fullscreen';
  renderMode();
}

export async function close(): Promise<void> {
  const fn = disposeFn;
  disposeFn = null;
  const t = state?.token;
  state = null;
  mode = 'inline';
  // Call the dispose function to tear down viewer listeners; it returns the
  // container node which we explicitly remove from the DOM here.
  const body = fn?.();
  if (body instanceof HTMLElement) {
    body.remove();
  }
  // Clear both hosts so no stale DOM survives between sessions.
  const inlineHost = document.getElementById('preview-host');
  const overlayRoot = document.getElementById('preview-overlay-root');
  if (inlineHost) inlineHost.replaceChildren();
  if (overlayRoot) {
    overlayRoot.replaceChildren();
    overlayRoot.classList.remove('visible');
    overlayRoot.classList.add('hidden');
  }
  if (t) void window.nexusDesktop.previewClose(t);
}

function render(): void {
  if (!state) return;
  disposeFn?.();
  switch (state.kind) {
    case 'image':   disposeFn = mountImageViewer(state); break;
    case 'video':   disposeFn = mountVideoViewer(state); break;
    case 'audio':   disposeFn = mountVideoViewer(state); break; // reuse <audio> fallback
    case 'pdf':     disposeFn = mountPdfViewer(state); break;
    case 'html':    disposeFn = mountHtmlViewer(state); break;
    case 'markdown':
    case 'text':    disposeFn = mountTextViewer(state); break;
    case 'docx':
    case 'pptx':
    case 'xlsx':    disposeFn = mountFallbackView(state); break;
    default:        disposeFn = mountFallbackView(state); break;
  }
  renderMode();
}

function renderMode(): void {
  const inlineHost = document.getElementById('preview-host');
  const overlayRoot = document.getElementById('preview-overlay-root');
  if (!inlineHost && !overlayRoot) return;
  if (!disposeFn) return;
  const body = disposeFn();
  if (!(body instanceof HTMLElement)) return;
  if (mode === 'fullscreen' && overlayRoot) {
    // Move the live DOM node into the overlay so playback/scroll state survives.
    overlayRoot.replaceChildren(body);
    // `hidden` class is the master gate; `visible` mirrors it for the CSS anim.
    overlayRoot.classList.remove('hidden');
    overlayRoot.classList.add('visible');
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
    // Enable the section toolbar buttons
    const toolbar = document.getElementById('preview-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');
  } else {
    const sec = document.getElementById('preview-section');
    // Section stays visible (accordion) but toolbar goes away when no preview.
  }
}
