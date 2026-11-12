/**
 * Viewer for local HTML files — renders in a strictly-sandboxed iframe.
 * Block cross-origin access, popups, modals, and top-navigation so a
 * malicious page cannot exfiltrate data or reach the host UI.
 */

import type { PreviewState } from '../open.js';

export function mountHtmlViewer(state: PreviewState): () => HTMLElement {
  const container = document.createElement('div');
  container.className = 'preview-viewer preview-html-viewer';

  const iframe = document.createElement('iframe');
  iframe.src = state.url;
  iframe.sandbox.add('allow-scripts');
  // Deliberately omitting: allow-same-origin, allow-top-navigation,
  // allow-popups, allow-modals, allow-forms — all blocked for safety.
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  container.appendChild(iframe);

  container.dataset.kind = 'html';
  container.dataset.name = state.name;

  return () => container;
}
