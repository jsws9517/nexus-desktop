/**
 * Harness primitives — the general layer the session replay depends on.
 *
 * These are unit-level assertions, deliberately phrased as properties rather
 * than symptoms:
 *   - a declared invariant is satisfied only by an OBSERVED run;
 *   - "nothing checked" is never "passed";
 *   - novel output is not progress once a goal is declared;
 *   - a capability denial is its own result class;
 *   - session budgets outlive turns and fire once per threshold.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  parseContract,
  verifyContract,
  claimsCompletion,
} = await import('../dist/agent/deliverable-contract.js');
const {
  normalizeManifest,
  loadManifest,
  manifestExists,
} = await import('../dist/agent/contract-manifest.js');
const { deriveTurnVerdict } = await import('../dist/agent/task-verdict.js');
const { ProgressLedger } = await import('../dist/agent/progress-ledger.js');
const { SessionBudget } = await import('../dist/agent/session-budget.js');
const { classifyToolResult, buildBlockedSteer } = await import('../dist/agent/capability-gate.js');

const MANIFEST = {
  version: 1,
  invariants: [
    {
      id: 'timeline-ssot',
      describe: 'video/audio/subtitle share one timeline',
      predicate: 'abs(video_s - audio_s) <= 0.05',
      checks: [
        {
          cmd: 'python tools/check_timeline.py',
          expect: { exitCode: 0, stdoutMatch: '^OK' },
          evidence: 'content_check',
        },
      ],
    },
  ],
};

const exists = () => true;
const noFiles = () => false;

describe('check manifest', () => {
  it('normalises a valid manifest and drops malformed entries', () => {
    const m = normalizeManifest({
      invariants: [MANIFEST.invariants[0], { id: '', checks: [] }, { id: 'x' }, 42],
      acceptance: [{ kind: 'file_exists', path: 'out.mp4' }, { kind: 'invariant', id: 'nope' }],
    });
    assert.equal(m.invariants.length, 1);
    assert.equal(m.invariants[0].id, 'timeline-ssot');
    assert.equal(m.invariants[0].checks[0].expect.stdoutMatch, '^OK');
    // Users cannot fabricate harness-only item kinds.
    assert.deepEqual(m.acceptance, [{ kind: 'file_exists', path: 'out.mp4', nonEmpty: false }]);
  });

  it('loads from the convention path and reports unreadable files', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-manifest-'));
    try {
      assert.equal(manifestExists(root), false);
      mkdirSync(join(root, '.nexus'), { recursive: true });
      writeFileSync(join(root, '.nexus', 'checks.json'), JSON.stringify(MANIFEST));
      assert.equal(manifestExists(root), true);
      const { loaded } = loadManifest(root);
      assert.equal(loaded.manifest.invariants.length, 1);

      writeFileSync(join(root, '.nexus', 'checks.json'), '{not json');
      const bad = loadManifest(root);
      assert.equal(bad.loaded, null);
      assert.match(bad.error, /checks\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('contract compilation', () => {
  it('merges declared invariants and reports the manifest as the source', () => {
    const c = parseContract('随便改改', '', normalizeManifest(MANIFEST));
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0].kind, 'invariant');
    assert.equal(c.source, 'declared_manifest');
  });

  it('turns a consistency request with no manifest into manifest_required', () => {
    // The request that produced 0 contract items in the video-plus session.
    const c = parseContract('重新修复代码中图片和音频对齐问题');
    assert.equal(c.items.length, 1);
    assert.equal(c.items[0].kind, 'manifest_required');
  });

  it('does not require a manifest for an ordinary fix request', () => {
    const c = parseContract('修复解析器的空指针');
    assert.equal(c.items.length, 0, 'no invented items for an uncontracted fix');
  });
});

describe('invariant verification (observation-only)', () => {
  const contract = parseContract('把音频和视频对齐', '', normalizeManifest(MANIFEST));

  it('reports declared-but-unrun as skipped, never passed', () => {
    const v = verifyContract(contract, { exists, manifestPresent: true, observations: [] });
    assert.equal(v.passed, true, 'no failing evidence');
    assert.equal(v.checked, 1);
    assert.equal(v.skipped.length, 1);
    assert.match(v.skipped[0].why, /not observed/);
  });

  it('passes on an observed run with the expected output', () => {
    const v = verifyContract(contract, {
      exists,
      manifestPresent: true,
      observations: [
        {
          cmd: 'cd project && python tools/check_timeline.py',
          exitCode: 0,
          output: 'OK video=27.94 audio=27.94 subtitle_end=27.95',
        },
      ],
    });
    assert.equal(v.passed, true);
    assert.equal(v.failed.length, 0);
    assert.equal(v.skipped.length, 0);
  });

  it('fails when the observed run contradicts the invariant', () => {
    const v = verifyContract(contract, {
      exists,
      manifestPresent: true,
      observations: [
        { cmd: 'python tools/check_timeline.py', exitCode: 0, output: 'MISMATCH video=15.2 audio=27.9' },
      ],
    });
    assert.equal(v.passed, false);
    assert.match(v.failed[0].why, /did not match/);
  });

  it('satisfies a test item from an observed run instead of skipping it', () => {
    const c = parseContract('跑一下 pytest 然后告诉结果');
    const v = verifyContract(c, {
      exists: noFiles,
      observations: [{ cmd: 'pytest -q', exitCode: 0, output: '12 passed' }],
    });
    assert.equal(v.skipped.length, 0);
    assert.equal(v.passed, true);
  });

  it('requires a manifest to exist for manifest_required', () => {
    const c = parseContract('把字幕和音频对齐');
    const v = verifyContract(c, { exists: noFiles, manifestPresent: false });
    assert.equal(v.passed, false);
    assert.match(v.failed[0].why, /declared invariant/);
    const ok = verifyContract(c, { exists: noFiles, manifestPresent: true });
    assert.equal(ok.passed, true);
  });
});

describe('completion-claim lexicon', () => {
  it('catches the phrasings the session actually used', () => {
    for (const s of [
      '**修复成功！**',
      '字幕时间轴完全正确！',
      '视频 27.94s，音频 27.94s，完全匹配。',
      '问题已解决',
      '修复确认生效',
      '已删除 _cleanup.py',
    ]) {
      assert.equal(claimsCompletion(s), true, `should detect: ${s}`);
    }
  });

  it('does not treat honest negatives as claims', () => {
    for (const s of ['尚未修复', '没有完成', '未验证', '代码改了一半', 'not yet done']) {
      assert.equal(claimsCompletion(s), false, `should not detect: ${s}`);
    }
  });
});

describe('turn verdict', () => {
  const failing = {
    passed: false,
    checked: 1,
    failed: [{ item: { kind: 'file_exists', path: 'out.mp4' }, why: 'missing' }],
    skipped: [],
  };
  const unobserved = {
    passed: true,
    checked: 1,
    failed: [],
    skipped: [{ item: { kind: 'invariant', id: 'x', checks: [] }, why: 'not observed' }],
  };
  const passing = { passed: true, checked: 2, failed: [], skipped: [] };

  it('marks a claim with no evidence as unverified', () => {
    const v = deriveTurnVerdict({
      contract: { items: [], source: 'inferred_baseline', raw: '' },
      verdict: { passed: true, checked: 0, failed: [], skipped: [] },
      findings: [],
      lastAssistantText: '修复成功！',
    });
    assert.equal(v.status, 'unverified');
    assert.equal(v.claimed, true);
    assert.match(v.reason, /no machine-checkable evidence/);
  });

  it('marks a claim that contradicts a check as failed', () => {
    const v = deriveTurnVerdict({
      contract: { items: [], source: 'parsed_from_user', raw: '' },
      verdict: failing,
      findings: [],
      lastAssistantText: '已修复',
    });
    assert.equal(v.status, 'failed');
    assert.equal(v.claims[0].status, 'refuted');
  });

  it('marks a claim after a blocked action as blocked', () => {
    const v = deriveTurnVerdict({
      contract: null,
      verdict: null,
      findings: [],
      lastAssistantText: '临时文件已删除',
      blockedActions: ['exec_command: del _cleanup.py'],
    });
    assert.equal(v.status, 'blocked');
    assert.match(v.reason, /never produced/);
  });

  it('passes only when the declared checks were observed and succeeded', () => {
    const v = deriveTurnVerdict({
      contract: { items: [], source: 'declared_manifest', raw: '' },
      verdict: passing,
      findings: [],
      lastAssistantText: '已修复，检查通过',
    });
    assert.equal(v.status, 'passed');
    assert.equal(v.claims[0].status, 'supported');
  });

  it('is quiet when the turn makes no claim', () => {
    const v = deriveTurnVerdict({
      contract: null,
      verdict: null,
      findings: [],
      lastAssistantText: '我先看一下目录结构。',
    });
    assert.equal(v.status, 'unclaimed');
  });
});

describe('goal-relative progress', () => {
  it('stops crediting novel output once the task has open acceptance items', () => {
    const l = new ProgressLedger({ frozenSteps: 99 });
    const sources = [];
    for (let i = 0; i < 5; i += 1) {
      const step = l.recordStep({
        actions: [{ tool: 'exec_command', args: { command: `probe ${i}` } }],
        toolOutcomes: [{ tool: 'exec_command', ok: true }],
        toolResultTexts: [`brand new output ${i} ${Math.random()}`],
        acceptanceSatisfied: 0,
        goalStrict: true,
      });
      sources.push(step.progressSource);
    }
    assert.deepEqual(sources, ['none', 'none', 'none', 'none', 'none']);
    assert.equal(l.currentStrictNoProgress, 5);
  });

  it('credits an acceptance delta and resets the strict streak', () => {
    const l = new ProgressLedger();
    l.recordStep({ goalStrict: true, acceptanceSatisfied: 0, toolResultTexts: ['x'] });
    const step = l.recordStep({ goalStrict: true, acceptanceSatisfied: 1, toolResultTexts: ['y'] });
    assert.equal(step.outcome, 'progress');
    assert.equal(step.progressSource, 'acceptance');
    assert.equal(l.currentStrictNoProgress, 0);
  });

  it('derives a loop signal from the strict streak', () => {
    const l = new ProgressLedger({ frozenSteps: 3 });
    let step;
    for (let i = 0; i < 4; i += 1) {
      step = l.recordStep({
        actions: [{ tool: 'exec_command', args: { command: `ffprobe ${i}` } }],
        toolOutcomes: [{ tool: 'exec_command', ok: true }],
        toolResultTexts: [`duration=${18 + i}`],
        acceptanceSatisfied: 0,
        goalStrict: true,
      });
    }
    const signals = l.signals(step, '');
    const loop = signals.find((s) => s.kind === 'loop_no_progress');
    assert.ok(loop, 'strict spin must produce a loop signal');
    assert.ok(loop.evidence.some((e) => /acceptance\/diff\/test delta/.test(e)));
  });
});

describe('session budget', () => {
  it('counts across turns and fires once per severity', () => {
    let now = 0;
    const b = new SessionBudget({ maxNoProgressSteps: 3, maxRepeatProbes: 2, now: () => now });
    assert.deepEqual(b.noteStep({ outcome: 'neutral' }), []);
    assert.deepEqual(b.noteStep({ outcome: 'neutral' }), []);
    const soft = b.noteStep({ outcome: 'neutral' });
    assert.equal(soft.length, 1);
    assert.equal(soft[0].kind, 'no_progress');
    assert.equal(soft[0].severity, 'soft');
    // Same threshold does not re-fire.
    assert.equal(b.noteStep({ outcome: 'neutral' }).length, 0);

    const hard = [b.noteStep({ outcome: 'neutral' }), b.noteStep({ outcome: 'neutral' }), b.noteStep({ outcome: 'neutral' })]
      .flat()
      .filter((x) => x.severity === 'hard');
    assert.equal(hard.length, 1);
    assert.equal(hard[0].kind, 'no_progress');
  });

  it('tracks identical probes across turn boundaries', () => {
    const b = new SessionBudget({ maxRepeatProbes: 3, maxNoProgressSteps: 999 });
    const key = 'exec_command:abc123';
    const fired = [];
    for (let i = 0; i < 7; i += 1) {
      fired.push(...b.noteStep({ outcome: 'neutral', probeKeys: [key] }));
    }
    const kinds = fired.map((f) => `${f.kind}/${f.severity}`);
    assert.deepEqual(kinds, ['repeat_probe/soft', 'repeat_probe/hard']);
    // Progress resets the no-progress streak but not the probe counter.
    b.noteStep({ outcome: 'progress', probeKeys: [key] });
    assert.equal(b.snapshot().noProgressStreak, 0);
  });

  it('fires the wall-clock dimension with a fake clock', () => {
    let now = 0;
    const b = new SessionBudget({ maxWallClockMs: 60_000, maxNoProgressSteps: 999, now: () => now });
    b.noteStep({ outcome: 'progress' });
    now = 60_000;
    const soft = b.noteStep({ outcome: 'progress' });
    assert.ok(soft.some((x) => x.kind === 'wall_clock' && x.severity === 'soft'));
    now = 120_000;
    const hard = b.noteStep({ outcome: 'progress' });
    assert.ok(hard.some((x) => x.kind === 'wall_clock' && x.severity === 'hard'));
  });
});

describe('capability gate classification', () => {
  it('separates a policy denial from a broken tool', () => {
    assert.equal(
      classifyToolResult(true, 'Unattended mode blocked file mutation: a git checkpoint is required'),
      'blocked',
    );
    assert.equal(classifyToolResult(true, 'Permission denied: /etc/shadow'), 'blocked');
    assert.equal(classifyToolResult(true, 'exited with code 1\nSyntaxError'), 'failed');
    assert.equal(classifyToolResult(false, 'all good'), 'ok');
    // A successful log line mentioning a blocked request is not a denial.
    assert.equal(classifyToolResult(false, '1 request blocked by upstream'), 'ok');
  });

  it('never suggests a syntax workaround in the steer', () => {
    const steer = buildBlockedSteer(['exec_command: del _cleanup.py']);
    assert.match(steer, /Do NOT describe the blocked action as done/);
    assert.match(steer, /Do NOT rewrite it as a script/);
    assert.doesNotMatch(steer, /write the logic to a script file/i);
  });
});
