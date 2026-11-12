/**
 * Inline preview card — rendered directly into the chat stream, below the
 * message / tool card / chip that triggered it (per the reference screenshot).
 *
 * Anatomy:
 *   ┌ header: icon + filename + [📂 ⤓ ⤢ ✕] (on app bg, ~32px)
 *   ├ body: full-bleed, height hugs the media's natural aspect ratio (capped at
 *   │   60vh, floored so nothing reads as a sliver), internally scrolling,
 *   │   drag handle to grow it. Images start as a compact thumbnail and expand
 *   │   on click; video/audio/documents size to their kind.
 *   └ action row: 复制 / 下载 / 收藏 / 引用 / 点赞 / 更多 · 「由 AI 生成」 · %
 *
 * The card mounts the SAME viewer kernel the side panel uses (core.mountViewer),
 * so zoom / playback state behaves identically in both places. The `preview`
 * label in the body top-right is the 预览/源码 toggle (text-like kinds only):
 * it swaps the viewer for a raw `<pre>` source view without reloading the file.
 */

import { classify, isPreviewable, type PreviewKind } from '../../shared/preview.js';
import { fetchPreview, mountViewer, type ViewerHandle, type MountedViewer, type PreviewState } from './core.js';
import { registerPreviewPathsAsync } from './register.js';
import { STR } from '../i18n.js';

export interface InlinePreviewCardOptions {
  /** Anchor the card after this element (the triggering message / card). */
  after?: HTMLElement | null;
  /** Scroll the anchor into view when set. */
  scrollIntoView?: boolean;
  /** Kind override (e.g. from an artifact body); defaults to classify(path). */
  kind?: PreviewKind;
  /** Show the "AI-generated" note in the action row. Default off: media tools
   *  watermark their output natively, so the card doesn't repeat it. */
  aiGenerated?: boolean;
  /** 0-100 progress hint shown on the action row while streaming. */
  progress?: number;
}

export interface InlinePreviewCard {
  readonly root: HTMLElement;
  readonly path: string;
  /** Toggle the 预览/源码 view (text-like kinds; no-op otherwise). */
  toggleSource(): void;
  /** Remove the card and revoke its preview token. */
  dispose(): void;
}

function tr(lang: string) {
  return (key: string, vars?: Record<string, unknown>): string => {
    let s = STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  };
}

const IMG_KINDS = new Set<PreviewKind>(['image']);
const SOURCE_KINDS = new Set<PreviewKind>(['markdown', 'text', 'html']);
/** Floor for the drag-to-resize handle and for compact image thumbnails. */
const MIN_BODY_HEIGHT = 120;

