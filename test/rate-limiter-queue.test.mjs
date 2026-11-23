/**
 * M9 — rate-limiter queue visibility + shared-quota pool merge.
 *
 *  - The limiter fires a `queued` event the moment a request starts waiting
 *    (429 backoff or a full RPM window) and accumulates the cumulative wait so
 *    the UI can hint once it crosses a loose 60s threshold.
 *  - A success (resetBackoff) clears the cumulative wait.
 *  - The main-process registry pools a shared provider quota: two tabs on the
 *    same account SUM their recent usage (one pool, not two budgets).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { RateLimiter } = await import(pathToFileURL(join(dist, 'agent', 'rate-limiter.js')));
const { RateLimitRegistry } = await import(pathToFileURL(join(dist, 'main', 'rate-limit-registry.js')));

function status(family, over = {}) {
  return {
    providerName: family,
    baseUrl: `https://x/${family}`,
    family,
    rpm: 20,
    recentRequests: 0,
    backoffMs: 0,
    status: 'normal',
    ...over,
  };
}

test('acquire fires a queued event on backoff and accumulates queuedMs', async () => {
  const rl = new RateLimiter();
  const events = [];
  rl.onQueueWait = (info) => events.push(info);

  // A tiny backoff (50ms) so the wait is real but the test is fast.
  rl.markRateLimited('zhipu', 50, 100);
  await rl.acquire('zhipu', 20);

  assert.equal(events.length, 1, 'one queue-wait event');
  assert.equal(events[0].family, 'zhipu');
  assert.equal(events[0].reason, 'backoff');
  assert.ok(events[0].waitMs > 0, 'reports how long this wait was');
  assert.equal(events[0].queuedMs, rl.getQueuedMs('zhipu'), 'event carries the cumulative wait');

  // A success resets the cumulative clock.
  rl.resetBackoff('zhipu');
  assert.equal(rl.getQueuedMs('zhipu'), 0, 'success clears the queue wait');
});

test('queuedMs accumulates across consecutive waits', async () => {
  const rl = new RateLimiter();
  const waits = [];
  rl.onQueueWait = (i) => waits.push(i.queuedMs);

  rl.markRateLimited('agnes', 30, 100);
  await rl.acquire('agnes', 20);
  rl.markRateLimited('agnes', 30, 100);
  await rl.acquire('agnes', 20);

  assert.equal(waits.length, 2);
  assert.ok(waits[1] > waits[0], 'the cumulative wait grows across waits');
  assert.equal(waits[1], rl.getQueuedMs('agnes'));
});

test('registry pools a shared quota: same account sums recent usage', () => {
  const reg = new RateLimitRegistry();
  // Two tabs, same provider account (family + baseUrl), 10 requests each.
  reg.report('tab-a', status('zhipu', { recentRequests: 10 }));
  reg.report('tab-b', status('zhipu', { recentRequests: 10 }));

  const agg = reg.getAggregated();
  assert.equal(agg.length, 1, 'same account is one pool');
  assert.equal(agg[0].family, 'zhipu');
  // Shared pool = SUM, not max: the account really drew 20 of its 20 RPM.
  assert.equal(agg[0].recentRequests, 20, 'usage is summed across tabs');
  assert.equal(agg[0].status, 'throttled', 'summed usage against the shared rpm');
});

test('registry keeps distinct accounts in separate pools', () => {
  const reg = new RateLimitRegistry();
  reg.report('tab-a', status('zhipu', { baseUrl: 'https://open.bigmodel.cn', recentRequests: 10 }));
  reg.report('tab-b', status('zhipu', { baseUrl: 'https://other-account.cn', recentRequests: 10 }));

  const agg = reg.getAggregated();
  assert.equal(agg.length, 2, 'different baseUrl = different pools');
  assert.ok(agg.every((p) => p.recentRequests === 10), 'no cross-account summing');
});

test('registry merges backoff as the max and carries queuedMs', () => {
  const reg = new RateLimitRegistry();
  reg.report('tab-a', status('agnes', { backoffMs: 5_000, queuedMs: 60_000 }));
  reg.report('tab-b', status('agnes', { backoffMs: 20_000, queuedMs: 10_000 }));

  const [agg] = reg.getAggregated();
  assert.equal(agg.backoffMs, 20_000, 'the most restrictive backoff wins');
  assert.equal(agg.queuedMs, 60_000, 'the longest observed queue is surfaced');
  assert.equal(agg.status, 'throttled');
});
