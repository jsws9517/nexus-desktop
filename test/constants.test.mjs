import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_MASK,
  WORKER_MARKERS,
  EARLY_METHODS,
  isWorkerPrompt,
  isWorkerBlockText,
} from '../dist/shared/constants.js';

test('KEY_MASK is the expected placeholder', () => {
  assert.equal(KEY_MASK, '••••••••••••');
});

test('WORKER_MARKERS covers all four sub-agent dispatch markers', () => {
  assert.deepEqual(WORKER_MARKERS, [
    '[Project Directory]',
    '[Original Request]',
    '[Prior Task Results]',
    '[Role:',
  ]);
});

test('isWorkerPrompt flags worker-block user rows only', () => {
  assert.equal(isWorkerPrompt({ role: 'user', content: '[Project Directory] D:/x\nrest' }), true);
  assert.equal(isWorkerPrompt({ role: 'user', content: '[Role: coder] instructions' }), true);
  assert.equal(isWorkerPrompt({ role: 'user', content: 'a [Project Directory] b' }), true);
  assert.equal(isWorkerPrompt({ role: 'user', content: 'hello world' }), false);
  assert.equal(isWorkerPrompt({ role: 'assistant', content: '[Project Directory] x' }), false);
  assert.equal(isWorkerPrompt({ role: 'user', content: '' }), false);
});

test('isWorkerBlockText mirrors isWorkerPrompt for plain strings', () => {
  assert.equal(isWorkerBlockText('[Original Request] do the thing'), true);
  assert.equal(isWorkerBlockText('normal question'), false);
});

test('EARLY_METHODS contains the read-only fast-path methods', () => {
  for (const m of ['listSessions', 'getMessages', 'getConfig', 'getProviders', 'getStatus', 'getSessionStats', 'startSession']) {
    assert.ok(EARLY_METHODS.has(m), `expected ${m} in EARLY_METHODS`);
  }
  assert.ok(!EARLY_METHODS.has('chat'), 'chat must not be early');
});
