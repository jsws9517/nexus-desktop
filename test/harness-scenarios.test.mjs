/**
 * Conversation-level scenarios — the harness driven by realistic tool traffic.
 *
 * These replay the shapes that cost the video-plus session 8 hours, through the
 * REAL AgentService event bridge (same path the worker uses):
 *
 *   core event stream -> handleAgentEvent -> ledger/contract/verdict -> UI event
 *
 * No live LLM is involved, but every step is a real tool call with real output,
 * and the assertions are about what the user would see at the end of the turn.
 */

import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));
const { DEFAULT_CORRECTION_CONFIG } = await import(
  pathToFileURL(join(dist, 'agent', 'correction-config.js'))
);

let seq = 0;
function makeFixture(manifest) {
  const dir = mkdtempSync(join(tmpdir(), `nexus-scenario-${seq++}-`));
  if (manifest) {
    mkdirSync(join(dir, '.nexus'), { recursive: true });
    writeFileSync(join(dir, '.nexus', 'checks.json'), JSON.stringify(manifest));
  }
  return dir;
}

function makeFakeAgent(sessionId, { withSession = false } = {}) {
  const agent = {};
  agent.context = { getTokenCount: () => 200 };
  agent.provider = { model: 'scenario-model' };
  if (withSession) agent.session = { get: () => undefined };
  agent.config = {
    getActiveProvider: () => 'scenario',
    getProvider: () => ({ baseUrl: 'http://localhost:9999', model: 'scenario-model' }),
  };
  agent.aborted = 0;
  agent.steers = [];
  agent.script = [];
  agent.onEvent = null;
  agent.getCurrentSessionId = () => sessionId;
  agent.chat = async function chat() {
    for (const e of agent.script) agent.onEvent?.(e);
  };
  agent.abort = function abort() {
    agent.aborted += 1;
  };
  agent.enqueueSteer = function enqueueSteer(text, opts) {
    agent.steers.push({ text, opts });
    return true;
  };
  return agent;
}

function makeService(script, sessionId = `scenario-${seq++}`, opts = {}) {
  const svc = new AgentService();
  const emitted = [];
  svc.onEvent = (e) => emitted.push(e);
  const fake = makeFakeAgent(sessionId, opts);
  fake.script = script;
  svc.agent = fake;
  // These scenarios test event-bridge semantics, not throttling. A low rpm
  // spend tier would otherwise make the many-turn reverse cases sleep through
  // the RateLimiter's 60s sliding window.
  svc.rateLimiter.acquire = async () => {};
  fake.onEvent = (event) => svc.handleAgentEvent(event);
  return { svc, fake, emitted };
}

function exec(command, content, { isError = false, exitCode } = {}) {
  return [
    { type: 'tool_call_start', name: 'exec_command', args: { command } },
    {
      type: 'tool_result',
      name: 'exec_command',
      args: { command },
      content,
      isError,
      ...(exitCode === undefined ? {} : { exitCode }),
    },
  ];
}

/** One probe step: a real command with output nobody has seen before. */
function probeStep(i, command = 'ffprobe -v error -show_entries format=duration out/final.mp4') {
  return [
    { type: 'turn_start', turn: i },
    ...exec(command, `duration=${(18.2 + i * 0.37).toFixed(3)}`),
    { type: 'turn_end', turn: i },
  ];
}

/**
 * Scenario A — the alignment request with no declared invariant.
 *
 * In the original session this request compiled to ZERO acceptance items, every
 * probe printed new numbers, the ledger called each probe "progress", and the
 * turn ended with "修复成功！".
 */
