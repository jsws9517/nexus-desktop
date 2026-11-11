/**
 * Automations sidebar page — T6 desktop automation control plane.
 *
 * Lists scheduled automations (cron / interval), shows their recent run
 * history, and offers run-now / delete / toggle-enabled actions. All data
 * flows through the main-process IPC channels (no worker round-trip), so
 * this page is a pure view + command surface.
 *
 * Dependency-injected for unit tests (fake list/upsert/delete/runNow/runs
 * fetchers), same pattern as jobs.ts.
 */

import { STR } from '../../i18n.js';
import type { SubTaskStatus } from '../../../agent/types.js';
import type { SidebarContext } from '../types.js';

// ---- Types -------------------------------------------------------------------

interface AutomationRow {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { type: string; expr?: string; everyMs?: number };
  prompt: string;
  profile: string;
  createdAt: number;
  updatedAt: number;
}

interface RunRow {
  id: string;
  automationId: string;
  sessionId?: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  missed?: number;
}

export interface AutomationPageOptions {
  listAutomations?: () => Promise<{ ok: boolean; automations?: unknown[]; error?: string }>;
  upsertAutomation?: (params: {
    id?: string;
    name?: string;
    enabled?: boolean;
    schedule?: unknown;
    prompt?: string;
    profile?: string;
    missPolicy?: string;
  }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  deleteAutomation?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  runAutomationNow?: (id: string) => Promise<{ ok: boolean; runId?: string; reason?: string; error?: string }>;
  listRuns?: (params?: { id?: string; limit?: number }) => Promise<{ ok: boolean; runs?: unknown[]; error?: string }>;
  getUiLang?: () => string;
}

type UpsertParams = Parameters<NonNullable<AutomationPageOptions['upsertAutomation']>>[0];

// ---- Helpers -----------------------------------------------------------------

function str(key: string, lang: string, vars?: Record<string, string | number>): string {
  let out = STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  return out;
}

function strOr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function boolOr(v: unknown): boolean {
  return v === true;
}

function mapAutomation(raw: unknown): AutomationRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  const id = strOr(j.id);
  if (!id) return null;
  return {
    id,
    name: strOr(j.name) ?? id,
    enabled: boolOr(j.enabled),
    schedule: (j.schedule ?? {}) as AutomationRow['schedule'],
    prompt: strOr(j.prompt) ?? '',
    profile: strOr(j.profile) ?? 'default',
    createdAt: numOr(j.createdAt) ?? 0,
    updatedAt: numOr(j.updatedAt) ?? 0,
  };
}

function mapRun(raw: unknown): RunRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  const id = strOr(j.id);
  if (!id) return null;
  return {
    id,
    automationId: strOr(j.automationId) ?? '',
    sessionId: strOr(j.sessionId),
    status: strOr(j.status) ?? 'pending',
    startedAt: numOr(j.startedAt) ?? 0,
    endedAt: numOr(j.endedAt),
    summary: strOr(j.summary),
    error: strOr(j.error),
    missed: numOr(j.missed),
  };
}

/** Map a raw run status to the shared SubTaskStatus set for TaskStatusCard. */
function runStatusToSubTask(s: string): SubTaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'timeout';
    case 'killed':
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'cancelled';
    case 'missed':
      return 'pending';
    default:
      return 'pending';
  }
}

// ---- Defaults ----------------------------------------------------------------

function defaultList() {
  return window.nexusDesktop.automationList();
}
function defaultUpsert(params: UpsertParams) {
  return window.nexusDesktop.automationUpsert(params);
}
function defaultDelete(id: string) {
  return window.nexusDesktop.automationDelete(id);
}
function defaultRunNow(id: string) {
  return window.nexusDesktop.automationRunNow(id);
}
function defaultRuns(params?: { id?: string; limit?: number }) {
  return window.nexusDesktop.automationRuns(params ?? {});
}

// ---- Mount --------------------------------------------------------------------

