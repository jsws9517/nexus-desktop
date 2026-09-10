/**
 * Lightweight sheet renderer (no external grid library) — a capped, scrollable
 * HTML table over the artifact's { columns, rows }. Meets M0 preview needs;
 * virtualisation/AG-Grid is a deliberate non-goal.
 */

import { t } from '../i18n.js';

const MAX_DISPLAY_ROWS = 500;

export function csvFromSheet(artifact: { body: unknown }): string {
  const body = artifact.body as { columns?: unknown; rows?: unknown } | null;
  if (!body || !Array.isArray(body.columns)) return '';
  const cols = body.columns as string[];
  const rows = (Array.isArray(body.rows) ? body.rows : []) as unknown[][];
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

export function buildSheetTable(container: HTMLElement, artifact: { body: unknown }): void {
  const body = artifact.body as {
    columns?: unknown;
    rows?: unknown;
    rowCount?: unknown;
    colCount?: unknown;
    analysis?: unknown;
    truncated?: unknown;
    source?: unknown;
  } | null;
  const cols = (Array.isArray(body?.columns) ? body.columns : []) as string[];
  const rows = (Array.isArray(body?.rows) ? body.rows : []) as unknown[][];
  const totalRows = typeof body?.rowCount === 'number' ? body.rowCount : rows.length;
  if (cols.length === 0) {
    container.textContent = t('artifactEmptyData');
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'artifact-table-wrap';

  const table = document.createElement('table');
  table.className = 'artifact-table';
  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    headTr.appendChild(th);
  }
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const shown = rows.slice(0, MAX_DISPLAY_ROWS);
  for (const r of shown) {
    const tr = document.createElement('tr');
    for (let ci = 0; ci < cols.length; ci += 1) {
      const td = document.createElement('td');
      const v = ci < r.length ? r[ci] : null;
      td.textContent = v === null || v === undefined ? '—' : String(v);
      if (typeof v === 'number') td.className = 'num';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  const meta = document.createElement('div');
  meta.className = 'artifact-meta';
  const source = typeof body?.source === 'string' ? body.source : '';
  const truncated = body?.truncated === true || rows.length > MAX_DISPLAY_ROWS;
  const parts: string[] = [];
  if (typeof totalRows === 'number') parts.push(`${totalRows} × ${cols.length}`);
  if (source) parts.push(source);
  if (truncated) parts.push(t('artifactTruncated'));
  meta.textContent = parts.join(' · ');
  wrap.appendChild(meta);

  container.appendChild(wrap);
}