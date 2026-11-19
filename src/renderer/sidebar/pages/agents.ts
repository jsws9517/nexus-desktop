/**
 * Agent Roles workbench view.
 *
 * A single place for non-developers to see the config template, create/edit
 * roles through a structured form (no hand-written Markdown/YAML), and apply a
 * role to the CURRENT session. Roles live as Markdown files in
 * ~/.nexus/agents (user) or <cwd>/.nexus/agents (project); every filesystem
 * operation goes through main-process IPC — the renderer only sends validated
 * ids/fields, never a path.
 *
 * This view is mounted inside the unified "Workbench" panel as one of its
 * segmented sections (sub-agents / agents / automations / jobs / artifacts).
 * Dependency-injected like the other pages so the filter/form logic is unit
 * testable under happy-dom without Electron.
 */

import { STR } from '../../i18n.js';
import type { SidebarContext } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentView {
  id: string;
  name: string;
  description: string;
  tools?: string[];
  systemPrompt: string;
  source: 'user' | 'project';
  path: string;
  error?: string;
}

export interface AgentSpec {
  scope: 'user' | 'project';
  id: string;
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
}

export interface AgentsPageOptions {
  /** List user + project roles. `refresh` bypasses the main-side scan cache. */
  listAgents?: (refresh?: boolean) => Promise<{
    ok: boolean; agents: AgentView[]; reason?: string; error?: string;
  }>;
  saveAgent?: (spec: AgentSpec) => Promise<{ ok: boolean; error?: string; code?: string }>;
  deleteAgent?: (id: string, scope: 'user' | 'project') => Promise<{ ok: boolean; error?: string }>;
  /** Apply a role id ('' clears) to the active session. */
  applyRole?: (id: string) => void;
  /** Currently applied role id for the active session. */
  getActiveRole?: () => string;
  getUiLang?: () => string;
}

/** Starter values shown by "use template" — the raw Markdown is produced by
 *  serializeCustomAgent() main-side when the form is saved. */
export const AGENT_TEMPLATE_FIELDS = {
  scope: 'user' as const,
  id: 'my_assistant',
  name: 'My Assistant',
  description: 'When should this role be used?',
  tools: [] as string[],
  systemPrompt:
    'You are a helpful assistant.\n\n' +
    'Describe how this role should think, what it should focus on, and any rules it must follow. ' +
    'The role is advisory and can never override the baseline prompt, project constitution, or global rules.',
};

/** Raw Markdown template displayed to the user (mirrors serializeCustomAgent). */
export const AGENT_TEMPLATE_MD =
`---
name: My Assistant
description: When should this role be used?
tools: []          # empty = unrestricted; e.g. [read_text_file, git_status]
---
You are a helpful assistant.

Describe how this role should think, what it should focus on, and any rules it
must follow. The role is advisory and can never override the baseline prompt,
the project constitution, or global rules.`;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Parse the comma-separated tools field into a clean, deduped list. */
export function parseToolsInput(raw: string): string[] {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t, i, all) => all.indexOf(t) === i);
}

/** Validate a role id using the same grammar as main-side safeAgentId(). */
export function validRoleId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test((id ?? '').trim());
}

type FieldBag = Record<string, string>;

/** Read form fields into an AgentSpec. Invalid content is returned as-is so
 *  the caller can surface field-level errors before any IPC call. */
export function specFromFields(fields: FieldBag): AgentSpec {
  return {
    scope: fields.scope === 'project' ? 'project' : 'user',
    id: (fields.id ?? '').trim(),
    name: (fields.name ?? '').trim(),
    description: (fields.description ?? '').trim(),
    tools: parseToolsInput(fields.tools ?? ''),
    systemPrompt: (fields.systemPrompt ?? '').trim(),
  };
}

