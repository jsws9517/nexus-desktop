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
  cwd: string;
  profile: string;
  provider: string;
  model: string;
  missPolicy: string;
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
    cwd?: string;
    profile?: string;
    provider?: string;
    model?: string;
    missPolicy?: string;
  }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  deleteAutomation?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  runAutomationNow?: (id: string) => Promise<{ ok: boolean; runId?: string; reason?: string; error?: string }>;
  listRuns?: (params?: { id?: string; limit?: number }) => Promise<{ ok: boolean; runs?: unknown[]; error?: string }>;
  getUiLang?: () => string;
  /** Default cwd for a newly created automation (dependency-injectable). */
  getCurrentCwd?: () => string;
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
    cwd: strOr(j.cwd) ?? '',
    profile: strOr(j.profile) ?? 'default',
    provider: strOr(j.provider) ?? '',
    model: strOr(j.model) ?? '',
    missPolicy: strOr(j.missPolicy) ?? 'skip',
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
  const getCurrentCwd = opts.getCurrentCwd ?? (() => '');
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

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'automation-action-btn automation-new-btn';
  newBtn.textContent = str('automationsNew', getLang());
  newBtn.addEventListener('click', () => openForm(null));
  header.appendChild(newBtn);

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

  /** Expand a friendly schedule helper into a core schedule object. */
  function buildSchedule(
    mode: string,
    dailyTime: string,
    weekday: string,
    weekdayTime: string,
    everyValue: string,
    everyUnit: string,
    cronExpr: string,
  ): { type: string; expr?: string; everyMs?: number } | null {
    if (mode === 'cron') {
      const expr = cronExpr.trim();
      return expr ? { type: 'cron', expr } : null;
    }
    if (mode === 'interval') {
      const n = Number(everyValue);
      if (!Number.isFinite(n) || n <= 0) return null;
      const mult = everyUnit === 'hour' ? 3_600_000 : everyUnit === 'day' ? 86_400_000 : 60_000;
      return { type: 'interval', everyMs: Math.round(n * mult) };
    }
    if (mode === 'daily') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(dailyTime.trim());
      if (!m) return null;
      const hh = Number(m[1]); const mm = Number(m[2]);
      if (hh > 23 || mm > 59) return null;
      return { type: 'cron', expr: `${mm} ${hh} * * *` };
    }
    if (mode === 'weekly') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(weekdayTime.trim());
      if (!m) return null;
      const days: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const d = days[weekday];
      if (d === undefined) return null;
      const hh = Number(m[1]); const mm = Number(m[2]);
      if (hh > 23 || mm > 59) return null;
      return { type: 'cron', expr: `${mm} ${hh} * * ${d}` };
    }
    return null;
  }

  /** Parse an existing cron expr back into friendly helper inputs (best-effort). */
  function cronToDaily(expr: string): { time: string } | null {
    const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(expr.trim());
    if (!m) return null;
    return { time: `${String(m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}` };
  }

  /** Open the create/edit dialog. `edit` is null for a new automation. */
  function openForm(edit: AutomationRow | null): void {
    const overlay = document.createElement('div');
    overlay.className = 'automation-form-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'automation-form';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const heading = document.createElement('div');
    heading.className = 'automation-form-heading';
    heading.textContent = edit ? str('automationsEdit', getLang()) : str('automationsNew', getLang());
    dialog.appendChild(heading);

    const errEl = document.createElement('div');
    errEl.className = 'automation-form-error hidden';
    dialog.appendChild(errEl);

    const fields = document.createElement('div');
    fields.className = 'automation-form-fields';
    dialog.appendChild(fields);

    function addField(label: string, input: HTMLElement): void {
      const row = document.createElement('label');
      row.className = 'automation-form-field';
      const lab = document.createElement('span');
      lab.textContent = label;
      row.appendChild(lab);
      row.appendChild(input);
      fields.appendChild(row);
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.maxLength = 200;
    nameInput.value = edit?.name ?? '';
    addField(str('automationFieldName', getLang()), nameInput);

    const promptInput = document.createElement('textarea');
    promptInput.rows = 4; promptInput.maxLength = 65536;
    promptInput.value = edit?.prompt ?? '';
    addField(str('automationFieldPrompt', getLang()), promptInput);

    // Schedule helper — friendly presets that fill expr/everyMs.
    const scheduleSel = document.createElement('select');
    for (const [v, label] of [
      ['daily', str('automationSchedDaily', getLang())],
      ['weekly', str('automationSchedWeekly', getLang())],
      ['interval', str('automationSchedInterval', getLang())],
      ['cron', str('automationSchedCron', getLang())],
    ] as const) {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      scheduleSel.appendChild(o);
    }
    addField(str('automationFieldSchedule', getLang()), scheduleSel);

    const dailyRow = document.createElement('div');
    const dailyTime = document.createElement('input');
    dailyTime.type = 'time'; dailyTime.value = '09:00';
    const dailyHint = document.createElement('span');
    dailyHint.textContent = str('automationTimeZoneHint', getLang());
    dailyRow.appendChild(dailyTime); dailyRow.appendChild(dailyHint);
    addField(str('automationSchedDaily', getLang()), dailyRow);

    const weeklyRow = document.createElement('div');
    const weekdaySel = document.createElement('select');
    for (const [v, label] of [
      ['mon', str('automationWeekMon', getLang())], ['tue', str('automationWeekTue', getLang())],
      ['wed', str('automationWeekWed', getLang())], ['thu', str('automationWeekThu', getLang())],
      ['fri', str('automationWeekFri', getLang())], ['sat', str('automationWeekSat', getLang())],
      ['sun', str('automationWeekSun', getLang())],
    ] as const) {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      weekdaySel.appendChild(o);
    }
    const weekdayTime = document.createElement('input');
    weekdayTime.type = 'time'; weekdayTime.value = '09:00';
    weeklyRow.appendChild(weekdaySel); weeklyRow.appendChild(weekdayTime);
    addField(str('automationSchedWeekly', getLang()), weeklyRow);

    const intervalRow = document.createElement('div');
    const everyValue = document.createElement('input');
    everyValue.type = 'number'; everyValue.min = '1'; everyValue.value = '30';
    const everyUnit = document.createElement('select');
    for (const [v, label] of [
      ['minute', str('automationUnitMinute', getLang())],
      ['hour', str('automationUnitHour', getLang())],
      ['day', str('automationUnitDay', getLang())],
    ] as const) {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      everyUnit.appendChild(o);
    }
    intervalRow.appendChild(everyValue); intervalRow.appendChild(everyUnit);
    addField(str('automationSchedInterval', getLang()), intervalRow);

    const cronInput = document.createElement('input');
    cronInput.type = 'text'; cronInput.placeholder = '0 9 * * *';
    addField(str('automationFieldCron', getLang()), cronInput);

    // Initialize schedule inputs from an existing automation (best-effort).
    if (edit) {
      if (edit.schedule?.type === 'interval') {
        scheduleSel.value = 'interval';
        const ms = edit.schedule.everyMs ?? 0;
        if (ms >= 86_400_000) { everyValue.value = String(Math.round(ms / 86_400_000)); everyUnit.value = 'day'; }
        else if (ms >= 3_600_000) { everyValue.value = String(Math.round(ms / 3_600_000)); everyUnit.value = 'hour'; }
        else { everyValue.value = String(Math.round(ms / 60_000)); everyUnit.value = 'minute'; }
      } else if (edit.schedule?.type === 'cron' && edit.schedule.expr) {
        const d = cronToDaily(edit.schedule.expr);
        if (d) { scheduleSel.value = 'daily'; dailyTime.value = d.time; }
        else { scheduleSel.value = 'cron'; cronInput.value = edit.schedule.expr; }
      }
    }

    const cwdInput = document.createElement('input');
    cwdInput.type = 'text'; cwdInput.value = edit?.cwd ?? getCurrentCwd();
    addField(str('automationFieldCwd', getLang()), cwdInput);

    const profileSel = document.createElement('select');
    for (const v of ['default', 'office']) {
      const o = document.createElement('option'); o.value = v; o.textContent = v;
      profileSel.appendChild(o);
    }
    profileSel.value = edit?.profile ?? 'default';
    addField(str('automationFieldProfile', getLang()), profileSel);

    const missPolicySel = document.createElement('select');
    for (const v of ['skip', 'catchup']) {
      const o = document.createElement('option'); o.value = v; o.textContent = v;
      missPolicySel.appendChild(o);
    }
    missPolicySel.value = edit?.missPolicy ?? 'skip';
    addField(str('automationFieldMissPolicy', getLang()), missPolicySel);

    const providerInput = document.createElement('input');
    providerInput.type = 'text'; providerInput.value = edit?.provider ?? '';
    addField(str('automationFieldProvider', getLang()), providerInput);

    const modelInput = document.createElement('input');
    modelInput.type = 'text'; modelInput.value = edit?.model ?? '';
    addField(str('automationFieldModel', getLang()), modelInput);

    // Show only the schedule controls relevant to the chosen mode.
    function syncScheduleVisibility(): void {
      dailyRow.classList.toggle('hidden', scheduleSel.value !== 'daily');
      weeklyRow.classList.toggle('hidden', scheduleSel.value !== 'weekly');
      intervalRow.classList.toggle('hidden', scheduleSel.value !== 'interval');
      cronInput.parentElement?.classList.toggle('hidden', scheduleSel.value !== 'cron');
    }
    scheduleSel.addEventListener('change', syncScheduleVisibility);
    syncScheduleVisibility();

    const actions = document.createElement('div');
    actions.className = 'automation-form-actions';
    dialog.appendChild(actions);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'automation-action-btn';
    cancelBtn.textContent = str('automationCancel', getLang());
    actions.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button'; saveBtn.className = 'automation-action-btn automation-action-primary';
    saveBtn.textContent = str('automationSave', getLang());
    actions.appendChild(saveBtn);

    function close(): void {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    function showError(msg: string): void {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }

    saveBtn.addEventListener('click', () => {
      errEl.classList.add('hidden');
      const name = nameInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!name) { showError(str('automationErrName', getLang())); return; }
      if (!prompt) { showError(str('automationErrPrompt', getLang())); return; }
      const schedule = buildSchedule(
        scheduleSel.value, dailyTime.value, weekdaySel.value, weekdayTime.value,
        everyValue.value, everyUnit.value, cronInput.value,
      );
      if (!schedule) { showError(str('automationErrSchedule', getLang())); return; }
      saveBtn.setAttribute('disabled', 'true');
      upsertAutomation({
        ...(edit ? { id: edit.id } : {}),
        name, prompt, schedule,
        enabled: edit ? edit.enabled : true,
        cwd: cwdInput.value.trim(),
        profile: profileSel.value,
        provider: providerInput.value.trim(),
        model: modelInput.value.trim(),
        missPolicy: missPolicySel.value,
      }).then((res) => {
        if (!res?.ok) { showError(res?.error ?? str('automationErrSave', getLang())); return; }
        close();
        void pull();
      }).catch(() => {
        showError(str('automationErrSave', getLang()));
      }).finally(() => {
        saveBtn.removeAttribute('disabled');
      });
    });

    nameInput.focus();
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

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'automation-action-btn automation-edit-btn';
      editBtn.textContent = str('automationsEdit', getLang());
      editBtn.addEventListener('click', () => openForm(aut));
      actions.appendChild(editBtn);

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
          cwd: aut.cwd,
          profile: aut.profile,
          provider: aut.provider,
          model: aut.model,
          missPolicy: aut.missPolicy,
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
