/**
 * Unit tests for the composer slash-command autocomplete controller and its
 * pure helpers. Uses happy-dom so no Electron main process is needed.
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
// The controller dispatches `new Event('input')`; happy-dom requires its own
// Event implementation for dispatchEvent to accept it.
globalThis.Event = win.Event;

const {
  parseSlashToken,
  filterSlashCommands,
  SlashMenuController,
  SLASH_COMMANDS,
  DEFAULT_SLASH_CAP,
  MAX_SLASH_QUERY,
} = await import(pathToFileURL(join(dist, 'renderer', 'slash-menu.js')));

after(() => win.close());

function labels(lang = 'zh-CN') {
  const zh = lang === 'zh-CN';
  return {
    panelAria: zh ? 'Slash 命令候选' : 'Slash command candidates',
    hint: zh ? '↑↓ 选择' : '↑↓ navigate',
    categories: {
      session: zh ? '会话' : 'Session',
      model: zh ? '模型与权限' : 'Model & Permissions',
      tools: zh ? '工具' : 'Tools',
      tasks: zh ? '任务' : 'Tasks',
      other: zh ? '其他' : 'Other',
    },
    desc: (key) => (zh ? `中文:${key}` : `EN:${key}`),
  };
}

function setup() {
  document.body.innerHTML = `
    <textarea id="input"></textarea>
    <div id="panel" class="hidden" role="listbox"></div>`;
  const input = document.getElementById('input');
  const panel = document.getElementById('panel');
  const inputEvents = [];
  input.addEventListener('input', () => inputEvents.push(input.value));
  const controller = new SlashMenuController({ input, panel, labels: labels() });
  return { input, panel, controller, inputEvents };
}

function type(input, text) {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

function key(name) {
  return new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
}

// ---------- pure helpers ----------

test('parseSlashToken recognises only a leading command token', () => {
  assert.deepEqual(parseSlashToken('/', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(parseSlashToken('/mo', 3), { start: 0, end: 3, query: 'mo' });
  assert.deepEqual(parseSlashToken('  /mo', 5), { start: 2, end: 5, query: 'mo' });
  assert.deepEqual(parseSlashToken('\n/re', 4), { start: 1, end: 4, query: 're' });
});

test('parseSlashToken rejects URLs, mid-sentence slashes, args and trailing text', () => {
  assert.equal(parseSlashToken('http://x', 8), null);
  assert.equal(parseSlashToken('and/or', 6), null);
  assert.equal(parseSlashToken('hello /mo', 9), null);
  assert.equal(parseSlashToken('/model set x', 12), null);
  assert.equal(parseSlashToken('/mo x', 3), null);
  assert.equal(parseSlashToken('/' + 'a'.repeat(MAX_SLASH_QUERY + 1), MAX_SLASH_QUERY + 2), null);
});

test('filterSlashCommands matches canonical names, then aliases, and respects cap', () => {
  const all = filterSlashCommands(SLASH_COMMANDS, '');
  assert.equal(all.length, SLASH_COMMANDS.length);
  assert.deepEqual(all.slice(0, 3).map((c) => c.insert), ['new', 'session', 'info']);
  assert.equal(DEFAULT_SLASH_CAP, 50);

  assert.deepEqual(filterSlashCommands(SLASH_COMMANDS, 'mo').map((c) => c.insert), ['model']);
  assert.deepEqual(
    filterSlashCommands(SLASH_COMMANDS, 'models').map((c) => [c.insert, c.isAlias, c.command.name]),
    [['models', true, 'model']],
  );
  assert.deepEqual(filterSlashCommands(SLASH_COMMANDS, 'b').map((c) => c.insert), ['bypass', 'billing', 'bg']);
  assert.equal(filterSlashCommands(SLASH_COMMANDS, '', 2).length, 2);
  assert.deepEqual(filterSlashCommands(SLASH_COMMANDS, 'zzzz').map((c) => c.insert), []);
});

test('desktop-only and core commands are both present; CLI-only names are absent', () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  for (const name of ['new', 'model', 'plan', 'manual', 'chcwd', 'billing', 'compact', 'revise', 'commit']) {
    assert.ok(names.has(name), `missing supported command /${name}`);
  }
  for (const name of ['delete', 'context', 'btw', 'pasteimage', 'skill', 'flush', 'exit', 'quit']) {
    assert.ok(!names.has(name), `unsupported CLI-only command /${name} must not be offered`);
  }
});

// ---------- controller ----------

test('typing / opens a grouped panel and filters as characters are typed', () => {
  const { input, panel, controller } = setup();
  type(input, '/');
  assert.equal(controller.isOpen(), true);
  assert.equal(panel.classList.contains('hidden'), false);
  assert.ok(panel.querySelectorAll('.slash-menu-option').length >= 30);
  assert.ok(panel.querySelector('.slash-menu-group'));
  assert.match(panel.textContent, /会话/);

  type(input, '/mo');
  assert.equal(controller.isOpen(), true);
  assert.equal(panel.querySelectorAll('.slash-menu-option').length, 1);
  assert.equal(panel.querySelector('.slash-menu-name').textContent, '/model');
  assert.match(panel.textContent, /中文:slashDescModel/);
  controller.dispose();
});

test('ArrowUp/ArrowDown selects, Enter completes without sending, and fires input', () => {
  const { input, panel, controller, inputEvents } = setup();
  type(input, '/');
  input.dispatchEvent(key('ArrowDown'));
  const active = panel.querySelector('.slash-menu-option.active .slash-menu-name');
  assert.equal(active.textContent, '/session');
  input.dispatchEvent(key('ArrowUp'));
  assert.equal(panel.querySelector('.slash-menu-option.active .slash-menu-name').textContent, '/new');

  const before = inputEvents.length;
  const enter = key('Enter');
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, '/new ');
  assert.equal(input.selectionStart, 5);
  assert.equal(controller.isOpen(), false);
  assert.ok(inputEvents.length > before, 'a synthetic input event must refresh draft/autogrow');
  controller.dispose();
});

test('Tab completes an alias to the typed alias form', () => {
  const { input, controller } = setup();
  type(input, '/models');
  const tab = key('Tab');
  input.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(input.value, '/models ');
  assert.equal(controller.isOpen(), false);
  controller.dispose();
});

test('Escape and outside clicks close the menu without changing text', () => {
  const { input, panel, controller } = setup();
  type(input, '/mo');
  const esc = key('Escape');
  input.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(controller.isOpen(), false);
  assert.equal(input.value, '/mo');
  assert.equal(panel.classList.contains('hidden'), true);

  type(input, '/');
  document.body.dispatchEvent(new win.Event('mousedown', { bubbles: true }));
  assert.equal(controller.isOpen(), false);
  controller.dispose();
});

test('clicking an option completes it; typing args or ordinary text closes the menu', () => {
  const { input, panel, controller } = setup();
  type(input, '/mo');
  const opt = panel.querySelector('[data-slash-index="0"]');
  opt.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(input.value, '/model ');
  assert.equal(controller.isOpen(), false);

  type(input, '/model set');
  assert.equal(controller.isOpen(), false);
  type(input, 'hello world');
  assert.equal(controller.isOpen(), false);
  controller.dispose();
});

test('applyLanguage re-renders an open panel after a language switch', () => {
  const { input, panel, controller } = setup();
  type(input, '/');
  assert.match(panel.textContent, /中文:/);
  // Swap the option labels the controller reads, then ask it to re-render.
  controller.labels = labels('en');
  controller.applyLanguage();
  assert.match(panel.textContent, /EN:slashDescNew/);
  controller.dispose();
});
