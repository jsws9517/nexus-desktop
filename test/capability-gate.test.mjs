/**
 * Capability gate — grant_hint wiring.
 *
 * H-1: when a capability denial happens, the model gets a LEGITIMATE path to
 * acquire the capability (grant_hint) instead of retrying the same args and
 * tripping the sentinel probe-loop freeze.
 *
 * These tests pin:
 *   - classifyToolResult still separates blocked from failed (regression);
 *   - buildDecisionRequest carries grant_hint when provided;
 *   - buildBlockedSteer appends the legitimate path when hints are given;
 *   - buildGrantHint produces the right kind for each tool family;
 *   - buildGrantHint returns undefined for unknown tools (no false hints).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nexus-capability-gate-'));
process.env.NEXUS_CONFIG_DIR = join(tmp, '.nexus');
process.env.LLMA_DATA_DIR = join(tmp, '.llm-agent');
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows file-lock: best-effort */ }
});

const {
  classifyToolResult,
  buildDecisionRequest,
  buildBlockedSteer,
  describeBlocked,
} = await import('../dist/agent/capability-gate.js');

// ---------------------------------------------------------------------------
// Regression: classifyToolResult
// ---------------------------------------------------------------------------

describe('classifyToolResult (regression)', () => {
  it('returns ok for non-error', () => {
    assert.equal(classifyToolResult(false, 'done'), 'ok');
  });

  it('returns failed for error with no blocked pattern', () => {
    assert.equal(classifyToolResult(true, 'ENOENT: file not found'), 'failed');
  });

  it('returns blocked for "unattended mode blocked"', () => {
    assert.equal(classifyToolResult(true, 'unattended mode blocked: rm -rf /'), 'blocked');
  });

  it('returns blocked for "permission denied"', () => {
    assert.equal(classifyToolResult(true, 'permission denied'), 'blocked');
  });

  it('returns blocked for [subagent:blocked_policy]', () => {
    assert.equal(
      classifyToolResult(true, '[subagent:blocked_policy] quota exhausted'),
      'blocked',
    );
  });

  it('returns failed for empty error content', () => {
    assert.equal(classifyToolResult(true, ''), 'failed');
  });
});

// ---------------------------------------------------------------------------
// buildDecisionRequest with and without grant_hint
// ---------------------------------------------------------------------------

describe('buildDecisionRequest', () => {
  it('without hint: grant_hint is undefined', () => {
    const req = buildDecisionRequest('exec_command', 'rm -rf /', 'blocked by policy');
    assert.equal(req.type, 'decision_request');
    assert.equal(req.tool, 'exec_command');
    assert.equal(req.command, 'rm -rf /');
    assert.equal(req.grant_hint, undefined);
    // note should NOT mention grant_hint
    assert.doesNotMatch(req.note, /grant_hint/i);
  });

  it('with hint: grant_hint is carried through', () => {
    const hint = {
      kind: 'config',
      instruction: 'Add to permissions.allow in config.json',
      configKey: 'permissions.allow',
      suggestedValue: '{"command": "rm -rf *"}',
    };
    const req = buildDecisionRequest('exec_command', 'rm -rf /', 'blocked by policy', hint);
    assert.deepEqual(req.grant_hint, hint);
    // note should reference grant_hint
    assert.match(req.note, /grant_hint/i);
  });

  it('options always present', () => {
    const req = buildDecisionRequest('tool', 'cmd', 'reason');
    assert.equal(req.options.length, 3);
    assert.deepEqual(
      req.options.map((o) => o.id),
      ['grant', 'switch_mode', 'skip'],
    );
  });
});

// ---------------------------------------------------------------------------
// buildBlockedSteer with and without hints
// ---------------------------------------------------------------------------

describe('buildBlockedSteer', () => {
  it('without hints: classic 3-rule steer (regression)', () => {
    const steer = buildBlockedSteer(['exec_command: rm -rf /']);
    assert.match(steer, /<harness_correction kind="capability_blocked">/);
    assert.match(steer, /1\) Do NOT describe/);
    assert.match(steer, /2\) Do NOT rewrite/);
    assert.match(steer, /3\) Ask the user/);
    // No "Legitimate paths" section
    assert.doesNotMatch(steer, /Legitimate paths/);
  });

  it('with hints: appends legitimate path section', () => {
    const hints = [
      { kind: 'config', instruction: 'Add to permissions.allow' },
      { kind: 'switch_mode', instruction: 'Switch to auto mode' },
    ];
    const steer = buildBlockedSteer(['exec_command: rm -rf /'], hints);
    assert.match(steer, /Legitimate paths/);
    assert.match(steer, /Add to permissions\.allow/);
    assert.match(steer, /Switch to auto mode/);
    assert.match(steer, /STOP retrying/);
  });

  it('with empty hints array: no legitimate path section', () => {
    const steer = buildBlockedSteer(['tool: cmd'], []);
    assert.doesNotMatch(steer, /Legitimate paths/);
  });

  it('caps hints at 3 in the steer', () => {
    const hints = [
      { kind: 'config', instruction: 'hint 1' },
      { kind: 'config', instruction: 'hint 2' },
      { kind: 'config', instruction: 'hint 3' },
      { kind: 'config', instruction: 'hint 4' },
      { kind: 'config', instruction: 'hint 5' },
    ];
    const steer = buildBlockedSteer(['tool: cmd'], hints);
    assert.match(steer, /hint 1/);
    assert.match(steer, /hint 2/);
    assert.match(steer, /hint 3/);
    assert.doesNotMatch(steer, /hint 4/);
    assert.doesNotMatch(steer, /hint 5/);
  });
});

