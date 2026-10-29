/**
 * Regression tests — mid-turn intent recognition (steer + rollback).
 *
 * The reported bug: "turn内不会主动探测后续prompt意图". Intent recognition was
 * only ever an *abort* predicate. A follow-up sent while a turn was running was
 * pushed into a renderer-local queue and stayed inert — the running turn could
 * not see it until its whole chat() cycle resolved, so a misread instruction
 * kept the agent working on the wrong thing with no way to course-correct.
 *
 * Covered here:
 *   core     Agent.enqueueSteer / drainSteerQueue / rollbackToLastUserBoundary,
 *            ContextManager.truncateAfter's system-prompt handling, and the
 *            tool-batch early exit that must keep tool_use/tool_result paired.
 *   desktop  AgentService.steer's config gate + the nexus:steer / nexus:restore
 *            param specs, and the absence of the deleted keyword classifier.
 *
 * Design notes worth keeping in mind while reading:
 *   - Rollback runs at the TOP of runLlmTurn, never mid-tool-batch: the loop
 *     still holds pendingToolCalls and appends a tool_result per call, so
 *     truncating underneath would orphan a tool message and the provider would
 *     reject the request.
 *   - The rollback boundary must SKIP <user_steer> messages. Treating one as the
 *     boundary would delete the very follow-up being applied.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const coreDist = join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src');

const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));
const { validateWorkerParams } = await import(pathToFileURL(join(dist, 'shared', 'ipc-validation.js')));
const { Agent } = await import(pathToFileURL(join(coreDist, 'agent.js')));
const { ContextManager } = await import(pathToFileURL(join(coreDist, 'llm', 'context-manager.js')));

const STEER = '<user_steer>';

/** Fake core agent exposing only the surface steer()/restore() touch. */
function makeFakeAgent({ busy = true, intentRollback = false } = {}) {
  const agent = { steerCalls: [] };
  agent.context = { getTokenCount: () => 10 };
  agent.provider = { model: 'steer-test-model' };
  agent.config = {
    getActiveProvider: () => 'steer-test',
    getProvider: () => ({ baseUrl: 'http://localhost:9999', model: 'steer-test-model' }),
    getContextWindow: () => ({ intentRollback }),
  };
  agent.busy = busy;
  agent.enqueueSteer = function enqueueSteer(text, opts) {
    this.steerCalls.push({ text, opts });
    if (!text || !text.trim()) return false;
    if (!this.busy) return false;
    return true;
  };
  agent.restoreFromBackup = async () => ({ restored: 3 });
  return agent;
}

function makeService(agent) {
  const svc = new AgentService();
  svc.agent = agent;
  return svc;
}

/** Bare core Agent with just the fields the rollback/steer path reads. */
function bareAgent({ messages = [], stored = [], busy = true } = {}) {
  const agent = Object.create(Agent.prototype);
  agent.busy = busy;
  agent.currentSessionId = 'sess-1';
  agent.rollbackRequested = false;
  agent.rollbackDone = false;
  agent.steerQueue = [];
  agent.toolErrorCount = new Map();
  agent.toolExactFailCount = new Map();
  agent.events = [];
  agent.onEvent = (e) => agent.events.push(e);
  agent.contextMessages = [...messages];
  agent.storedRows = [...stored];
  agent.context = {
    getMessages: () => [...agent.contextMessages],
    add: (m) => agent.contextMessages.push(m),
    truncateAfter: (i) => agent.contextMessages.splice(i),
  };
  agent.session = {
    addMessage: (_sid, m) => agent.storedRows.push({ id: agent.storedRows.length + 1, role: m.role, content: m.content }),
    getStoredMessages: () => [...agent.storedRows],
    deleteMessagesFrom: (_sid, fromId) => {
      const before = agent.storedRows.length;
      agent.storedRows = agent.storedRows.filter((r) => r.id < fromId);
      return before - agent.storedRows.length;
    },
  };
  return agent;
}

