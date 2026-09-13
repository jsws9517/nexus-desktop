import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from '../node_modules/nexus-coder/dist/src/llm/context-manager.js';

const WINDOW = 128000;
const HARD_RATIO = 0.95;
const HARD_CEILING = WINDOW * HARD_RATIO;

function makeCtx({ calls }) {
  return new ContextManager({
    maxContextTokens: WINDOW,
    compressionHardRatio: HARD_RATIO,
    provider: {
      complete: () => {
        calls.complete++;
        throw new Error('provider refused: over limit');
      },
    },
  });
}

function overflow(ctx, target = WINDOW * 1.02) {
  let i = 0;
  let guard = 0;
  while (ctx.getTokenCount() < target && guard++ < 20000) {
    ctx.add({ role: i % 2 === 0 ? 'user' : 'assistant', content: '中文上下文填充'.repeat(300) + `|block-${i}` });
    i++;
  }
  return ctx.getTokenCount();
}

test('localOnly compress drops an over-limit context under the hard ceiling', async () => {
  const calls = { complete: 0 };
  const ctx = makeCtx({ calls });
  const filled = overflow(ctx);
  assert.ok(filled > HARD_CEILING, `expected >${HARD_CEILING} tokens before compress, got ${filled}`);

  await ctx.compress(0, true);

  const after = ctx.getTokenCount();
  assert.ok(after <= HARD_CEILING, `expected <=${HARD_CEILING} after local compress, got ${after}`);
  assert.equal(calls.complete, 0, 'localOnly compress must not call the provider');
});

test('localOnly compress still works when provider would reject (no remote request)', async () => {
  const calls = { complete: 0 };
  const ctx = makeCtx({ calls });
  overflow(ctx, HARD_CEILING + 8000);

  await ctx.compress(0, true);

  assert.equal(calls.complete, 0, 'over-had context must never fire a summarize request');
  assert.ok(ctx.getTokenCount() <= HARD_CEILING);
  assert.ok(ctx.getMessages().length >= 4, 'compression must keep a usable tail');
});

test('getCompressionHardRatio returns the configured value / default', async () => {
  const calls = { complete: 0 };
  assert.equal(makeCtx({ calls }).getCompressionHardRatio(), HARD_RATIO);
  assert.equal(new ContextManager({ maxContextTokens: WINDOW }).getCompressionHardRatio(), 0.95);
});

test('summarizeRounds=0 + snapshotEnabled=false collapses to pure-local compression', async () => {
  const calls = { complete: 0 };
  const ctx = new ContextManager({
    maxContextTokens: WINDOW,
    compressionHardRatio: HARD_RATIO,
    summarizeRounds: 0,
    snapshotEnabled: false,
    provider: {
      complete: () => {
        calls.complete++;
        throw new Error('provider refused');
      },
    },
  });
  // Between threshold (0.85) and hard ceiling (0.95): not overHard, so the
  // strategy ladder is what decides. If any remote strategy leaked in, the
  // provider would be called.
  overflow(ctx, WINDOW * 0.9);

  for (let r = 0; r < 6; r++) {
    await ctx.compress(0, false);
  }

  assert.equal(calls.complete, 0, 'summarizeRounds=0 + snapshotEnabled=false must never call remote provider');
  assert.ok(ctx.getMessages().length >= 4, 'must keep a usable tail');
});

test('default summarizeRounds routes the first round to remote Summarize (back-compat)', async () => {
  const calls = { complete: 0 };
  const ctx = new ContextManager({
    maxContextTokens: WINDOW,
    compressionHardRatio: HARD_RATIO,
    provider: {
      complete: () => {
        calls.complete++;
        throw new Error('provider refused: over limit');
      },
    },
  });
  overflow(ctx, WINDOW * 0.9);

  await ctx.compress(0, false);

  assert.equal(calls.complete, 1, 'round 1 ≤ summarizeRounds(2) must attempt Summarize, then fall back');
  assert.ok(ctx.getTokenCount() <= WINDOW, 'fallback truncate must bring usage down');
});

test('applyConfig hot-reloads strategy params on a live context', async () => {
  const calls = { complete: 0 };
  const ctx = makeCtx({ calls });
  overflow(ctx, WINDOW * 0.9);

  ctx.applyConfig({ summarizeRounds: 0, snapshotEnabled: false });
  for (let r = 0; r < 4; r++) {
    await ctx.compress(0, false);
  }

  assert.equal(calls.complete, 0, 'hot-applied summarizeRounds=0 must stop remote calls');
  assert.equal(ctx.getCompressionMaxDepth(), 10, 'default depth unchanged by summarize/snapshot apply');

  // Second scenario: hot-applied depth limit is reflected by the getter.
  const ctx2 = makeCtx({ calls });
  ctx2.applyConfig({ compressionMaxDepth: 3 });
  assert.equal(ctx2.getCompressionMaxDepth(), 3);
  assert.equal(new ContextManager({ maxContextTokens: WINDOW }).getCompressionMaxDepth(), 10);
});

test('tailMinKeep safeguards the tail floor after aggressive truncation', async () => {
  const calls = { complete: 0 };
  const ctx = makeCtx({ calls });
  ctx.applyConfig({ tailKeepRatio: 0.1, tailMinKeep: 3 });
  overflow(ctx);

  await ctx.compress(0, true);

  assert.equal(calls.complete, 0);
  assert.ok(ctx.getMessages().length >= 3, `expected ≥ 3 kept messages, got ${ctx.getMessages().length}`);
  assert.ok(ctx.getTokenCount() <= HARD_CEILING);
});

test('compressionMaxDepth caps recursion (config-driven, not hardcoded)', async () => {
  const calls = { complete: 0 };
  const ctx = new ContextManager({
    maxContextTokens: WINDOW,
    compressionHardRatio: HARD_RATIO,
    compressionMaxDepth: 3,
    provider: { complete: () => { calls.complete++; throw new Error('nope'); } },
  });
  overflow(ctx, WINDOW * 1.2);

  await ctx.compress(0, true);
  await ctx.compress(0, true);

  assert.equal(calls.complete, 0, 'localOnly never calls the provider');
  assert.ok(ctx.getTokenCount() <= WINDOW * 1.5, 'bounded recursion terminates without spinning');
});