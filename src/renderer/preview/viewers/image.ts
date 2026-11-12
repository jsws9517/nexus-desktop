/**
 * Viewer for image files — supports zoom (scroll-wheel / buttons / ±), pan
 * (drag), fit-to-window, 1:1 toggles and 90° rotation, with a checkerboard
 * backdrop so transparent areas (PNG/WebP/SVG) are visible. No external
 * dependency; uses <img> + CSS transforms. State lives on the element so it
 * survives host moves (inline ↔ fullscreen).
 */

import type { PreviewState, ViewerHandle } from '../core.js';

export function mountImageViewer(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
  container.className = 'preview-viewer preview-image-viewer';

  // Rotate / 1:1 bar above the stage.
  const bar = document.createElement('div');
  bar.className = 'preview-image-bar';
  const makeBtn = (text: string, label: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preview-image-btn';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    return b;
  };
  const btnRotL = makeBtn('⟲', 'rotate left');
  const btnRotR = makeBtn('⟳', 'rotate right');
  const btnReset = makeBtn('1:1', 'reset (zoom + rotation)');
  bar.append(btnRotL, btnRotR, btnReset);
  container.appendChild(bar);

  const stage = document.createElement('div');
  stage.className = 'preview-image-stage';

  const img = document.createElement('img');
  img.className = 'preview-img';
  img.src = state.url;
  img.alt = state.name;
  img.draggable = false;
  img.style.maxWidth = '100%';
  img.style.maxHeight = '100%';
  img.style.display = 'block';
  img.style.margin = 'auto';
  stage.appendChild(img);
  container.appendChild(stage);

  // Zoom + rotate. Wheel zooms, drag pans, dblclick resets to fit.
  let scale = 1;
  let rotation = 0;
  let panX = 0, panY = 0;
  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.1, ZOOM_MAX = 10;
  const apply = () => {
    img.style.transform =
      `translate(${panX}px, ${panY}px) ${scale === 1 && rotation === 0 ? '' : `scale(${scale}) rotate(${rotation}deg)`}`;
    img.style.transformOrigin = 'center center';
  };
  const fitToContainer = () => {
    const host = container.parentElement;
    if (!host || !img.naturalWidth) return;
    const availW = host.clientWidth - 16;
    const availH = host.clientHeight - 16;
    if (availW <= 0 || availH <= 0) { scale = 1; apply(); return; }
    scale = Math.min(availW / img.naturalWidth, availH / img.naturalHeight, 1);
    if (scale < ZOOM_MIN) scale = ZOOM_MIN;
    apply();
  };
  img.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    apply();
  }, { passive: false });
  img.addEventListener('dblclick', () => { scale = 1; rotation = 0; panX = 0; panY = 0; apply(); });

  // Pan: drag on the stage (only when zoomed in — at scale 1 the image is
  // fit-to-container and panning would just fight the layout).
  let dragging = false;
  let lastX = 0, lastY = 0;
  stage.addEventListener('mousedown', (e: MouseEvent) => {
    if (scale <= 1) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    stage.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    apply();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    stage.style.cursor = '';
  });

  btnRotL.addEventListener('click', () => { rotation = (rotation - 90 + 360) % 360; apply(); });
  btnRotR.addEventListener('click', () => { rotation = (rotation + 90) % 360; apply(); });
  btnReset.addEventListener('click', () => { rotation = 0; panX = 0; panY = 0; scale = 1; fitToContainer(); });
  img.addEventListener('load', () => { fitToContainer(); });

  // Expose controls via the ViewerHandle surface (shared by the panel
  // toolbar, inline cards and document tabs).
  container.zoomIn = () => { scale = Math.min(ZOOM_MAX, scale + ZOOM_STEP); apply(); };
  container.zoomOut = () => { scale = Math.max(ZOOM_MIN, scale - ZOOM_STEP); apply(); };
  container.fit = () => { panX = 0; panY = 0; fitToContainer(); };

  container.dataset.kind = 'image';
  container.dataset.width = String(img.naturalWidth ?? 0);
  container.dataset.height = String(img.naturalHeight ?? 0);
  container.dataset.size = String(state.size);

  return container;
}
