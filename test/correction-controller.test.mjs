/**
 * Correction Controller — ladder, budget, escalation, de-escalation tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { CorrectionController } = await import('../dist/agent/correction-controller.js');
const { DEFAULT_CORRECTION_CONFIG, mergeCorrectionConfig } = await import(
  '../dist/agent/correction-config.js'
);

function makeController(configPatch = {}) {
  const config = mergeCorrectionConfig(DEFAULT_CORRECTION_CONFIG, configPatch);
  const calls = { steer: [], policy: [], abort: 0, events: [] };
  const ctl = new CorrectionController({
    config,
    now: () => 1_700_000_000_000,
    executors: {
      steer: (text, opts) => {
        calls.steer.push({ text, opts });
        return true;
      },
      setToolPolicy: (policy) => calls.policy.push(policy),
      abort: () => {
        calls.abort += 1;
      },
      emit: (event) => calls.events.push(event),
    },
  });
  return { ctl, calls, config };
}

function step(seq, overrides = {}) {
  return {
    seq,
    at: 0,
    model: 'test',
    fingerprint: `fp-${seq}`,
    actions: [],
    outcome: 'neutral',
    evidence: [],
    thinkingTokens: 0,
    textTokens: 0,
    toolOutcomes: [],
    ...overrides,
  };
}

const signal = (kind, severity, evidence = ['e']) => ({
  kind,
  severity,
  confidence: severity >= 0.7 ? 'high' : 'medium',
  evidence,
});

describe('L1 — targeted steer', () => {
  it('fires a steer with evidence for a low-severity loop signal', () => {
    const { ctl, calls } = makeController();
    const action = ctl.onStep(step(5), [signal('loop_no_progress', 0.4)]);
    assert.ok(action);
    assert.equal(action.level, 1);
    assert.equal(calls.steer.length, 1);
    assert.ok(calls.steer[0].text.includes('<harness_correction'));
    assert.ok(calls.steer[0].text.includes('e'));
    assert.equal(calls.abort, 0);
  });

  it('emits a structured correction event', () => {
    const { ctl, calls } = makeController();
    ctl.onStep(step(5), [signal('thinking_dilution', 0.4)]);
    assert.equal(calls.events.length, 1);
    assert.equal(calls.events[0].type, 'correction');
    assert.equal(calls.events[0].level, 1);
    assert.equal(calls.events[0].kind, 'thinking_dilution');
  });

  it('does nothing for a healthy step', () => {
    const { ctl, calls } = makeController();
    assert.equal(ctl.onStep(step(1, { outcome: 'progress' }), []), null);
    assert.equal(calls.steer.length, 0);
  });

  it('never acts on a signal with no evidence', () => {
    const { ctl } = makeController();
    assert.equal(ctl.onStep(step(2), [signal('loop_no_progress', 0.9, [])]), null);
  });
});

describe('budget and cooldown', () => {
  it('suppresses low-confidence nudges once the L1 budget is spent', () => {
    const { ctl, calls } = makeController({ budget: { l1PerTurn: 0 } });
    const action = ctl.onStep(step(5), [signal('loop_no_progress', 0.4)]);
    assert.equal(action, null);
    assert.equal(calls.steer.length, 0);
  });

  it('escalates a high-confidence signal when L1 is exhausted', () => {
    const { ctl, calls } = makeController({ budget: { l1PerTurn: 0 } });
    const action = ctl.onStep(step(5), [signal('loop_no_progress', 0.75)]);
    assert.ok(action);
    assert.equal(action.level, 2);
    assert.ok(action.policy);
  });

  it('enforces the cooldown between two L1 nudges', () => {
    const { ctl, calls } = makeController({ budget: { coolDownStepsAfterL1: 5 } });
    const first = ctl.onStep(step(5), [signal('thinking_dilution', 0.4)]);
    assert.ok(first);
    // Different kind, only 1 step later -> cooldown blocks it.
    const second = ctl.onStep(step(6), [signal('loop_no_progress', 0.4)]);
    assert.equal(second, null);
    assert.equal(calls.steer.length, 1);
  });
});

describe('escalation', () => {
  it('raises the level when the same signal recurs within three steps', () => {
    const { ctl } = makeController();
    const first = ctl.onStep(step(5), [signal('loop_no_progress', 0.4)]);
    const second = ctl.onStep(step(6), [signal('loop_no_progress', 0.4)]);
    assert.equal(first.level, 1);
    assert.equal(second.level, 2);
  });

  it('L2 narrows the tool space and names the failed tools', () => {
    const { ctl } = makeController();
    const action = ctl.onStep(
      step(7, {
        toolOutcomes: [{ tool: 'exec_command', ok: false, failKey: 'exec_command:exec-failed' }],
      }),
      [signal('loop_no_progress', 0.6)],
    );
    assert.equal(action.level, 2);
    assert.equal(action.policy.active, true);
    assert.deepEqual(action.policy.denyTools, ['exec_command']);
    assert.equal(action.policy.requirePlanFirst, true);
  });

  it('L3 requests a rollback and a replan', () => {
    const { ctl, calls } = makeController();
    const action = ctl.onStep(step(9), [signal('loop_no_progress', 0.9)]);
    assert.equal(action.level, 3);
    assert.equal(action.rollback, true);
    assert.equal(calls.steer[0].opts.rollback, true);
    assert.ok(calls.steer[0].text.includes('rolled back'));
  });
});

describe('de-escalation', () => {
  it('returns to L0 and lifts the tool policy after enough progress', () => {
    const { ctl, calls, config } = makeController();
    ctl.onStep(step(5), [signal('loop_no_progress', 0.6)]);
    assert.equal(ctl.currentLevel, 2);

    for (let i = 0; i < config.deescalation.progressRequired; i += 1) {
      ctl.onStep(step(10 + i, { outcome: 'progress' }), []);
    }
    assert.equal(ctl.currentLevel, 0);
    assert.equal(calls.policy[calls.policy.length - 1], null);
  });
});

describe('terminal paths', () => {
  it('a safety probe is always L4 and aborts', () => {
    const { ctl, calls } = makeController();
    const action = ctl.onStep(step(4), [signal('safety_probe', 0.1)]);
    assert.equal(action.level, 4);
    assert.equal(action.abort, true);
    assert.equal(calls.abort, 1);
  });

  it('forceTerminate bypasses budget and evidence checks', () => {
    const { ctl, calls } = makeController({ budget: { l1PerTurn: 0, l2PerTurn: 0, l3PerTurn: 0 } });
    const action = ctl.forceTerminate('safety_probe', 'policy write', ['target=.nexus/rules']);
    assert.equal(action.level, 4);
    assert.equal(calls.abort, 1);
    assert.equal(calls.events[0].kind, 'safety_probe');
  });

  it('picks safety over a higher raw severity loop signal', () => {
    const { ctl } = makeController();
    const action = ctl.onStep(step(6), [
      signal('loop_no_progress', 0.99),
      signal('safety_probe', 0.2),
    ]);
    assert.equal(action.kind, 'safety_probe');
    assert.equal(action.level, 4);
  });
});

describe('evidence pack', () => {
  it('records the ledger tail and every action taken', () => {
    const { ctl } = makeController();
    const s = step(5);
    ctl.onStep(s, [signal('loop_no_progress', 0.6)]);
    const pack = ctl.evidencePack('loop_no_progress', [s], 'do the thing');
    assert.equal(pack.ledgerTail.length, 1);
    assert.equal(pack.actions.length, 1);
    assert.equal(pack.userMessage, 'do the thing');
    assert.ok(pack.level >= 2);
  });
});
