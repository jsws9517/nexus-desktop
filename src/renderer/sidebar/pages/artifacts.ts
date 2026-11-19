/**
 * My Artifacts sidebar page (T2-4).
 *
 * A cross-session, STRUCTURED view of the Artifact envelopes embedded in tool
 * messages. This is deliberately NOT the right-side FileBrowser: that component
 * enumerates physical files in the current project tree, while this page reads
 * historical messages and includes inline / base64 artifacts that never touch
 * disk. Filtering is by type / session / time only — never body full-text or
 * tags — so an inline artifact is never accidentally dropped.
 *
 * Dependency-injected (list/get/export/open callbacks) so the filter state
 * machine and rendering can be unit-tested without Electron.
 */

import {
  parseArtifactContent,
  type Artifact,
  type ArtifactListItem,
} from '../../../shared/artifact.js';
import { STR } from '../../i18n.js';
import { csvFromSheet } from '../../artifacts/table-view.js';
import {
  imageArtifactPayload,
  textArtifactPayload,
} from '../../artifacts/artifact-view.js';
import { mountChart, type ChartMenu } from '../../artifacts/chart-view.js';
import type { SidebarContext } from '../types.js';

export type ArtifactTimeFilter = 'today' | '7days' | 'all';

export interface ArtifactFilterState {
  /** '' = all types. */
  type: string;
  /** '' = all sessions. */
  sessionId: string;
  time: ArtifactTimeFilter;
}

export interface SessionOption {
  sessionId: string;
  sessionName: string;
}

export interface ArtifactsPageOptions {
  listArtifacts?: (opts?: {
    limit?: number; sessionId?: string; type?: string; sinceMs?: number;
  }) => Promise<{ ok: boolean; items: ArtifactListItem[]; error?: string }>;
  getArtifact?: (messageId: number) => Promise<{ ok: boolean; content?: string; error?: string }>;
  saveArtifact?: (defaultName: string, data: string, encoding?: 'base64' | 'text') => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Open/focus the source session (renderer supplies the real tab logic). */
  openSession?: (sessionId: string) => void;
  getUiLang?: () => string;
  /** Poll interval for the "new session produced artifacts" case (AC-7). */
  refreshMs?: number;
  now?: () => number;
  limit?: number;
}

export interface ExportPayload {
  defaultName: string;
  data: string;
  encoding: 'base64' | 'text';
}

