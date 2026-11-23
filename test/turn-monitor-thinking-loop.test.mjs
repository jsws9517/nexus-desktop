/**
 * M11 — thinking-loop detection: "no new content growth after a prefix".
 *
 * The exact-repeat detector (same delta × N) only catches byte-identical
 * hallucination spins. M11 adds the looser semantic case: the model keeps
 * re-emitting the SAME idea with surface variation (three shuffled
 * re-wordings of one sentence, over and over). The span grows, but its
 * content diversity (distinct 3-grams / total) stays low — no NEW content is
 * actually being produced. Flagged as a thinking loop; distinct reasoning
 * (high diversity) must never trip it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { TurnMonitor, estimateTokens } = await import(pathToFileURL(join(dist, 'agent', 'turn-monitor.js')));

/**
 * Cycle through a few re-wordings of the SAME thought, long enough to cross
 * the loose loopMinTokens (400) floor but with near-zero content growth.
 */
function feedRehashedThought(m) {
  const base = [
    'Let me think about the problem carefully and consider the different options and possible approaches',
    'I should think about the problem carefully and weigh the different options and likely approaches',
    'Let me consider the problem carefully and think through the options and plausible approaches here',
  ];
  for (let i = 0; i < 30; i++) {
    m.noteThinking(base[i % 3] + ' ');
  }
}

test('a re-hashed thought (low diversity, over the token floor) is a prefix loop', () => {
  const m = new TurnMonitor();
  feedRehashedThought(m);
  const stall = m.checkStall();
  assert.equal(stall.stalled, true, 'the span crosses the loose token floor');
  assert.equal(stall.reason, 'loop');
  assert.equal(stall.loopKind, 'prefix', 'not an exact repeat — a prefix re-emission');
  assert.ok(stall.thinkingTokens >= 400, 'well past the loose loopMinTokens floor');
});

test('genuinely distinct reasoning stays clean even when long', () => {
  const m = new TurnMonitor();
  // ~100 distinct items — the span clears the 400-token loop floor but stays
  // under the 2500-token idle budget; the content is actually growing, so the
  // diversity measure must NOT read it as a loop.
  for (let i = 0; i < 100; i++) {
    m.noteThinking(`step ${i}: examine item-${(i * 7) % 199} against the constraints `);
  }
  const stall = m.checkStall();
  assert.equal(stall.stalled, false, 'diverse thinking is not a stall');
  assert.equal(stall.reason, 'none');
});

test('the exact-repeat detector still reports loopKind exact', () => {
  const m = new TurnMonitor();
  for (let i = 0; i < 10; i++) m.noteThinking('same delta repeated ');
  const stall = m.checkStall();
  assert.equal(stall.reason, 'loop');
  assert.equal(stall.loopKind, 'exact', 'byte-identical repeats keep their own kind');
});

test('progress resets the span: prior rehashing can no longer stall', () => {
  const m = new TurnMonitor();
  feedRehashedThought(m);
  m.noteText('now doing real work');
  m.noteThinking('a fresh line of reasoning about the new state ');
  assert.equal(m.checkStall().stalled, false, 'the loop memory cleared with progress');
});

test('the stall fires exactly once per span', () => {
  const m = new TurnMonitor();
  feedRehashedThought(m);
  assert.equal(m.checkStall().stalled, true);
  m.markStallHandled();
  assert.equal(m.checkStall().stalled, false, 'idempotent after handling');
});

test('under the loose token floor, rehashing is not yet a loop', () => {
  const m = new TurnMonitor();
  const base = 'Let me think about the problem carefully and consider the options here ';
  for (let i = 0; i < 5; i++) m.noteThinking(base); // ~220 chars ≈ 56 tokens
  const stall = m.checkStall();
  assert.ok(estimateTokens(stall.thinkingTokens) < 400, 'below the floor');
  assert.equal(stall.stalled, false, 'too short to matter yet');
});
