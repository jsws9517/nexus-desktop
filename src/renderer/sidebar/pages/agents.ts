/**
 * Agent Roles workbench view.
 *
 * A single place for non-developers to see the config template, create/edit
 * roles through a structured form (no hand-written Markdown/YAML), and apply a
 * role to the CURRENT session. Creation and editing happen in a roomy modal
 * dialog rather than an inline sidebar form, so the fields have space to breathe.
 * Roles live as Markdown files in ~/.nexus/agents (user) or <cwd>/.nexus/agents
 * (project); every filesystem operation goes through main-process IPC — the
 * renderer only sends validated ids/fields, never a path.
 *
 * This view is mounted inside the unified "Workbench" panel as one of its
 * segmented sections. Dependency-injected like the other pages so the filter,
 * form and modal logic are unit testable under happy-dom without Electron.
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

// ── Bilingual role content ───────────────────────────────────────────────────
// The UI language selects the variant shown in the template card, prefilled by
// "use template", and written when a built-in role is installed.

type Lang = 'zh-CN' | 'en';
type BiContent = { name: string; description: string; systemPrompt: string };
type TemplateContent = BiContent & { md: string };

export function isZhLang(lang: string): boolean {
  return lang === 'zh-CN' || lang.toLowerCase().startsWith('zh');
}
const variant = <T>(lang: string, zh: T, en: T): T => isZhLang(lang) ? zh : en;

const TEMPLATE: Record<Lang, TemplateContent> = {
  'zh-CN': {
    name: '我的助手',
    description: '什么时候使用这个角色？',
    systemPrompt:
      '你是一名乐于助人的助手。\n\n' +
      '在这里描述角色应如何思考、关注什么、遵守哪些规则。内容保持简短具体——角色只是建议，' +
      '不能放宽基础提示、项目宪法或全局规则。',
    md:
`---
name: 我的助手
description: 什么时候使用这个角色？
tools: []          # 留空 = 不限制；如 [read_text_file, git_status]
---
你是一名乐于助人的助手。

在这里描述角色应如何思考、关注什么、遵守哪些规则。内容保持简短具体——角色只是建议，
不能放宽基础提示、项目宪法或全局规则。`,
  },
  en: {
    name: 'My Assistant',
    description: 'When should this role be used?',
    systemPrompt:
      'You are a helpful assistant.\n\n' +
      'Describe how this role should think, what it should focus on, and any rules it must follow. ' +
      'The role is advisory and can never override the baseline prompt, project constitution, or global rules.',
    md:
`---
name: My Assistant
description: When should this role be used?
tools: []          # empty = unrestricted; e.g. [read_text_file, git_status]
---
You are a helpful assistant.

Describe how this role should think, what it should focus on, and any rules it
must follow. The role is advisory and can never override the baseline prompt,
the project constitution, or global rules.`,
  },
};

/** Starter fields shown by "use template" in the active UI language. The raw
 *  Markdown is produced by serializeCustomAgent() main-side when saved. */
export function agentTemplate(lang: string): AgentSpec {
  const c = variant(lang, TEMPLATE['zh-CN'], TEMPLATE.en);
  return {
    scope: 'user', id: 'my_assistant', name: c.name, description: c.description,
    tools: [], systemPrompt: c.systemPrompt,
  };
}

/** Raw Markdown template displayed in the quick-start card. */
export function agentTemplateMd(lang: string): string {
  return variant(lang, TEMPLATE['zh-CN'].md, TEMPLATE.en.md);
}

export interface AgentPreset {
  /** Stable user-scope file id. */
  id: string;
  content: Record<Lang, BiContent>;
}

/** Curated starter roles for common workflows. Installing one simply writes a
 *  regular user-scope role through the existing validated IPC, so it behaves
 *  exactly like a hand-authored role (editable, deletable, tool-scoped). */
