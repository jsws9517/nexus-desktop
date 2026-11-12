/**
 * Viewer for PDFs — delegates to Chromium's built-in PDF renderer via sandboxed
 * iframe. Zero dependencies; requires webPreferences.plugins:true (set in index.ts).
 */

import type { PreviewState, ViewerHandle } from '../core.js';

export function mountPdfViewer(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
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

  // PDF zoom is handled by Chromium's built-in renderer (Ctrl +/- inside the
  // iframe); no host-side zoom surface needed.
  return container;
}
