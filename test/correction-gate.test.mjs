/**
 * Desktop wiring for the core's pre-execution hooks.
 *
 * The core owns the hook invocation (covered by nexus-coder tests); these tests
 * pin the desktop side: `earlyInit` registers the hooks, the sentinel verdict
 * captured on `tool_call_start` is enforced at the execution boundary, and the
 * completion gate refuses a "done" when the deliverable contract is unmet.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nexus-correction-gate-'));
process.env.NEXUS_CONFIG_DIR = join(tmp, '.nexus');
process.env.LLMA_DATA_DIR = join(tmp, '.llm-agent');
// The sandboxed config dir has no credentials, and constructing AgentService
// resolves the default provider's key eagerly. CI has no ambient key (a dev
// machine often does), so provide a throwaway one — these tests never call the
// network.
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
after(() => rmSync(tmp, { recursive: true, force: true }));

const { AgentService } = await import('../dist/agent/service.js');
const { SecuritySentinel } = await import('../dist/agent/security-sentinel.js');
const { parseContract } = await import('../dist/agent/deliverable-contract.js');
const { DEFAULT_CORRECTION_CONFIG } = await import('../dist/agent/correction-config.js');

const signal = () => new AbortController().signal;

describe('core hook wiring', () => {
  let svc;

  before(async () => {
    svc = new AgentService();
    await svc.earlyInit();
  });

  after(async () => {
    try {
      await svc.agent?.shutdown?.();
    } catch {}
  });

  it('earlyInit registers preToolUse and onTurnEnd', () => {
    assert.equal(typeof svc.agent.hooks.preToolUse, 'function');
    assert.equal(typeof svc.agent.hooks.onTurnEnd, 'function');
  });

  it('preToolUse denies a cached sentinel verdict (before execution)', () => {
    svc.activeSentinel = new SecuritySentinel({ root: process.cwd() });
    svc.activeMonitor = {
      isNoise: () => false,
      noteThinking: () => {},
      noteText: () => {},
      noteProgress: () => {},
      checkStall: () => ({ stalled: false }),
    };
    svc.activeRepMonitor = null;

    const args = { path: '.nexus/rules/NEXUS.md', content: 'pwned' };
    const emitted = [];
    svc.onEvent = (e) => emitted.push(e);
    svc.handleAgentEvent({ type: 'tool_call_start', name: 'write_file', args });

    // A fatal probe is surfaced and cached.
    const probes = emitted.filter((e) => e.type === 'security_probe');
    assert.equal(probes.length, 1);
    assert.equal(probes[0].fatal, true);

    // The core hook sees the deny at the execution boundary.
    const verdict = svc.guardToolExecution({ name: 'write_file', arguments: args });
    assert.equal(verdict.verdict, 'deny');
    assert.match(verdict.blockedRule, /^sentinel:/);
    assert.match(verdict.reason, /policy/i);
  });

  it('preToolUse allows a clean call and unknown calls', () => {
    svc.activeSentinel = new SecuritySentinel({ root: process.cwd() });
    svc.sentinelDecisions.clear();
    svc.handleAgentEvent({
      type: 'tool_call_start',
      name: 'read_text_file',
      args: { path: 'package.json' },
    });
    assert.equal(svc.guardToolExecution({ name: 'read_text_file', arguments: { path: 'package.json' } }), 'allow');
    assert.equal(svc.guardToolExecution(undefined), 'allow');
  });

  it('preToolUse leaves a non-fatal probe to the permission bridge', () => {
    // A write outside the root is a probe, not a verdict: the user still gets
    // the Allow/Deny card. Hard-denying here would make that card a no-op.
    svc.activeSentinel = new SecuritySentinel({ root: process.cwd() });
    svc.sentinelDecisions.clear();
    // A path outside the project root: use the OS temp dir so the case holds on
    // POSIX too (a literal `C:\Windows\Temp\...` is a *relative* path on Linux,
    // which stays inside the root and never raises a probe).
    const args = { path: join(tmpdir(), 'nexus-probe.txt'), content: 'x' };
    const emitted = [];
    svc.onEvent = (e) => emitted.push(e);
    svc.handleAgentEvent({ type: 'tool_call_start', name: 'write_file', args });

    const probe = emitted.find((e) => e.type === 'security_probe');
    assert.equal(probe.fatal, false);
    assert.equal(svc.guardToolExecution({ name: 'write_file', arguments: args }), 'allow');
  });
});

describe('completion gate', () => {
  let svc;

  before(async () => {
    svc = new AgentService();
    await svc.earlyInit();
    svc.correctionConfig = DEFAULT_CORRECTION_CONFIG;
    svc.turnTranscript = [{ role: 'user', text: '请创建 `src/__gate_missing__.ts` 并实现解析逻辑' }];
    svc.currentTurnInput = '请创建 `src/__gate_missing__.ts` 并实现解析逻辑';
  });

  after(async () => {
    try {
      await svc.agent?.shutdown?.();
    } catch {}
  });

  it('refuses a completion claim when a required file is missing', () => {
    svc.activeContract = parseContract(svc.currentTurnInput);
    svc.completionGateAttempts = 0;
    const verdict = svc.evaluateCompletionGate('已完成，文件已创建。');
    assert.ok(verdict, 'expected the gate to reject');
    assert.equal(verdict.verdict, 'continue');
    assert.equal(verdict.gate, 'deliverable_contract');
    assert.match(verdict.reason, /acceptance item/);
    assert.match(verdict.steer, /__gate_missing__\.ts/);
    assert.equal(svc.completionGateAttempts, 1);
  });

  it('lets a completion through when the deliverable exists and tools ran', () => {
    svc.activeContract = parseContract('请创建 `package.json`');
    svc.completionGateAttempts = 0;
    svc.turnTranscript = [
      { role: 'user', text: '请创建 `package.json`' },
      { role: 'assistant', text: 'checking', toolCalls: 2 },
      { role: 'tool', text: 'ok' },
    ];
    const verdict = svc.evaluateCompletionGate('已完成，文件已创建。');
    assert.equal(verdict, undefined);
  });

  it('does nothing when the answer does not claim completion', () => {
    svc.activeContract = parseContract(svc.currentTurnInput);
    svc.completionGateAttempts = 0;
    const verdict = svc.evaluateCompletionGate('还在处理中，下一步会写入。');
    assert.equal(verdict, undefined);
  });

  it('stops gating after the per-turn retry budget is spent', () => {
    svc.activeContract = parseContract(svc.currentTurnInput);
    svc.completionGateAttempts = DEFAULT_CORRECTION_CONFIG.thresholds.contract.maxAntiCheatRetries;
    const verdict = svc.evaluateCompletionGate('已完成，文件已创建。');
    assert.equal(verdict, undefined);
  });

  it('the registered onTurnEnd hook calls the gate', async () => {
    svc.activeContract = parseContract('请创建 `src/__gate_missing__.ts`');
    svc.completionGateAttempts = 0;
    svc.turnTranscript = [{ role: 'user', text: svc.currentTurnInput }];
    const verdict = await svc.agent.hooks.onTurnEnd({
      turn: 1,
      signal: signal(),
      userInput: svc.currentTurnInput,
      assistantText: '已完成',
    });
    assert.equal(verdict.verdict, 'continue');
    assert.equal(verdict.gate, 'deliverable_contract');
  });
});
