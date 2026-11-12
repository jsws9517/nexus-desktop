/**
 * Viewer for Markdown / plain-text files. Markdown goes through the desktop's
 * own rendering pipeline (`renderBlocks` — which returns an HTML string, plus
 * `hydrateImages` / `attachCodeCopy` for post-processing); plain text gets a
 * mono, line-numbered view with an in-view search bar.
 */

import { renderBlocks, hydrateImages, attachCodeCopy } from '../../markdown.js';
import type { PreviewState, ViewerHandle } from '../core.js';
import { t } from '../../i18n.js';

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
        err.textContent = t('docLoadFailed');
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
        return;
      }

      // ── Plain text: mono, line-numbered gutter, in-view search. ───────
      const full = text.length > 2_000_000
        ? text.slice(0, 2_000_000) + '\n' + t('docTextTruncated')
        : text;
      const lines = full.split('\n');

      const search = document.createElement('div');
      search.className = 'preview-text-search';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'preview-text-search-input';
      input.dataset.i18nPlaceholder = 'docTextSearchPlaceholder';
      input.placeholder = t('docTextSearchPlaceholder');
      const count = document.createElement('span');
      count.className = 'preview-text-search-count';
      search.append(input, count);

      const gutter = document.createElement('pre');
      gutter.className = 'preview-text-gutter';
      const content = document.createElement('pre');
      content.className = 'preview-text-content';
      const body = document.createElement('div');
      body.className = 'preview-text-body';
      body.append(gutter, content);
      container.append(search, body);

      // Line numbers (shared line-height keeps the gutter aligned).
      gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n');

      // Content column: plain text without a query; with a query the matches
      // are wrapped in <mark> (rebuilds are debounced, large files capped).
      const renderContent = (query: string): void => {
        const q = query ? query.toLowerCase() : '';
        if (!q) {
          content.replaceChildren();
          content.textContent = lines.join('\n');
          count.textContent = '';
          return;
        }
        const frag = document.createDocumentFragment();
        let matchLines = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const span = document.createElement('span');
          span.className = 'preview-text-line';
          if (line.toLowerCase().includes(q)) {
            matchLines++;
            let rest = line;
            let guard = 0;
            while (guard++ < 200) {
              const at = rest.toLowerCase().indexOf(q);
              if (at === -1) break;
              if (at > 0) span.appendChild(document.createTextNode(rest.slice(0, at)));
              const mark = document.createElement('mark');
              mark.className = 'preview-text-match';
              mark.textContent = rest.slice(at, at + q.length);
              span.appendChild(mark);
              rest = rest.slice(at + q.length);
            }
            if (rest) span.appendChild(document.createTextNode(rest));
          } else {
            span.textContent = line;
          }
          frag.appendChild(span);
          if (i < lines.length - 1) frag.appendChild(document.createTextNode('\n'));
        }
        content.replaceChildren();
        content.appendChild(frag);
        count.textContent = t('docTextSearchCount', { n: matchLines });
      };

      // Text zoom surface for the shared toolbar / ± shortcuts (font scaling
      // on the whole body keeps gutter + content aligned; element-owned).
      let textScale = 1;
      const applyTextScale = (): void => {
        body.style.fontSize = `${Math.round(13 * textScale)}px`;
      };
      container.zoomIn = () => { textScale = Math.min(3, textScale + 0.2); applyTextScale(); };
      container.zoomOut = () => { textScale = Math.max(0.5, textScale - 0.2); applyTextScale(); };
      container.fit = () => { textScale = 1; applyTextScale(); };

      let debounce: ReturnType<typeof setTimeout> | undefined;
      input.addEventListener('input', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => renderContent(input.value.trim()), 150);
      });

      // Initial paint — without this the content column stays empty until
      // the user types a search query (the gutter alone gave the false
      // impression that "the file loaded").
      renderContent('');
    })
    .catch(() => {
      if (!container.isConnected) return;
      const err = document.createElement('div');
      err.className = 'preview-error';
      err.textContent = t('docLoadFailed');
      container.appendChild(err);
    });

  container.dataset.kind = state.kind;
  container.dataset.name = state.name;
  container.dataset.size = String(state.size);

  return container;
}
