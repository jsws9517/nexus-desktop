/**
 * Preview kernel — the shared "fetch + mount" half of the preview subsystem.
 *
 * Two hosts mount the same viewer instances, which is why the kernel is
 * decoupled from any specific DOM anchor:
 *   - `#preview-host` (right-sidebar accordion, legacy, kept until the sidebar
 *     tab rework retires it)
 *   - inline preview cards in the chat stream (see ./inline.ts)
 *
 * All file I/O goes through the `nexusDesktop` IPC bridge:
 *   - `previewOpen(path)`  → token + `nexus-preview://` URL + kind/mime/size
 *   - `previewClose(token)`→ revokes the token in the main process
 *   - `previewRead(token)` → raw text for markdown/text source views
 *
 * `mountViewer` returns a "mount function": call it to get a freshly-created
 * root element for the given host. One mount function per live preview; the
 * host owns its own instance so document tabs / inline cards never share DOM.
 */

import type { PreviewKind } from '../../shared/preview.js';
import { mountImageViewer } from './viewers/image.js';
import { mountVideoViewer } from './viewers/video.js';
import { mountPdfViewer } from './viewers/pdf.js';
import { mountHtmlViewer } from './viewers/html.js';
import { mountTextViewer } from './viewers/text.js';
import { mountDocxViewer } from './viewers/docx.js';
import { mountXlsxViewer } from './viewers/xlsx.js';
import { mountPptxViewer } from './viewers/pptx.js';
import { mountFallbackView } from './viewers/fallback.js';

/**
 * Per-mount viewer control surface. The element IS the handle: the viewer's
 * root DOM node doubles as its control interface so toolbar / shortcut wiring
 * can drive it uniformly regardless of kind. Extends HTMLElement so all
 * standard DOM methods (appendChild, dataset, style, …) remain accessible.
 */
export interface ViewerHandle extends HTMLElement {
  /** Self-reference for symmetry with the callers that hold a handle; set by
   *  mountViewer. Read-only so the element is never re-aliased. */
  readonly root?: HTMLElement;
  zoomIn?: () => void;
  zoomOut?: () => void;
  fit?: () => void;
  fullscreen?: () => void;
}
export interface PreviewState {
  readonly token: string;
  readonly url: string;
  /** Original absolute path the preview was opened from (for external-open
   *  fallback / reveal-in-folder). The token/url alone can't resolve it. */
  readonly path: string;
  readonly kind: PreviewKind;
  readonly mime: string;
  readonly size: number;
  readonly name: string;
}

export interface FetchPreviewResult extends PreviewState {
  readonly error?: string;
}

/**
 * IPC-only preview fetch. No DOM involved — safe to call from anywhere in the
 * renderer. Returns `null` when the file cannot be previewed (unsupported
 * kind, outside allowed roots, too large, missing, …); the reason is on
 * `.error` when present.
 */
export async function fetchPreview(path: string): Promise<FetchPreviewResult | null> {
  if (!path || typeof path !== 'string') return null;
  let res: Awaited<ReturnType<typeof window.nexusDesktop.previewOpen>>;
  try {
    res = await window.nexusDesktop.previewOpen(path);
  } catch {
    return { token: '', url: '', path, kind: 'unsupported', mime: '', size: 0, name: path.split(/[\\/]/).pop() ?? path, error: 'preview IPC unavailable' };
  }
  if (!res.ok || !res.url) {
    return {
      token: '',
      url: '',
      path,
      kind: 'unsupported',
      mime: '',
      size: 0,
      name: path.split(/[\\/]/).pop() ?? path,
      error: res.error ?? 'preview unavailable',
    };
  }
  return {
    token: res.token!,
    url: res.url,
    path,
    kind: (res.kind as PreviewKind) ?? 'unsupported',
    mime: res.mime ?? '',
    size: res.size ?? 0,
    name: res.name ?? path.split(/[\\/]/).pop() ?? path,
  };
}

export type ViewerMount = () => HTMLElement;

/**
 * The concrete type returned by mountViewer: an HTMLElement that also carries
 * the ViewerHandle control surface + a dispose() lifecycle. Callers should use
 * this type rather than `ViewerHandle` directly when they need `dispose`.
 */
export type MountedViewer = ViewerHandle & { dispose(): void };

/**
 * Mount a viewer once, returning a persistent element + lifecycle. The element
 * is created exactly once: hosts (inline panel / fullscreen overlay / chat
 * cards / document tabs) move the SAME node between anchors with
 * `appendChild`, so zoom / scroll / playback state survives. Call `dispose()`
 * exactly once when the preview is closed (removes the node + revokes the
 * token).
 */
export function mountViewer(state: PreviewState): MountedViewer {
  let el: HTMLElement;
  switch (state.kind) {
    case 'image':    el = mountImageViewer(state); break;
    case 'video':    el = mountVideoViewer(state); break;
    case 'audio':    el = mountVideoViewer(state); break; // reuse <audio> fallback
    case 'pdf':      el = mountPdfViewer(state); break;
    case 'html':     el = mountHtmlViewer(state); break;
    case 'markdown':
    case 'text':     el = mountTextViewer(state); break;
    case 'docx':     el = mountDocxViewer(state); break;
    case 'xlsx':     el = mountXlsxViewer(state); break;
    case 'pptx':     el = mountPptxViewer(state); break;
    default:         el = mountFallbackView(state); break;
  }
  const handle = el as unknown as ViewerHandle;
  (handle as { root: HTMLElement }).root = el;
  const mounted = handle as MountedViewer;
  mounted.dispose = () => {
    el.remove();
    revokePreview(state.token);
  };
  return mounted;
}

/**
 * Read the raw source text for a previewed file (markdown/text source view,
 * "preview ↔ source" toggle). Returns `null` on failure.
 */
export async function readSource(state: PreviewState, maxBytes = 4 * 1024 * 1024): Promise<string | null> {
  try {
    const res = await window.nexusDesktop.previewRead(state.token, maxBytes);
    if (res.ok && res.text != null) return res.text;
  } catch { /* fall through */ }
  return null;
}

/** Revoke the token in the main process (no-op when empty). */
export function revokePreview(token: string): void {
  if (!token) return;
  void window.nexusDesktop.previewClose(token);
}
