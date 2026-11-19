/**
 * T2-1 UX — novices can discover, author and apply agent roles from the unified
 * workbench, without ever writing Markdown/YAML by hand.
 *
 * Covers:
 *   - main-side id safety + structured serialization (renderer sends no paths),
 *   - IPC validation of the new save/delete/refresh params,
 *   - the Agents page helpers (tools parsing, id grammar, spec normalization),
 *   - the mounted Agents view under happy-dom: template, role list, apply/clear,
 *     modal form validation, save + refresh, delete, and clean dispose,
 *   - workbench registration order (automation/roles before the rest).
 */
import './sandbox-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const {
  safeAgentId, serializeCustomAgent, parseFrontmatter,
} = await import(pathToFileURL(join(dist, 'tools', 'custom-agents.js')).href);
const { validateMainLocalParams } = await import(
  pathToFileURL(join(dist, 'shared', 'ipc-validation.js')).href
);
const {
  agentTemplate, agentTemplateMd, isTemplateFields,
  AGENT_PRESETS, presetSpec, displayAgent,
  parseToolsInput, validRoleId, specFromFields, mountAgentsPage,
} = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'agents.js')).href);

// ── main-side id safety + serialization ─────────────────────────────────────

test('safeAgentId rejects traversal, separators and dot segments', () => {
  for (const bad of ['', '..', '.', '../evil', 'a/b', 'a\\b', 'a'.repeat(65), 'x y']) {
    assert.equal(safeAgentId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  // Surrounding whitespace is trimmed, not rejected (matches validRoleId).
  assert.equal(safeAgentId('  spaced  '), 'spaced');
  for (const good of ['reviewer', 'my_assistant', 'Role-2', '1a']) {
    assert.equal(safeAgentId(good), good);
  }
});

test('serializeCustomAgent round-trips through parseFrontmatter', () => {
  const md = serializeCustomAgent({
    name: 'Code Reviewer',
    description: 'Reviews "diffs" \\ lines',
    tools: ['read_text_file', 'git_status', 'read_text_file'],
    systemPrompt: 'You are a reviewer.\nOnly advise, never edit.',
  });
  const { attrs, body } = parseFrontmatter(md);
  assert.equal(attrs.name, 'Code Reviewer');
  assert.equal(attrs.description, 'Reviews "diffs" \\ lines');
  assert.deepEqual(attrs.tools, ['read_text_file', 'git_status']); // deduped
  assert.match(body, /You are a reviewer/);
  assert.match(body, /never edit/);

  // Empty tools → unrestricted marker, never a broken frontmatter list.
  const noTools = parseFrontmatter(serializeCustomAgent({
    name: 'Writer', description: '', tools: [], systemPrompt: 'Write docs.',
  }));
  assert.deepEqual(noTools.attrs.tools, []);
});

// ── IPC validation ──────────────────────────────────────────────────────────

test('new role IPC params: valid shapes pass, invalid rejected', () => {
  const base = { cwd: 'C:\\proj', scope: 'user', id: 'reviewer' };
  assert.equal(validateMainLocalParams('deleteCustomAgent', base), null);
  assert.match(validateMainLocalParams('deleteCustomAgent', { ...base, scope: 'root' }) ?? '', /scope/);
  assert.match(validateMainLocalParams('deleteCustomAgent', { scope: 'user', id: 'x' }) ?? '', /cwd/);

  const save = { ...base, name: 'Reviewer', description: '', tools: 'a, b', systemPrompt: 'body' };
  assert.equal(validateMainLocalParams('saveCustomAgent', save), null);
  assert.match(validateMainLocalParams('saveCustomAgent', { ...save, tools: 42 }) ?? '', /tools/);
  assert.match(validateMainLocalParams('saveCustomAgent', { ...save, systemPrompt: undefined }) ?? '', /systemPrompt/);

  assert.equal(validateMainLocalParams('listCustomAgents', { cwd: 'C:\\proj' }), null);
  assert.equal(validateMainLocalParams('listCustomAgents', { cwd: 'C:\\proj', refresh: true }), null);
  assert.match(validateMainLocalParams('listCustomAgents', { cwd: 'C:\\proj', refresh: 'yes' }) ?? '', /refresh/);
});

// ── page helpers ────────────────────────────────────────────────────────────

test('page helpers parse tools, validate ids and normalize form specs', () => {
  assert.deepEqual(
    parseToolsInput(' read_text_file, git_status,\n git_status , '),
    ['read_text_file', 'git_status'],
  );
  assert.equal(validRoleId('reviewer'), true);
  assert.equal(validRoleId('../evil'), false);
  assert.equal(validRoleId('a'.repeat(65)), false);
  assert.equal(validRoleId('a/b'), false);

  const spec = specFromFields({
    scope: 'project', id: ' writer ', name: ' Writer ',
    description: ' docs ', tools: 'a,b', systemPrompt: '  body  ',
  });
  assert.deepEqual(spec, {
    scope: 'project', id: 'writer', name: 'Writer', description: 'docs',
    tools: ['a', 'b'], systemPrompt: 'body',
  });
  assert.match(agentTemplateMd('en'), /^---\nname: My Assistant/);
  assert.match(agentTemplateMd('zh-CN'), /^---\nname: 我的助手/);
  assert.equal(agentTemplate('en').scope, 'user');
  assert.equal(agentTemplate('zh-CN').name, '我的助手');
  assert.equal(isTemplateFields({
    id: 'my_assistant', name: 'My Assistant', description: 'When should this role be used?',
    tools: '', systemPrompt: agentTemplate('en').systemPrompt,
  }, 'en'), true);
});

test('built-in presets are bilingual, id-safe and resolve to regular role specs', () => {
  assert.deepEqual(
    AGENT_PRESETS.map((p) => p.id),
    ['project_developer', 'code_reviewer', 'office_assistant', 'creative_writer'],
  );
  for (const preset of AGENT_PRESETS) {
    assert.equal(validRoleId(preset.id), true, `invalid preset id ${preset.id}`);
    const en = presetSpec(preset, 'en');
    const zh = presetSpec(preset, 'zh-CN');
    assert.equal(en.scope, 'user');
    assert.equal(zh.scope, 'user');
    assert.equal(en.id, preset.id);
    assert.equal(zh.id, preset.id);
    assert.notEqual(en.name, zh.name);
    assert.match(en.systemPrompt, /advisory/);
    assert.match(zh.systemPrompt, /建议/);
    assert.deepEqual(en.tools, []);
  }
});

test('installed built-in roles follow the UI language; renamed roles are preserved', () => {
  const preset = AGENT_PRESETS[0]; // project_developer
  const en = presetSpec(preset, 'en');
  const zh = presetSpec(preset, 'zh-CN');
  const installed = {
    id: preset.id, name: en.name, description: en.description,
    tools: [], systemPrompt: en.systemPrompt, source: 'user', path: '/x',
  };
  // Installed while English was active, viewed in Chinese -> Chinese display.
  assert.equal(displayAgent(installed, 'zh-CN').name, zh.name);
  assert.equal(displayAgent(installed, 'zh-CN').description, zh.description);
  // A hand-renamed role keeps its own name in every language.
  const renamed = { ...installed, name: 'My Personal Workflow' };
  assert.equal(displayAgent(renamed, 'zh-CN').name, 'My Personal Workflow');
  // Ordinary roles are returned verbatim.
  const custom = { ...installed, id: 'my_own', name: 'Custom' };
  assert.deepEqual(displayAgent(custom, 'en'), { name: 'Custom', description: en.description });
});

// ── mounted page (happy-dom) ────────────────────────────────────────────────

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
after(() => win.close());

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeCtx(activeId = '', initialLang = 'en') {
  let lang = initialLang;
  let unsubscribed = false;
  let autoHidePaused = false;
  const subs = [];
  return {
    sessionId: 's1',
    getUiLang: () => lang,
    setUiLang: (next) => { lang = next; subs.forEach((fn) => fn({ type: 'language_changed' })); },
    setAutoHidePaused: (paused) => { autoHidePaused = paused; },
    isAutoHidePaused: () => autoHidePaused,
    subscribe: (fn) => {
      subs.push(fn);
      unsubscribed = true;
      return () => { unsubscribed = false; };
    },
    getSubAgentRuns: () => new Map(),
    didUnsubscribe: () => unsubscribed,
  };
}

const TWO_ROLES = [
  {
    id: 'reviewer', name: 'Code Reviewer', description: 'Reviews diffs',
    tools: ['read_text_file', 'git_status'], systemPrompt: 'advise only',
    source: 'user', path: 'C:\\u\\reviewer.md',
  },
  {
    id: 'writer', name: 'Writer', description: 'Writes docs',
    tools: [], systemPrompt: 'write docs', source: 'project', path: 'C:\\p\\writer.md',
  },
];

test('Agents page shows template + role list, and applies/clears roles', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const applied = [];
  const ctx = makeCtx('reviewer');
  let listCalls = 0;
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async () => { listCalls += 1; return { ok: true, agents: TWO_ROLES }; },
    applyRole: (id) => applied.push(id),
    getActiveRole: () => (applied.at(-1) ?? 'reviewer'),
  });
  // allow the initial reload() microtask to settle
  await tick();

  assert.equal(listCalls, 1);
  assert.match(container.innerHTML, /name: My Assistant/); // template visible
  assert.equal(container.querySelectorAll('.agent-row').length, 2);
  assert.match(container.querySelector('.agent-current').textContent, /Code Reviewer/);

  // Apply the second (currently inactive) role.
  const writerRow = [...container.querySelectorAll('.agent-row')].find((r) => r.dataset.id === 'writer');
  writerRow.querySelector('[data-act="apply"]').click();
  assert.equal(applied.at(-1), 'writer');

  // Clear the active role.
  container.querySelector('[data-act="clear"]').click();
  assert.equal(applied.at(-1), '');

  dispose();
  assert.equal(container.innerHTML, '');
});

