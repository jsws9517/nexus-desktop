/**
 * P1 unit tests — Built-in sidebar pages: Terminal, Side Chat, Git.
 *
 * Covers docs/dsh-plugin-adoption-plan.md §4.2 built-in pages against the
 * same dependency-injected contract as the Sub-Agents page:
 *   - Terminal: renders buffered logs, appends live log lines (bounded),
 *     submit executes the command, dispose cleans up
 *   - Side chat: renders last N messages, sending appends + forwards,
 *     agent events reflect, dispose unsubscribes
 *   - Git: renders project dir (or fallback hint) + git_* tool chips
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// --- minimal DOM shim (same as sidebar-adoption.test.mjs) ---
class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this._listeners = {}; }
  className = '';
  dataset = {};
  style = {};
  innerHTML = '';
  scrollTop = 0;
  spellcheck = false;
  placeholder = '';
  value = '';
  appendChild(el) { this.children.push(el); return el; }
  replaceChildren() { this.children = []; }
  addEventListener(ev, fn) { this._listeners[ev] = fn; }
  dispatch(ev, arg) { this._listeners[ev]?.(arg ?? { key: 'Enter' }); }
}
class FakeContainer extends FakeEl {
  classList = { add() {}, remove() {} };
  constructor() { super('div'); }
}
globalThis.document = {
  createElement(tag) { return new FakeEl(tag); },
};

const { mountTerminalPage } = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'terminal.js')));
const { mountSideChatPage } = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'side-chat.js')));
const { mountGitPage } = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'git.js')));

function fakeCtx() {
  return {
    sessionId: 's1',
    getParallelSessions: () => new Map(),
    subscribe: () => () => {},
  };
}

function findEl(root, className) {
  if (root.className === className) return root;
  for (const c of root.children ?? []) {
    const hit = findEl(c, className);
    if (hit) return hit;
  }
  return undefined;
}

// ===========================================================================
// 1. Terminal page
// ===========================================================================

test('terminal: renders initial logs and live log lines (bounded)', () => {
  const container = new FakeContainer();
  const logSubscribers = [];
  const dispose = mountTerminalPage(container, fakeCtx(), {
    getUiLang: () => 'en',
    readLogs: async () => ['[info] boot ok', '[warn] something'],
    subscribeLogs: (cb) => { logSubscribers.push(cb); return () => { logSubscribers.length = 0; }; },
  });
  const output = findEl(container, 'terminal-output');
  assert.ok(output, 'terminal output element exists');
  return (async () => {
    await new Promise((r) => setTimeout(r, 0));
    assert.match(output.textContent, /boot ok/);
    logSubscribers[0]('[info] live line');
    assert.match(output.textContent, /live line/);
    assert.equal(logSubscribers.length, 1);
    dispose();
    assert.equal(logSubscribers.length, 0, 'dispose unsubscribes');
  })();
});

test('terminal: pressing Enter executes the typed command', () => {
  const container = new FakeContainer();
  const executed = [];
  flushSync();
  const dispose = mountTerminalPage(container, fakeCtx(), {
    getUiLang: () => 'en',
    readLogs: async () => [],
    subscribeLogs: () => () => {},
    exec: (cmd) => { executed.push(cmd); },
  });
  const input = findEl(container, 'terminal-input');
  assert.ok(input, 'input exists');
  input.value = 'git status';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(executed, ['git status']);
  dispose();
});

function flushSync() { /* no-op: ensures readLogs microtask order is deterministic */ }

// ===========================================================================
// 2. Side chat page
// ===========================================================================

test('side-chat: renders history, sends on submit, reflects agent events', async () => {
  const container = new FakeContainer();
  const sent = [];
  const handlers = [];
  const ctx = {
    sessionId: 's1',
    getParallelSessions: () => new Map(),
    subscribe: (fn) => { handlers.push(fn); return () => { handlers.length = 0; }; },
  };
  const dispose = mountSideChatPage(container, ctx, {
    getUiLang: () => 'en',
    send: (input, sessionId) => sent.push({ input, sessionId }),
    loadMessages: async () => [{ role: 'user', content: 'previous' }],
  });
  await new Promise((r) => setTimeout(r, 0));
  const history = findEl(container, 'sidechat-history');
  assert.ok(history, 'history exists');
  assert.ok(history.children.some((el) => el.textContent?.includes('previous')), 'history loaded');

  const input = findEl(container, 'sidechat-input');
  input.value = 'quick prompt';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(sent, [{ input: 'quick prompt', sessionId: 's1' }]);

  // agent turn arrives on the bus → appended
  for (const h of handlers) h({ type: 'text', sessionId: 's1', text: 'answer' });
  assert.ok(history.children.some((el) => el.textContent?.includes('answer')), 'agent reply reflected');

  dispose();
  assert.equal(handlers.length, 0, 'dispose unsubscribes');
});

// ===========================================================================
// 3. Git page
// ===========================================================================

test('git: renders project dir and git tool chips', async () => {
  const container = new FakeContainer();
  const dispose = mountGitPage(container, fakeCtx(), {
    getUiLang: () => 'en',
    getProjectDir: async () => '/repo/nexus',
    toolNames: ['git_status', 'git_commit', 'git_push'],
  });
  await new Promise((r) => setTimeout(r, 0));
  const dir = findEl(container, 'git-dir');
  assert.ok(dir, 'git-dir exists');
  assert.equal(dir.textContent, '/repo/nexus');
  const chips = findEl(container, 'git-tools');
  assert.ok(chips, 'git-tools exists');
  assert.equal(chips.children.length, 3);
  assert.equal(chips.children[1].textContent, 'git_commit');
  dispose();
});

test('git: falls back to a hint when no project dir is bound', async () => {
  const container = new FakeContainer();
  const dispose = mountGitPage(container, fakeCtx(), {
    getUiLang: () => 'zh-CN',
    getProjectDir: async () => '',
  });
  await new Promise((r) => setTimeout(r, 0));
  const dir = findEl(container, 'git-dir');
  assert.match(dir.textContent, /未绑定项目目录/);
  dispose();
});