export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: 'project_developer',
    content: {
      'zh-CN': {
        name: '项目开发',
        description: '拆解需求、编写代码、跑通测试并汇总改动',
        systemPrompt:
          '你是一名资深项目开发助手。先确认目标与约束，再拆解任务、逐步实现并验证结果。\n\n' +
          '- 优先复用现有代码与项目约定，改动尽量小而清晰。\n' +
          '- 每完成一步就运行相关检查或测试，发现问题先自查再汇报。\n' +
          '- 不做未经确认的破坏性操作。\n' +
          '- 该角色仅提供建议，不能放宽基础提示、项目宪法或全局规则。',
      },
      en: {
        name: 'Project Developer',
        description: 'Break down requirements, write code, run tests and summarize changes',
        systemPrompt:
          'You are a senior project development assistant. Confirm the goal and constraints first, ' +
          'then break the work into steps, implement them and verify the result.\n\n' +
          '- Reuse existing code and project conventions; keep changes small and clear.\n' +
          '- Run the relevant checks or tests after each step, and self-check before reporting.\n' +
          '- Never perform destructive actions without confirmation.\n' +
          '- This role is advisory and can never relax the baseline prompt, project constitution, or global rules.',
      },
    },
  },
  {
    id: 'code_reviewer',
    content: {
      'zh-CN': {
        name: '代码审查',
        description: '只读审阅改动，指出正确性、安全和可维护性问题',
        systemPrompt:
          '你是一名代码审查员。只分析代码并给出可执行建议，不要修改任何文件。\n\n' +
          '- 先用一句话说明改动目的，再按严重程度列出问题。\n' +
          '- 每个问题给出文件、位置和具体修复建议。\n' +
          '- 明确区分「必须修复」与「建议改进」。\n' +
          '- 该角色仅提供建议，不能放宽基础提示、项目宪法或全局规则。',
      },
      en: {
        name: 'Code Reviewer',
        description: 'Read-only review of changes for correctness, safety and maintainability',
        systemPrompt:
          'You are a code reviewer. Analyze code and give actionable advice only — never modify files.\n\n' +
          '- State the purpose of the change in one line, then list issues by severity.\n' +
          '- Give the file, location and a concrete fix for every issue.\n' +
          '- Clearly separate "must fix" from "nice to have".\n' +
          '- This role is advisory and can never relax the baseline prompt, project constitution, or global rules.',
      },
    },
  },
  {
    id: 'office_assistant',
    content: {
      'zh-CN': {
        name: '办公助理',
        description: '整理会议纪要、邮件、表格与日程，输出结构化文档',
        systemPrompt:
          '你是一名办公助理。把零散信息整理成清晰、可直接使用的文档。\n\n' +
          '- 使用标题、要点和表格，先给结论再给细节。\n' +
          '- 日期、人名和数字保持原样，不臆造缺失信息。\n' +
          '- 把需要人工确认的地方明确列为待办。\n' +
          '- 该角色仅提供建议，不能放宽基础提示、项目宪法或全局规则。',
      },
      en: {
        name: 'Office Assistant',
        description: 'Turn notes, email, tables and schedules into structured documents',
        systemPrompt:
          'You are an office assistant. Turn scattered information into clear, ready-to-use documents.\n\n' +
          '- Use headings, bullets and tables; lead with the conclusion.\n' +
          '- Keep dates, names and numbers verbatim; never invent missing facts.\n' +
          '- List anything needing human confirmation as an explicit follow-up.\n' +
          '- This role is advisory and can never relax the baseline prompt, project constitution, or global rules.',
      },
    },
  },
  {
    id: 'creative_writer',
    content: {
      'zh-CN': {
        name: '创作达人',
        description: '撰写与润色故事、文案和脚本，提供多版风格供选择',
        systemPrompt:
          '你是一名创作助手。围绕主题给出有画面感、有节奏的内容。\n\n' +
          '- 先确认受众、语气与篇幅，再动笔。\n' +
          '- 一次给出两到三个不同风格的版本供选择。\n' +
          '- 保留用户原文的核心信息，不擅自改变事实。\n' +
          '- 该角色仅提供建议，不能放宽基础提示、项目宪法或全局规则。',
      },
      en: {
        name: 'Creative Writer',
        description: 'Draft and polish stories, copy and scripts with multiple styles',
        systemPrompt:
          'You are a creative writing assistant. Produce vivid, well-paced content around the topic.\n\n' +
          '- Confirm audience, tone and length before writing.\n' +
          '- Offer two or three distinct style variants at once.\n' +
          '- Preserve the user\'s core information; never change facts without asking.\n' +
          '- This role is advisory and can never relax the baseline prompt, project constitution, or global rules.',
      },
    },
  },
];

/** Resolve a preset to a regular user-scope role spec in the active language. */
export function presetSpec(preset: AgentPreset, lang: string): AgentSpec {
  const c = variant(lang, preset.content['zh-CN'], preset.content.en);
  return {
    scope: 'user', id: preset.id, name: c.name, description: c.description,
    tools: [], systemPrompt: c.systemPrompt,
  };
}

