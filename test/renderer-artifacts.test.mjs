/**
 * Renderer artifact tests (Tier 3 of work-mode testing) — exercises the
 * renderer half of the WorkBuddy contract headless under happy-dom: parsing
 * the tool-result envelope, building the inline preview cards (sheet table /
 * vega chart fallback), and the export actions. No Electron, no real vega.
 *
 * Part of `npm run test:unit` (needs dist built first).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;

/** Calls into the preload surface the artifact actions rely on. */
const preloadCalls = { save: [], reveal: [] };
win.nexusDesktop = {
  saveArtifact: (defaultName, data, encoding) => {
    preloadCalls.save.push({ defaultName, data, encoding });
    return Promise.resolve({ ok: true, path: `C:\\out\\${defaultName}` });
  },
  revealFile: () => {
    preloadCalls.reveal.push(1);
    return Promise.resolve();
  },
};

const { tryMountArtifact } = await import(pathToFileURL(join(dist, 'renderer', 'artifacts', 'artifact-view.js')));
const { csvFromSheet } = await import(pathToFileURL(join(dist, 'renderer', 'artifacts', 'table-view.js')));
const { toArtifactContent } = await import(pathToFileURL(join(dist, 'shared', 'artifact.js')));
const { t } = await import(pathToFileURL(join(dist, 'renderer', 'i18n.js')));

const tick = () => new Promise((r) => setTimeout(r, 0));

after(() => win.close());

const baseArtifact = (overrides = {}) => ({
  id: 'a-1',
  type: 'sheet',
  title: 'Sales',
  version: 1,
  status: 'done',
  meta: { sessionId: 's1', skill: 'sheet.read', origin: 'main' },
  body: null,
  ...overrides,
});

test('tryMountArtifact returns null for non-artifact content', () => {
  assert.equal(tryMountArtifact('plain text'), null);
  assert.equal(tryMountArtifact('{"some":"json"}'), null);
  assert.equal(tryMountArtifact(JSON.stringify({ __artifactVersion: 99, artifact: baseArtifact() })), null);
  assert.equal(tryMountArtifact(JSON.stringify({ __artifactVersion: 1, artifact: { ...baseArtifact(), type: 'nope' } })), null);
});

test('csvFromSheet serializes with quoting/escaping', () => {
  const artifact = baseArtifact({
    body: {
      columns: ['name', 'note'],
      rows: [['alice', 'say "hi"'], ['bob', 'a, b']],
    },
  });
  assert.equal(
    csvFromSheet(artifact),
    'name,note\n'
    + 'alice,"say ""hi"""\n'
    + 'bob,"a, b"',
  );
  assert.equal(csvFromSheet({ body: null }), '');
});

test('sheet artifact mounts a table card and exports CSV', async () => {
  const artifact = baseArtifact({
    body: {
      columns: ['month', 'amount', 'region'],
      rows: [
        ['Jan', 120, 'North'],
        ['Feb', 260, 'North'],
      ],
      rowCount: 2,
      source: 'sales.csv',
    },
  });
  const card = tryMountArtifact(toArtifactContent(artifact));
  assert.ok(card, 'card mounted');
  assert.match(card.className, /artifact-card/);

  // header: icon + title + skill chip
  assert.equal(card.querySelector('.artifact-title')?.textContent, 'Sales');
  assert.equal(card.querySelector('.artifact-chip')?.textContent, 'sheet.read');

  // table
  const table = card.querySelector('table.artifact-table');
  assert.ok(table, 'table rendered');
  const ths = table.querySelectorAll('thead th');
  assert.deepEqual([...ths].map((th) => th.textContent), ['month', 'amount', 'region']);
  assert.equal(table.querySelectorAll('tbody tr').length, 2);
  assert.equal(table.querySelectorAll('td.num').length, 2, 'numeric cells get .num');
  assert.match(card.querySelector('.artifact-meta')?.textContent ?? '', /2 × 3/);
  assert.match(card.querySelector('.artifact-meta')?.textContent ?? '', /sales\.csv/);

  // export CSV button -> saveArtifact(revealFile)
  const btns = card.querySelectorAll('button.artifact-action');
  assert.equal(btns.length, 1);
  assert.equal(btns[0].textContent, t('artifactExportCsv'));
  btnClick(btns[0]);
  await tick();
  assert.equal(preloadCalls.save.length, 1);
  assert.deepEqual(preloadCalls.save[0], {
    defaultName: 'Sales.csv',
    data: 'month,amount,region\nJan,120,North\nFeb,260,North',
    encoding: 'text',
  });
  assert.equal(preloadCalls.reveal.length, 1);
});

test('chart artifact falls back to a JSON details card when vega is absent', async () => {
  const artifact = baseArtifact({
    type: 'chart',
    title: 'Amount by Month',
    body: { spec: { $schema: 'https://vega.github.io/schema/vega-lite/v5.json', data: { name: 'table', values: [] }, mark: 'bar' } },
  });
  const card = tryMountArtifact(toArtifactContent(artifact));
  assert.ok(card);
  assert.equal(card.querySelector('.artifact-chip')?.textContent, 'sheet.read');
  const details = card.querySelector('.chart-fallback');
  assert.ok(details, 'fallback details rendered without window.vegaEmbed');
  const pre = details.querySelector('pre');
  assert.ok(pre, 'spec JSON is shown');
  assert.match(pre.textContent ?? '', /"mark":\s*"bar"/);
  const btns = card.querySelectorAll('button.artifact-action');
  assert.equal(btns.length, 1);
  assert.equal(btns[0].textContent, t('artifactExportPng'));
});

test('error-status artifact renders the error text without actions', async () => {
  const artifact = baseArtifact({
    type: 'chart',
    status: 'error',
    error: 'Vega-Lite rejected the spec',
    body: null,
  });
  const card = tryMountArtifact(toArtifactContent(artifact));
  assert.ok(card);
  assert.equal(card.querySelector('.artifact-error-text')?.textContent, 'Vega-Lite rejected the spec');
  assert.equal(card.querySelector('.artifact-actions'), null);
});

function btnClick(btn) {
  btn.dispatchEvent(new win.Event('click', { bubbles: true }));
}