test('Agents page opens a modal editor, validates and saves via the injected bridge', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const saved = [];
  const applied = [];
  let refreshSeen = false;
  const ctx = makeCtx('');
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async (refresh) => { refreshSeen = refreshSeen || refresh === true; return { ok: true, agents: [] }; },
    saveAgent: async (spec) => { saved.push(spec); return { ok: true }; },
    applyRole: (id) => applied.push(id),
    getActiveRole: () => '',
  });
  await tick();

  // "Use this template" opens a roomy modal on <body>, not an inline form
  // squeezed into the narrow sidebar container.
  container.querySelector('[data-act="use-template"]').click();
  const overlay = document.querySelector('.agent-role-overlay');
  assert.ok(overlay, 'modal overlay exists');
  assert.ok(!container.contains(overlay), 'modal lives outside the sidebar container');
  const modal = overlay.querySelector('.agent-role-modal');
  assert.ok(modal, 'modal dialog exists');
  assert.equal(ctx.isAutoHidePaused(), true, 'idle collapse suspended while the dialog is open');
  const idField = modal.querySelector('[data-field="id"]');
  assert.equal(idField.value, 'my_assistant');
  assert.ok(!idField.hasAttribute('readonly'), 'new roles allow choosing an id');

  // Invalid id → field error, no IPC call.
  idField.value = '../escape';
  modal.querySelector('[data-act="save"]').click();
  await tick();
  assert.equal(saved.length, 0);
  assert.match(modal.querySelector('.agent-err').textContent, /id/i);

  // Fix the id and save → bridge receives a clean spec, list refreshes, role applied.
  modal.querySelector('[data-field="id"]').value = 'my_assistant';
  modal.querySelector('[data-field="name"]').value = 'My Assistant';
  modal.querySelector('[data-field="tools"]').value = 'read_text_file, git_status';
  modal.querySelector('[data-act="save"]').click();
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'my_assistant');
  assert.deepEqual(saved[0].tools, ['read_text_file', 'git_status']);
  assert.equal(refreshSeen, true, 'reload(true) bypasses the scan cache after a write');
  assert.equal(applied.at(-1), 'my_assistant');
  assert.equal(document.querySelector('.agent-role-overlay'), null, 'modal closes after save');
  assert.equal(ctx.isAutoHidePaused(), false, 'idle collapse resumed after save');

  dispose();
  container.remove();
});

