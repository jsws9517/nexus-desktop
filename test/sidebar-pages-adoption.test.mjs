/**
 * P1 unit tests — Built-in sidebar pages: Side Chat.
 *
 * Covers docs/dsh-plugin-adoption-plan.md §4.2 built-in pages against the
 * same dependency-injected contract as the Sub-Agents page:
 *   - Side chat: sends the renderer-held transcript to the isolated `send`
 *     bridge, shows a pending bubble while waiting, replaces it with the
 *     single reply (no per-chunk event mirroring), handles failures, and
 *     dispose removes every DOM node.
 *
 * Terminal and Git pages were removed (鸡肋 panels); their regression
 * coverage is gone with them.
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

const { mountSideChatPage } = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'side-chat.js')));

function findEl(root, className) {
  if (root.className === className) return root;
  for (const c of root.children ?? []) {
    const hit = findEl(c, className);
    if (hit) return hit;
  }
  return undefined;
}

function msgTexts(history) {
  return history.children.map((el) => el.textContent).join('|');
}

test('side-chat: sends renderer-held transcript and stitches a single reply', async () => {
  const container = new FakeContainer();
  const sent = [];
  const dispose = mountSideChatPage(container, { sessionId: 's1' }, {
    getUiLang: () => 'en',
    send: async (messages) => {
      sent.push(messages);
      return 'single answer';
    },
  });
  const history = findEl(container, 'sidechat-history');
  const input = findEl(container, 'sidechat-input');
  assert.ok(history, 'history exists');

  input.value = 'quick prompt';
  input.dispatch('keydown', { key: 'Enter' });
  // A pending bubble is shown immediately (feedback while the worker replies).
  assert.ok(msgTexts(history).includes('thinking'), 'pending bubble shown');

  await new Promise((r) => setTimeout(r, 0));
  // The transcript sent must contain the user turn (renderer-held memory).
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], [{ role: 'user', content: 'quick prompt' }]);
  // Exactly one assistant bubble with the single reply — no per-chunk spam.
  assert.ok(msgTexts(history).includes('single answer'), 'reply stitched into one bubble');
  const userBubbles = history.children.filter((el) => el.textContent === 'quick prompt');
  const agentBubbles = history.children.filter((el) => el.textContent === 'single answer');
  assert.equal(userBubbles.length, 1);
  assert.equal(agentBubbles.length, 1);

  // Second turn carries the whole transcript (multi-turn memory).
  input.value = 'follow-up';
  input.dispatch('keydown', { key: 'Enter' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent[1], [
    { role: 'user', content: 'quick prompt' },
    { role: 'assistant', content: 'single answer' },
    { role: 'user', content: 'follow-up' },
  ]);

  dispose();
});

test('side-chat: send failure shows an error bubble and stays usable', async () => {
  const container = new FakeContainer();
  const dispose = mountSideChatPage(container, { sessionId: 's1' }, {
    getUiLang: () => 'en',
    send: async () => { throw new Error('busy'); },
  });
  const history = findEl(container, 'sidechat-history');
  const input = findEl(container, 'sidechat-input');

  input.value = 'will fail';
  input.dispatch('keydown', { key: 'Enter' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(msgTexts(history).includes('failed'), 'error bubble rendered');

  // Still able to send after a failure (pending flag released).
  input.value = 'retry';
  input.dispatch('keydown', { key: 'Enter' });
  assert.ok(msgTexts(history).includes('retry'), 'input usable after failure');
  dispose();
});

test('side-chat: no messages are loaded from the main session and no bus events are mirrored', async () => {
  const container = new FakeContainer();
  const handlers = [];
  const ctx = {
    sessionId: 's1',
    subscribe: (fn) => { handlers.push(fn); return () => { handlers.length = 0; }; },
  };
  const dispose = mountSideChatPage(container, ctx, { getUiLang: () => 'en', send: async () => 'ok' });
  await new Promise((r) => setTimeout(r, 0));
  const history = findEl(container, 'sidechat-history');
  const input = findEl(container, 'sidechat-input');
  // The page must start empty — it never pulls main-session history into view.
  assert.equal(history.children.length, 0, 'starts with an empty isolated transcript');
  // It subscribes ONLY for the renderer's language-control event; real session
  // events (chunks / turns) are ignored so nothing is mirrored into the transcript.
  assert.ok(handlers.length === 1, 'subscribes once (language control only)');

  input.value = 'prompt';
  input.dispatch('keydown', { key: 'Enter' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(history.children.length, 2, 'two bubbles after a turn');

  // A main-session streaming chunk must NOT appear (no mirroring).
  for (const h of handlers) h({ type: 'text', sessionId: 's1', text: 'echo' });
  assert.equal(history.children.length, 2, 'session chunk ignored');
  assert.ok(!msgTexts(history).includes('echo'), 'no chunk mirrored into side chat');

  dispose();
});

test('side-chat: re-paints static labels when the UI language changes', () => {
  // Live language is fed through ctx.getUiLang (renderer context) so the page
  // follows the running app language; the opts override is only for older tests.
  const container = new FakeContainer();
  const handlers = [];
  let lang = 'en';
  const input = () => findEl(container, 'sidechat-input');
  const title = () => findEl(container, 'sidechat-title')?.textContent ?? '';
  const dispose = mountSideChatPage(container, {
    sessionId: 's1',
    getUiLang: () => lang,
    subscribe: (fn) => { handlers.push(fn); return () => { handlers.length = 0; }; },
  }, { send: async () => 'ok' });
  try {
    assert.equal(title(), '💬 Side Chat', 'mounts in the current language');
    assert.match(input().placeholder, /quick prompt/, 'placeholder follows language');

    // Language switch (config window closed with a new language) → labels repaint
    // immediately, transcript content untouched.
    lang = 'zh-CN';
    for (const h of handlers) h({ type: 'language_changed' });
    assert.equal(title(), '💬 旁路聊天', 'title repainted in zh-CN');
    assert.match(input().placeholder, /快捷提问/, 'placeholder repainted');
  } finally {
    dispose();
  }
});