/**
 * Viewer for Markdown / plain-text files. Reuses the desktop's existing
 * markdown rendering pipeline when available; falls back to a pre-wrap <pre>.
 */

import type { PreviewState } from '../open.js';

export function mountTextViewer(state: PreviewState): () => HTMLElement {
  const container = document.createElement('div');
  container.className = 'preview-viewer preview-text-viewer';

  // Fetch content through the IPC bridge (reliable in sandboxed renderers);
  // fall back to fetch() on the nexus-preview:// URL if IPC is unavailable.
  const load = async (): Promise<string | null> => {
    try {
      const res = await window.nexusDesktop.previewRead(state.token);
      if (res.ok && res.text != null) return res.text;
    } catch { /* fall through to fetch */ }
    try {
      const r = await fetch(state.url);
      return await r.text();
    } catch { return null; }
  };

  load()
    .then((text) => {
      if (text == null) {
        if (!container.isConnected) return;
        const err = document.createElement('div');
        err.className = 'preview-error';
        err.textContent = 'Unable to load text content';
        container.appendChild(err);
        return;
      }
      if (!container.isConnected) return;
      if (state.kind === 'markdown' && typeof (window as unknown as Record<string, unknown>)['renderBlocks'] === 'function') {
        // Hybrid: let the renderer's markdown pipeline handle it (includes image hydration etc.).
        const md = document.createElement('div');
        md.className = 'preview-markdown';
        const fn = (window as unknown) as Record<string, unknown>;
        if (typeof fn['renderBlocks'] === 'function') (fn as Record<string, Function>)['renderBlocks'](text, md);
        container.appendChild(md);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'preview-pre';
        pre.textContent = text.length > 2_000_000 ? text.slice(0, 2_000_000) + '\n… (truncated)' : text;
        container.appendChild(pre);
      }
    })
    .catch(() => {
      if (!container.isConnected) return;
      const err = document.createElement('div');
      err.className = 'preview-error';
      err.textContent = 'Unable to load text content';
      container.appendChild(err);
    });

  container.dataset.kind = state.kind;
  container.dataset.name = state.name;
  container.dataset.size = String(state.size);

  return () => container;
}
