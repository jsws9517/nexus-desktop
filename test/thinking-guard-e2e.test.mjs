/**
 * End-to-end verification of the thinking-guard + token-accounting chain
 * (docs/implementation-schedule.md §6 空转幻觉防护).
 *
 * Drives the REAL AgentService wiring — the exact bridge `earlyInit()`
 * installs (`this.agent.onEvent -> this.handleAgentEvent`, service.ts:570) —
 * with a fake core agent that replays scripted nexus-coder events. This proves
 * the full production chain without needing a live LLM:
 *
 *   core event stream -> handleAgentEvent -> TurnMonitor -> checkStall
 *     -> handleThinkingStall -> onEvent('thinking_stall') (renderer consumes)
 *
 *  - loop: 6 identical thinking deltas => single stall, aborting=true, agent.abort()
 *  - idle: ~10k chars of distinct thinking, no text/tool => single stall,
 *    aborting=false, NO abort
 *  - healthy: interleaved text resets progress => no stall at all
 *  - noise: whitespace/U+FFFD deltas dropped (never forwarded, never counted)
 *  - calibration: 5 identical deltas do NOT fire (threshold is exactly 6)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));

/** Minimal fake core agent exposing the exact surface AgentService touches:
 *  `onEvent` (the bridge earlyInit sets), `chat()`, `abort()`,
 *  `context.getTokenCount()`, `provider.model`. */
function makeFakeAgent() {
  const agent = {};
  agent.context = { getTokenCount: () => 130 };
  agent.provider = { model: 'e2e-test-model' };
  agent.aborted = 0;
  agent.chatInputs = [];
  agent.script = [];
  agent.onEvent = null;
  agent.chat = async function chat(input) {
    agent.chatInputs.push(input);
    for (const e of agent.script) agent.onEvent?.(e);
  };
  agent.abort = function abort() {
    agent.aborted += 1;
  };
  return agent;
}

/** Build a service wired exactly like earlyInit() + a fake agent whose chat()
 *  replays `script`. Collects every event the service emits externally. */
function makeService(script) {
  const svc = new AgentService();
  const emitted = [];
  svc.onEvent = (e) => emitted.push(e);
  const fake = makeFakeAgent();
  fake.script = script;
  svc.agent = fake; // private field, erased at runtime
  fake.onEvent = (event) => svc.handleAgentEvent(event); // service.ts:570 bridge
  return { svc, fake, emitted };
}

const stallsOf = (emitted) => emitted.filter((e) => e.type === 'thinking_stall');

// ===========================================================================
// 1. Loop 空转循环 — the degenerate "hallucination spin"
// ===========================================================================

test('e2e loop: six identical thinking deltas emit ONE loop stall and abort the turn', async () => {
  const script = [
    { type: 'turn_start', turn: 1 },
    ...Array.from({ length: 6 }, () => ({
      type: 'thinking',
      thinking: 'repeating hallucination spin text without any new info',
    })),
    { type: 'text', text: 'late output (fake replays it regardless of abort)' },
  ];
  const { svc, fake, emitted } = makeService(script);
  const usage = await svc.runTurn('user prompt');

  const stalls = stallsOf(emitted);
  assert.equal(stalls.length, 1, 'fires exactly once per turn');
  assert.equal(stalls[0].reason, 'loop');
  assert.equal(stalls[0].aborting, true, 'loop aborts to stop the token burn');
  assert.equal(stalls[0].repeatCount, 6);
  assert.ok(stalls[0].thinkingTokens > 0, 'real token estimate, not zero');

  assert.equal(fake.aborted, 1, 'core abort() was invoked');
  assert.deepEqual(fake.chatInputs, ['user prompt']);

  // real (estimated) accounting flows out of runTurn, not hardcoded zeros
  assert.equal(usage.prompt, 130, 'prompt baseline from context.getTokenCount()');
  assert.ok(usage.completion > 0);
  assert.ok(usage.thinkingEstimate > 0);
  assert.equal(usage.thinkingDeltas, 6);
});

test('e2e calibration: 5 identical deltas do NOT fire (threshold is exactly 6)', async () => {
  const script = Array.from({ length: 5 }, (_, i) => ({
    type: 'thinking',
    thinking: `near-miss reasoning chunk ${i}`,
  }));
  // all five differ -> not a loop by delta-count alone; must stay silent
  const scriptLoop = {
    type: 'thinking',
    thinking: 'exact repeated block over and over inside the loop',
  };
  const loopScript = [scriptLoop, scriptLoop, scriptLoop, scriptLoop, scriptLoop];
  for (const s of [script, loopScript]) {
    const { svc, fake, emitted } = makeService(s);
    await svc.runTurn('p');
    assert.equal(stallsOf(emitted).length, 0, 'no stall below the threshold');
    assert.equal(fake.aborted, 0);
  }
});

