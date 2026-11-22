/**
 * Renderer-side interaction tests for the voice picker (no real mic / STT).
 * Covers the second-mic-click manual stop, the inert transcribing state, the
 * semi-hidden × across all stages, exact undo of the last transcript, its
 * 10 s-style expiry, and hiding the pre-existing running-status readout.
 * Needs `npm run build` first (imports dist/renderer/voice-input.js).
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
globalThis.Event = win.Event;

const { VoiceInputController } = await import(pathToFileURL(join(dist, 'renderer', 'voice-input.js')));

after(() => win.close());

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Minimal Web Audio graph: lets `start()` run for real without a mic, then
 *  lets a test deliver one synthetic frame. */
class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = {};
    FakeAudioContext.last = this;
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() {
    const node = { onaudioprocess: null, connect() {}, disconnect() {} };
    FakeAudioContext.lastProcessor = node;
    return node;
  }
  createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  resume() { return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

function setup(overrides = {}) {
  document.body.innerHTML = `
    <span id="input-status" class="running"></span>
    <div id="voice-box">
      <button id="btn-voice-clear" class="btn icon voice-clear"></button>
      <button id="btn-voice" class="btn icon"></button>
      <div id="voice-popover" class="voice-popover hidden">
        <span id="voice-provider"></span>
        <span id="voice-timer"></span>
        <div id="voice-bars"></div>
        <div id="voice-hint"></div>
      </div>
    </div>
    <textarea id="input"></textarea>`;

  const state = { errors: [], notices: [], fills: 0, stopCalls: [], startCalls: 0 };
  const controller = new VoiceInputController({
    button: document.getElementById('btn-voice'),
    clearButton: document.getElementById('btn-voice-clear'),
    popover: document.getElementById('voice-popover'),
    input: document.getElementById('input'),
    statusEl: document.getElementById('input-status'),
    transcribe: async () => ({ ok: true, text: '转写结果', provider: 'p', model: 'm' }),
    getProviderLabel: () => 'openai / whisper-1',
    onError: (m) => state.errors.push(m),
    onNotice: (m) => state.notices.push(m),
    onAfterFill: () => { state.fills++; },
    undoWindowMs: 40,
    ...overrides,
  });
  controller.setAvailable(true);
  return {
    controller,
    state,
    button: document.getElementById('btn-voice'),
    clear: document.getElementById('btn-voice-clear'),
    status: document.getElementById('input-status'),
    input: document.getElementById('input'),
    hint: document.getElementById('voice-hint'),
  };
}

test('a second mic click stops and transcribes; clicks while transcribing are ignored', async () => {
  const { controller, button, state } = setup();
  controller.start = async () => { state.startCalls++; };
  controller.stopAndTranscribe = async (manual) => { state.stopCalls.push(manual); };

  button.click();
  await tick();
  assert.equal(state.startCalls, 1, 'idle click starts recording');

  controller.setState('recording');
  button.click();
  await tick();
  assert.deepEqual(state.stopCalls, [true], 'recording click is a manual stop');

  controller.setState('transcribing');
  button.click();
  await tick();
  assert.deepEqual(state.stopCalls, [true], 'transcribing click does nothing');
});

test('× / running-status / tooltips follow the voice stage', () => {
  const { controller, button, clear, status } = setup();

  controller.setState('recording');
  controller.showClear();
  assert.equal(clear.classList.contains('visible'), true);
  assert.equal(status.classList.contains('voice-hidden'), true);
  assert.match(button.title, /停止并转写/);
  assert.match(clear.title, /取消本次录音/);
  // The mic is not delivering frames yet, so the popover must not claim it is
  // listening. See the dedicated first-frame test below.
  assert.match(document.getElementById('voice-hint').textContent, /启动中/);

  controller.setState('transcribing');
  assert.equal(status.classList.contains('voice-hidden'), true);
  assert.match(button.title, /正在转写/);
  assert.match(clear.title, /取消转写/);

  controller.setState('idle');
  assert.equal(status.classList.contains('voice-hidden'), false);
  assert.match(button.title, /语音输入/);
});

test('the popover says "starting" until the first captured audio frame', async () => {
  const originalNavigator = globalThis.navigator;
  const originalAudioContext = win.AudioContext;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
  });
  win.AudioContext = FakeAudioContext;
  try {
    const { controller, hint } = setup();
    await controller.start();
    assert.match(hint.textContent, /启动中/, 'no frames yet — do not tell the user to speak');

    FakeAudioContext.lastProcessor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array(1024) },
    });
    assert.match(hint.textContent, /聆听中/, 'first real frame flips the hint to listening');
    controller.close();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    win.AudioContext = originalAudioContext;
  }
});

