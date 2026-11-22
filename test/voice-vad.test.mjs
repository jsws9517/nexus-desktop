import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVadState, updateVad } from '../dist/renderer/voice-input.js';

/**
 * Drive the real conservative VAD frame by frame (60 fps) and report when the
 * controller's trailing-silence / pre-speech rules would fire. Mirrors
 * voice-input.ts: only confirmed voice frames refresh `lastVoiceAt`.
 */
function simulate(rmsAt, frames = 1800) {
  const vad = makeVadState();
  const dtMs = 1000 / 60;
  const preSilenceMs = 10_000;
  const silenceMs = 5_000;
  let lastVoiceAt = -Infinity;
  let voicedMs = 0;
  let peakFloor = vad.floor;

  for (let i = 0; i < frames; i++) {
    const now = i * dtMs;
    const rms = rmsAt(now / 1000);
    const frame = updateVad(vad, rms, dtMs);
    peakFloor = Math.max(peakFloor, frame.floor);
    if (frame.active) {
      lastVoiceAt = now;
      voicedMs += dtMs;
    }
    if (lastVoiceAt === -Infinity && now >= preSilenceMs) {
      return { result: 'no-speech', voicedMs, peakFloor };
    }
    if (lastVoiceAt > -Infinity && now - lastVoiceAt >= silenceMs) {
      return { result: 'transcribe', voicedMs, peakFloor };
    }
  }
  return { result: 'timeout', voicedMs, peakFloor };
}

const HUSH = 0.001;
const SPEECH = 0.03;
const QUIET_SPEECH = 0.01;
const LOW_NOISE = 0.008;
const NOISY_ROOM = 0.02;
const LOUD_SPEECH = 0.05;
const SPIKE = 0.08;
const MIN_SPEECH_MS = 300;

test('speech starting on the very first frame is detected (no poisoned floor)', () => {
  // Regression: the old mean-of-first-300ms calibration let immediate speech
  // inflate the floor, so the threshold rose above every later utterance and
  // the recorder always cancelled with "no speech detected".
  const r = simulate((s) => (s < 2 ? SPEECH : HUSH));
  assert.equal(r.result, 'transcribe');
  assert.ok(r.voicedMs > MIN_SPEECH_MS, `voicedMs=${r.voicedMs} should exceed the discard floor`);
});

test('sustained room noise below the voice-on threshold never starts a segment', () => {
  const r = simulate(() => LOW_NOISE);
  assert.equal(r.result, 'no-speech');
  assert.equal(r.voicedMs, 0);
});

test('covered-mic style spikes shorter than 150 ms never confirm speech', () => {
  // 100 ms of loud thump every second: each burst resets the onset counter,
  // so the 5 s trailing timer must not be held until the 120 s hard cap.
  const r = simulate((s) => (s % 1 < 0.1 ? SPIKE : HUSH));
  assert.equal(r.result, 'no-speech');
  assert.equal(r.voicedMs, 0);
});

test('spikes after a real utterance cannot postpone auto-transcription', () => {
  const r = simulate((s) => {
    if (s < 2) return SPEECH;
    return s % 1 < 0.1 ? SPIKE : HUSH;
  });
  assert.equal(r.result, 'transcribe');
  assert.ok(r.voicedMs > MIN_SPEECH_MS);
});

test('hysteresis keeps a sentence alive across a brief dip between thresholds', () => {
  const vad = makeVadState();
  const dtMs = 1000 / 60;
  const step = (rms, ms) => {
    let last;
    for (let t = 0; t < ms; t += dtMs) last = updateVad(vad, rms, dtMs);
    return last;
  };
  step(LOUD_SPEECH, 6000); // floor saturates at 0.012 → on 0.036, off 0.024
  assert.equal(vad.active, true);
  assert.ok(vad.offThreshold > 0.02, `off threshold ${vad.offThreshold} should exceed 0.02`);

  // 0.025 sits between off (0.024) and on (0.036): a single-threshold VAD would
  // drop the segment here; hysteresis must keep it voiced.
  const dipped = step(0.025, 200);
  assert.equal(dipped.active, true, 'a 200 ms dip above the off threshold must not end the segment');

  const ended = step(HUSH, 400);
  assert.equal(ended.active, false, '400 ms below the off threshold ends the segment');
});

test('the noise floor cannot collapse to zero on a single quiet frame', () => {
  const vad = makeVadState();
  const frame = updateVad(vad, 0, 1000 / 60);
  assert.ok(frame.floor > 0.001 && frame.floor < 0.002,
    `floor ${frame.floor} should fall at a limited rate, not instantly`);
});

test('a noisy room still permits clearly louder speech', () => {
  const r = simulate((s) => (s >= 1 && s < 3 ? LOUD_SPEECH : NOISY_ROOM));
  assert.equal(r.result, 'transcribe');
  assert.ok(r.voicedMs > MIN_SPEECH_MS);
});

test('very quiet speech is intentionally missed by VAD (manual stop is the fallback)', () => {
  // The user chose the conservative trade-off: 0.01-level speech does not
  // cross the 0.010 onset threshold, but a second mic click uses total audio
  // length and still transcribes it.
  const r = simulate((s) => (s >= 1 && s < 3 ? QUIET_SPEECH : HUSH));
  assert.equal(r.result, 'no-speech');
});

test('true silence still cancels with no-speech', () => {
  const r = simulate(() => HUSH);
  assert.equal(r.result, 'no-speech');
  assert.equal(r.voicedMs, 0);
});

test('the floor rises slowly enough that a normal utterance stays voiced', () => {
  const vad = makeVadState();
  const dtMs = 1000 / 60;
  let frame;
  for (let i = 0; i < 120; i++) frame = updateVad(vad, SPEECH, dtMs);
  // After 2 s of continuous speech the onset threshold must still be below the
  // speech level, otherwise the tail of the utterance stops counting as voiced.
  assert.ok(frame.onThreshold < SPEECH,
    `onThreshold ${frame.onThreshold} should stay below speech ${SPEECH}`);
  assert.equal(frame.active, true);
});
