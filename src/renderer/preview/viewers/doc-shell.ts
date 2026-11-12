/**
 * PR3 doc-canvas — shared layout shell for the document viewers (docx/xlsx/pptx).
 *
 * The shell builds the doc-canvas DOM (eyebrow / title / KPI grid / content
 * body) and the loading / error states, and loads the main-process-parsed
 * model over `nexus:previewDocument`. Each concrete viewer renders its own
 * content into `shell.body`.
 *
 * Layout tokens live in static/styles.css (`.doc-canvas` block); the canvas
 * follows the active theme (dark canvas on dark themes, paper white on
 * light themes). HTML / iframe viewers intentionally never use this shell.
 */

import type { PreviewState, ViewerHandle } from '../core.js';
import type { ParsedDocument } from '../../../shared/preview-docs.js';

export interface DocShell {
  container: ViewerHandle;
  /** `.doc-canvas` — the themed canvas element. */
  canvas: HTMLElement;
  /** `.doc-body` — concrete content goes here. */
  body: HTMLElement;
  /** `.doc-kpis` grid (hidden until populated via setKpis). */
  kpis: HTMLElement;
  setTitle(title: string): void;
  setKpis(pairs: Array<[label: string, value: string | number]>): void;
  showLoading(message?: string): void;
  showError(message: string): void;
}

/** Populate the KPI grid (auto-fit `minmax(140px, 1fr)` — see styles.css). */
function fillKpis(kpis: HTMLElement, pairs: Array<[label: string, value: string | number]>): void {
  kpis.replaceChildren();
  for (const [label, value] of pairs) {
    const cell = document.createElement('div');
    cell.className = 'doc-kpi';
    const l = document.createElement('div');
    l.className = 'doc-kpi-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'doc-kpi-value';
    v.textContent = String(value);
    cell.append(l, v);
    kpis.appendChild(cell);
  }
  kpis.style.display = '';
}

export function docShell(state: PreviewState, kind: 'docx' | 'xlsx' | 'pptx'): DocShell {
  const container = document.createElement('div') as unknown as ViewerHandle;
  container.className = `preview-viewer preview-doc-viewer preview-${kind}-viewer`;
  container.dataset.kind = kind;
  container.dataset.name = state.name;
  container.dataset.size = String(state.size);

  const canvas = document.createElement('div');
  canvas.className = 'doc-canvas';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'doc-eyebrow';
  eyebrow.textContent = `${kind.toUpperCase()} · document`;

  const title = document.createElement('div');
  title.className = 'doc-title';
  title.textContent = state.name;

  const kpis = document.createElement('div');
  kpis.className = 'doc-kpis';
  kpis.style.display = 'none';

  const body = document.createElement('div');
  body.className = 'doc-body';

  canvas.append(eyebrow, title, kpis, body);
  container.appendChild(canvas);

  const shell: DocShell = {
    container,
    canvas,
    body,
    kpis,
    setTitle: (t: string) => { title.textContent = t; },
    setKpis: (pairs) => { fillKpis(kpis, pairs); },
    showLoading: (message = 'Parsing document…') => {
      body.replaceChildren();
      const el = document.createElement('div');
      el.className = 'doc-loading';
      el.textContent = message;
      body.appendChild(el);
    },
    showError: (message: string) => {
      body.replaceChildren();
      const el = document.createElement('div');
      el.className = 'preview-error';
      el.textContent = message;
      body.appendChild(el);
    },
  };
  return shell;
}

/**
 * Load the main-process-parsed document model for a preview state.
 * Returns the normalized `ParsedDocument` (never re-parsed by the renderer)
 * or `null` + error — the caller renders the error state on the shell.
 */
export async function loadDocument(
  state: PreviewState,
): Promise<{ doc: ParsedDocument | null; error: string | null; source?: 'parse' | 'cache' | 'artifact' }> {
  try {
    const res = await window.nexusDesktop.previewDocument(state.path);
    if (res.ok && res.doc) return { doc: res.doc, error: null, source: res.source };
    return { doc: null, error: res.error ?? 'document preview unavailable' };
  } catch (err) {
    return { doc: null, error: err instanceof Error ? err.message : 'preview IPC unavailable' };
  }
}