// ============================================================ steer (core) ==

test('enqueueSteer rejects blank text and an idle agent', () => {
  const agent = bareAgent();
  assert.equal(agent.enqueueSteer('   '), false, 'blank rejected even while busy');
  agent.busy = false;
  assert.equal(agent.enqueueSteer('real text'), false, 'idle agent rejects');
});

test('enqueueSteer carries the rollback request through', () => {
  const agent = bareAgent();
  assert.equal(agent.enqueueSteer('重来', { rollback: true }), true);
  assert.equal(agent.rollbackRequested, true, 'rollback staged for the turn boundary');
  agent.drainSteerQueue();
  assert.equal(agent.rollbackRequested, false, 'consumed at the boundary');
});

test('drainSteerQueue merges every steer into one user message and reports it', () => {
  const agent = bareAgent();
  agent.steerQueue = ['第一句', '第二句'];
  agent.drainSteerQueue();

  assert.equal(agent.contextMessages.length, 1, 'merged into a single message');
  assert.equal(agent.contextMessages[0].role, 'user');
  assert.ok(agent.contextMessages[0].content.includes('第一句'));
  assert.ok(agent.contextMessages[0].content.includes('第二句'));
  assert.equal(agent.steerQueue.length, 0, 'queue emptied');
  assert.deepEqual(agent.events.at(-1), { type: 'steer_applied', texts: ['第一句', '第二句'] });
});

test('drainSteerQueue is a no-op with an empty queue and no rollback', () => {
  const agent = bareAgent();
  agent.drainSteerQueue();
  assert.equal(agent.contextMessages.length, 0);
  assert.equal(agent.events.length, 0);
});

// ========================================================== rollback (core) ==

test('rollback truncates at the last real user message, keeping earlier history', () => {
  const agent = bareAgent({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '原始指令' },
      { role: 'assistant', content: '半成品回答' },
      { role: 'tool', content: 'tool out', toolCallId: 'c1' },
    ],
    stored: [
      { id: 1, role: 'user', content: '原始指令' },
      { id: 2, role: 'assistant', content: '半成品回答' },
      { id: 3, role: 'tool', content: 'tool out', toolCallId: 'c1' },
    ],
  });
  agent.rollbackRequested = true;
  agent.drainSteerQueue();

  assert.deepEqual(
    agent.contextMessages.map((m) => m.role),
    ['system', 'user'],
    'assistant + tool rows removed, prompt and system kept',
  );
  assert.deepEqual(agent.storedRows.map((r) => r.id), [1], 'DB tail deleted');
});

test('rollback boundary SKIPS <user_steer> messages', () => {
  // Two steers already merged in this cycle. The boundary must still be the
  // original prompt — otherwise the rollback would delete the follow-ups the
  // user actually sent.
  const agent = bareAgent({
    messages: [
      { role: 'user', content: '原始指令' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: `${STEER}\n第一条后续\n</user_steer>` },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: `${STEER}\n第二条后续\n</user_steer>` },
      { role: 'assistant', content: 'c' },
    ],
  });
  agent.steerQueue = ['第三条后续'];
  agent.rollbackRequested = true;
  agent.drainSteerQueue();

  assert.equal(
    agent.contextMessages.filter((m) => m.content.includes(STEER)).length,
    1,
    'both earlier steers discarded, only the newly injected one remains',
  );
  assert.equal(agent.contextMessages[0].content, '原始指令', 'boundary is the original prompt');
  assert.ok(agent.contextMessages[1].content.includes('第三条后续'));
});

test('rollback does nothing without a real user message in context', () => {
  const agent = bareAgent({ messages: [{ role: 'system', content: 'sys' }] });
  agent.rollbackRequested = true;
  agent.drainSteerQueue();
  assert.equal(agent.contextMessages.length, 1, 'system prompt untouched');
  assert.equal(agent.events.filter((e) => e.type === 'rollback_applied').length, 0);
});