// ===========================================================================
// 2. Idle 无进展思考 — warn only, never abort
// ===========================================================================

test('e2e idle: ~10k chars of distinct thinking without progress emits ONE idle warning, no abort', async () => {
  // each delta ~200 chars, ALL distinct from the first normalized char
  // (loop detection keeps only the first 64 chars -> the index MUST lead the
  //  line so the fingerprints differ). 56 × ~197 chars ≈ 11k chars
  // -> estimateTokens ≈ 2700 >= idleThinkingTokens(2500)@default
  const deltas = Array.from({ length: 56 }, (_, i) => ({
    type: 'thinking',
    thinking: `${i} ` + 'a'.repeat(190),
  }));
  const { svc, fake, emitted } = makeService([...deltas, { type: 'text', text: 'done' }]);
  const usage = await svc.runTurn('count');

  const stalls = stallsOf(emitted);
  assert.equal(stalls.length, 1, 'fires exactly once per turn');
  assert.equal(stalls[0].reason, 'idle');
  assert.equal(stalls[0].aborting, false, 'idle is detection-only, never aborts');
  assert.ok(stalls[0].thinkingTokens >= 2500, 'crosses the idle budget');

  assert.equal(fake.aborted, 0, 'idle must NOT abort a legitimate deep-think turn');
  assert.ok(usage.thinkingEstimate >= 2500);
  assert.ok(usage.thinkingDeltas >= 56);
});

// ===========================================================================
// 3. Healthy turn — interleaved text progress resets, silence is correct
// ===========================================================================

test('e2e healthy: interleaved text progress never raises a stall', async () => {
  const make = (start, suffix) =>
    Array.from({ length: 40 }, (_, i) => ({
      type: 'thinking',
      thinking: `${start + i} ${suffix} ` + 'b'.repeat(50), // index LEADS -> distinct fingerprints
    }));
  const script = [
    ...make(0, 'first half'),               // ~2.6k chars
    { type: 'text', text: 'progress point' }, // resets the idle accumulator
    ...make(40, 'second half'),             // another ~2.6k chars, still < 10k
    { type: 'text', text: 'final answer' },
  ];
  const { svc, fake, emitted } = makeService(script);
  await svc.runTurn('p');
  assert.equal(stallsOf(emitted).length, 0, 'no stall for a healthy turn');
  assert.equal(fake.aborted, 0);
});

// ===========================================================================
// 4. Noise — dropped at the bridge, never forwarded, never counted
// ===========================================================================

test('e2e noise: whitespace + U+FFFD thinking deltas are dropped (not forwarded, not counted)', async () => {
  const script = [
    { type: 'thinking', thinking: '   \n\t  ' },
    { type: 'thinking', thinking: '\uFFFD\uFFFD\uFFFD' },
    { type: 'thinking', thinking: 'real reasoning text' },
    { type: 'text', text: 'the answer' },
  ];
  const { svc, emitted } = makeService(script);
  const usage = await svc.runTurn('p');

  const thinkingEvents = emitted.filter((e) => e.type === 'thinking');
  assert.equal(thinkingEvents.length, 1, 'only the informative delta reaches the renderer');
  assert.equal(thinkingEvents[0].thinking, 'real reasoning text');
  assert.equal(usage.thinkingChars, 'real reasoning text'.length, 'noise excluded from accounting');
  assert.equal(usage.textChars, 'the answer'.length);
});

// ===========================================================================
// 5. Token accounting sanity on the real chain
// ===========================================================================

test('e2e accounting: completion = (text + thinking) chars / 4, prompt = context baseline', async () => {
  const script = [
    { type: 'thinking', thinking: 'abcd' }, // 4 chars  -> 1 token
    { type: 'text', text: 'wxyz' },        // 4 chars  -> 1 token
  ];
  const { svc } = makeService(script);
  const usage = await svc.runTurn('p');
  assert.equal(usage.prompt, 130, 'from context.getTokenCount()');
  assert.equal(usage.completion, 2, 'ceil((4 + 4) / 4) = 2');
  assert.equal(usage.thinkingEstimate, 1);
});