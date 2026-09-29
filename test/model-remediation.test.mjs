/**
 * Regression tests — provider/model mismatch must not re-apply the global default.
 *
 * The reported bug: with a provider whose /models list does not advertise the
 * active model (e.g. provider `zen` on a `big-pickle` model), the desktop kept
 * forcing the globally configured model back onto the pair — on every tab switch,
 * every /models refetch, every app restart, and on every failed turn.
 *
 * Two independent causes are covered here:
 *   1. the once-only ledger was keyed by session alone, so a permanent mismatch
 *      was re-remediated forever (and a fallback off one model blocked the check
 *      for a different one);
 *   2. call-time remediation matched generic auth/quota failures. A bare "403
 *      Forbidden" says nothing about the model, and `localizeError()` rewrites it
 *      into 访问被拒绝（403）, so the old pattern matched BOTH and destroyed the
 *      real "model not available" wording in the process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { isModelUnavailableError, RemediationLedger } = await import(
  pathToFileURL(join(dist, 'renderer', 'model-remediation.js')),
);

const { localizeError } = await import(pathToFileURL(join(dist, 'renderer', 'i18n.js')));

// ---------------------------------------------------------------- ledger ----

test('a permanent provider/model mismatch is remediated exactly once per session', () => {
  const ledger = new RemediationLedger();
  const sid = 'sess-a';
  assert.equal(ledger.claim(sid, 'zen', 'big-pickle'), true, 'first sight remediated');
  // Tab switch, /models TTL refetch, app restart-in-the-same-process, retry...
  for (let i = 0; i < 50; i++) {
    assert.equal(ledger.claim(sid, 'zen', 'big-pickle'), false, 'never re-remediated');
  }
  assert.equal(ledger.has(sid, 'zen', 'big-pickle'), true);
});

test('a fallback off one model does not block evaluation of a different one', () => {
  const ledger = new RemediationLedger();
  assert.equal(ledger.claim('sess-a', 'zen', 'big-pickle'), true);
  // Session-keyed ledgers wrongly returned false here — the new model then never
  // got its own single evaluation.
  assert.equal(ledger.claim('sess-a', 'zen', 'glm-4.7'), true, 'new model evaluated');
  assert.equal(ledger.claim('sess-a', 'zen', 'glm-4.7'), false, 'and only once');
});

test('the ledger is per session — one tab does not disarm another', () => {
  const ledger = new RemediationLedger();
  assert.equal(ledger.claim('sess-a', 'zen', 'big-pickle'), true);
  assert.equal(ledger.claim('sess-b', 'zen', 'big-pickle'), true, 'other session unaffected');
});

test('the global (session-less) worker has its own ledger scope', () => {
  const ledger = new RemediationLedger();
  assert.equal(ledger.claim('', 'zen', 'big-pickle'), true);
  assert.equal(ledger.claim('', 'zen', 'big-pickle'), false);
  assert.equal(ledger.claim('sess-a', 'zen', 'big-pickle'), true, 'session scope is distinct');
});

test('an explicit user selection re-arms every pair of that session only', () => {
  const ledger = new RemediationLedger();
  ledger.claim('sess-a', 'zen', 'big-pickle');
  ledger.claim('sess-a', 'zen', 'glm-4.7');
  ledger.claim('sess-b', 'zen', 'big-pickle');

  ledger.rearmSession('sess-a');

  assert.equal(ledger.has('sess-a', 'zen', 'big-pickle'), false, 're-armed for a');
  assert.equal(ledger.has('sess-a', 'zen', 'glm-4.7'), false);
  assert.equal(ledger.has('sess-b', 'zen', 'big-pickle'), true, 'b untouched');
  assert.equal(ledger.claim('sess-a', 'zen', 'big-pickle'), true, 'fresh evaluation allowed');
});

test('an empty provider or model is never claimed', () => {
  const ledger = new RemediationLedger();
  assert.equal(ledger.claim('sess-a', 'zen', ''), false);
  assert.equal(ledger.claim('sess-a', '', 'big-pickle'), false);
});

// -------------------------------------------------- call-time error match ----

test('a genuine model-unavailable error is recognized', () => {
  const matched = [
    'Model is unavailable',
    'Model is not available',
    'The model `gpt-4o` does not exist',
    "error: model 'claude-x' not found",
    'model gpt-4o is no longer available',
    'model_not_found',
    'model-unavailable',
    'The requested model is deprecated',
    '模型 glm-4.7-flash 不可用',
    '模型不存在',
    '模型已下架',
    '该模型已下线',
  ];
  for (const msg of matched) {
    assert.equal(isModelUnavailableError(msg), true, `should match: ${msg}`);
  }
});

test('a generic auth / quota failure is NOT treated as a delisted model', () => {
  // Each of these used to force the global default back onto the active pair and
  // permanently blacklist the model id.
  const notMatched = [
    '403 Forbidden',
    'Error: 403',
    'forbidden',
    'You do not have access to this resource',
    '访问被拒绝（403）',
    '访问被拒绝',
    '401 Unauthorized',
    'authentication failed',
    'Invalid API key provided',
    '429 Too Many Requests',
    'rate limit exceeded for model gpt-4o',
    'ECONNRESET',
    'socket hang up',
  ];
  for (const msg of notMatched) {
    assert.equal(isModelUnavailableError(msg), false, `should NOT match: ${msg}`);
  }
});

test('an empty error never matches', () => {
  assert.equal(isModelUnavailableError(''), false);
});

test('the 403 collapse by localizeError is why raw text must be matched', () => {
  // Guards the premise behind matching rawError: a bare 403 becomes a string
  // that the OLD pattern (bare `403` + `访问被拒绝`) matched unconditionally,
  // while the real "model unavailable" wording is gone.
  const collapsed = localizeError('403 Forbidden');
  assert.match(collapsed, /403/);
  assert.doesNotMatch(collapsed, /model/i, 'real wording is discarded by the localizer');
  assert.equal(isModelUnavailableError(collapsed), false);
  // ...while the untouched original still identifies a delisted model.
  assert.equal(isModelUnavailableError('Model is unavailable for this region'), true);
});