function label(key: string, lang: string, vars?: Record<string, string | number>): string {
  let out = STR[key]?.[lang as 'en' | 'zh-CN'] ?? STR[key]?.['zh-CN'] ?? key;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  return out;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// ── Page ────────────────────────────────────────────────────────────────────

export function mountAgentsPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: AgentsPageOptions = {},
): () => void {
  const listAgents = opts.listAgents ?? (() => Promise.resolve({ ok: false, agents: [], error: 'no bridge' }));
  const saveAgent = opts.saveAgent ?? (() => Promise.resolve({ ok: false, error: 'no bridge' }));
  const deleteAgent = opts.deleteAgent ?? (() => Promise.resolve({ ok: false, error: 'no bridge' }));
  const applyRole = opts.applyRole ?? (() => {});
  const getActiveRole = opts.getActiveRole ?? (() => '');
  const lang = (): string => ctx.getUiLang?.() ?? opts.getUiLang?.() ?? 'en';

  let agents: AgentView[] = [];
  let editing: (AgentSpec & { _new: boolean }) | null = null;
  let disposed = false;

  container.classList.add('agents-page');

  function formHtml(): string {
    if (!editing) return '';
    const e = editing;
    return `
      <div class="wb-card agent-form">
        <div class="row1"><b>${esc(label(e._new ? 'agentNewRole' : 'agentEditRole', lang()))}</b>
          <span class="wb-badge note">${esc(label('agentFormHint', lang()))}</span></div>
        <div class="agent-err" data-role="err"></div>
        <label class="af-label">${esc(label('agentId', lang()))}</label>
        <input data-field="id" value="${esc(e.id)}" ${e._new ? '' : 'readonly'} placeholder="reviewer" />
        <div class="af-grid">
          <div><label class="af-label">${esc(label('agentName', lang()))}</label>
            <input data-field="name" value="${esc(e.name)}" placeholder="${esc(label('agentName', lang()))}" /></div>
          <div><label class="af-label">${esc(label('agentScope', lang()))}</label>
            <select data-field="scope">
              <option value="user" ${e.scope === 'user' ? 'selected' : ''}>${esc(label('agentScopeUser', lang()))}</option>
              <option value="project" ${e.scope === 'project' ? 'selected' : ''}>${esc(label('agentScopeProject', lang()))}</option>
            </select></div>
        </div>
        <label class="af-label">${esc(label('agentDescription', lang()))}</label>
        <input data-field="description" value="${esc(e.description)}" placeholder="${esc(label('agentDescription', lang()))}" />
        <label class="af-label">${esc(label('agentTools', lang()))}</label>
        <input data-field="tools" value="${esc(e.tools.join(', '))}" placeholder="read_text_file, git_status" />
        <label class="af-label">${esc(label('agentPrompt', lang()))}</label>
        <textarea data-field="systemPrompt" rows="6">${esc(e.systemPrompt)}</textarea>
        <div class="agent-actions">
          <button type="button" class="btn ghost small" data-act="cancel">${esc(label('agentCancel', lang()))}</button>
          <button type="button" class="btn primary small" data-act="save">${esc(label('agentSave', lang()))}</button>
        </div>
      </div>`;
  }

  function render(): void {
    if (disposed) return;
    const active = getActiveRole();
    const activeAgent = agents.find((a) => a.id === active);
    const activeName = activeAgent?.name || (active ? active : label('agentRoleNone', lang()));

    const parts: string[] = [];
    parts.push(`<div class="agent-current">${active ? `<span class="ac-clear" data-act="clear">${esc(label('agentClear', lang()))}</span>` : ''}
      <span class="ac-cap">${esc(label('agentCurrent', lang()))}</span><br><b>${esc(activeName)}</b></div>`);

    parts.push(`<details class="wb-card agent-template" open>
      <summary>${esc(label('agentTemplateTitle', lang()))}</summary>
      <p class="wb-desc">${esc(label('agentTemplateHint', lang()))}</p>
      <pre>${esc(AGENT_TEMPLATE_MD)}</pre>
      <div class="agent-actions">
        <button type="button" class="btn small" data-act="use-template">${esc(label('agentUseTemplate', lang()))}</button>
      </div></details>`);

    parts.push(formHtml());

    parts.push(`<div class="wb-title">${esc(label('agentExisting', lang(), { n: agents.length }))}</div>`);
    if (agents.length === 0) {
      parts.push(`<div class="wb-empty">${esc(label('agentEmpty', lang()))}</div>`);
    } else {
      for (const a of agents) {
        const isActive = a.id === active;
        const tools = a.tools ?? [];
        parts.push(`<div class="wb-card agent-row ${isActive ? 'active' : ''}" data-id="${esc(a.id)}" data-source="${esc(a.source)}">
          <div class="row1">
            <span class="t">${esc(a.name)}</span>
            <span class="wb-badge ${a.source === 'project' ? 'project' : ''}">${esc(label(a.source === 'project' ? 'agentRoleProject' : 'agentRoleUser', lang()))}</span>
            ${isActive ? `<span class="wb-badge ok">${esc(label('agentCurrentBadge', lang()))}</span>` : ''}
          </div>
          <div class="wb-desc">${esc(a.description || '—')} · id: ${esc(a.id)}${a.error ? ` · ⚠ ${esc(a.error)}` : ''}</div>
          ${tools.length
            ? `<div class="wb-chips">${tools.map((t) => `<span class="wb-chip">${esc(t)}</span>`).join('')}</div>`
            : `<span class="wb-badge note">${esc(label('agentNoTools', lang()))}</span>`}
          <div class="agent-actions">
            <button type="button" class="btn small ${isActive ? '' : 'primary'}" data-act="apply" ${isActive ? 'disabled' : ''}>${isActive ? esc(label('agentApplied', lang())) : esc(label('agentApply', lang()))}</button>
            <button type="button" class="btn ghost small" data-act="edit">${esc(label('agentEdit', lang()))}</button>
            <button type="button" class="btn ghost small" data-act="delete">${esc(label('agentDelete', lang()))}</button>
          </div></div>`);
      }
    }
    container.innerHTML = parts.join('');
    bind();
  }

  function setErr(msg: string): void {
    const el = container.querySelector('.agent-err') as HTMLElement | null;
    if (el) el.textContent = msg;
  }

  function readFields(): FieldBag {
    const out: FieldBag = {};
    container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]')
      .forEach((el) => { out[el.dataset.field as string] = el.value; });
    return out;
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const spec = specFromFields(readFields());
    if (!validRoleId(spec.id)) { setErr(label('agentBadId', lang())); return; }
    if (!spec.name) { setErr(label('agentBadName', lang())); return; }
    const res = await saveAgent(spec);
    if (disposed) return;
    if (!res.ok) { setErr(res.error || label('agentSaveFailed', lang())); return; }
    editing = null;
    await reload(true);
    applyRole(spec.id);
  }

  async function reload(refresh = false): Promise<void> {
    const res = await listAgents(refresh);
    if (disposed) return;
    agents = Array.isArray(res.agents) ? res.agents : [];
    render();
  }

  function bind(): void {
    container.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
      el.addEventListener('click', () => void onAction(el.dataset.act as string, el));
    });
  }

  async function onAction(act: string, el: HTMLElement): Promise<void> {
    switch (act) {
      case 'use-template':
        editing = { ...AGENT_TEMPLATE_FIELDS, _new: true };
        render();
        break;
      case 'cancel':
        editing = null;
        render();
        break;
      case 'save':
        await save();
        break;
      case 'clear':
        applyRole('');
        render();
        break;
      case 'apply': {
        const row = el.closest('.agent-row') as HTMLElement | null;
        if (row?.dataset.id) { applyRole(row.dataset.id); render(); }
        break;
      }
      case 'edit': {
        const row = el.closest('.agent-row') as HTMLElement | null;
        const a = agents.find((x) => x.id === row?.dataset.id);
        if (a) {
          editing = {
            id: a.id, name: a.name, description: a.description,
            tools: a.tools ?? [], systemPrompt: a.systemPrompt,
            scope: a.source, _new: false,
          };
          render();
        }
        break;
      }
      case 'delete': {
        const row = el.closest('.agent-row') as HTMLElement | null;
        const a = agents.find((x) => x.id === row?.dataset.id);
        if (a) {
          const ok = typeof window === 'undefined' || !window.confirm
            ? true
            : window.confirm(label('agentConfirmDelete', lang(), { name: a.name }));
          if (!ok) break;
          const res = await deleteAgent(a.id, a.source);
          if (!res.ok && typeof window !== 'undefined' && window.alert) {
            window.alert(res.error || label('agentDeleteFailed', lang()));
          }
          await reload(true);
          if (getActiveRole() === a.id) applyRole('');
        }
        break;
      }
    }
  }

  void reload();

  // Re-render when the UI language changes at runtime (same hook other pages use).
  const offLang = ctx.subscribe
    ? ctx.subscribe((event) => { if ((event as { type?: string }).type === 'language_changed') render(); })
    : () => {};

  return () => {
    disposed = true;
    offLang();
    container.innerHTML = '';
    container.classList.remove('agents-page');
  };
}

export const AgentsPage = {
  id: 'agents',
  title: 'Agent Roles',
  titleKey: 'sidebarAgents',
  icon: '🤖',
  mount: mountAgentsPage,
} as const;
