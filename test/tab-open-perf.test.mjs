import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const src = (p) => readFileSync(join(dist, p), 'utf8');

/** Slice from the first occurrence of `start` (exclusive) to `end` (exclusive). */
function between(text, start, end) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `missing start marker: ${start}`);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end marker: ${end}`);
  return text.slice(a + start.length, b);
}

// ---------------------------------------------------------------------------
// P1: no duplicated init on a leased spare, transcript load off the critical path
// ---------------------------------------------------------------------------

test('a leased spare skips initAcp and loadSkills in both open() and openNew()', () => {
  const text = src('main/session-workers.js');
  let cursor = 0;
  let branches = 0;
  for (;;) {
    const at = text.indexOf('if (fromSpare) {', cursor);
    if (at < 0) break;
    const elseAt = text.indexOf('else {', at);
    assert.ok(elseAt >= 0, 'fromSpare branch must have an else counterpart');
    const spare = text.slice(at, elseAt);
    assert.ok(
      !/request\('initAcp'/.test(spare),
      'spare was warmed with initAcp — re-running it is pure latency',
    );
    assert.ok(
      !/request\('loadSkills'/.test(spare),
      'spare was warmed with loadSkills — re-running the scan is pure latency',
    );
    branches += 1;
    cursor = elseAt + 1;
  }
  assert.ok(branches >= 2, `expected spare branches in open()/openNew(), found ${branches}`);
});

test('open() registers the tab before awaiting startSession (background bind)', () => {
  const text = src('main/session-workers.js');
  const openBody = between(text, 'async open(sessionId', 'bindSessionInBackground(bound, sessionId) {');
  assert.ok(
    !/await[^\n]*request\('startSession'/.test(openBody),
    'startSession must not be awaited on the foreground open path',
  );
  assert.ok(
    /this\.bindSessionInBackground\(bound, sessionId\)/.test(openBody),
    'open() must fire the background bind after registering the tab',
  );
  assert.ok(
    /this\.map\.set\(sessionId, bound\)[\s\S]*this\.onChange\?\.\(this\.tabs\(\)\)/.test(openBody),
    'the tab must be registered/notified before the function returns',
  );
});

test('turn-producing RPCs gate on the background session bind', () => {
  const text = src('agent-worker.js');
  assert.ok(
    /SESSION_GATED_METHODS\.has\(req\.method\) && sessionReadyPromise/.test(text),
    'agent-worker must gate chat/steer/... on startSession completion',
  );
  assert.ok(
    /sessionReadyPromise = p/.test(text),
    'the startSession handler must publish its promise for the gate',
  );
});

test('extractor packages are imported on first RAG use, not on every worker boot', () => {
  const text = src('agent-worker.js');
  const early = between(text, "if (req.method === 'earlyInit')", '// C1: validate params');
  assert.ok(
    !/loadExtractorPackages\(/.test(early),
    'extractor imports must stay off the earlyInit/startup path',
  );
  assert.ok(/async function ensureExtractors\(\)/.test(text), 'lazy loader helper must exist');
  const helpers = text.match(/await ensureExtractors\(\)/g) ?? [];
  assert.ok(helpers.length >= 3, 'RAG handlers must trigger the lazy loader');
});

// ---------------------------------------------------------------------------
// P0: instant click feedback, history read off the global worker's event loop
// ---------------------------------------------------------------------------

test('getMessages is served straight from the session DB in main', () => {
  const text = src('ipc/register.js');
  assert.ok(
    /getMessageLast\(sessionId, params\.last\)/.test(text),
    'last-N history reads must bypass the global worker',
  );
  assert.ok(
    /getMessageWindow\(sessionId, offset, limit\)/.test(text),
    'paged history reads must bypass the global worker',
  );
});

test('a session click inserts an optimistic loading tab before the open RPC', () => {
  const text = src('renderer/renderer.js');
  const openBody = between(text, 'async function openTab(', "if (!res.ok) {");
  assert.ok(/openingSessions\.add\(sessionId\)/.test(openBody));
  assert.ok(/loading: true/.test(openBody), 'the optimistic chip must be marked loading');
  assert.ok(
    openBody.indexOf('renderTabBar()') < openBody.indexOf('openSession('),
    'the tab bar must render before the awaited openSession RPC',
  );
});