test('Agents page modal locks the id when editing and supports Escape/backdrop/cancel', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = makeCtx('');
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async () => ({ ok: true, agents: TWO_ROLES }),
    saveAgent: async () => ({ ok: true }),
    applyRole: () => {},
    getActiveRole: () => '',
  });
  await tick();

  // Editing an existing role: fields prefilled, id locked (file name).
  const reviewer = [...container.querySelectorAll('.agent-row')].find((r) => r.dataset.id === 'reviewer');
  reviewer.querySelector('[data-act="edit"]').click();
  let modal = document.querySelector('.agent-role-modal');
  assert.ok(modal);
  assert.equal(ctx.isAutoHidePaused(), true);
  assert.match(modal.textContent, /Edit role/);
  assert.equal(modal.querySelector('[data-field="id"]').value, 'reviewer');
  assert.ok(modal.querySelector('[data-field="id"]').hasAttribute('readonly'));
  assert.equal(modal.querySelector('[data-field="name"]').value, 'Code Reviewer');

  // Escape dismisses the editor and unbinds its key handler.
  modal.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.agent-role-overlay'), null);
  assert.equal(ctx.isAutoHidePaused(), false, 'Escape resumes idle collapse');

  // Backdrop click dismisses.
  container.querySelector('[data-act="use-template"]').click();
  document.querySelector('.agent-role-overlay').click();
  assert.equal(document.querySelector('.agent-role-overlay'), null);

  // Cancel button dismisses.
  container.querySelector('[data-act="use-template"]').click();
  document.querySelector('.agent-role-modal [data-act="cancel"]').click();
  assert.equal(document.querySelector('.agent-role-overlay'), null);

  // Disposing with an open editor tears the modal down too.
  container.querySelector('[data-act="use-template"]').click();
  assert.ok(document.querySelector('.agent-role-overlay'));
  dispose();
  assert.equal(document.querySelector('.agent-role-overlay'), null);
  assert.equal(ctx.isAutoHidePaused(), false, 'dispose resumes idle collapse even with an open dialog');

  container.remove();
});

