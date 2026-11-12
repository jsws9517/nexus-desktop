/**
 * Fallback view for unsupported / unhandled preview kinds. Shows metadata
 * plus a "Open externally" button wired to the existing revealFile IPC.
 */

import type { PreviewState, ViewerHandle } from '../core.js';
import { formatBytes } from '../../../shared/preview.js';

export function mountFallbackView(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
  container.className = 'preview-viewer preview-fallback';

  const header = document.createElement('div');
  header.className = 'preview-header';
  header.textContent = state.name || state.kind;

  const meta = document.createElement('div');
  meta.className = 'preview-meta';
  meta.textContent = [
    state.kind !== 'unsupported' ? `kind: ${state.kind}` : '',
    state.mime ? `mime: ${state.mime}` : '',
    state.size > 0 ? `size: ${formatBytes(state.size)}` : '',
  ].filter(Boolean).join(' · ');

  const msg = document.createElement('div');
  msg.className = 'preview-fallback-msg';
  msg.textContent =
    state.kind === 'unsupported'
      ? 'This file type cannot be previewed inline. Open with the default application instead.'
      : 'Inline preview is not implemented for this type yet.';

  const btn = document.createElement('button');
  btn.className = 'btn primary small';
  btn.type = 'button';
  btn.textContent = 'Open externally';
  // `state.path` is the real absolute path (not the nexus-preview:// URL) so
  // the OS default app gets a usable target.
  btn.addEventListener('click', () => {
    void window.nexusDesktop.openExternalFile(state.path).then((res) => {
      if (res && res.ok === false) {
        msg.textContent = `External open failed: ${res.error ?? 'unknown error'}`;
      }
    }).catch(() => {});
  });

  container.appendChild(header);
  container.appendChild(meta);
  container.appendChild(msg);
  container.appendChild(btn);

  container.dataset.kind = 'fallback';

  return container;
}
