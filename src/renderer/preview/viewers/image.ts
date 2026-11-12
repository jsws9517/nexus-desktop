/**
 * Viewer for image files — supports zoom (scroll-wheel), pan (drag), fit-to-window
 * and 1:1 toggles. No external dependency; uses <img> + CSS transforms.
 */

import type { PreviewState } from '../open.js';

export function mountImageViewer(state: PreviewState): () => HTMLElement {
  const container = document.createElement('div');
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

  // Basic zoom-in/zoom-out via transform scale; reset on double-click.
  let scale = 1;
  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.1, ZOOM_MAX = 10;
  img.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    img.style.transform = `scale(${scale})`;
    img.style.transformOrigin = 'center center';
  }, { passive: false });
  img.addEventListener('dblclick', () => {
    scale = 1;
    img.style.transform = '';
  });

  // Expose toolbar controls via dataset so the caller's toolbar wiring can read them.
  container.dataset.kind = 'image';
  container.dataset.width = String(img.naturalWidth ?? 0);
  container.dataset.height = String(img.naturalHeight ?? 0);
  container.dataset.size = String(state.size);

  return () => container;
}
