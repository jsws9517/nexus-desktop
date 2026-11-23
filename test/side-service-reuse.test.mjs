/**
 * L5 — side-chat service reuse.
 *
 * One side AgentService per worker (lazily created, single-flight), reused
 * across sideChat requests instead of paying a full core re-init per message.
 * Plus the transcript-seed helper: the renderer replays the full side history,
 * and everything before the last user message is what `chat()` needs to see
 * (chat() appends the last user message itself).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { SideServiceCache, historyBeforeLastUser } = await import(
  pathToFileURL(join(dist, 'agent', 'side-service.js'))
);

test('one service is built and reused across requests', async () => {
  let created = 0;
  let inits = 0;
  const cache = new SideServiceCache(
    () => {
      created++;
      return { id: created };
    },
    async () => {
      inits++;
    },
  );
  const a = await cache.get();
  const b = await cache.get();
  const c = await cache.get();
  assert.equal(a, b, 'same instance on the second request');
  assert.equal(b, c, 'same instance on the third request');
  assert.equal(created, 1, 'the factory ran exactly once');
  assert.equal(inits, 1, 'init ran exactly once');
});

test('concurrent gets single-flight the init', async () => {
  let inits = 0;
  const cache = new SideServiceCache(
    () => ({ shared: true }),
    () =>
      new Promise((resolve) => {
        inits++;
        setTimeout(resolve, 15);
      }),
  );
  const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(a, b, 'all three callers got the same instance');
  assert.equal(b, c);
  assert.equal(inits, 1, 'three concurrent requests paid init once');
  // After settling, further gets are free.
  assert.equal(await cache.get(), a);
  assert.equal(inits, 1);
});

test('a failed init does not poison the cache — the next request retries', async () => {
  let attempts = 0;
  const cache = new SideServiceCache(
    () => ({ n: ++attempts }),
    async () => {
      if (attempts === 1) throw new Error('boom');
    },
  );
  await assert.rejects(() => cache.get(), /boom/, 'the first request sees the failure');
  const s = await cache.get();
  assert.equal(s.n, 2, 'the second request retried and got a fresh service');
  assert.equal(await cache.get(), s, 'the success is then cached');
  assert.equal(attempts, 2, 'no further retries after success');
});

test('historyBeforeLastUser: seed = everything before the last user message', () => {
  const msgs = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
  ];
  const h = historyBeforeLastUser(msgs);
  assert.deepEqual(
    h.map((m) => m.content),
    ['q1', 'a1', 'q2', 'a2'],
    'the last user message is excluded (chat() appends it)',
  );
});

test('historyBeforeLastUser: single-message / no-user-message → empty seed', () => {
  assert.deepEqual(
    historyBeforeLastUser([{ role: 'user', content: 'only' }]),
    [],
    'one user message: nothing before it',
  );
  assert.deepEqual(
    historyBeforeLastUser([{ role: 'assistant', content: 'orphan' }]),
    [],
    'no user message: nothing to seed',
  );
  assert.deepEqual(historyBeforeLastUser([]), [], 'empty transcript: empty seed');
});
