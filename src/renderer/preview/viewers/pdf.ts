/**
 * Viewer for PDFs — delegates rendering to Chromium's built-in PDF renderer
 * via a sandboxed iframe (zero dependencies; requires
 * webPreferences.plugins:true, set in index.ts).
 *
 * Page navigation / zoom / search work natively inside the embedded viewer
 * (Ctrl+arrow, Ctrl++/-, Ctrl+F). The host side adds a small zoom bar that
 * scales the iframe itself (transform), which is the surface the shared
 * toolbar / ± shortcuts drive.
 */

import type { PreviewState, ViewerHandle } from '../core.js';

export function mountPdfViewer(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
  container.className = 'preview-viewer preview-pdf-viewer';

  // Zoom bar (host-side iframe scale). Buttons drive the same state the
  // shared toolbar / ± shortcuts do via zoomIn / zoomOut / fit.
  const bar = document.createElement('div');
  bar.className = 'preview-pdf-bar';
  const btnOut = document.createElement('button');
  btnOut.type = 'button';
  btnOut.className = 'preview-pdf-zoom-btn';
  btnOut.textContent = '−';
  btnOut.setAttribute('aria-label', 'zoom out');
  const btnIn = document.createElement('button');
  btnIn.type = 'button';
  btnIn.className = 'preview-pdf-zoom-btn';
  btnIn.textContent = '+';
  btnIn.setAttribute('aria-label', 'zoom in');
  const label = document.createElement('span');
  label.className = 'preview-pdf-zoom-label';
  const btnFit = document.createElement('button');
  btnFit.type = 'button';
  btnFit.className = 'preview-pdf-zoom-btn';
  btnFit.textContent = '1:1';
  btnFit.setAttribute('aria-label', 'reset zoom');
  bar.append(btnOut, label, btnIn, btnFit);
  container.appendChild(bar);

  const wrap = document.createElement('div');
  wrap.className = 'preview-pdf-wrap';
  const iframe = document.createElement('iframe');
  iframe.src = state.url;
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.display = 'block';
  // No sandbox attributes — Chromium's built-in PDF viewer needs full
  // privileges to render annotations / form fields correctly.
  wrap.appendChild(iframe);
  container.appendChild(wrap);

  // Host-side zoom: scale the iframe wrapper (transform), page/search stay
  // native inside the embedded viewer.
  let scale = 1;
  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
  const apply = (): void => {
    iframe.style.transform = scale === 1 ? '' : `scale(${scale})`;
    iframe.style.transformOrigin = 'top center';
    label.textContent = `${Math.round(scale * 100)}%`;
  };
  apply();
  btnIn.addEventListener('click', () => { scale = Math.min(ZOOM_MAX, scale + ZOOM_STEP); apply(); });
  btnOut.addEventListener('click', () => { scale = Math.max(ZOOM_MIN, scale - ZOOM_STEP); apply(); });
  btnFit.addEventListener('click', () => { scale = 1; apply(); });

  // Toolbar control surface (shared by the panel toolbar / inline cards /
  // document tabs) drives the same host-side zoom state.
  container.zoomIn = () => { scale = Math.min(ZOOM_MAX, scale + ZOOM_STEP); apply(); };
  container.zoomOut = () => { scale = Math.max(ZOOM_MIN, scale - ZOOM_STEP); apply(); };
  container.fit = () => { scale = 1; apply(); };

  container.dataset.kind = 'pdf';
  container.dataset.name = state.name;

  return container;
}
