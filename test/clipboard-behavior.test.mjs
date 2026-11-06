/**
 * Linux-style clipboard affordance tests for the chat surfaces.
 *
 * Covers src/renderer/clipboard-behavior.ts against happy-dom:
 *   - transcript-only selection detection,
 *   - select-to-copy after the selection settles,
 *   - Ctrl/Cmd+C on a transcript selection (and editable controls opting out),
 *   - middle-click copy + autoscroll suppression,
 *   - right-click paste on the composer only (picker buttons stay untouched).
 *
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

const { selectedTextIn, installHistorySelectionCopy, installRightClickPaste } = await import(
  pathToFileURL(join(dist, 'renderer', 'clipboard-behavior.js'))
);

after(() => win.close());

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function reset() {
  document.body.innerHTML = `
    <div id="messages"><p id="m1">hello transcript</p></div>
    <button id="btn-attach">+</button>
    <button id="btn-rag">◈</button>
    <textarea id="composer"></textarea>
    <p id="outside">outside text</p>`;
  win.getSelection().removeAllRanges();
  return {
    messages: document.getElementById('messages'),
    composer: document.getElementById('composer'),
  };
}

function select(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function keydownC(target, extra = {}) {
  return new win.KeyboardEvent('keydown', {
    key: 'c',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
}

function mouse(type, button) {
  return new win.MouseEvent(type, { button, bubbles: true, cancelable: true });
}

test('selectedTextIn only accepts a non-empty selection inside the transcript', () => {
  const { messages } = reset();

  select(document.getElementById('m1'));
  assert.equal(selectedTextIn(messages, win.getSelection()), 'hello transcript');

  select(document.getElementById('outside'));
  assert.equal(selectedTextIn(messages, win.getSelection()), '', 'outside selection ignored');

  win.getSelection().removeAllRanges();
  assert.equal(selectedTextIn(messages, win.getSelection()), '', 'collapsed selection ignored');
});

test('a settled transcript selection is copied to the clipboard silently', async () => {
  const { messages } = reset();
  const writes = [];
  const notices = [];
  const handle = installHistorySelectionCopy({
    root: messages,
    writeText: (text) => {
      writes.push(text);
      return { ok: true };
    },
    onCopied: (text, source) => notices.push(source),
    debounceMs: 5,
  });

  select(document.getElementById('m1'));
  document.dispatchEvent(new win.Event('selectionchange'));
  await tick(20);

  assert.deepEqual(writes, ['hello transcript']);
  assert.deepEqual(notices, [], 'select-to-copy stays quiet');
  handle.dispose();
});

test('Ctrl+C copies a transcript selection and yields in editable controls', async () => {
  const { messages, composer } = reset();
  const writes = [];
  const handle = installHistorySelectionCopy({
    root: messages,
    writeText: (text) => {
      writes.push(text);
      return { ok: true };
    },
    debounceMs: 9999,
  });

  select(document.getElementById('m1'));
  const ev = keydownC(document.body);
  document.body.dispatchEvent(ev);
  await tick();
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(writes, ['hello transcript']);

  // An editable control keeps its native copy semantics even while a stale
  // transcript selection exists.
  const inComposer = keydownC(composer);
  composer.dispatchEvent(inComposer);
  assert.equal(inComposer.defaultPrevented, false);
  assert.equal(writes.length, 1);

  handle.dispose();
});

test('middle-click copies the live selection and suppresses autoscroll', async () => {
  const { messages } = reset();
  const writes = [];
  const notices = [];
  const handle = installHistorySelectionCopy({
    root: messages,
    writeText: (text) => {
      writes.push(text);
      return { ok: true };
    },
    onCopied: (_text, source) => notices.push(source),
    debounceMs: 9999,
  });

  select(document.getElementById('m1'));
  const down = mouse('mousedown', 1);
  document.getElementById('m1').dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, 'autoscroll suppressed when a selection exists');

  const aux = mouse('auxclick', 1);
  document.getElementById('m1').dispatchEvent(aux);
  await tick();
  assert.equal(aux.defaultPrevented, true);
  assert.deepEqual(writes, ['hello transcript']);
  assert.deepEqual(notices, ['middle'], 'explicit copies notify the caller');

  // With no selection, middle-click keeps Chromium's default behaviour.
  win.getSelection().removeAllRanges();
  const plainDown = mouse('mousedown', 1);
  document.getElementById('m1').dispatchEvent(plainDown);
  assert.equal(plainDown.defaultPrevented, false);

  handle.dispose();
});

test('right-click on the composer replays the native paste command', async () => {
  const { composer } = reset();
  let pastes = 0;
  const handle = installRightClickPaste({
    input: composer,
    paste: () => {
      pastes += 1;
    },
  });

  const ev = mouse('contextmenu', 2);
  composer.dispatchEvent(ev);
  await tick();

  assert.equal(ev.defaultPrevented, true);
  assert.equal(pastes, 1);
  assert.equal(document.activeElement, composer, 'composer is focused before the paste command');
  handle.dispose();
});

test('right-click on the attach / RAG picker buttons is not hijacked', () => {
  reset();
  let pastes = 0;
  const composer = document.getElementById('composer');
  const handle = installRightClickPaste({
    input: composer,
    paste: () => {
      pastes += 1;
    },
  });

  for (const id of ['btn-attach', 'btn-rag']) {
    const ev = mouse('contextmenu', 2);
    document.getElementById(id).dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false, `${id} keeps its native context menu`);
  }
  assert.equal(pastes, 0);
  handle.dispose();
});