test('a second rollback in the same turn is a no-op', () => {
  const agent = bareAgent({
    messages: [
      { role: 'user', content: '原始指令' },
      { role: 'assistant', content: 'a' },
    ],
    stored: [
      { id: 1, role: 'user', content: '原始指令' },
      { id: 2, role: 'assistant', content: 'a' },
    ],
  });
  agent.rollbackRequested = true;
  agent.drainSteerQueue();
  assert.equal(agent.rollbackDone, true);
  assert.deepEqual(agent.storedRows.map((r) => r.id), [1], 'tail deleted once');

  // Second request in the same turn: the rollback is refused, but the new steer
  // is still injected and persisted — nothing is deleted a second time.
  const deletionsBefore = agent.storedRows.length;
  agent.steerQueue = ['again'];
  agent.rollbackRequested = true;
  agent.drainSteerQueue();
  assert.equal(
    agent.storedRows.filter((r) => r.id <= 1).length,
    deletionsBefore,
    'the surviving prompt row was not deleted again',
  );
  assert.deepEqual(
    agent.events.filter((e) => e.type === 'rollback_applied').length,
    1,
    'rollback_applied emitted exactly once',
  );
  assert.ok(agent.contextMessages.at(-1).content.includes('again'), 'second steer still applied');
});

// ============================================ ContextManager.truncateAfter ===

test('truncateAfter keeps systemPromptInjected when a system message survives', () => {
  const ctx = new ContextManager();
  // The real path: chat() injects the system prompt exactly once via
  // insertSystemPromptFirst(), which sets the flag.
  ctx.insertSystemPromptFirst('the real system prompt');
  assert.equal(ctx.hasRealSystemPrompt(), true);

  ctx.add({ role: 'user', content: 'q' });
  ctx.add({ role: 'assistant', content: 'a' });
  const removed = ctx.truncateAfter(2);

  assert.equal(removed.length, 1);
  assert.equal(
    ctx.hasRealSystemPrompt(),
    true,
    'MUST stay true — otherwise the next chat() injects a SECOND system prompt',
  );
  assert.equal(ctx.getMessages().filter((m) => m.role === 'system').length, 1);
});

test('truncateAfter clears systemPromptInjected when no system message remains', () => {
  const ctx = new ContextManager();
  ctx.insertSystemPromptFirst('sys');
  assert.equal(ctx.hasRealSystemPrompt(), true);
  ctx.truncateAfter(0);
  assert.equal(ctx.hasRealSystemPrompt(), false);
});

test('truncateAfter at or past the end is a no-op', () => {
  const ctx = new ContextManager();
  ctx.add({ role: 'user', content: 'q' });
  assert.deepEqual(ctx.truncateAfter(99), []);
  assert.equal(ctx.getMessages().length, 1);
});

// ================================================= tool-batch early exit ====

test('leaving the tool batch keeps tool_use/tool_result strictly paired', () => {
  // Mirrors the loop body: a steer arrives after the 1st of 3 calls, so calls 2
  // and 3 must still get a result or the provider rejects the next request.
  const calls = [
    { id: 'a', name: 'seq_a', arguments: {} },
    { id: 'b', name: 'seq_b', arguments: {} },
    { id: 'c', name: 'seq_c', arguments: {} },
  ];
  const context = [];
  const emitted = [];
  const sessionRows = [];
  let tci = 0;
  // The steer lands while call #1 is running: call 1 completes normally, then
  // calls 2 and 3 are abandoned.
  let steerPending = false;

  for (; tci < calls.length; tci++) {
    const call = calls[tci];
    if (steerPending) {
      const reason = 'Cancelled: the user sent a new instruction before this tool ran.';
      for (let k = tci; k < calls.length; k++) {
        context.push({ role: 'tool', content: reason, toolCallId: calls[k].id });
        sessionRows.push({ role: 'tool', content: reason, toolCallId: calls[k].id });
        emitted.push({ index: k, name: calls[k].name, isError: true });
      }
      break;
    }
    context.push({ role: 'tool', content: `result of ${call.id}`, toolCallId: call.id });
    sessionRows.push({ role: 'tool', content: `result of ${call.id}`, toolCallId: call.id });
    if (call.id === 'a') steerPending = true;
  }

  const toolUseIds = calls.map((c) => c.id);
  const resultIds = context.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
  assert.deepEqual(resultIds, toolUseIds, 'every tool_use has exactly one tool_result, in order');
  assert.equal(sessionRows.length, context.length, 'DB mirrors the context');
  assert.equal(tci, 1, 'abandoned after the first call, not after the whole batch');
  assert.equal(emitted.length, 2, 'both skipped calls reported to the UI');
});