test('× cancels recording and transcription without notifying the user', () => {
  const { controller, clear, state } = setup();

  controller.setState('recording');
  controller.showClear();
  const before = controller.transcribingToken;
  clear.click();
  assert.equal(controller.state, 'idle');
  assert.equal(clear.classList.contains('visible'), false);
  assert.equal(state.notices.length, 0);

  controller.setState('transcribing');
  controller.showClear();
  clear.click();
  assert.equal(controller.state, 'idle');
  assert.ok(controller.transcribingToken > before, 'pending STT result is invalidated');
  assert.equal(state.notices.length, 0);
});

test('inserted transcript is inserted at the caret and undo removes only that text', () => {
  const { controller, clear, input, state } = setup();
  input.value = '原有内容';
  input.setSelectionRange(4, 4);

  controller.insertText('新转写');
  assert.equal(input.value, '原有内容 新转写');
  assert.equal(clear.classList.contains('visible'), true);
  assert.equal(input.selectionStart, 8);
  assert.equal(state.fills, 1, 'autogrow / draft persistence ran on insert');

  clear.click();
  assert.equal(input.value, '原有内容');
  assert.equal(input.selectionStart, 4);
  assert.equal(clear.classList.contains('visible'), false);
  assert.equal(state.fills, 2, 'autogrow / draft persistence ran on undo');
});

test('undo refuses to delete transcript text the user has already edited', () => {
  const { controller, clear, input, state } = setup();
  input.value = '原有内容';
  input.setSelectionRange(4, 4);
  controller.insertText('新转写');

  // Edit *inside* the inserted span — the exact-string check must reject it.
  input.value = input.value.replace('新转写', '新X转写');
  clear.click();
  assert.equal(input.value, '原有内容 新X转写');
  assert.equal(clear.classList.contains('visible'), false);
  assert.ok(state.notices.some((m) => m.includes('内容已修改')), 'user is told why undo was skipped');
});

test('undo keeps text the user typed after the inserted span', () => {
  const { controller, clear, input } = setup();
  input.value = '原有内容';
  input.setSelectionRange(4, 4);
  controller.insertText('新转写');

  input.value += '后续内容';
  clear.click();
  assert.equal(input.value, '原有内容后续内容');
});

test('the undo affordance expires on its timer and on the next user edit', async () => {
  const { controller, clear, input } = setup();
  controller.insertText('第一段');
  await tick(90);
  assert.equal(clear.classList.contains('visible'), false, 'expired after the undo window');

  controller.insertText('第二段');
  assert.equal(clear.classList.contains('visible'), true);
  input.dispatchEvent(new Event('input'));
  assert.equal(clear.classList.contains('visible'), false, 'typing hides the undo affordance');
});

test('losing the STT provider disables the mic and clears any affordance', () => {
  const { controller, button, clear, state } = setup();
  controller.setState('recording');
  controller.showClear();
  controller.setAvailable(false);
  assert.equal(button.disabled, true);
  assert.equal(controller.state, 'idle');
  assert.equal(clear.classList.contains('visible'), false);
  assert.ok(state.notices.some((m) => m.includes('未配置 STT')));
});