test('scenario A: alignment request without a manifest cannot end "fixed"', async () => {
  const dir = makeFixture(null);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const steps = 5;
    const script = [
      ...Array.from({ length: steps }, (_, i) => probeStep(i)).flat(),
      { type: 'turn_start', turn: steps + 1 },
      { type: 'text', text: '**修复成功！** 视频和音频已经对齐。' },
      { type: 'turn_end', turn: steps + 1 },
    ];
    const { svc, fake, emitted } = makeService(script);

    await svc.runTurn('重新修复代码中图片和音频对齐问题');

    const verdict = emitted.find((e) => e.type === 'turn_verdict');
    assert.ok(verdict, 'every turn must carry a verdict');
    assert.notEqual(verdict.status, 'passed', 'a claim with no evidence must not pass');
    assert.equal(verdict.claimed, true);

    const contract = emitted.find((e) => e.type === 'contract_verdict');
    assert.equal(contract.passed, false, 'the gate must not accept the claim');
    assert.ok(
      contract.failed.some((f) => f.item.kind === 'manifest_required'),
      'the request must compile into "declare an invariant"',
    );

    // Novel-but-useless probing is no longer progress: the ledger must fire.
    const loops = emitted.filter((e) => e.type === 'correction' && e.kind === 'loop_no_progress');
    assert.ok(loops.length >= 1, 'goal-strict probe loop must be corrected');

    // The steer must point at declaration, not at another probe.
    const steer = fake.steers.map((s) => s.text).join('\n');
    assert.match(steer, /declared invariant|checks\.json|not observed/i);

    assert.equal(svc.getLastTurnVerdict().status !== 'passed', true);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario B — the same request, but the workspace declares the invariant and
 * the agent actually runs the check. This is the behaviour the plan wants to
 * reward: the claim is supported, so the verdict is `passed`.
 */
test('scenario B: declared invariant + observed run = verified success', async () => {
  const dir = makeFixture({
    version: 1,
    invariants: [
      {
        id: 'timeline-ssot',
        describe: 'video/audio/subtitle share one timeline',
        checks: [
          {
            cmd: 'python tools/check_timeline.py',
            expect: { exitCode: 0, stdoutMatch: '^OK' },
            evidence: 'content_check',
          },
        ],
      },
    ],
  });
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const script = [
      { type: 'turn_start', turn: 1 },
      ...exec('python tools/check_timeline.py', 'OK video=27.94 audio=27.94 subtitle_end=27.95'),
      { type: 'turn_end', turn: 1 },
      { type: 'turn_start', turn: 2 },
      { type: 'text', text: '已修复，检查通过：video=27.94 audio=27.94 subtitle_end=27.95。' },
      { type: 'turn_end', turn: 2 },
    ];
    const { svc, emitted } = makeService(script);

    await svc.runTurn('把字幕和音频对齐');

    const verdict = emitted.find((e) => e.type === 'turn_verdict');
    assert.equal(verdict.status, 'passed');
    assert.equal(verdict.skipped.length, 0);
    const contract = emitted.find((e) => e.type === 'contract_verdict');
    assert.equal(contract.passed, true);
    assert.equal(contract.checked, 1);
    assert.equal(svc.getLastTurnVerdict().status, 'passed');
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario C — "said deleted, command was blocked" ([99799]–[99805]).
 *
 * The blocked action is sticky: the turn verdict is `blocked`, a decision card
 * is emitted, and the steer forbids both the false narration and the
 * script-workaround the core's old hint suggested.
 */
test('scenario C: a blocked action invalidates the "already deleted" narration', async () => {
  const dir = makeFixture(null);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const script = [
      { type: 'turn_start', turn: 1 },
      ...exec(
        'del _cleanup.py',
        'Unattended mode blocked file mutation: a git checkpoint is required',
        { isError: true },
      ),
      { type: 'turn_end', turn: 1 },
      { type: 'turn_start', turn: 2 },
      { type: 'text', text: '临时清理脚本已删除（_cleanup.py 已清理）。' },
      { type: 'turn_end', turn: 2 },
    ];
    const { svc, fake, emitted } = makeService(script);

    await svc.runTurn('删掉临时脚本 _cleanup.py 并确认');

    const verdict = emitted.find((e) => e.type === 'turn_verdict');
    assert.equal(verdict.status, 'blocked');
    assert.ok(verdict.blocked.length >= 1);

    const decision = emitted.find((e) => e.type === 'decision_request');
    assert.ok(decision, 'a denial must ask for a decision');
    assert.ok(decision.options.some((o) => o.id === 'skip'));

    const steer = fake.steers.map((s) => s.text).join('\n');
    assert.match(steer, /Do NOT describe the blocked action as done/);
    assert.match(steer, /Do NOT rewrite it as a script/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario D — cross-turn spin. Each turn stays under the per-turn thresholds
 * (so every existing guard is silent); only the session-scoped budget sees the
 * same probe on turns 1, 2 and 3.
 */
test('scenario D: the same probe across user turns is caught by the session budget', async () => {
  const dir = makeFixture(null);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const perTurn = 4; // below the per-turn frozen threshold (needs 5)
    const probe = 'dir face /b';
    const { svc, fake, emitted } = makeService([], 'scenario-cross-turn');

    // Session budgets are deliberately relaxed for long unattended coding runs
    // (session 47f9e6c7). Drive enough identical probes to cross the HARD repeat
    // threshold (2× maxRepeatProbes) so this reverse case still proves a true
    // across-turn spin is terminated — not coupled to a hardcoded threshold.
    const turnsToHardBreach = Math.ceil(
      (DEFAULT_CORRECTION_CONFIG.session.maxRepeatProbes * 2) / perTurn,
    );
    for (let turn = 0; turn < turnsToHardBreach; turn += 1) {
      fake.script = Array.from({ length: perTurn }, (_, i) =>
        probeStep(turn * perTurn + i, probe),
      ).flat();
      await svc.runTurn('继续检查一下当前状态');
      if (turn === 0) {
        assert.equal(
          emitted.filter((e) => e.type === 'correction').length,
          0,
          'a single turn must not trip the per-turn guards',
        );
      }
    }

    const breaks = emitted.filter((e) => e.type === 'spin_break');
    assert.ok(breaks.length >= 1, 'the session budget must notice the repeat');
    assert.ok(breaks.some((b) => b.kind === 'repeat_probe'), 'repeat_probe expected');
    assert.ok(breaks.some((b) => b.severity === 'hard'));
    assert.ok(fake.aborted >= 1, 'hard breach terminates the runaway turn');
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario E — a declared invariant that was never run. This is the exact
 * end-state of the video-plus session: the model is sure, the check exists,
 * nobody ran it. The verdict must be `unverified`, never `passed`.
 */
test('scenario E: declared but unrun check yields unverified, not success', async () => {
  const dir = makeFixture({
    version: 1,
    invariants: [
      {
        id: 'subtitle-coverage',
        checks: [{ cmd: 'python tools/check_timeline.py', expect: { stdoutMatch: '^OK' } }],
      },
    ],
  });
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const script = [
      ...Array.from({ length: 3 }, (_, i) => probeStep(i)).flat(),
      { type: 'turn_start', turn: 9 },
      { type: 'text', text: '字幕时间轴完全正确！每条字幕都精准落在对应的 shot 内。' },
      { type: 'turn_end', turn: 9 },
    ];
    const { svc, emitted } = makeService(script);

    await svc.runTurn('把字幕和音频对齐');

    const verdict = emitted.find((e) => e.type === 'turn_verdict');
    assert.equal(verdict.status, 'unverified');
    assert.ok(verdict.skipped.length >= 1, 'the unrun check must be reported');
    assert.equal(svc.getLastTurnVerdict().status, 'unverified');

    const contract = emitted.find((e) => e.type === 'contract_verdict');
    assert.equal(contract.passed, false);
    assert.ok(contract.skipped.length >= 1);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario F — the same-domain success path with a *failing* check: the tool
 * ran, so the contract is checked, and it contradicts the claim. This is the
 * 03:40:22 / 03:40:53 flip ("not aligned" -> "basically correct") reduced to
 * one turn: the verdict must be `failed`, and the failing output is quoted.
 */
test('scenario F: an observed check that contradicts the claim is failed, with evidence', async () => {
  const dir = makeFixture({
    version: 1,
    invariants: [
      {
        id: 'timeline-ssot',
        checks: [{ cmd: 'python tools/check_timeline.py', expect: { stdoutMatch: '^OK' } }],
      },
    ],
  });
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const script = [
      { type: 'turn_start', turn: 1 },
      ...exec('python tools/check_timeline.py', 'MISMATCH video=15.20 audio=27.94 subtitle_end=15.20'),
      { type: 'turn_end', turn: 1 },
      { type: 'turn_start', turn: 2 },
      { type: 'text', text: '修复成功！视频 27.94s，音频 27.94s，完全匹配。' },
      { type: 'turn_end', turn: 2 },
    ];
    const { svc, emitted } = makeService(script);

    await svc.runTurn('把图片、音频和字幕对齐');

    const verdict = emitted.find((e) => e.type === 'turn_verdict');
    assert.equal(verdict.status, 'failed');
    assert.ok(verdict.failed.some((f) => /did not match|violated/.test(f)));
    assert.equal(svc.getLastTurnVerdict().claims[0].status, 'refuted');
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario G — the 8-hour session was invisible from the outside: `/stats`
 * reported tokens and message count, so nobody could ask "how many turns in
 * this session ended without evidence?". The counters must be per-session and
 * must survive the turn boundary.
 */
test('scenario G: session stats expose verdict counts across turns', async () => {
  const dir = makeFixture(null);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const sessionId = 'scenario-stats';
    const { svc, fake } = makeService([], sessionId, { withSession: true });

    // Turn 1: a probe-only turn with no claim -> unclaimed.
    fake.script = probeStep(0);
    await svc.runTurn('先看看当前状态');

    // Turn 2: a claim with no evidence -> unverified.
    fake.script = [
      { type: 'turn_start', turn: 2 },
      { type: 'text', text: '修复成功！已经全部对齐了。' },
      { type: 'turn_end', turn: 2 },
    ];
    await svc.runTurn('重新修复代码中图片和音频对齐问题');

    // Turn 3: a blocked action -> blocked.
    fake.script = [
      { type: 'turn_start', turn: 3 },
      ...exec('del _cleanup.py', 'Unattended mode blocked file mutation', { isError: true }),
      { type: 'text', text: '清理脚本已删除。' },
      { type: 'turn_end', turn: 3 },
    ];
    await svc.runTurn('删掉临时脚本');

    const stats = await svc.getSessionStats(sessionId);
    assert.ok(stats.verdicts, 'verdict counters must be part of session stats');
    assert.equal(stats.verdicts.total, 3);
    assert.equal(stats.verdicts.unclaimed, 1);
    // The alignment request compiles to "declare an invariant" and none
    // exists, so the claim is refuted (not merely unverified).
    assert.equal(stats.verdicts.failed, 1);
    assert.equal(stats.verdicts.blocked, 1);
    assert.equal(stats.verdicts.passed, 0);
    assert.equal(stats.steps, 3, 'session steps survive every turn_end');
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario H — the overnight autopilot. A background job finished after a turn
 * that ended without a passing verdict; waking the agent would resume "one more
 * attempt" without the user. The gate must skip the wake and say so.
 */
test('scenario H: a wake turn is skipped while the last verdict did not pass', async () => {
  const dir = makeFixture(null);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    const { svc, emitted } = makeService([
      { type: 'turn_start', turn: 1 },
      { type: 'text', text: '字幕时间轴完全正确。' },
      { type: 'turn_end', turn: 1 },
    ]);

    await svc.runTurn('把字幕和音频对齐');
    const last = svc.getLastTurnVerdict();
    assert.notEqual(last.status, 'passed', 'a prose-only turn must not pass');

    // A completed background job arrives; the wake must not run.
    let ran = 0;
    svc.runTurn = async () => {
      ran += 1;
      return {};
    };
    await svc.runWakeTurn({
      job: { id: 'job-1', status: 'completed' },
      kind: 'completed',
      summary: { id: 'job-1', cmd: 'npm test', exitCode: 0 },
    });

    assert.equal(ran, 0, 'the wake turn must not run on a non-passing last turn');
    const skipped = emitted.find((e) => e.type === 'wake_skipped');
    assert.ok(skipped, 'skipping must be visible, not silent');
    assert.match(skipped.reason, new RegExp(last.status));
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Scenario I — a media generation turn that produced a real artifact.
 *
 * Regression for session 6eb6232d: "已有交付件" (generate_image wrote a PNG)
 * must become machine-checkable evidence. Without it the contract stayed empty
 * and the turn ended `unverified` despite a delivered image.
 */
test('scenario I: a media artifact turns an unverified claim into a verified one', async () => {
  const dir = makeFixture(null);
  const prev = process.cwd();
  process.chdir(dir);
  const artifact = join(dir, 'output', 'flat-lay.png');
  mkdirSync(join(dir, 'output'), { recursive: true });
  writeFileSync(artifact, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const PNG = artifact;
    const envelope = JSON.stringify({
      ok: true,
      task_id: 'mt_test',
      status: 'succeeded',
      kind: 'image',
      files: [PNG],
      image_path: PNG,
    });
    const script = [
      { type: 'turn_start', turn: 1 },
      { type: 'tool_call_start', name: 'generate_image', args: { prompt: 'flat lay' } },
      {
        type: 'tool_result',
        name: 'generate_image',
        args: { prompt: 'flat lay' },
        content: envelope,
      },
      { type: 'text', text: '已生成图片。' },
      { type: 'turn_end', turn: 1 },
    ];
    const { svc, emitted } = makeService(script);

    await svc.runTurn('帮我生成一张俯视视角的桌面静物照');

    const verdict = emitted.find((e) => e.type === 'turn_verdict');
    assert.equal(verdict.status, 'passed');
    assert.equal(verdict.claimed, true);

    const contract = emitted.find((e) => e.type === 'contract_verdict');
    assert.equal(contract.passed, true);
    assert.ok(contract.failed.length === 0, 'no failed acceptance items expected');
    assert.equal(svc.getLastTurnVerdict().status, 'passed');
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
