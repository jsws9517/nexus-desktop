/**
 * Artifact mounting — the renderer-side half of the WorkBuddy contract.
 *
 * Parses a tool-result string; when it carries an Artifact envelope, builds the
 * preview card for the matching type (sheet table / vega chart / …). Returns
 * null for non-artifact content so callers fall back to the plain tool card.
 */

import { parseArtifactContent, type Artifact } from '../../shared/artifact.js';
import { t } from '../i18n.js';
import { buildSheetTable, csvFromSheet } from './table-view.js';
import { mountChart, type ChartMenu } from './chart-view.js';

const TYPE_ICON: Record<string, string> = {
  sheet: '📊',
  chart: '📈',
  ppt: '🎞️',
  docx: '📄',
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
  if (artifact.type === 'sheet' || artifact.type === 'csv' || artifact.type === 'dataframe') {
    buildSheetTable(container, artifact);
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
}