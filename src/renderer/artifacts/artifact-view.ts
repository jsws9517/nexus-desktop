/**
 * Artifact mounting — the renderer-side half of the WorkBuddy contract.
 *
 * Parses a tool-result string; when it carries an Artifact envelope, builds the
 * preview card for the matching type (sheet table / vega chart / …). Returns
 * null for non-artifact content so callers fall back to the plain tool card.
 */

import { parseArtifactContent, type Artifact } from '../../shared/artifact.js';
import { t } from '../i18n.js';
import { renderBlocks } from '../markdown.js';
import { buildSheetTable, csvFromSheet } from './table-view.js';
import { mountChart, type ChartMenu } from './chart-view.js';
import { mountDocxView } from './docx-view.js';
import { mountPptxView } from './pptx-view.js';
import { mountPdfView } from './pdf-view.js';

const TYPE_ICON: Record<string, string> = {
  sheet: '📊',
  chart: '📈',
  ppt: '🎞️',
  docx: '📄',
  pdf: '📄',
  markdown: '📝',
  html: '🌐',
  image: '🖼️',
  csv: '📋',
  dataframe: '🗃️',
};

function makeButton(text: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'btn ghost small artifact-action';
  btn.type = 'button';
  btn.textContent = text;
  return btn;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/**
 * T2-4: extract the text payload of a markdown / html artifact. Body may be a
 * bare string or an object with one of the conventional text keys. Keeping this
 * pure makes the dispatch testable without a DOM.
 */
export function textArtifactPayload(
  artifact: Artifact,
  type: 'markdown' | 'html',
): { text: string; ext: string } {
  const keys = type === 'markdown'
    ? ['content', 'markdown', 'text', 'body']
    : ['html', 'content', 'text', 'body'];
  const rec = asRecord(artifact.body);
  let text = typeof artifact.body === 'string' ? artifact.body : '';
  if (rec) {
    for (const k of keys) {
      if (typeof rec[k] === 'string') { text = rec[k] as string; break; }
    }
  }
  return { text, ext: type === 'markdown' ? 'md' : 'html' };
}

/** T2-4: normalize an image artifact's body into a displayable data URL and
 *  exportable base64. Accepts a data URL, a bare base64 string, or an object
 *  with `data`/`base64`/`content` plus an optional `mime`/`ext`. */
export function imageArtifactPayload(artifact: Artifact): {
  dataUrl: string; base64: string; mime: string; ext: string;
} | null {
  const rec = asRecord(artifact.body);
  let raw = typeof artifact.body === 'string' ? artifact.body : '';
  let mime = typeof rec?.mime === 'string' ? rec.mime : '';
  let ext = typeof rec?.ext === 'string' ? rec.ext : '';
  if (rec) {
    for (const k of ['data', 'base64', 'content']) {
      if (typeof rec[k] === 'string') { raw = rec[k] as string; break; }
    }
  }
  if (!raw) return null;
  if (raw.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(raw);
    if (!match) return null;
    mime = match[1];
    raw = match[2];
  }
  if (!mime) mime = 'image/png';
  if (!ext) ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
  // Reject obviously non-base64 data so a bogus body never produces a broken <img>.
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;
  return { dataUrl: `data:${mime};base64,${raw}`, base64: raw, mime, ext };
}

/** Markdown inline view (AC-4): reuse the chat markdown renderer. */
export function mountMarkdownView(container: HTMLElement, artifact: Artifact): void {
  const { text } = textArtifactPayload(artifact, 'markdown');
  const el = document.createElement('div');
  el.className = 'artifact-markdown';
  el.innerHTML = renderBlocks(text);
  container.appendChild(el);
}

/** HTML inline view (AC-5): a fully sandboxed iframe. No `allow-scripts` and
 *  no `allow-same-origin`, so artifact HTML cannot reach main-process privileges
 *  or the parent DOM — it renders as inert markup only. */
export function mountHtmlView(container: HTMLElement, artifact: Artifact): void {
  const { text } = textArtifactPayload(artifact, 'html');
  const frame = document.createElement('iframe');
  frame.className = 'artifact-html-frame';
  frame.setAttribute('sandbox', '');
  frame.setAttribute('title', artifact.title || 'artifact preview');
  frame.srcdoc = text;
  container.appendChild(frame);
}

/** Image inline view (AC-6): thumbnail from the normalized data URL. */
export function mountImageView(container: HTMLElement, artifact: Artifact): void {
  const payload = imageArtifactPayload(artifact);
  if (!payload) {
    const err = document.createElement('div');
    err.className = 'artifact-error-text';
    err.textContent = t('artifactImageUnavailable');
    container.appendChild(err);
    return;
  }
  const img = document.createElement('img');
  img.className = 'artifact-image';
  img.src = payload.dataUrl;
  img.alt = artifact.title || 'image';
  container.appendChild(img);
}

/** Mount a preview card for artifact-bearing tool content. Null = not an artifact. */
export function tryMountArtifact(content: string): HTMLElement | null {
  const artifact = parseArtifactContent(content);
  if (!artifact) return null;
  return buildCard(artifact);
}

function buildCard(artifact: Artifact): HTMLElement {
  const card = document.createElement('div');
  card.className = `artifact-card status-${artifact.status}`;

  // header
  const head = document.createElement('div');
  head.className = 'artifact-head';
  const type = document.createElement('span');
  type.className = 'artifact-type';
  type.textContent = TYPE_ICON[artifact.type] ?? '🧩';
  const title = document.createElement('span');
  title.className = 'artifact-title';
  title.textContent = artifact.title;
  title.title = artifact.id;
  const chip = document.createElement('span');
  chip.className = `artifact-chip ${artifact.status}`;
  chip.textContent = artifact.meta.skill;
  head.appendChild(type);
  head.appendChild(title);
  head.appendChild(chip);
  card.appendChild(head);

  // body
  const body = document.createElement('div');
  body.className = 'artifact-body';
  let chartMenu: ChartMenu | null = null;
  if (artifact.status === 'error') {
    const err = document.createElement('div');
    err.className = 'artifact-error-text';
    err.textContent = artifact.error ?? t('artifactError');
    body.appendChild(err);
  } else {
    chartMenu = mountBody(body, artifact);
  }
  card.appendChild(body);

  // actions
  const actions = document.createElement('div');
  actions.className = 'artifact-actions';
  mountActions(actions, artifact, chartMenu);
  if (actions.childElementCount > 0) card.appendChild(actions);

  return card;
}

function mountBody(container: HTMLElement, artifact: Artifact): ChartMenu | null {
  if (artifact.type === 'chart') {
    return mountChart(container, artifact.body);
  }
  if (artifact.type === 'markdown') {
    mountMarkdownView(container, artifact);
  } else if (artifact.type === 'html') {
    mountHtmlView(container, artifact);
  } else if (artifact.type === 'image') {
    mountImageView(container, artifact);
  } else if (artifact.type === 'sheet' || artifact.type === 'csv' || artifact.type === 'dataframe') {
    buildSheetTable(container, artifact);
  } else if (artifact.type === 'docx') {
    mountDocxView(container, artifact.body as Record<string, unknown>);
  } else if (artifact.type === 'ppt') {
    mountPptxView(container, artifact.body as Record<string, unknown>);
  } else if (artifact.type === 'pdf') {
    mountPdfView(container, artifact.body as Record<string, unknown>);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'artifact-json';
    pre.textContent = JSON.stringify(artifact.body, null, 2);
    container.appendChild(pre);
  }
  return null;
}

function mountActions(container: HTMLElement, artifact: Artifact, chartMenu: ChartMenu | null): void {
  if (artifact.status === 'error') return;
  if (artifact.type === 'sheet' || artifact.type === 'csv' || artifact.type === 'dataframe') {
    const csvBtn = makeButton(t('artifactExportCsv'));
    csvBtn.addEventListener('click', () => {
      const csv = csvFromSheet(artifact);
      if (!csv) return;
      void window.nexusDesktop.saveArtifact(`${artifact.title || 'sheet'}.csv`, csv, 'text').then((r) => {
        if (r.ok && r.path) void window.nexusDesktop.revealFile(r.path);
      });
    });
    container.appendChild(csvBtn);
  }
  if (artifact.type === 'chart' && chartMenu) {
    const pngBtn = makeButton(t('artifactExportPng'));
    pngBtn.addEventListener('click', () => {
      void chartMenu.exportPng(artifact.title);
    });
    container.appendChild(pngBtn);
  }
  // T2-4: markdown → .md (text), html → .html (text), image → original bytes.
  if (artifact.type === 'markdown' || artifact.type === 'html') {
    const { text, ext } = textArtifactPayload(artifact, artifact.type);
    if (text) {
      const btn = makeButton(t('artifactExport'));
      btn.addEventListener('click', () => {
        void window.nexusDesktop.saveArtifact(`${artifact.title || 'artifact'}.${ext}`, text, 'text')
          .then((r) => { if (r.ok && r.path) void window.nexusDesktop.revealFile(r.path); });
      });
      container.appendChild(btn);
    }
  }
  if (artifact.type === 'image') {
    const payload = imageArtifactPayload(artifact);
    if (payload) {
      const btn = makeButton(t('artifactExport'));
      btn.addEventListener('click', () => {
        void window.nexusDesktop.saveArtifact(
          `${artifact.title || 'image'}.${payload.ext}`, payload.base64, 'base64',
        ).then((r) => { if (r.ok && r.path) void window.nexusDesktop.revealFile(r.path); });
      });
      container.appendChild(btn);
    }
  }
}