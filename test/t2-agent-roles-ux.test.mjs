/**
 * T2-1 UX — novices can discover, author and apply agent roles from the unified
 * workbench, without ever writing Markdown/YAML by hand.
 *
 * Covers:
 *   - main-side id safety + structured serialization (renderer sends no paths),
 *   - IPC validation of the new save/delete/refresh params,
 *   - the Agents page helpers (tools parsing, id grammar, spec normalization),
 *   - the mounted Agents view under happy-dom: template, role list, apply/clear,
 *     form validation, save + refresh, delete, and clean dispose.
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
  AGENT_TEMPLATE_MD, AGENT_TEMPLATE_FIELDS,
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
  assert.match(AGENT_TEMPLATE_MD, /^---\nname: My Assistant/);
  assert.equal(AGENT_TEMPLATE_FIELDS.scope, 'user');
});

// ── mounted page (happy-dom) ────────────────────────────────────────────────

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
after(() => win.close());

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeCtx(activeId = '') {
  let unsubscribed = false;
  return {
    sessionId: 's1',
    getUiLang: () => 'en',
    subscribe: () => { unsubscribed = true; return () => { unsubscribed = false; }; },
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

test('Agents page validates the form and saves via the injected bridge', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const saved = [];
  let refreshSeen = false;
  const ctx = makeCtx('');
  const dispose = mountAgentsPage(container, ctx, {
    listAgents: async (refresh) => { refreshSeen = refreshSeen || refresh === true; return { ok: true, agents: [] }; },
    saveAgent: async (spec) => { saved.push(spec); return { ok: true }; },
    applyRole: () => {},
    getActiveRole: () => '',
  });
  await tick();

  // "Use this template" opens a prefilled structured form (no Markdown writing).
  container.querySelector('[data-act="use-template"]').click();
  assert.ok(container.querySelector('.agent-form'));
  const idField = container.querySelector('[data-field="id"]');
  assert.equal(idField.value, 'my_assistant');

  // Invalid id → field error, no IPC call.
  idField.value = '../escape';
  container.querySelector('[data-act="save"]').click();
  await tick();
  assert.equal(saved.length, 0);
  assert.match(container.querySelector('.agent-err').textContent, /id/i);

  // Fix the id and save → bridge receives a clean spec, list refreshes, role applied.
  container.querySelector('[data-field="id"]').value = 'my_assistant';
  container.querySelector('[data-field="name"]').value = 'My Assistant';
  container.querySelector('[data-field="tools"]').value = 'read_text_file, git_status';
  container.querySelector('[data-act="save"]').click();
  await tick();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'my_assistant');
  assert.deepEqual(saved[0].tools, ['read_text_file', 'git_status']);
  assert.equal(refreshSeen, true, 'reload(true) bypasses the scan cache after a write');

  dispose();
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

test('index.html exposes one workbench entry, not a crowded tab strip / role dropdown', () => {
  const html = readFileSync(join(dist, 'static', 'index.html'), 'utf-8');
  assert.match(html, /id="btn-workbench"/);
  assert.match(html, /id="workbench-panel"/);
  assert.match(html, /id="sidebar-tabs"/); // shared segmented nav lives inside the panel
  assert.ok(!html.includes('id="agent-role-select"'), 'toolbar role dropdown removed');
  assert.match(html, /data-i18n="workbenchEntry"/);
});