const TYPE_ICON: Record<string, string> = {
  sheet: '📊', chart: '📈', ppt: '🎞️', docx: '📄', pdf: '📄',
  markdown: '📝', html: '🌐', image: '🖼️', csv: '📋', dataframe: '🗃️',
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ── pure filter / derivation helpers (unit-tested) ─────────────────────────

/** Translate the time dropdown into a `sinceMs` bound for the IPC. */
export function sinceMsFor(filter: ArtifactTimeFilter, now: number): number | undefined {
  if (filter === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (filter === '7days') return now - 7 * DAY_MS;
  return undefined;
}

/** Unique sessions from the current (time-filtered) aggregate, name-sorted. */
export function deriveSessions(items: ArtifactListItem[]): SessionOption[] {
  const byId = new Map<string, string>();
  for (const it of items) {
    if (!it.sessionId) continue;
    const name = it.sessionName || '';
    if (!byId.has(it.sessionId) || (name && !byId.get(it.sessionId))) {
      byId.set(it.sessionId, name);
    }
  }
  return [...byId.entries()]
    .map(([sessionId, sessionName]) => ({ sessionId, sessionName }))
    .sort((a, b) => (a.sessionName || a.sessionId).localeCompare(b.sessionName || b.sessionId));
}

/**
 * Apply type / session / time filters to the aggregated list. Entries with a
 * missing type or session simply never match a specific filter (they stay
 * visible under "all") — the risk noted in the plan. No body inspection.
 */
export function filterArtifacts(
  items: ArtifactListItem[],
  state: ArtifactFilterState,
  now: number,
): ArtifactListItem[] {
  const since = sinceMsFor(state.time, now);
  return items.filter((it) => {
    if (state.type && it.type !== state.type) return false;
    if (state.sessionId && it.sessionId !== state.sessionId) return false;
    if (since !== undefined && it.createdAt < since) return false;
    return true;
  });
}

/** Export payload for the text/table/image types. Chart PNG is handled via the
 *  chart view's own exporter (see `exportChartPng`). */
export function exportPayloadFor(artifact: Artifact): ExportPayload | null {
  const title = artifact.title || 'artifact';
  if (artifact.type === 'markdown' || artifact.type === 'html') {
    const { text, ext } = textArtifactPayload(artifact, artifact.type);
    return text ? { defaultName: `${title}.${ext}`, data: text, encoding: 'text' } : null;
  }
  if (artifact.type === 'sheet' || artifact.type === 'csv' || artifact.type === 'dataframe') {
    const csv = csvFromSheet(artifact);
    return csv ? { defaultName: `${title}.csv`, data: csv, encoding: 'text' } : null;
  }
  if (artifact.type === 'image') {
    const p = imageArtifactPayload(artifact);
    return p
      ? { defaultName: `${title}.${p.ext}`, data: p.base64, encoding: 'base64' }
      : null;
  }
  return null;
}

/** Chart export reuses the real vega-backed exporter in an off-screen mount. */
export async function exportChartPng(artifact: Artifact): Promise<void> {
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.left = '-10000px';
  document.body.appendChild(host);
  let menu: ChartMenu | null = null;
  try {
    menu = mountChart(host, artifact.body);
    await menu.render();
    await menu.exportPng(artifact.title || 'chart');
  } catch {
    /* export is best-effort */
  } finally {
    menu?.dispose();
    if (host.parentNode) host.parentNode.removeChild(host);
  }
}

const langOf = (ctx: SidebarContext, opts: ArtifactsPageOptions): string =>
  ctx.getUiLang?.() ?? opts.getUiLang?.() ?? 'en';

function label(key: string, lang: string): string {
  return STR[key]?.[lang as 'en' | 'zh-CN'] ?? STR[key]?.['zh-CN'] ?? key;
}

function timeLabel(createdAt: number, lang: string): string {
  try {
    return new Date(createdAt).toLocaleString(lang === 'zh-CN' ? 'zh-CN' : 'en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(createdAt);
  }
}

function makeSelect(labelKey: string, lang: string): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = document.createElement('label');
  wrap.className = 'artifacts-filter';
  const caption = document.createElement('span');
  caption.textContent = label(labelKey, lang);
  const select = document.createElement('select');
  wrap.appendChild(caption);
  wrap.appendChild(select);
  return { wrap, select };
}

/**
 * Mount the page into `container`; returns a dispose function that stops the
 * poll timer and clears the DOM (registry guarantees it runs exactly once).
 */
export function mountArtifactsPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: ArtifactsPageOptions = {},
): () => void {
  const listArtifacts = opts.listArtifacts ?? ((o) => window.nexusDesktop.listArtifacts(o));
  const getArtifact = opts.getArtifact ?? ((id) => window.nexusDesktop.getArtifact(id));
  const saveArtifact = opts.saveArtifact ?? ((n, d, e) => window.nexusDesktop.saveArtifact(n, d, e));
  const now = opts.now ?? (() => Date.now());
  const limit = opts.limit ?? 100;
  const pollMs = opts.refreshMs ?? 10_000;

  const state: ArtifactFilterState = { type: '', sessionId: '', time: 'all' };
  let allItems: ArtifactListItem[] = [];
  let disposed = false;

  container.classList.add('artifacts-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'artifacts-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'artifacts-header';
  const title = document.createElement('span');
  title.className = 'artifacts-title';
  title.textContent = label('artifactsPanel', langOf(ctx, opts));
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn ghost small artifact-action';
  refresh.textContent = label('artifactRefresh', langOf(ctx, opts));
  refresh.addEventListener('click', () => void load());
  header.appendChild(title);
  header.appendChild(refresh);
  root.appendChild(header);

  const filters = document.createElement('div');
  filters.className = 'artifacts-filters';
  const typeSel = makeSelect('artifactFilterType', langOf(ctx, opts));
  const sessionSel = makeSelect('artifactFilterSession', langOf(ctx, opts));
  const timeSel = makeSelect('artifactFilterTime', langOf(ctx, opts));

  const allTypes = document.createElement('option');
  allTypes.value = '';
  allTypes.textContent = label('artifactFilterAllTypes', langOf(ctx, opts));
  typeSel.select.appendChild(allTypes);
  for (const type of ['sheet', 'chart', 'ppt', 'docx', 'pdf', 'markdown', 'html', 'image', 'csv', 'dataframe']) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = `${TYPE_ICON[type] ?? '🧩'} ${type}`;
    typeSel.select.appendChild(option);
  }
  timeSel.select.replaceChildren();
  const timeChoices: Array<[ArtifactTimeFilter, string]> = [
    ['all', 'artifactTimeAll'], ['today', 'artifactTimeToday'], ['7days', 'artifactTime7Days'],
  ];
  for (const [value, key] of timeChoices) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label(key, langOf(ctx, opts));
    timeSel.select.appendChild(option);
  }
  filters.appendChild(typeSel.wrap);
  filters.appendChild(sessionSel.wrap);
  filters.appendChild(timeSel.wrap);
  root.appendChild(filters);

  const status = document.createElement('div');
  status.className = 'artifacts-status';
  root.appendChild(status);
  const list = document.createElement('div');
  list.className = 'artifacts-list';
  root.appendChild(list);

  typeSel.select.addEventListener('change', () => { state.type = typeSel.select.value; render(); });
  timeSel.select.addEventListener('change', () => {
    state.time = (timeSel.select.value as ArtifactTimeFilter) || 'all';
    void load();
  });
  sessionSel.select.addEventListener('change', () => {
    state.sessionId = sessionSel.select.value;
    render();
  });

  function renderSessions(): void {
    const lang = langOf(ctx, opts);
    const current = state.sessionId;
    sessionSel.select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = label('artifactFilterAllSessions', lang);
    sessionSel.select.appendChild(all);
    for (const s of deriveSessions(allItems)) {
      const option = document.createElement('option');
      option.value = s.sessionId;
      option.textContent = s.sessionName || label('artifactUntitledSession', lang);
      option.title = s.sessionId;
      sessionSel.select.appendChild(option);
    }
    sessionSel.select.value = current;
    if (sessionSel.select.value !== current) state.sessionId = '';
  }

  function render(): void {
    const lang = langOf(ctx, opts);
    const rows = filterArtifacts(allItems, state, now());
    status.textContent = `${rows.length}`;
    list.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'artifacts-empty';
      empty.textContent = label('artifactEmpty', lang);
      list.appendChild(empty);
      return;
    }
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'artifacts-row';

      const icon = document.createElement('span');
      icon.className = 'artifacts-row-icon';
      icon.textContent = TYPE_ICON[item.type] ?? '🧩';
      row.appendChild(icon);

      const main = document.createElement('div');
      main.className = 'artifacts-row-main';
      const name = document.createElement('span');
      name.className = 'artifacts-row-title';
      name.textContent = item.title || item.id.toString();
      name.title = item.preview || name.textContent;
      const meta = document.createElement('span');
      meta.className = 'artifacts-row-meta';
      meta.textContent = `${item.type || '?'} · ${item.sessionName || label('artifactUntitledSession', lang)} · ${timeLabel(item.createdAt, lang)}`;
      main.appendChild(name);
      main.appendChild(meta);
      row.appendChild(main);

      const actions = document.createElement('div');
      actions.className = 'artifacts-row-actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn ghost small artifact-action';
      open.textContent = label('artifactOpenSession', lang);
      open.addEventListener('click', () => {
        const fn = opts.openSession ?? ((sid: string) => void window.nexusDesktop.openSession(sid));
        fn(item.sessionId);
      });
      actions.appendChild(open);

      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'btn ghost small artifact-action';
      exportBtn.textContent = label('artifactExport', lang);
      exportBtn.addEventListener('click', () => void exportOne(item));
      actions.appendChild(exportBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  async function exportOne(item: ArtifactListItem): Promise<void> {
    let content: string | undefined;
    try {
      const res = await getArtifact(item.id);
      content = res.ok ? res.content : undefined;
    } catch {
      content = undefined;
    }
    if (!content) return;
    const artifact = parseArtifactContent(content);
    if (!artifact) return;
    if (artifact.type === 'chart') {
      await exportChartPng(artifact);
      return;
    }
    const payload = exportPayloadFor(artifact);
    if (!payload) return;
    try {
      const res = await saveArtifact(payload.defaultName, payload.data, payload.encoding);
      if (res.ok && res.path && window.nexusDesktop.revealFile) {
        void window.nexusDesktop.revealFile(res.path);
      }
    } catch {
      /* export is best-effort */
    }
  }

  async function load(): Promise<void> {
    if (disposed) return;
    try {
      const res = await listArtifacts({ limit, ...(sinceMsFor(state.time, now()) !== undefined
        ? { sinceMs: sinceMsFor(state.time, now()) } : {}) });
      if (disposed) return;
      if (!res.ok) {
        status.textContent = label('artifactLoadError', langOf(ctx, opts));
        return;
      }
      allItems = res.items;
      renderSessions();
      render();
    } catch {
      if (!disposed) status.textContent = label('artifactLoadError', langOf(ctx, opts));
    }
  }

  void load();
  const timer = setInterval(() => void load(), pollMs);

  return () => {
    disposed = true;
    clearInterval(timer);
    container.innerHTML = '';
  };
}

export const ArtifactsPage = {
  id: 'artifacts',
  title: 'Artifacts',
  titleKey: 'sidebarArtifacts',
  icon: '🧩',
  mount: mountArtifactsPage,
} as const;
