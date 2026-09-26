/**
 * Jobs sidebar page — background-job list over core `bg_` shell jobs
 * (worker-local JobManager, launched via /jobs).
 *
 * Core owns the jobs, their lifecycle and their persistence; this page is a
 * read-only view plus kill/tail/remove controls routed to the owning worker.
 * Driven by the agent event bus (bg_job_event) with an initial pull + 10s
 * auto-recycle. Status vocabularies are normalized into the shared
 * SubTaskStatus set so ParallelExecutionCard can render them.
 *
 * Dependency-injected for unit tests (fake list/kill/tail fetchers).
 */

import { ParallelExecutionCard } from '../../components/ParallelExecutionCard.js';
import { STR } from '../../i18n.js';
import type { SubTaskStatus } from '../../../agent/types.js';
import type { AgentEvent } from '../../../agent/types.js';
import type { SidebarContext } from '../types.js';

export interface JobRow {
  id: string;
  title: string;
  status: SubTaskStatus;
  sessionId?: string;
  command?: string;
  error?: string;
  pid?: number;
  logBytes?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface JobsPageOptions {
  /** Pull core bg_ jobs (default: window.nexusDesktop.coreBgList). */
  listCore?: (sessionId?: string) => Promise<{ ok: boolean; jobs?: unknown[]; error?: string }>;
  /** Kill a core job (default: window.nexusDesktop.coreBgKill). sessionId routes to the owning worker. */
  killCore?: (jobId: string, sessionId?: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** Remove a finished core job (default: window.nexusDesktop.coreBgRemove). sessionId routes to the owning worker. */
  removeCore?: (jobId: string, sessionId?: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** Fetch a core job log tail (default: window.nexusDesktop.coreBgTail). sessionId routes to the owning worker. */
  tailCore?: (jobId: string, lines?: number, sessionId?: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  getUiLang?: () => string;
  renderCard?: typeof ParallelExecutionCard;
}

const statusRank: Record<string, number> = {
  running: 0,
  queued: 1,
  pending: 2,
  succeeded: 3,
  failed: 4,
  timeout: 4,
  cancelled: 5,
};

/** Normalize core JobManager status vocabulary into SubTaskStatus. */
export function normalizeJobStatus(raw: unknown): SubTaskStatus {
  const s = String(raw ?? '').toLowerCase();
  switch (s) {
    case 'created':
      return 'pending';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'lost':
      return 'failed';
    case 'timeout':
      return 'timeout';
    case 'killed':
    case 'cancelled':
      return 'cancelled';
    case 'stale':
      return 'timeout';
    default:
      return 'pending';
  }
}

const TERMINAL = new Set<SubTaskStatus>(['succeeded', 'failed', 'timeout', 'cancelled']);

function str(key: string, lang: string, vars?: Record<string, string | number>): string {
  let out = STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strOr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Map a raw core BgJob JSON object into a JobRow. */
export function coreJobToRow(raw: unknown): JobRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  const id = strOr(j.id);
  if (!id) return null;
  const startedAt = num(j.startedAt);
  const finishedAt = num(j.finishedAt);
  return {
    id,
    title: strOr(j.label) || strOr(j.command) || id,
    status: normalizeJobStatus(j.status),
    sessionId: strOr(j.sessionId),
    command: strOr(j.command),
    error: strOr(j.error),
    pid: num(j.pid),
    logBytes: num(j.logBytes),
    startedAt,
    finishedAt,
    durationMs: startedAt != null && finishedAt != null ? finishedAt - startedAt : undefined,
  };
}

async function defaultListCore(sessionId?: string) {
  return window.nexusDesktop.coreBgList(sessionId ? { sessionId } : {});
}
async function defaultKillCore(jobId: string, sessionId?: string) {
  return window.nexusDesktop.coreBgKill(jobId, sessionId);
}
async function defaultRemoveCore(jobId: string, sessionId?: string) {
  return window.nexusDesktop.coreBgRemove(jobId, sessionId);
}
async function defaultTailCore(jobId: string, lines?: number, sessionId?: string) {
  return window.nexusDesktop.coreBgTail(jobId, lines, sessionId);
}

export function mountJobsPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: JobsPageOptions = {},
): () => void {
  const renderCard = opts.renderCard ?? ParallelExecutionCard;
  const listCore = opts.listCore ?? defaultListCore;
  const killCore = opts.killCore ?? defaultKillCore;
  const removeCore = opts.removeCore ?? defaultRemoveCore;
  const tailCore = opts.tailCore ?? defaultTailCore;
  const getLang = (): string => ctx.getUiLang?.() ?? opts.getUiLang?.() ?? 'zh-CN';

  container.classList.add('jobs-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'jobs-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'jobs-header';
  root.appendChild(header);

  const titleEl = document.createElement('span');
  titleEl.className = 'jobs-title';
  header.appendChild(titleEl);

  const legendEl = document.createElement('span');
  legendEl.className = 'jobs-legend';
  header.appendChild(legendEl);

  const scopeEl = document.createElement('span');
  scopeEl.className = 'jobs-scope';
  header.appendChild(scopeEl);

  const list = document.createElement('div');
  list.className = 'jobs-list';
  root.appendChild(list);

  const empty = document.createElement('div');
  empty.className = 'jobs-empty';
  list.appendChild(empty);

  /** Latest pulled rows, keyed by id for O(1) event merges. */
  const rows = new Map<string, JobRow>();
  /** Tombstones: ids the user removed this mount — late events / stale pulls must not re-add them. */
  const removedIds = new Set<string>();
  /** Session-scoped view: when set, only rows for that session render. */
  let boundSessionId = '';
  let pullSeq = 0;

  const truncateId = (id: string, maxLen = 8): string =>
    id.length > maxLen ? id.slice(0, maxLen) + '…' : id;

  async function pull(): Promise<void> {
    const seq = ++pullSeq;
    const sid = ctx.getActiveSessionId?.() ?? ctx.sessionId;
    boundSessionId = sid || '';
    const core = await listCore(sid || undefined).catch(() => ({ ok: false as const, jobs: [] as unknown[] }));
    if (seq !== pullSeq) return; // a newer pull superseded this one
    // Rebuild from scratch: the authoritative snapshot for this render pass.
    // Event-driven merges below keep the map warm between pulls.
    const keep = new Map<string, JobRow>();
    for (const j of core.jobs ?? []) {
      const row = coreJobToRow(j);
      if (row && !removedIds.has(row.id)) keep.set(row.id, row);
    }
    // Preserve any event-only rows the pull might have missed (e.g. just-launched
    // core job not yet in the manager list race) only if still non-terminal.
    for (const [id, row] of rows) {
      if (!keep.has(id) && !TERMINAL.has(row.status)) keep.set(id, row);
    }
    rows.clear();
    for (const [id, row] of keep) rows.set(id, row);
    render();
  }

  /** Fold a bg job lifecycle event into the local map (no full re-pull). */
  function applyEvent(event: AgentEvent): void {
    if (event.type !== 'bg_job_event') return;
    const row = coreJobToRow(event.job);
    if (!row || removedIds.has(row.id)) return;
    const prev = rows.get(row.id);
    rows.set(row.id, {
      ...row,
      // Keep earlier duration if finishedAt not yet stamped.
      durationMs: row.durationMs ?? prev?.durationMs,
    });
  }

  function killRow(row: JobRow): void {
    if (TERMINAL.has(row.status)) return;
    void killCore(row.id, row.sessionId).then(() => {
      rows.set(row.id, { ...row, status: 'cancelled' });
      render();
    }).catch(() => {});
  }

  /** Drop a terminal card. Tombstone the id so late bg_job_event events and the
   *  10s pull cannot re-add it (backend remove may race the event bus). */
  function removeRow(row: JobRow): void {
    if (!TERMINAL.has(row.status)) return;
    void removeCore(row.id, row.sessionId)
      .then((res) => {
        const ok = res?.ok !== false;
        if (!ok) return; // keep card so the user can retry
        removedIds.add(row.id);
        rows.delete(row.id);
        render();
      })
      .catch(() => {
        // Network/IPC hiccup — keep the card so the user can retry.
      });
  }

  function tailRow(row: JobRow, body: HTMLElement): void {
    void tailCore(row.id, 40, row.sessionId).then((res) => {
      body.textContent = res.text || res.error || '';
      body.classList.remove('hidden');
    }).catch(() => {});
  }

  function renderSection(titleKey: string, sectionRows: JobRow[], parent: HTMLElement): void {
    if (sectionRows.length === 0) return;
    const section = document.createElement('div');
    section.className = 'jobs-section';
    const head = document.createElement('div');
    head.className = 'jobs-section-head';
    head.textContent = `${str(titleKey, getLang())} — ${sectionRows.length}`;
    section.appendChild(head);

    for (const row of sectionRows) {
      const card = document.createElement('div');
      card.className = `job-card-wrapper status-${row.status}`;
      card.dataset.jobId = row.id;
      card.dataset.status = row.status;
      const description = row.command || row.title;
      card.innerHTML = renderCard({
        taskId: row.id,
        description,
        status: row.status,
        durationMs: row.durationMs,
        error: row.error,
      });
      const first = card.firstElementChild as HTMLElement | null;
      const el = first ?? card;
      const tailBody = document.createElement('pre');
      tailBody.className = 'job-tail hidden';
      // Actions (kill / remove / log tail).
      const actions = document.createElement('div');
      actions.className = 'job-actions';
      if (row.pid != null) {
        const pid = document.createElement('span');
        pid.className = 'job-meta';
        pid.textContent = `pid ${row.pid}`;
        actions.appendChild(pid);
      }
      if (row.logBytes != null) {
        const lb = document.createElement('span');
        lb.className = 'job-meta';
        lb.textContent = `${row.logBytes}B`;
        actions.appendChild(lb);
      }
      if (!TERMINAL.has(row.status)) {
        const killBtn = document.createElement('button');
        killBtn.type = 'button';
        killBtn.className = 'job-action-btn';
        killBtn.textContent = str('jobsKill', getLang());
        killBtn.addEventListener('click', () => killRow(row));
        actions.appendChild(killBtn);
      } else {
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'job-action-btn job-action-remove';
        rmBtn.textContent = str('jobsRemove', getLang());
        rmBtn.addEventListener('click', () => removeRow(row));
        actions.appendChild(rmBtn);
      }
      const tailBtn = document.createElement('button');
      tailBtn.type = 'button';
      tailBtn.className = 'job-action-btn';
      tailBtn.textContent = str('jobsTail', getLang());
      tailBtn.addEventListener('click', () => tailRow(row, tailBody));
      actions.appendChild(tailBtn);
      el.appendChild(actions);
      el.appendChild(tailBody);
      section.appendChild(el);
    }
    parent.appendChild(section);
  }

  const render = (): void => {
    titleEl.textContent = str('jobsPanel', getLang());
    legendEl.textContent = str('jobsLegend', getLang());
    const activeSessionId = ctx.getActiveSessionId?.() ?? ctx.sessionId;
    scopeEl.textContent = `🗂 ${activeSessionId ? truncateId(activeSessionId) : str('jobsNoSession', getLang())}`;

    const all = [...rows.values()];
    const scoped = activeSessionId
      ? all.filter((r) => !r.sessionId || r.sessionId === activeSessionId)
      : all;
    scoped.sort((a, b) => {
      const ra = statusRank[a.status] ?? 99;
      const rb = statusRank[b.status] ?? 99;
      if (ra !== rb) return ra - rb;
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });

    list.replaceChildren();
    if (scoped.length === 0) {
      empty.textContent = all.length > 0
        ? str('jobsScopedEmpty', getLang(), { session: truncateId(activeSessionId || '—') })
        : str('jobsEmpty', getLang());
      list.appendChild(empty);
      return;
    }
    renderSection('jobsShellSection', scoped, list);
  };

  render();
  void pull();

  const onEvent = (event: AgentEvent): void => {
    if (
      event.type === 'bg_job_event' ||
      event.type === 'session_changed' ||
      event.type === 'language_changed'
    ) {
      if (event.type === 'session_changed') {
        void pull();
        return;
      }
      applyEvent(event);
      render();
    }
  };

  const unsubscribe = ctx.subscribe(onEvent);
  // Reconcile against the authoritative stores periodically (covers kill from
  // /jobs, worker restarts, and anything that mutates outside this page).
  const autoRecycle = setInterval(() => { void pull(); }, 10_000);

  return () => {
    clearInterval(autoRecycle);
    unsubscribe();
    container.classList.remove('jobs-page');
    container.innerHTML = '';
  };
}

export const JobsPage = {
  id: 'jobs',
  title: 'Jobs',
  titleKey: 'sidebarJobs',
  icon: '⚙',
  mount: mountJobsPage,
} as const;