export function mountAutomationPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: AutomationPageOptions = {},
): () => void {
  const listAutomations = opts.listAutomations ?? defaultList;
  const upsertAutomation = opts.upsertAutomation ?? defaultUpsert;
  const deleteAutomation = opts.deleteAutomation ?? defaultDelete;
  const runAutomationNow = opts.runAutomationNow ?? defaultRunNow;
  const listRuns = opts.listRuns ?? defaultRuns;
  const getLang = (): string => ctx.getUiLang?.() ?? opts.getUiLang?.() ?? 'zh-CN';

  container.classList.add('automation-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'automation-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'automation-header';
  root.appendChild(header);

  const titleEl = document.createElement('span');
  titleEl.className = 'automation-title';
  header.appendChild(titleEl);

  const list = document.createElement('div');
  list.className = 'automation-list';
  root.appendChild(list);

  const emptyEl = document.createElement('div');
  emptyEl.className = 'automation-empty';
  list.appendChild(emptyEl);

  let automations: AutomationRow[] = [];
  let runs: RunRow[] = [];
  let pullSeq = 0;

  async function pull(): Promise<void> {
    const seq = ++pullSeq;
    const [autoRes, runsRes] = await Promise.all([
      listAutomations().catch(() => ({ ok: false, automations: [] as unknown[], error: 'ipc' })),
      listRuns({ limit: 50 }).catch(() => ({ ok: false, runs: [] as unknown[], error: 'ipc' })),
    ]);
    if (seq !== pullSeq) return;
    automations = (autoRes.automations ?? []).map((a) => mapAutomation(a)).filter(Boolean) as AutomationRow[];
    runs = (runsRes.runs ?? []).map((r) => mapRun(r)).filter(Boolean) as RunRow[];
    render();
  }

  function latestRunFor(automationId: string): RunRow | undefined {
    return runs.find((r) => r.automationId === automationId);
  }

  function scheduleLabel(schedule: AutomationRow['schedule']): string {
    if (schedule.type === 'cron') {
      return `cron: ${schedule.expr ?? ''}`;
    }
    if (schedule.type === 'interval') {
      const ms = schedule.everyMs ?? 0;
      if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
      if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
      return `${Math.round(ms / 1000)}s`;
    }
    return '';
  }

  function render(): void {
    titleEl.textContent = str('automationsPanel', getLang());
    list.replaceChildren(emptyEl);
    if (automations.length === 0) {
      emptyEl.textContent = str('automationsEmpty', getLang());
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    for (const aut of automations) {
      const card = document.createElement('div');
      card.className = `automation-card ${aut.enabled ? '' : 'disabled'}`;
      card.dataset.autId = aut.id;

      const nameEl = document.createElement('div');
      nameEl.className = 'automation-name';
      nameEl.textContent = aut.name;
      const schedEl = document.createElement('span');
      schedEl.className = 'automation-schedule';
      schedEl.textContent = scheduleLabel(aut.schedule);
      nameEl.appendChild(schedEl);
      card.appendChild(nameEl);

      const promptEl = document.createElement('div');
      promptEl.className = 'automation-prompt';
      promptEl.textContent = aut.prompt.length > 120 ? aut.prompt.slice(0, 120) + '…' : aut.prompt;
      card.appendChild(promptEl);

      const latest = latestRunFor(aut.id);
      if (latest) {
        const statusEl = document.createElement('div');
        statusEl.className = `automation-run-status status-${runStatusToSubTask(latest.status)}`;
        const timeStr = latest.startedAt ? new Date(latest.startedAt).toLocaleString(getLang()) : '';
        statusEl.textContent = `${latest.status}${timeStr ? ' · ' + timeStr : ''}${latest.summary ? ' · ' + latest.summary : ''}`;
        if (latest.error) statusEl.textContent += ` (${latest.error})`;
        card.appendChild(statusEl);
      }

      const actions = document.createElement('div');
      actions.className = 'automation-actions';

      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'automation-action-btn';
      runBtn.textContent = str('automationsRunNow', getLang());
      runBtn.addEventListener('click', () => {
        runAutomationNow(aut.id).then((res) => {
          if (res?.ok && res.runId) {
            void pull();
          } else if (res && !res.ok && res.reason) {
            // busy / not found — just re-pull to show current state
            void pull();
          }
        }).catch(() => {});
      });
      actions.appendChild(runBtn);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'automation-action-btn';
      toggleBtn.textContent = aut.enabled ? str('automationsDisable', getLang()) : str('automationsEnable', getLang());
      toggleBtn.addEventListener('click', () => {
        upsertAutomation({
          id: aut.id,
          name: aut.name,
          enabled: !aut.enabled,
          schedule: aut.schedule,
          prompt: aut.prompt,
          profile: aut.profile,
        }).then(() => void pull()).catch(() => {});
      });
      actions.appendChild(toggleBtn);

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'automation-action-btn automation-action-remove';
      rmBtn.textContent = str('automationsDelete', getLang());
      rmBtn.addEventListener('click', () => {
        if (!confirm(str('automationsDeleteConfirm', getLang(), { name: aut.name }))) return;
        deleteAutomation(aut.id).then(() => void pull()).catch(() => {});
      });
      actions.appendChild(rmBtn);

      card.appendChild(actions);
      list.appendChild(card);
    }
  }

  render();
  void pull();

  const autoRecycle = setInterval(() => void pull(), 10_000);

  const unsubscribe = ctx.subscribe((event) => {
    if (event.type === 'language_changed' || event.type === 'session_changed') {
      void pull();
    }
  });

  return () => {
    clearInterval(autoRecycle);
    unsubscribe();
    container.classList.remove('automation-page');
    container.innerHTML = '';
  };
}

// ---- Page descriptor ----------------------------------------------------------

export const AutomationPage = {
  id: 'automations',
  title: 'Automations',
  titleKey: 'sidebarAutomations',
  icon: '⏰',
  mount: mountAutomationPage,
} as const;
