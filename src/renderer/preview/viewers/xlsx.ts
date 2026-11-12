/**
 * PR3 viewer for .xlsx — renders the main-process-parsed workbook on the
 * doc-canvas: sheet tabs (32 cap), a table per active sheet with numbers
 * right-aligned, and a truncation note when caps clipped the data. KPI row:
 * sheets / rows / columns of the active sheet.
 */

import type { PreviewState, ViewerHandle } from '../core.js';
import type { XlsxDoc, XlsxSheet } from '../../../shared/preview-docs.js';
import { docShell, loadDocument } from './doc-shell.js';

function renderTable(sheet: XlsxSheet, host: HTMLElement): void {
  host.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'doc-table-wrap';

  const table = document.createElement('table');
  table.className = 'doc-table doc-xlsx-table';

  const [head, ...rest] = sheet.rows;
  if (head?.length) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of head) {
      const th = document.createElement('th');
      th.textContent = String(cell);
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }
  const tbody = document.createElement('tbody');
  for (const row of rest) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      if (typeof cell === 'number') td.classList.add('num'); // right-aligned via CSS
      td.textContent = String(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);

  if (sheet.truncated) {
    const note = document.createElement('div');
    note.className = 'doc-note';
    note.textContent = 'Truncated — showing the first portion of this sheet (preview caps).';
    host.appendChild(note);
  }
}

export function mountXlsxViewer(state: PreviewState): ViewerHandle {
  const shell = docShell(state, 'xlsx');
  shell.showLoading();

  void loadDocument(state).then(({ doc, error }) => {
    if (!doc || doc.kind !== 'xlsx') {
      shell.showError(error ?? 'Unsupported document');
      return;
    }
    const d = doc as XlsxDoc;
    shell.setTitle(d.name || state.name);
    if (!d.sheets.length) { shell.showError('No sheets found in workbook'); return; }

    // KPIs + current sheet (sheet KPIs update on tab switch).
    shell.setKpis([['Sheets', d.sheets.length]]);

    // Sheet tabs (hidden for single-sheet workbooks to keep the canvas calm).
    const tabs = document.createElement('div');
    tabs.className = 'doc-sheet-tabs';
    tabs.style.display = d.sheets.length > 1 ? '' : 'none';

    const tableHost = document.createElement('div');
    tableHost.className = 'doc-sheet-content';

    const showSheet = (sheet: XlsxSheet): void => {
      shell.setKpis([
        ['Sheet', sheet.name],
        ['Rows', sheet.rows.length],
        ['Columns', sheet.rows[0]?.length ?? 0],
      ]);
      renderTable(sheet, tableHost);
      for (const btn of tabs.children) {
        (btn as HTMLElement).classList.toggle('active', (btn as HTMLElement).dataset.name === sheet.name);
      }
    };

    d.sheets.forEach((sheet) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'doc-sheet-tab';
      btn.dataset.name = sheet.name;
      btn.textContent = sheet.name;
      btn.addEventListener('click', () => showSheet(sheet));
      tabs.appendChild(btn);
    });

    shell.body.append(tabs, tableHost);
    showSheet(d.sheets[0]);

    // Text zoom surface for the shared toolbar / ± shortcuts (font scaling
    // keeps the table layout readable; state lives on the element).
    let scale = 1;
    const apply = (): void => {
      tableHost.style.fontSize = `${Math.round(13 * scale)}px`;
    };
    shell.container.zoomIn = () => { scale = Math.min(2, scale + 0.15); apply(); };
    shell.container.zoomOut = () => { scale = Math.max(0.5, scale - 0.15); apply(); };
    shell.container.fit = () => { scale = 1; apply(); };
  });

  return shell.container;
}
