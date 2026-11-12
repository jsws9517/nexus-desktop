/**
 * Viewer for Markdown / plain-text files. Markdown goes through the desktop's
 * own rendering pipeline (`renderBlocks` — which returns an HTML string, plus
 * `hydrateImages` / `attachCodeCopy` for post-processing); plain text and
 * oversized files fall back to a pre-wrap <pre>.
 */

import { renderBlocks, hydrateImages, attachCodeCopy } from '../../markdown.js';
import type { PreviewState, ViewerHandle } from '../core.js';

export function mountTextViewer(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
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
      if (state.kind === 'markdown') {
        // Markdown: render through the pipeline. `renderBlocks` returns an
        // HTML string; hydration (local images) + code-copy wiring follow.
        const md = document.createElement('div');
        md.className = 'preview-markdown';
        md.innerHTML = renderBlocks(text);
        container.appendChild(md);
        hydrateImages(container);
        attachCodeCopy(container);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'preview-pre';
        pre.textContent = text.length > 2_000_000 ? text.slice(0, 2_000_000) + '\n… (truncated)' : text;
        container.appendChild(pre);
        // Plain-text zoom surface for the shared toolbar / ± shortcuts.
        let textScale = 1;
        const applyTextScale = () => { pre.style.fontSize = `${Math.round(13 * textScale)}px`; };
        container.zoomIn = () => { textScale = Math.min(3, textScale + 0.2); applyTextScale(); };
        container.zoomOut = () => { textScale = Math.max(0.5, textScale - 0.2); applyTextScale(); };
        container.fit = () => { textScale = 1; applyTextScale(); };
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

  return container;
}