/** Display name/description for an installed role. A built-in preset keeps
 *  showing in the CURRENT UI language even if it was installed while a
 *  different language was active — otherwise a Chinese and an English copy of
 *  the same preset sit side by side. A user-renamed role is left untouched. */
export function displayAgent(a: AgentView, lang: string): { name: string; description: string } {
  const preset = AGENT_PRESETS.find((p) => p.id === a.id);
  if (!preset) return { name: a.name, description: a.description };
  const presetNames = [preset.content['zh-CN'].name, preset.content.en.name];
  if (!presetNames.includes(a.name)) return { name: a.name, description: a.description };
  const spec = presetSpec(preset, lang);
  return { name: spec.name, description: spec.description };
}

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

/** True when a new-role form still holds the starter template of `lang`, i.e.
 *  the user has not edited it. Such a form follows the UI language on switch. */
export function isTemplateFields(fields: FieldBag, lang: string): boolean {
  const t = agentTemplate(lang);
  return (fields.id ?? '').trim() === t.id
    && (fields.name ?? '').trim() === t.name
    && (fields.description ?? '').trim() === t.description
    && (fields.systemPrompt ?? '').trim() === t.systemPrompt
    && parseToolsInput(fields.tools ?? '').join(',') === t.tools.join(',');
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
  let disposed = false;

  // Modal editor state — kept separate from the sidebar list render so opening
  // the editor never tears down the (idle-auto-hiding) workbench page.
  let editorSpec: (AgentSpec & { _new: boolean }) | null = null;
  let editorOverlay: HTMLElement | null = null;
  let editorKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Language the open editor was created in — used to detect untouched
   *  template values when the UI language switches. */
  let editorLang = lang();

  container.classList.add('agents-page');

  // ── Modal editor ──────────────────────────────────────────────────────────

  function editorHtml(spec: AgentSpec & { _new: boolean }): string {
    return `
      <div class="modal agent-role-modal" role="document" aria-labelledby="agent-role-modal-title">
        <div class="modal-head">
          <h3 id="agent-role-modal-title">${esc(label(spec._new ? 'agentNewRole' : 'agentEditRole', lang()))}</h3>
          <button type="button" class="btn ghost small icon-only" data-act="close" aria-label="${esc(label('agentCancel', lang()))}">✕</button>
        </div>
        <div class="agent-err" data-role="err"></div>
        <div class="ar-fields">
          <div class="ar-grid">
            <div class="ar-field"><label>${esc(label('agentId', lang()))}</label>
              <input class="modal-input" data-field="id" value="${esc(spec.id)}" ${spec._new ? '' : 'readonly'} placeholder="reviewer" /></div>
            <div class="ar-field"><label>${esc(label('agentName', lang()))}</label>
              <input class="modal-input" data-field="name" value="${esc(spec.name)}" placeholder="${esc(label('agentName', lang()))}" /></div>
          </div>
          <div class="ar-field"><label>${esc(label('agentScope', lang()))}</label>
            <select class="modal-input" data-field="scope">
              <option value="user" ${spec.scope === 'user' ? 'selected' : ''}>${esc(label('agentScopeUser', lang()))}</option>
              <option value="project" ${spec.scope === 'project' ? 'selected' : ''}>${esc(label('agentScopeProject', lang()))}</option>
            </select></div>
          <div class="ar-field"><label>${esc(label('agentDescription', lang()))}</label>
            <input class="modal-input" data-field="description" value="${esc(spec.description)}" placeholder="${esc(label('agentDescription', lang()))}" /></div>
          <div class="ar-field"><label>${esc(label('agentTools', lang()))}</label>
            <input class="modal-input" data-field="tools" value="${esc(spec.tools.join(', '))}" placeholder="read_text_file, git_status" /></div>
          <div class="ar-field"><label>${esc(label('agentPrompt', lang()))}</label>
            <textarea class="modal-input" data-field="systemPrompt" rows="7">${esc(spec.systemPrompt)}</textarea></div>
        </div>
        <div class="modal-actions">
          <span class="ar-hint">${esc(label('agentFormHint', lang()))}</span>
          <button type="button" class="btn ghost" data-act="cancel">${esc(label('agentCancel', lang()))}</button>
          <button type="button" class="btn primary" data-act="save">${esc(label('agentSave', lang()))}</button>
        </div>
      </div>`;
  }

  function bindEditor(overlay: HTMLElement): void {
    overlay.querySelector<HTMLElement>('[data-act="close"]')?.addEventListener('click', closeEditor);
    overlay.querySelector<HTMLElement>('[data-act="cancel"]')?.addEventListener('click', closeEditor);
    overlay.querySelector<HTMLElement>('[data-act="save"]')?.addEventListener('click', () => void saveEditor());
    // Clicking the dimmed backdrop dismisses the editor.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEditor(); });
  }

  function trapEditorKeys(e: KeyboardEvent, overlay: HTMLElement): void {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); return; }
    if (e.key !== 'Tab') return;
    const focusables = Array.from(overlay.querySelectorAll<HTMLElement>('button, input, select, textarea'))
      .filter((el) => !el.hasAttribute('disabled') && !el.hasAttribute('readonly'));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openEditor(spec: AgentSpec & { _new: boolean }): void {
    closeEditor();
    editorSpec = spec;
    editorLang = lang();
    // The dialog lives on <body>, outside the workbench's activity listeners.
    // Hold off idle folding so an unfinished edit is never torn down.
    ctx.setAutoHidePaused?.(true);
    const overlay = document.createElement('div');
    overlay.className = 'overlay agent-role-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = editorHtml(spec);
    document.body.appendChild(overlay);
    editorOverlay = overlay;
    bindEditor(overlay);
    editorKeyHandler = (e) => trapEditorKeys(e, overlay);
    document.addEventListener('keydown', editorKeyHandler, true);
    // Focus the first editable field for immediate typing.
    overlay.querySelector<HTMLElement>(spec._new ? '[data-field="id"]' : '[data-field="name"]')?.focus();
  }

  function closeEditor(): void {
    ctx.setAutoHidePaused?.(false);
    if (editorKeyHandler) document.removeEventListener('keydown', editorKeyHandler, true);
    editorOverlay?.remove();
    editorOverlay = null;
    editorKeyHandler = null;
    editorSpec = null;
  }

  function readEditorFields(): FieldBag {
    const out: FieldBag = {};
    editorOverlay?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-field]')
      .forEach((el) => { out[el.dataset.field as string] = el.value; });
    return out;
  }

  function editorErr(msg: string): void {
    const el = editorOverlay?.querySelector('.agent-err') as HTMLElement | null;
    if (el) el.textContent = msg;
  }

  async function saveEditor(): Promise<void> {
    if (!editorSpec) return;
    const spec = specFromFields(readEditorFields());
    if (!validRoleId(spec.id)) { editorErr(label('agentBadId', lang())); return; }
    if (!spec.name) { editorErr(label('agentBadName', lang())); return; }

    const saveBtn = editorOverlay?.querySelector<HTMLButtonElement>('[data-act="save"]');
    if (saveBtn) saveBtn.disabled = true;
    const res = await saveAgent(spec);
    if (disposed) return;
    if (!res.ok) {
      if (saveBtn) saveBtn.disabled = false;
      editorErr(res.error || label('agentSaveFailed', lang()));
      return;
    }
    closeEditor();
    await reload(true);
    applyRole(spec.id);
  }

  /** Rebuild the open editor in a new language. An untouched new-role form
   *  follows the template into the new language; hand-edited values are kept. */
  function refreshEditor(): void {
    if (!editorSpec || !editorOverlay) return;
    const fields = readEditorFields();
    const isNew = editorSpec._new;
    const followTemplate = isNew && isTemplateFields(fields, editorLang);
    editorSpec = followTemplate
      ? { ...agentTemplate(lang()), _new: true }
      : { ...specFromFields(fields), _new: isNew };
    editorLang = lang();
    const activeField = (document.activeElement as HTMLElement | null)?.dataset?.field;
    editorOverlay.innerHTML = editorHtml(editorSpec);
    bindEditor(editorOverlay);
    if (activeField) editorOverlay.querySelector<HTMLElement>(`[data-field="${activeField}"]`)?.focus();
  }

  // ── Sidebar list render ───────────────────────────────────────────────────

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
      <p class="wb-desc">${esc(label('agentLangHint', lang()))}</p>
      <pre>${esc(agentTemplateMd(lang()))}</pre>
      <div class="agent-actions">
        <button type="button" class="btn small" data-act="use-template">${esc(label('agentUseTemplate', lang()))}</button>
      </div></details>`);

    const installedIds = new Set(agents.map((a) => a.id));
    const presetCards = AGENT_PRESETS.map((preset) => {
      const spec = presetSpec(preset, lang());
      const installed = installedIds.has(preset.id);
      const inUse = active === preset.id;
      return `<div class="wb-card agent-preset ${inUse ? 'active' : ''}" data-preset="${esc(preset.id)}">
        <div class="row1">
          <span class="t">${esc(spec.name)}</span>
          <span class="wb-badge builtin">${esc(label('agentBuiltInBadge', lang()))}</span>
          ${installed ? `<span class="wb-badge ok">${esc(label('agentInstalled', lang()))}</span>` : ''}
        </div>
        <div class="wb-desc">${esc(spec.description)}</div>
        <div class="agent-actions">
          <button type="button" class="btn small ${inUse ? '' : 'primary'}" data-act="preset-use" ${inUse ? 'disabled' : ''}>${inUse ? esc(label('agentApplied', lang())) : esc(label('agentPresetUse', lang()))}</button>
          ${installed ? `<button type="button" class="btn ghost small" data-act="preset-edit">${esc(label('agentEdit', lang()))}</button>` : ''}
        </div></div>`;
    }).join('');
    parts.push(`<div class="wb-title">${esc(label('agentBuiltInTitle', lang()))}</div>
      <p class="wb-desc">${esc(label('agentBuiltInHint', lang()))}</p>
      <div class="agent-presets">${presetCards}</div>`);

    parts.push(`<div class="wb-title">${esc(label('agentExisting', lang(), { n: agents.length }))}</div>`);
    if (agents.length === 0) {
      parts.push(`<div class="wb-empty">${esc(label('agentEmpty', lang()))}</div>`);
    } else {
      for (const a of agents) {
        const isActive = a.id === active;
        const tools = a.tools ?? [];
        const shown = displayAgent(a, lang());
        parts.push(`<div class="wb-card agent-row ${isActive ? 'active' : ''}" data-id="${esc(a.id)}" data-source="${esc(a.source)}">
          <div class="row1">
            <span class="t">${esc(shown.name)}</span>
            <span class="wb-badge ${a.source === 'project' ? 'project' : ''}">${esc(label(a.source === 'project' ? 'agentRoleProject' : 'agentRoleUser', lang()))}</span>
            ${isActive ? `<span class="wb-badge ok">${esc(label('agentCurrentBadge', lang()))}</span>` : ''}
          </div>
          <div class="wb-desc">${esc(shown.description || '—')} · id: ${esc(a.id)}${a.error ? ` · ⚠ ${esc(a.error)}` : ''}</div>
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
        openEditor({ ...agentTemplate(lang()), _new: true });
        break;
      case 'preset-use': {
        const card = el.closest('.agent-preset') as HTMLElement | null;
        const preset = AGENT_PRESETS.find((p) => p.id === card?.dataset.preset);
        if (!preset) break;
        // Install on first use through the same validated IPC as a hand-authored
        // role; once present it behaves like any other editable role.
        if (!agents.some((a) => a.id === preset.id)) {
          const res = await saveAgent(presetSpec(preset, lang()));
          if (!res.ok) {
            if (typeof window !== 'undefined' && window.alert) {
              window.alert(res.error || label('agentPresetInstallFailed', lang()));
            }
            break;
          }
          await reload(true);
        }
        applyRole(preset.id);
        render();
        break;
      }
      case 'preset-edit': {
        const card = el.closest('.agent-preset') as HTMLElement | null;
        const preset = AGENT_PRESETS.find((p) => p.id === card?.dataset.preset);
        const a = agents.find((x) => x.id === preset?.id);
        if (a) {
          openEditor({
            id: a.id, name: a.name, description: a.description,
            tools: a.tools ?? [], systemPrompt: a.systemPrompt,
            scope: a.source, _new: false,
          });
        }
        break;
      }
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
          openEditor({
            id: a.id, name: a.name, description: a.description,
            tools: a.tools ?? [], systemPrompt: a.systemPrompt,
            scope: a.source, _new: false,
          });
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

  // Re-render the list AND any open editor when the UI language changes.
  const offLang = ctx.subscribe
    ? ctx.subscribe((event) => {
        if ((event as { type?: string }).type === 'language_changed') {
          render();
          refreshEditor();
        }
      })
    : () => {};

  return () => {
    disposed = true;
    offLang();
    closeEditor();
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
