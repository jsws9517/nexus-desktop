/**
 * Viewer for image files — supports zoom (scroll-wheel), pan (drag), fit-to-window
 * and 1:1 toggles. No external dependency; uses <img> + CSS transforms.
 */

import type { PreviewState, ViewerHandle } from '../core.js';

export function mountImageViewer(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
  container.className = 'preview-viewer preview-image-viewer';

  const img = document.createElement('img');
  img.src = state.url;
  img.alt = state.name;
  img.draggable = false;
  img.style.maxWidth = '100%';
  img.style.maxHeight = '100%';
  img.style.display = 'block';
  img.style.margin = 'auto';
  container.appendChild(img);

  // Zoom (wheel / buttons / ± shortcuts) + fit-to-container. State lives on
  // the element itself so it survives host moves (inline ↔ fullscreen).
  let scale = 1;
  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.1, ZOOM_MAX = 10;
  const apply = () => {
    img.style.transform = scale === 1 ? '' : `scale(${scale})`;
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
  img.addEventListener('dblclick', () => { scale = 1; apply(); });
  img.addEventListener('load', () => { fitToContainer(); });

  // Expose toolbar controls via the ViewerHandle surface (shared by the panel
  // toolbar, inline cards and document tabs).
  container.zoomIn = () => { scale = Math.min(ZOOM_MAX, scale + ZOOM_STEP); apply(); };
  container.zoomOut = () => { scale = Math.max(ZOOM_MIN, scale - ZOOM_STEP); apply(); };
  container.fit = () => { fitToContainer(); };

  container.dataset.kind = 'image';
  container.dataset.width = String(img.naturalWidth ?? 0);
  container.dataset.height = String(img.naturalHeight ?? 0);
  container.dataset.size = String(state.size);

  return container;
}
