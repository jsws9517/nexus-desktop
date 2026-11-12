/**
 * Viewer for PDFs — delegates to Chromium's built-in PDF renderer via sandboxed
 * iframe. Zero dependencies; requires webPreferences.plugins:true (set in index.ts).
 */

import type { PreviewState } from '../open.js';

export function mountPdfViewer(state: PreviewState): () => HTMLElement {
  const container = document.createElement('div');
  container.className = 'preview-viewer preview-pdf-viewer';

  const iframe = document.createElement('iframe');
  iframe.src = state.url;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  // No sandbox attributes — Chromium's built-in PDF viewer needs full privileges
  // to render annotations / form fields correctly.
  container.appendChild(iframe);

  container.dataset.kind = 'pdf';
  container.dataset.name = state.name;

  return () => container;
}
