/**
 * Inline preview card — rendered directly into the chat stream, below the
 * message / tool card / chip that triggered it (per the reference screenshot).
 *
 * Anatomy:
 *   ┌ header: icon + filename + [📂 ⤓ ⤢ ✕] (on app bg, ~32px)
 *   ├ body: full-bleed, default 340px tall, internally scrolling, drag handle
 *   │   to grow up to 70vh. Images start collapsed to a 120px thumbnail and
 *   │   expand on click.
 *   └ action row: 复制 / 下载 / 收藏 / 引用 / 点赞 / 更多 · 「由 AI 生成」 · %
 *
 * The card mounts the SAME viewer kernel the side panel uses (core.mountViewer),
 * so zoom / playback state behaves identically in both places. The `preview`
 * label in the body top-right is the 预览/源码 toggle (text-like kinds only):
 * it swaps the viewer for a raw `<pre>` source view without reloading the file.
 */

import { classify, isPreviewable, type PreviewKind } from '../../shared/preview.js';
import { fetchPreview, mountViewer, type ViewerHandle, type MountedViewer, type PreviewState } from './core.js';
import { STR } from '../i18n.js';

export interface InlinePreviewCardOptions {
  /** Anchor the card after this element (the triggering message / card). */
  after?: HTMLElement | null;
  /** Scroll the anchor into view when set. */
  scrollIntoView?: boolean;
  /** Kind override (e.g. from an artifact body); defaults to classify(path). */
  kind?: PreviewKind;
  /** Marks the card's action row source as AI-generated (default true). */
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
const THUMB_HEIGHT = 120;
const DEFAULT_BODY_HEIGHT = 340;

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
  body.style.height = `${IMG_KINDS.has(kind) ? THUMB_HEIGHT : DEFAULT_BODY_HEIGHT}px`;

  const stage = document.createElement('div');
  stage.className = 'ipc-stage';
  body.appendChild(stage);

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

  // Image thumbnail expand / collapse.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn ghost icon tiny ipc-toggle';
  toggle.hidden = !IMG_KINDS.has(kind);
  let imgCollapsed = IMG_KINDS.has(kind);
  const setCollapsed = (collapsed: boolean) => {
    imgCollapsed = collapsed;
    body.style.height = collapsed ? `${THUMB_HEIGHT}px` : `${DEFAULT_BODY_HEIGHT}px`;
    stage.style.display = collapsed ? 'none' : '';
    toggle.textContent = collapsed ? '⤢' : '⌃';
    toggle.title = collapsed ? t('inlinePreviewPreview') : t('inlinePreviewClose');
  };
  toggle.addEventListener('click', () => setCollapsed(!imgCollapsed));
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
    const h = Math.min(maxH(), Math.max(THUMB_HEIGHT, startH + (startY - e.clientY)));
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
  aiNote.hidden = !(opts.aiGenerated ?? true);
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
    viewer?.dispose();
    viewer = null;
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
    if (IMG_KINDS.has(kind)) setCollapsed(imgCollapsed);
    else viewer.fit?.();
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