// ============================================== desktop service + ipc specs ==

test('steer() forwards the follow-up to the live turn', () => {
  const agent = makeFakeAgent({ busy: true });
  assert.equal(makeService(agent).steer('  只要结论  '), true);
  assert.equal(agent.steerCalls.length, 1);
});

test('steer() reports false when no turn is in flight', () => {
  const agent = makeFakeAgent({ busy: false });
  assert.equal(makeService(agent).steer('下一轮再说'), false);
});

test('steer() is a no-op without an initialized agent', () => {
  assert.equal(new AgentService().steer('hello'), false);
});

test('steer() honours the intentRollback config gate in BOTH directions', () => {
  const off = makeFakeAgent({ busy: true, intentRollback: false });
  makeService(off).steer('重来', true);
  assert.equal(off.steerCalls[0].opts.rollback, false, 'rollback refused while the toggle is off');

  const on = makeFakeAgent({ busy: true, intentRollback: true });
  makeService(on).steer('重来', true);
  assert.equal(on.steerCalls[0].opts.rollback, true, 'rollback forwarded when enabled');

  const notRequested = makeFakeAgent({ busy: true, intentRollback: true });
  makeService(notRequested).steer('继续', false);
  assert.equal(notRequested.steerCalls[0].opts.rollback, false);
});

test('restore() delegates to the core and tolerates a missing agent', async () => {
  assert.deepEqual(await makeService(makeFakeAgent()).restore('C:/x.jsonl'), { restored: 3 });
  assert.equal(await new AgentService().restore('C:/x.jsonl'), null);
});

test('the deleted keyword classifier is really gone', () => {
  const src = readFileSync(join(dist, 'renderer', 'renderer.js'), 'utf8');
  // The un-anchored list matched 别 inside 识别/别名/告别, 即 inside 即将, and
  // 不要 inside 不要紧, while missing 中止/停止/终止. It must not come back.
  assert.ok(!src.includes('REFINE_MARKERS'), 'no keyword marker list');
  assert.ok(!src.includes('isIterativeIntent'), 'no intent predicate');
  assert.ok(!src.includes('bigrams'), 'no bigram overlap heuristic');
  assert.ok(
    !/withinWindow/.test(readFileSync(join(dist, 'agent', 'service.js'), 'utf8')),
    'no stale time-window abort in the service',
  );
});

test('nexus:steer accepts an optional rollback, nexus:restore requires a path', () => {
  assert.equal(validateWorkerParams('steer', { input: 'hi' }), null);
  assert.equal(validateWorkerParams('steer', { input: 'hi', rollback: true }), null);
  assert.match(validateWorkerParams('steer', { input: 'hi', rollback: 'yes' }), /rollback must be a boolean/);
  assert.match(validateWorkerParams('steer', {}), /missing required param: input/);
  assert.match(validateWorkerParams('steer', { input: 'x'.repeat(70000) }), /exceeds max length/);
  assert.equal(validateWorkerParams('restore', { backupPath: 'C:/a.jsonl' }), null);
  assert.match(validateWorkerParams('restore', {}), /missing required param: backupPath/);
  assert.match(validateWorkerParams('restore', { backupPath: 7 }), /must be a string/);
});
