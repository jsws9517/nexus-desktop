/**
 * T1-2: unit tests for the composer @ mention controller and its pure helpers.
 * Covers token parsing, filtering/caps, keyboard state machine, folder
 * expansion, rule candidates and traversal rejection against happy-dom.
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
  parseAtToken,
  splitQueryPath,
  joinUnder,
  filterDirectoryEntries,
  pickFolderFiles,
  filterRuleEntries,
  AtMentionController,
} = await import(pathToFileURL(join(dist, 'renderer', 'at-mention.js')));

after(() => win.close());

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const CWD = 'D:/proj';

function setup(dirOverrides = {}, ruleFiles = []) {
  document.body.innerHTML = `
    <textarea id="input"></textarea>
    <div id="panel" class="hidden" role="listbox"></div>`;
  const input = document.getElementById('input');
  const panel = document.getElementById('panel');
  const dirs = {
    [CWD]: [
      { name: 'src', type: 'directory', size: 0 },
      { name: 'assets', type: 'directory', size: 0 },
      { name: 'README.md', type: 'file', size: 12 },
      { name: '.git', type: 'directory', size: 0 },
      { name: 'node_modules', type: 'directory', size: 0 },
      ...(dirOverrides[CWD] ?? []),
    ],
    [`${CWD}/src`]: [
      { name: 'utils', type: 'directory', size: 0 },
      { name: 'index.ts', type: 'file', size: 30 },
      { name: 'main.ts', type: 'file', size: 40 },
      ...(dirOverrides[`${CWD}/src`] ?? []),
    ],
    [`${CWD}/assets`]: Array.from({ length: 60 }, (_, i) => ({
      name: `img${String(i).padStart(2, '0')}.png`, type: 'file', size: 5,
    })),
    ...dirOverrides,
  };
  const calls = { dirs: [], rules: [], picked: [], overflow: [], errors: [] };
  const controller = new AtMentionController({
    input,
    panel,
    getCwd: () => CWD,
    listDirectory: async (root, path) => {
      calls.dirs.push(path);
      return { ok: true, entries: dirs[path] ?? [] };
    },
    listProjectRules: async (cwd) => {
      calls.rules.push(cwd);
      return { ok: true, files: ruleFiles };
    },
    onPick: (paths) => calls.picked.push(paths),
    onFolderOverflow: (cap, total) => calls.overflow.push([cap, total]),
    onError: (msg) => calls.errors.push(msg),
    labels: {
      file: 'File', directory: 'Folder', rule: 'Rule',
      invalidPath: 'invalid path', genericError: 'error',
    },
    debounceMs: 5,
  });
  return { input, panel, calls, controller };
}

function typeAt(input, text) {
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

function key(name) {
  return new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
}

// ---------- pure helpers ----------

test('parseAtToken recognises inline @ tokens and rejects emails', () => {
  assert.deepEqual(parseAtToken('hello @src/ut', 13), {
    start: 6, end: 13, query: 'src/ut', kind: 'file',
  });
  assert.equal(parseAtToken('mail a@b.com', 12), null);
  assert.equal(parseAtToken('plain text', 10), null);
  assert.equal(parseAtToken('name@x', 6), null);
  assert.equal(parseAtToken('@', 1).query, '');
  assert.equal(parseAtToken('@Rule', 5).kind, 'rule');
  assert.equal(parseAtToken('@规则foo', 5).kind, 'rule');
});

test('splitQueryPath / joinUnder reject traversal and absolute segments', () => {
  assert.deepEqual(splitQueryPath('src/ut'), { dirs: ['src'], namePart: 'ut' });
  assert.equal(joinUnder(CWD, ['src', 'utils']), `${CWD}/src/utils`);
  assert.equal(joinUnder(CWD, ['..', 'secret']), null);
  assert.equal(joinUnder(CWD, ['C:evil']), null);
  assert.equal(joinUnder('C:\\proj', ['src']), 'C:\\proj\\src');
});

test('filterDirectoryEntries: dirs first, hidden ignored, prefix filter, cap', () => {
  const entries = [
    { name: 'z.txt', type: 'file', size: 1, path: 'D:/proj/z.txt' },
    { name: 'src', type: 'directory', size: 0, path: 'D:/proj/src' },
    { name: '.git', type: 'directory', size: 0, path: 'D:/proj/.git' },
    { name: 'node_modules', type: 'directory', size: 0, path: 'D:/proj/node_modules' },
    { name: 'style.md', type: 'file', size: 2, path: 'D:/proj/style.md' },
  ];
  const out = filterDirectoryEntries(entries, '', 50);
  assert.deepEqual(out.map((c) => c.label), ['src/', 'style.md', 'z.txt']);
  assert.deepEqual(filterDirectoryEntries(entries, 'st', 50).map((c) => c.label), ['style.md']);
  assert.equal(filterDirectoryEntries(entries, '', 2).length, 2);
});

test('pickFolderFiles: files only, ignores hidden, reports un-capped total', () => {
  const entries = [
    { name: 'a.txt', type: 'file', size: 1, path: 'D:/proj/a.txt' },
    { name: '.env', type: 'file', size: 1, path: 'D:/proj/.env' },
    { name: 'sub', type: 'directory', size: 0, path: 'D:/proj/sub' },
    { name: 'b.txt', type: 'file', size: 1, path: 'D:/proj/b.txt' },
  ];
  const out = pickFolderFiles(entries, 1);
  assert.deepEqual(out.files.map((f) => f.name), ['a.txt']);
  assert.equal(out.total, 2);
});

test('filterRuleEntries strips the @Rule prefix and filters by name', () => {
  const entries = [
    { name: '.nexus/rules/NEXUS.md', path: 'D:/proj/.nexus/rules/NEXUS.md', size: 1 },
    { name: '.trae/rules/style.md', path: 'D:/proj/.trae/rules/style.md', size: 1 },
  ];
  // Token queries exclude the leading '@' (parseAtToken strips it).
  assert.deepEqual(filterRuleEntries(entries, 'Rule', 50).map((c) => c.label), [
    '.nexus/rules/NEXUS.md', '.trae/rules/style.md',
  ]);
  assert.deepEqual(filterRuleEntries(entries, '规则style', 50).map((c) => c.label), [
    '.trae/rules/style.md',
  ]);
  assert.equal(filterRuleEntries(entries, 'Rule', 1).length, 1);
});

// ---------- controller state machine ----------

test('typing @ opens the menu; arrow keys move the selection', async () => {
  const { input, panel, controller } = setup();
  typeAt(input, 'look at @');
  await tick();
  assert.equal(controller.isOpen(), true);
  assert.equal(panel.querySelectorAll('[role="option"]').length, 3);
  // Directories first, then alphabetical: assets/ before src/.
  assert.equal(panel.querySelector('.active')?.textContent.includes('assets/'), true);

  input.dispatchEvent(key('ArrowDown'));
  assert.equal(panel.querySelector('.active')?.textContent.includes('src/'), true);
  input.dispatchEvent(key('ArrowUp'));
  assert.equal(panel.querySelector('.active')?.textContent.includes('assets/'), true);
  controller.dispose();
});

test('Enter on a file consumes the key, attaches it and removes the @token', async () => {
  const { input, calls, controller } = setup();
  typeAt(input, 'look at @RE');
  await tick();
  assert.equal(controller.isOpen(), true);
  assert.deepEqual(panelLabels(), ['README.md']);

  const enter = key('Enter');
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true, 'Enter must be consumed, never sent');
  assert.equal(controller.isOpen(), false);
  assert.equal(input.value, 'look at ', 'the @token is removed from the composer');
  await tick();
  assert.deepEqual(calls.picked, [[`${CWD}/README.md`]]);
  controller.dispose();
});

test('Escape closes the menu and is consumed', async () => {
  const { input, controller } = setup();
  typeAt(input, '@');
  await tick();
  assert.equal(controller.isOpen(), true);
  const esc = key('Escape');
  input.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(controller.isOpen(), false);
  controller.dispose();
});

test('no candidates closes silently (no error toast)', async () => {
  const { input, calls, controller } = setup({ [CWD]: [] });
  typeAt(input, '@zzz');
  await tick();
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(calls.errors, []);
  controller.dispose();
});

test('@Rule uses listProjectRules and attaches the rule file path', async () => {
  const rule = { name: '.nexus/rules/NEXUS.md', path: `${CWD}/.nexus/rules/NEXUS.md`, size: 100 };
  const { input, calls, controller } = setup({}, [rule]);
  typeAt(input, '@规则');
  await tick();
  assert.deepEqual(calls.rules, [CWD]);
  assert.equal(controller.isOpen(), true);
  input.dispatchEvent(key('Enter'));
  await tick();
  assert.deepEqual(calls.picked, [[rule.path]]);
  controller.dispose();
});

test('folder expansion caps at 50 and reports overflow', async () => {
  const { input, calls, controller } = setup();
  typeAt(input, '@assets');
  await tick();
  assert.equal(controller.isOpen(), true);
  input.dispatchEvent(key('Enter'));
  await tick();
  assert.equal(calls.picked[0].length, 50);
  assert.deepEqual(calls.overflow, [[50, 60]]);
  controller.dispose();
});

test('traversal in the query is rejected without leaving cwd', async () => {
  const { input, calls, controller } = setup();
  typeAt(input, '@../secret');
  await tick();
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(calls.errors, ['invalid path']);
  assert.deepEqual(calls.dirs, []);
  controller.dispose();
});

test('nested @src/ut filters the second level via listDirectory cache', async () => {
  const { input, calls, controller } = setup();
  typeAt(input, '@src/ma');
  await tick();
  assert.equal(controller.isOpen(), true);
  assert.deepEqual(calls.dirs, [`${CWD}/src`]);
  assert.deepEqual(
    [...panelLabels()].filter((s) => s.includes('main')),
    ['main.ts'],
  );
  controller.dispose();
});

function panelLabels() {
  return [...document.querySelectorAll('#panel .at-mention-label')].map((e) => e.textContent);
}