// ---------------------------------------------------------------------------
// buildGrantHint — tool-specific hint construction
// ---------------------------------------------------------------------------

describe('buildGrantHint (via AgentService)', () => {
  let svc;

  before(async () => {
    const { AgentService } = await import('../dist/agent/service.js');
    svc = new AgentService();
    await svc.earlyInit();
  });

  it('exec_command with rm -rf: hard class, no config escape — use a dedicated tool', () => {
    const internalHint = svc['buildGrantHint']('exec_command', 'rm -rf /tmp/old', '');
    assert.ok(internalHint, 'should produce a hint for rm -rf');
    assert.equal(internalHint.kind, 'one_tap', 'hard-class commands are not config-unlockable');
    assert.equal(internalHint.configKey, undefined, 'there is no config key for a hard-class command');
    assert.match(internalHint.instruction, /hard-blocked|hard-class|always denied/i);
    assert.match(internalHint.instruction, /delete_file|remove_file/);
    assert.match(internalHint.instruction, /tmp_cleanup|\.nexus\/trash/);
    assert.doesNotMatch(internalHint.instruction, /permissions\.allow/i, 'permissions.allow does not exist');
  });

  it('exec_command with unattended block: kind=switch_mode', () => {
    const internalHint = svc['buildGrantHint']('exec_command', 'npm install', 'unattended mode blocked: npm install');
    assert.ok(internalHint, 'should produce a hint for unattended block');
    assert.equal(internalHint.kind, 'switch_mode');
    assert.equal(internalHint.targetMode, 'auto');
    assert.match(internalHint.instruction, /execCommandOverrides/);
    assert.doesNotMatch(internalHint.instruction, /permissions\.allow/i, 'permissions.allow does not exist');
  });

  it('delete_file: kind=one_tap', () => {
    const internalHint = svc['buildGrantHint']('delete_file', 'path/to/file.txt', 'permission denied');
    assert.ok(internalHint, 'should produce a hint for delete_file');
    assert.equal(internalHint.kind, 'one_tap');
  });

  it('file grant hint: specific directory, not drive root; mode switch is not a path grant', () => {
    const internalHint = svc['buildGrantHint']('delete_file', 'path/to/file.txt', 'permission denied');
    assert.match(internalHint.instruction, /project directory|具体/i);
    assert.match(internalHint.instruction, /drive root|C:\\/i, 'warns against granting a drive root');
    assert.match(internalHint.instruction, /does NOT change the path boundary/i);
  });

  it('acp_route with not found: kind=config, configKey=acp.enabled', () => {
    const internalHint = svc['buildGrantHint']('acp_route', 'claude', 'Agent claude not found');
    assert.ok(internalHint, 'should produce a hint for acp_route not found');
    assert.equal(internalHint.kind, 'config');
    assert.equal(internalHint.configKey, 'acp.enabled');
  });

  it('acp_router with role not found: kind=config', () => {
    const internalHint = svc['buildGrantHint']('acp_router', 'tester', 'Role "tester" not found');
    assert.ok(internalHint, 'should produce a hint for acp_router role not found');
    assert.equal(internalHint.kind, 'config');
    assert.match(internalHint.configKey ?? '', /SKILL\.md/);
  });

  it('unknown tool: returns undefined', () => {
    const internalHint = svc['buildGrantHint']('some_unknown_tool', 'cmd', 'blocked');
    assert.equal(internalHint, undefined);
  });

  it('exec_command with no destructive pattern: returns undefined', () => {
    const internalHint = svc['buildGrantHint']('exec_command', 'ls -la', 'some generic error');
    assert.equal(internalHint, undefined);
  });
});

// ---------------------------------------------------------------------------
// describeBlocked (regression)
// ---------------------------------------------------------------------------

describe('describeBlocked (regression)', () => {
  it('truncates long commands to 160 chars', () => {
    const long = 'a'.repeat(300);
    const desc = describeBlocked(long);
    assert.equal(desc.length, 160);
  });

  it('normalizes whitespace', () => {
    assert.equal(describeBlocked('rm   -rf  /tmp'), 'rm -rf /tmp');
  });
});