test('Agents page deletes a role via the bridge', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const deleted = [];
  const ctx = makeCtx('');
  win.confirm = () => true; // auto-confirm the delete prompt
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async () => ({ ok: true, agents: TWO_ROLES }),
    deleteAgent: async (id, scope) => { deleted.push([id, scope]); return { ok: true }; },
    applyRole: () => {},
    getActiveRole: () => '',
  });
  await tick();

  const reviewer = [...container.querySelectorAll('.agent-row')].find((r) => r.dataset.id === 'reviewer');
  reviewer.querySelector('[data-act="delete"]').click();
  await tick();
  await tick();
  assert.deepEqual(deleted, [['reviewer', 'user']]);

  dispose();
  container.remove();
});

test('template, built-ins and an untouched editor follow the UI language', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = makeCtx('', 'en');
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async () => ({ ok: true, agents: [] }),
    saveAgent: async () => ({ ok: true }),
    applyRole: () => {},
    getActiveRole: () => '',
  });
  await tick();

  assert.match(container.querySelector('.agent-template pre').textContent, /name: My Assistant/);
  assert.match(container.textContent, /Built-in roles/);
  assert.match(container.textContent, /Project Developer/);

  ctx.setUiLang('zh-CN');
  await tick();
  assert.match(container.querySelector('.agent-template pre').textContent, /name: 我的助手/);
  assert.match(container.textContent, /内置角色/);
  assert.match(container.textContent, /项目开发/);

  // Untouched new-role editor switches its prefilled fields with the language.
  container.querySelector('[data-act="use-template"]').click();
  let modal = document.querySelector('.agent-role-modal');
  assert.equal(modal.querySelector('[data-field="name"]').value, '我的助手');
  ctx.setUiLang('en');
  await tick();
  modal = document.querySelector('.agent-role-modal');
  assert.equal(modal.querySelector('[data-field="name"]').value, 'My Assistant');
  assert.equal(modal.querySelector('[data-field="systemPrompt"]').value, agentTemplate('en').systemPrompt);

  // Hand-edited values survive a later switch.
  modal.querySelector('[data-field="name"]').value = 'My Custom Role';
  ctx.setUiLang('zh-CN');
  await tick();
  modal = document.querySelector('.agent-role-modal');
  assert.equal(modal.querySelector('[data-field="name"]').value, 'My Custom Role');

  dispose();
  container.remove();
});

