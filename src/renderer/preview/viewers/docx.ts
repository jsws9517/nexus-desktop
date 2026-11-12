/**
 * PR3 viewer for .docx — renders the main-process-parsed block model on the
 * doc-canvas: headings (level 1..6), paragraphs and tables. Nested tables
 * arrive as a single raw-text cell (plan fallback). KPI row: paragraphs,
 * tables, approximate word count.
 */

import type { PreviewState, ViewerHandle } from '../core.js';
import type { DocxBlock } from '../../../shared/preview-docs.js';
import { docShell, loadDocument } from './doc-shell.js';

function renderBlock(block: DocxBlock, body: HTMLElement): void {
  if (block.type === 'table' && block.rows?.length) {
    const table = document.createElement('table');
    table.className = 'doc-table';
    block.rows.forEach((row, ri) => {
      const tr = document.createElement('tr');
      row.forEach((cell) => {
        const td = document.createElement(ri === 0 ? 'th' : 'td');
        td.textContent = cell;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    body.appendChild(table);
    return;
  }
  const text = block.text ?? '';
  if (!text) return;
  if (block.type === 'heading') {
    const h = document.createElement(`h${Math.min(6, Math.max(2, (block.level ?? 1) + 1))}`);
    h.className = 'doc-h';
    h.dataset.level = String(block.level ?? 1);
    h.textContent = text;
    body.appendChild(h);
    return;
  }
  const p = document.createElement('p');
  p.className = 'doc-p';
  p.textContent = text;
  body.appendChild(p);
}

export function mountDocxViewer(state: PreviewState): ViewerHandle {
  const shell = docShell(state, 'docx');
  shell.showLoading();

  void loadDocument(state).then(({ doc, error }) => {
    if (!doc || doc.kind !== 'docx') {
      shell.showError(error ?? 'Unsupported document');
      return;
    }
    shell.setTitle(doc.title || state.name);
    const paragraphs = doc.blocks.filter((b) => b.type === 'paragraph').length;
    const tables = doc.blocks.filter((b) => b.type === 'table').length;
    const words = doc.blocks.reduce((n, b) => n + ((b.text ? b.text.split(/\s+/).filter(Boolean).length : 0)
      + (b.rows?.reduce((m, r) => m + r.reduce((k, c) => k + c.split(/\s+/).filter(Boolean).length, 0), 0) ?? 0)), 0);
    shell.setKpis([['Paragraphs', paragraphs], ['Tables', tables], ['Words (approx)', words]]);
    shell.body.replaceChildren();
    for (const b of doc.blocks) renderBlock(b, shell.body);
  });

  return shell.container;
}
