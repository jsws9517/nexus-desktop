/**
 * Progress Ledger — deterministic signal tests.
 *
 * These cover the two signals the ledger owns (thinking dilution, loop/no
 * progress) and the outcome classifier that everything else depends on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  ProgressLedger,
  newInfoRate,
  zlibRatio,
  ngramSet,
  normalizeForNgram,
  estimateTokensFromChars,
  normalizePath,
} = await import('../dist/agent/progress-ledger.js');

describe('ngram / novelty helpers', () => {
  it('normalises whitespace and punctuation away', () => {
    assert.equal(normalizeForNgram('Hello,   world!'), 'helloworld');
    assert.equal(normalizeForNgram('你好，世界'), '你好世界');
  });

  it('treats identical text as zero-novelty', () => {
    const t = 'the same reasoning block repeated over and over again';
    assert.equal(newInfoRate(t, [t]), 0);
  });

  it('treats unseen text as fully novel', () => {
    assert.equal(newInfoRate('completely different content here', ['nothing in common']), 1);
  });

  it('returns partial novelty for partly-overlapping text', () => {
    const a = 'alpha beta gamma delta epsilon zeta eta theta';
    const b = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
    const r = newInfoRate(b, [a]);
    assert.ok(r > 0 && r < 1, `expected partial novelty, got ${r}`);
  });

  it('produces 8-grams and token estimates', () => {
    assert.ok(ngramSet('abcdefghij').size > 0);
    assert.equal(estimateTokensFromChars(0), 0);
    assert.equal(estimateTokensFromChars(5), 2);
  });

  it('zlibRatio is 0 for short text and low for repetitive long text', () => {
    assert.equal(zlibRatio('short'), 0);
    const repetitive = 'abcabcabcabc'.repeat(400);
    const novel = Array.from({ length: 400 }, (_, i) => `token-${i}-${(i * 7919) % 104729}`).join(' ');
    const rRep = zlibRatio(repetitive);
    const rNovel = zlibRatio(novel);
    assert.ok(rRep < rNovel, `repetitive ${rRep} should compress better than novel ${rNovel}`);
  });

  it('normalises path separators and case on Windows', () => {
    const p = normalizePath('C:\\Repo\\SRC\\A.ts');
    assert.ok(p.includes('/'));
    if (process.platform === 'win32') assert.equal(p, 'c:/repo/src/a.ts');
  });
});

describe('outcome classification', () => {
  it('marks a novel tool result as progress', () => {
    const l = new ProgressLedger();
    const step = l.recordStep({
      actions: [{ tool: 'read_text_file', args: { path: 'a.ts' } }],
      toolOutcomes: [{ tool: 'read_text_file', ok: true }],
      toolResultTexts: ['first time we see this content'],
    });
    assert.equal(step.outcome, 'progress');
  });

  it('marks an identical result as neutral', () => {
    const l = new ProgressLedger();
    const input = {
      actions: [{ tool: 'read_text_file', args: { path: 'a.ts' } }],
      toolOutcomes: [{ tool: 'read_text_file', ok: true }],
      toolResultTexts: ['same body'],
    };
    l.recordStep(input);
    const second = l.recordStep(input);
    assert.equal(second.outcome, 'neutral');
  });

  it('marks an all-failed step as regress', () => {
    const l = new ProgressLedger();
    const step = l.recordStep({
      actions: [{ tool: 'exec_command', args: { command: 'false' } }],
      toolOutcomes: [{ tool: 'exec_command', ok: false, failKey: 'exec_command:exec-failed' }],
    });
    assert.equal(step.outcome, 'regress');
  });

  it('marks a diff as progress', () => {
    const l = new ProgressLedger();
    const step = l.recordStep({
      actions: [{ tool: 'write_file', args: { path: 'a.ts' } }],
      toolOutcomes: [{ tool: 'write_file', ok: true }],
      diffNonEmpty: true,
      touchedFiles: [{ path: 'a.ts', mtimeMs: 1, size: 10 }],
    });
    assert.equal(step.outcome, 'progress');
  });
});

describe('loop / no-progress signal', () => {
  function repeatReads(l, n) {
    let step;
    for (let i = 0; i < n; i += 1) {
      step = l.recordStep({
        actions: [{ tool: 'read_text_file', args: { path: `file-${i}.ts` } }],
        toolOutcomes: [{ tool: 'read_text_file', ok: true }],
        toolResultTexts: ['the exact same body every time'],
      });
    }
    return step;
  }

  it('fires after the frozen-step threshold (default 4)', () => {
    const l = new ProgressLedger({ frozenSteps: 4 });
    repeatReads(l, 4);
    const step = repeatReads(l, 1);
    const signals = l.signals(step, '');
    const loop = signals.find((s) => s.kind === 'loop_no_progress');
    assert.ok(loop, 'expected a loop signal');
    assert.ok(loop.evidence.length > 0, 'evidence must never be empty');
    assert.ok(loop.severity > 0);
  });

  it('does not fire while the workspace is changing', () => {
    const l = new ProgressLedger({ frozenSteps: 2 });
    for (let i = 0; i < 6; i += 1) {
      const step = l.recordStep({
        actions: [{ tool: 'write_file', args: { path: `out-${i}.ts` } }],
        toolOutcomes: [{ tool: 'write_file', ok: true }],
        diffNonEmpty: true,
        touchedFiles: [{ path: `out-${i}.ts`, mtimeMs: 100 + i, size: 10 + i }],
      });
      assert.equal(l.signals(step, '').length, 0);
    }
  });

  it('resets when a progress step lands', () => {
    const l = new ProgressLedger({ frozenSteps: 2 });
    repeatReads(l, 3);
    const good = l.recordStep({
      actions: [{ tool: 'write_file', args: { path: 'a.ts' } }],
      toolOutcomes: [{ tool: 'write_file', ok: true }],
      diffNonEmpty: true,
      touchedFiles: [{ path: 'a.ts', mtimeMs: 5, size: 5 }],
    });
    assert.equal(l.currentFrozenSteps, 0);
    assert.equal(l.signals(good, '').length, 0);
  });
});

describe('thinking dilution signal', () => {
  const repeated = '让我直接定位根因然后修复这个问题，重复分析同一段代码。'.repeat(150);

  it('fires for long, repeated thinking with no state change', () => {
    const l = new ProgressLedger();
    l.recordStep({ thinking: repeated });
    const step = l.recordStep({ thinking: repeated });
    const signals = l.signals(step, repeated);
    const dilution = signals.find((s) => s.kind === 'thinking_dilution');
    assert.ok(dilution, 'expected a dilution signal');
    assert.ok(dilution.evidence.some((e) => e.includes('newInfoRate')));
    assert.ok(dilution.severity > 0.4);
  });

  it('stays silent when the same thinking produced progress', () => {
    const l = new ProgressLedger();
    l.recordStep({ thinking: repeated });
    const step = l.recordStep({
      thinking: repeated,
      actions: [{ tool: 'write_file', args: { path: 'a.ts' } }],
      toolOutcomes: [{ tool: 'write_file', ok: true }],
      diffNonEmpty: true,
      touchedFiles: [{ path: 'a.ts', mtimeMs: 1, size: 1 }],
    });
    assert.equal(l.signals(step, repeated).length, 0);
  });

  it('stays silent below the thinking-token floor', () => {
    const l = new ProgressLedger({ minThinkingTokens: 10_000 });
    l.recordStep({ thinking: repeated });
    const step = l.recordStep({ thinking: repeated });
    assert.equal(l.signals(step, repeated).length, 0);
  });
});
