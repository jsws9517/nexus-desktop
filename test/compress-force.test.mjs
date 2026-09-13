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