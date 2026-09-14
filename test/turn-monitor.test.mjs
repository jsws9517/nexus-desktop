import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { TurnMonitor, estimateTokens, EMPTY_USAGE } = await import('../dist/agent/turn-monitor.js');

describe('estimateTokens', () => {
  it('rounds a char/4 estimate up and never goes negative', () => {
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(1), 1);
    assert.equal(estimateTokens(4), 1);
    assert.equal(estimateTokens(5), 2);
    assert.equal(estimateTokens(-10), 0);
  });
});

describe('TurnMonitor noise filtering', () => {
  it('drops empty / whitespace-only deltas', () => {
    const m = new TurnMonitor();
    assert.ok(m.isNoise(''));
    assert.ok(m.isNoise('   \n\t  '));
    assert.ok(m.isNoise('\uFFFD\uFFFD\uFFFD'));
  });

  it('flags heavily-whitespace deltas as noise (min info ratio)', () => {
    const m = new TurnMonitor();
    assert.ok(m.isNoise('      '));
    // A delta that is ~90% whitespace with a couple of chars is below 0.5 ratio.
    assert.ok(m.isNoise('a' + ' '.repeat(20)));
    assert.ok(!m.isNoise('some meaningful reasoning text'));
  });

  it('never counts noise into the completion estimate', () => {
    const m = new TurnMonitor();
    m.noteThinking('real reasoning');
    m.noteText('real answer text');
    // noise chars must not inflate the count
    m.noteThinking('\n\n\n');
    m.noteThinking('\uFFFD\uFFFD');
    const u = m.finish();
    assert.equal(u.thinkingChars, 'real reasoning'.length);
    assert.equal(u.textChars, 'real answer text'.length);
    // completion = (thinking + text) / 4
    assert.equal(u.completion, estimateTokens('real reasoning'.length + 'real answer text'.length));
  });
});

describe('TurnMonitor token accounting', () => {
  it('reports the prompt baseline as set', () => {
    const m = new TurnMonitor();
    m.setPromptBaseline(1234.8);
    const u = m.finish();
    assert.equal(u.prompt, 1235);
  });

  it('returns EMPTY_USAGE when nothing streamed', () => {
    const m = new TurnMonitor();
    m.setPromptBaseline(500);
    const u = m.finish();
    assert.equal(u.prompt, 500);
    assert.equal(u.completion, 0);
    assert.equal(u.thinkingDeltas, 0);
  });

  it('counts thinking deltas separately from text', () => {
    const m = new TurnMonitor();
    m.noteThinking('first');
    m.noteThinking('second');
    m.noteText('out');
    const u = m.finish();
    assert.equal(u.thinkingDeltas, 2);
    assert.ok(u.thinkingChars > 0);
    assert.ok(u.textChars === 'out'.length);
  });
});

describe('TurnMonitor stall detection', () => {
  it('flags a loop after maxRepeat identical deltas', () => {
    const m = new TurnMonitor({ maxRepeat: 4 });
    for (let i = 0; i < 3; i++) {
      assert.equal(m.checkStall().reason, 'none');
      m.noteThinking('repeat me');
    }
    // 4th identical delta tips it over
    m.noteThinking('repeat me');
    const s = m.checkStall();
    assert.equal(s.stalled, true);
    assert.equal(s.reason, 'loop');
    assert.equal(s.repeatCount, 4);
  });

  it('fires the loop stall exactly once per turn', () => {
    const m = new TurnMonitor({ maxRepeat: 3 });
    for (let i = 0; i < 10; i++) m.noteThinking('same');
    assert.equal(m.checkStall().stalled, true);
    m.markStallHandled();
    // even after more identical deltas, the stall stays handled for this turn
    m.noteThinking('same');
    assert.equal(m.checkStall().stalled, false);
  });

  it('does not flag a loop when deltas differ', () => {
    const m = new TurnMonitor({ maxRepeat: 5 });
    const words = ['one', 'two', 'three', 'four', 'five', 'six'];
    for (const w of words) m.noteThinking(w);
    assert.equal(m.checkStall().stalled, false);
  });

  it('resets the repetition counter on text progress', () => {
    const m = new TurnMonitor({ maxRepeat: 5 });
    m.noteThinking('spin');
    m.noteThinking('spin');
    m.noteThinking('spin');
    m.noteThinking('spin');
    m.noteText('progress');
    m.noteThinking('spin');
    m.noteThinking('spin');
    m.noteThinking('spin');
    assert.equal(m.checkStall().stalled, false);
  });

  it('flags idle thinking once it crosses the token budget without progress', () => {
    // ~16 chars/token? no — char/4, so 2500 tokens == 10000 chars.
    const m = new TurnMonitor({ idleThinkingTokens: 50 });
    for (let i = 0; i < 60; i++) m.noteThinking(`reasoning framing step ${i} which is informative variation `);
    const s = m.checkStall();
    assert.equal(s.reason, 'idle');
    assert.equal(s.stalled, true);
  });

  it('resets idle progress on tool calls', () => {
    const m = new TurnMonitor({ idleThinkingTokens: 50 });
    for (let i = 0; i < 60; i++) m.noteThinking(`some reasoning body flow number ${i} that goes along `);
    m.noteProgress(); // a tool_call_start reset progress
    assert.equal(m.checkStall().reason, 'none');
  });

  it('treats deep-but-legit thinking as detectable but reports mono progress', () => {
    const m = new TurnMonitor({ idleThinkingTokens: 30 });
    for (let i = 0; i < 40; i++) m.noteThinking(`step ${i} of the derivation we are building up `);
    const s = m.checkStall();
    assert.equal(s.reason, 'idle'); // detection only — the caller decides action
  });
});

describe('TurnMonitor options defaults', () => {
  it('applies conservative defaults', () => {
    const m = new TurnMonitor();
    // Repeated identical delta fires under the default maxRepeat=6
    for (let i = 0; i < 6; i++) m.noteThinking('x');
    assert.equal(m.checkStall().reason, 'loop');
  });
});