test('a built-in role installs on first use and applies to the current session', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const saved = [];
  const applied = [];
  let listCalls = 0;
  const reviewer = { ...TWO_ROLES[0], id: 'code_reviewer', name: 'Code Reviewer' };
  const ctx = makeCtx('');
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async () => {
      listCalls += 1;
      return { ok: true, agents: listCalls > 1 ? [reviewer] : [] };
    },
    saveAgent: async (spec) => { saved.push(spec); return { ok: true }; },
    applyRole: (id) => applied.push(id),
    getActiveRole: () => '',
  });
  await tick();

  const card = [...container.querySelectorAll('.agent-preset')]
    .find((c) => c.dataset.preset === 'code_reviewer');
  assert.ok(card, 'built-in card rendered');
  card.querySelector('[data-act="preset-use"]').click();
  await tick();
  await tick();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'code_reviewer');
  assert.equal(applied.at(-1), 'code_reviewer');
  assert.ok(
    container.querySelector('.agent-preset[data-preset="code_reviewer"] .wb-badge.ok'),
    'installed badge shown',
  );

  // A second click only applies — it must not re-write the role file.
  container.querySelector('.agent-preset[data-preset="code_reviewer"] [data-act="preset-use"]').click();
  await tick();
  assert.equal(saved.length, 1, 'no duplicate install');
  assert.equal(applied.at(-1), 'code_reviewer');

  dispose();
  container.remove();
});

test('index.html exposes one workbench entry, not a crowded tab strip / role dropdown', () => {
  const html = readFileSync(join(dist, 'static', 'index.html'), 'utf-8');
  assert.match(html, /id="btn-workbench"/);
  assert.match(html, /id="workbench-panel"/);
  assert.match(html, /id="sidebar-tabs"/); // shared segmented nav lives inside the panel
  assert.ok(!html.includes('id="agent-role-select"'), 'toolbar role dropdown removed');
  assert.match(html, /data-i18n="workbenchEntry"/);
});

test('workbench idle collapse is suspended while a page-owned dialog is open', () => {
  const renderer = readFileSync(join(__dirname, '..', 'src', 'renderer', 'renderer.ts'), 'utf-8');
  assert.match(renderer, /let sidebarAutoHidePaused = false;/);
  assert.match(renderer, /if \(sidebarAutoHidePaused \|\| activeSidebarTabId === null\) return;/);
  assert.match(renderer, /function setSidebarAutoHidePaused\(paused: boolean\): void \{/);
  assert.match(renderer, /setAutoHidePaused: setSidebarAutoHidePaused,/);
  assert.match(renderer, /hideSidebarPage\(\): void \{\s*sidebarAutoHidePaused = false;/);
});

test('workbench sections register in the requested display order', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'renderer', 'renderer.ts'), 'utf-8');
  const order = [...src.matchAll(/sidebarRegistry\.register\(\{\s*id:\s*(\w+Page)\.id/g)]
    .map((m) => m[1]);
  assert.deepEqual(order, ['AutomationPage', 'AgentsPage', 'JobsPage', 'SubAgentsPage', 'ArtifactsPage']);
});
