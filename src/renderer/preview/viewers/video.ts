/**
 * Viewer for video/audio files — uses <video controls> or <audio controls>.
 * Supports speed toggle and volume persistence via sessionStorage.
 */

import type { PreviewState, ViewerHandle } from '../core.js';

export function mountVideoViewer(state: PreviewState): ViewerHandle {
  const container = document.createElement('div') as unknown as ViewerHandle;
  container.className = 'preview-viewer preview-media-viewer';

  const isAudio = state.mime.startsWith('audio/') || state.kind === 'audio';

  if (isAudio) {
    const audio = document.createElement('audio');
    audio.src = state.url;
    audio.controls = true;
    audio.style.width = '100%';
    container.appendChild(audio);
    // Persist volume across sessions.
    const savedVol = parseFloat(sessionStorage.getItem('preview-audio-volume') ?? '');
    if (!isNaN(savedVol)) audio.volume = Math.min(1, Math.max(0, savedVol));
    audio.addEventListener('volumechange', () => {
      sessionStorage.setItem('preview-audio-volume', String(audio.volume));
    });
  } else {
    const video = document.createElement('video');
    video.src = state.url;
    video.controls = true;
    video.style.maxWidth = '100%';
    video.style.maxHeight = '70vh';
    video.style.display = 'block';
    video.style.margin = 'auto';
    container.appendChild(video);
    // Persist speed.
    const savedSpeed = parseFloat(sessionStorage.getItem('preview-video-speed') ?? '');
    if (savedSpeed > 0) video.playbackRate = savedSpeed;
    video.addEventListener('ratechange', () => {
      sessionStorage.setItem('preview-video-speed', String(video.playbackRate));
    });
  }

  container.dataset.kind = isAudio ? 'audio' : 'video';
  container.dataset.size = String(state.size);

  return container;
}