export function createInlinePreviewCard(
  path: string,
  lang: string,
  opts: InlinePreviewCardOptions = {},
): InlinePreviewCard {
  const t = tr(lang);
  const kind = opts.kind ?? classify(path);
  const previewable = isPreviewable(kind);

  const root = document.createElement('div');
  root.className = 'inline-preview-card';
  root.dataset.path = path;
  root.dataset.kind = kind;

  // ── header ────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'ipc-header';
  const title = document.createElement('span');
  title.className = 'ipc-title';
  title.textContent = basenameOf(path);
  title.title = path;
  const headerActions = document.createElement('span');
  headerActions.className = 'ipc-header-actions';

  let card: InlinePreviewCard;

  const mkBtn = (cls: string, glyph: string, label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ghost icon tiny ${cls}`;
    b.textContent = glyph;
    b.title = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };

  const btnReveal = mkBtn('ipc-act-reveal', '📂', t('inlinePreviewReveal'), () => {
    void window.nexusDesktop.revealFile(path).catch(() => {});
  });
  const btnDownload = mkBtn('ipc-act-download', '⤓', t('inlinePreviewDownload'), () => {
    void downloadFile(path);
  });
  const btnSidebar = mkBtn('ipc-act-sidebar', '⤢', t('inlinePreviewOpenSidebar'), () => {
    // PR2: pushes the path into the sidebar document tab strip. PR1 degrades
    // gracefully — the event simply has no listener yet.
    window.dispatchEvent(new CustomEvent('nexus:open-preview-sidebar', { detail: { path } }));
  });
  const btnClose = mkBtn('ipc-act-close', '✕', t('inlinePreviewClose'), () => card.dispose());
  headerActions.append(btnReveal, btnDownload, btnSidebar, btnClose);

  // ── body ────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'ipc-body';

  const stage = document.createElement('div');
  stage.className = 'ipc-stage';
  body.appendChild(stage);

  // The body hugs the media's natural proportions instead of a fixed box, so a
  // wide image isn't squeezed into a sliver and a tall one isn't stretched into
  // a wall. `mediaAspect` is filled in from the <img> natural size / <video>
  // metadata once the element is ready; until then a sensible default (3:2 image
  // / 16:9 video) keeps the first paint reasonable.
  let mediaAspect = 0;
  const widthNow = () => root.clientWidth || 640;
  const cap = () => {
    const ih = typeof window !== 'undefined' ? window.innerHeight : 0;
    return ih > 0 ? Math.round(ih * 0.6) : 720;
  };
  const applyHeight = (compact: boolean): void => {
    let h: number;
    const w = widthNow();
    if (kind === 'image') {
      const a = mediaAspect || 3 / 2;
      // Compact thumbnail: a quiet strip (never under the floor). Full view:
      // aspect-driven up to the 60vh cap so detail is actually visible.
      h = compact ? Math.min(220, Math.max(MIN_BODY_HEIGHT, w / a)) : Math.min(cap(), Math.max(220, w / a));
    } else if (kind === 'video') {
      const a = mediaAspect || 16 / 9;
      h = Math.min(cap(), Math.max(200, w / a));
    } else if (kind === 'audio') {
      h = 92; // a bare <audio> player — keep it to a slim strip
    } else {
      h = 360; // docs / text / html / pdf / office: a roomy scroll box
    }
    body.style.height = `${Math.round(h)}px`;
  };
  applyHeight(IMG_KINDS.has(kind)); // images open compact; everything else full

  const badge = document.createElement('span');
  badge.className = 'ipc-mode-badge';
  badge.textContent = kind === 'html' ? 'preview' : t('inlinePreviewPreview');
  badge.title = t('inlinePreviewPreview');
  badge.hidden = !SOURCE_KINDS.has(kind);
  badge.addEventListener('click', () => card.toggleSource());
  body.appendChild(badge);

  const status = document.createElement('div');
  status.className = 'ipc-status';
  status.textContent = t('inlinePreviewLoading');
  body.appendChild(status);

  // Image thumbnail expand / collapse. The stage STAYS visible in the collapsed
  // (compact) state — hiding it zeroed the fit calculation and left an empty
  // box instead of a real thumbnail. Collapsing just shrinks the body to its
  // compact height and hides the zoom/rotate bar (styles.css
  // .ipc-body[data-collapsed='1'] rules).
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn ghost icon tiny ipc-toggle';
  toggle.hidden = !IMG_KINDS.has(kind);
  const refit = () => {
    if (viewer) requestAnimationFrame(() => viewer?.fit?.());
  };
  let imgCollapsed = IMG_KINDS.has(kind);
  const setCollapsed = (collapsed: boolean) => {
    imgCollapsed = collapsed;
    body.dataset.collapsed = collapsed ? '1' : '';
    applyHeight(collapsed);
    toggle.textContent = collapsed ? '⤢' : '⌃';
    toggle.title = collapsed ? t('inlinePreviewPreview') : t('inlinePreviewClose');
  };
  toggle.addEventListener('click', () => {
    setCollapsed(!imgCollapsed);
    refit();
  });
  // Click the thumbnail itself to expand. The toggle button collapses again.
  stage.addEventListener('click', (e) => {
    if (!IMG_KINDS.has(kind) || !imgCollapsed) return;
    if ((e.target as HTMLElement).closest('.preview-image-btn')) return;
    setCollapsed(false);
    refit();
  });
  if (IMG_KINDS.has(kind)) {
    body.appendChild(toggle);
    setCollapsed(imgCollapsed);
  }

  // Drag handle: grow the body up to 70vh.
  const handle = document.createElement('div');
  handle.className = 'ipc-drag';
  let dragging = false, startY = 0, startH = 0;
  const maxH = () => Math.round(window.innerHeight * 0.7);
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = body.offsetHeight;
    try { handle.setPointerCapture(e.pointerId); } catch { /* no capture */ }
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = Math.min(maxH(), Math.max(MIN_BODY_HEIGHT, startH + (startY - e.clientY)));
    body.style.height = `${h}px`;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  body.appendChild(handle);

  // Keep a media preview filling the (resizable) chat column: recompute the
  // aspect-driven height when the card width changes. Height is a pure function
  // of width, so the observer converges in a single pass.
  let ro: ResizeObserver | null = null;
  if ((kind === 'image' || kind === 'video') && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      applyHeight(IMG_KINDS.has(kind) ? imgCollapsed : false);
      viewer?.fit?.();
    });
    ro.observe(root);
  }

  // ── action row ───────────────────────────────────────────────────────
  const row = document.createElement('div');
  row.className = 'ipc-actions';
  const addRowBtn = (glyph: string, label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost tiny ipc-row-btn';
    b.textContent = glyph;
    b.title = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    row.appendChild(b);
  };
  addRowBtn('⧉', t('inlinePreviewCopy'), () => {
    void navigator.clipboard?.writeText(path).catch(() => {});
  });
  addRowBtn('⤓', t('inlinePreviewDownload'), () => { void downloadFile(path); });
  addRowBtn('⭐', t('inlinePreviewFavorite'), () => {});
  addRowBtn('❝', t('inlinePreviewQuote'), () => {
    window.dispatchEvent(new CustomEvent('nexus:quote-file', { detail: { path } }));
  });
  addRowBtn('👍', t('inlinePreviewLike'), () => {});
  addRowBtn('⋯', t('inlinePreviewMore'), () => {});
  const aiNote = document.createElement('span');
  aiNote.className = 'ipc-ai-note';
  aiNote.textContent = t('inlinePreviewAiGenerated');
  aiNote.hidden = !opts.aiGenerated; // default off — the model watermarks natively
  row.appendChild(aiNote);
  const prog = document.createElement('span');
  prog.className = 'ipc-progress';
  prog.textContent = opts.progress != null ? `${opts.progress}%` : '';
  prog.hidden = opts.progress == null;
  row.appendChild(prog);

  header.append(title, headerActions);
  root.append(header, body, row);
  if (opts.after) opts.after.after(root);
  if (opts.scrollIntoView && opts.after) opts.after.scrollIntoView({ block: 'nearest' });

  // ── viewer lifecycle ─────────────────────────────────────────────────
  let viewer: MountedViewer | null = null;
  let lastState: PreviewState | null = null;
  let sourceEl: HTMLPreElement | null = null;
  let showSource = false;
  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    ro?.disconnect();
    ro = null;
    viewer?.dispose();
    viewer = null;
    // Let wrappers (dedupe maps, re-render cleanup sweeps) drop their
    // bookkeeping before the node leaves the DOM.
    root.dispatchEvent(new CustomEvent('ipc:disposed'));
    root.remove();
  }

  function toggleSource(): void {
    if (!SOURCE_KINDS.has(kind) || !viewer || !lastState) return;
    showSource = !showSource;
    if (showSource) {
      // Read raw source via a fresh previewRead call (no reload needed).
      void window.nexusDesktop.previewRead(lastState.token, 4 * 1024 * 1024)
        .then((res) => {
          if (disposed || !viewer) return;
          const text = res.ok ? res.text ?? '' : '(unavailable)';
          sourceEl = document.createElement('pre');
          sourceEl.className = 'ipc-source preview-pre';
          sourceEl.textContent = text;
          // Hide the live viewer element but keep its state; re-insert on toggle back.
          viewer.style.display = 'none';
          stage.appendChild(sourceEl);
        })
        .catch(() => {});
    } else if (sourceEl) {
      sourceEl.remove();
      sourceEl = null;
      viewer.style.display = '';
      viewer.fit?.();
    }
  }

  const cardImpl: InlinePreviewCard = { root, path, dispose, toggleSource };
  card = cardImpl;

  async function mount(): Promise<void> {
    if (disposed) return;
    if (!previewable) {
      status.textContent = t('inlinePreviewUnavailable');
      status.classList.add('error');
      return;
    }
    // Await the root registration BEFORE the token request: the main process
    // may still be realpath-ing the user-reached directory, and a first click
    // right after launch otherwise races the async previewAllowPaths handler
    // and fails the containment check ("path outside allowed roots").
    await registerPreviewPathsAsync([path]);
    if (disposed) return;
    const res = await fetchPreview(path);
    if (disposed) return;
    if (!res || !res.token) {
      status.textContent = `${t('inlinePreviewUnavailable')}${res?.error ? ` · ${res.error}` : ''}`;
      status.classList.add('error');
      return;
    }
    lastState = res;
    status.remove();
    viewer = mountViewer(res);
    stage.appendChild(viewer); // viewer IS the element (ViewerHandle extends HTMLElement)
    if (IMG_KINDS.has(kind)) {
      // Re-drive the adaptive body height off the real image proportions once
      // they're known, then fit the viewer into the freshly-sized stage.
      const img = viewer.querySelector<HTMLImageElement>('img');
      if (img) {
        const onImgSize = (): void => {
          mediaAspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : mediaAspect;
          setCollapsed(imgCollapsed);
          refit();
        };
        if (img.complete && img.naturalWidth) onImgSize();
        else img.addEventListener('load', onImgSize);
      } else {
        setCollapsed(imgCollapsed);
      }
    } else if (kind === 'video') {
      const vid = viewer.querySelector<HTMLVideoElement>('video');
      if (vid) {
        const onMeta = (): void => {
          mediaAspect = vid.videoWidth && vid.videoHeight ? vid.videoWidth / vid.videoHeight : mediaAspect;
          applyHeight(false);
          refit();
        };
        if (vid.videoWidth) onMeta();
        else vid.addEventListener('loadedmetadata', onMeta);
      }
      viewer.fit?.();
    } else {
      viewer.fit?.();
    }
  }

  void mount();
  return card;
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

async function downloadFile(path: string): Promise<void> {
  // Copy-out via the existing saveArtifact IPC (user-picked destination).
  try {
    await window.nexusDesktop.saveArtifact(basenameOf(path), '', 'text');
  } catch { /* dialog cancelled or IPC missing */ }
}
