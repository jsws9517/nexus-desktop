/**
 * Verifies session 47f9e6c7 problem ② temporary turn relaxation:
 *  - unattended + coding spend + coding task raises the parent `maxTurns` and
 *    every sub-agent role budget for the duration of runTurn();
 *  - both are restored in `finally` (success AND thrown chat);
 *  - prompt mode / non-coding task never relax anything.
 *
 * Run: node --test test/turn-relaxation.test.mjs
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')).href);
const { invalidateSpendModeCache } = await import(
  pathToFileURL(join(dist, 'agent', 'spend-mode-store.js')).href
);

// Force the `coding` spend tier for this whole file.
const cfgDir = process.env.NEXUS_CONFIG_DIR;
mkdirSync(cfgDir, { recursive: true });
writeFileSync(join(cfgDir, 'desktop.json'), JSON.stringify({ spendMode: { default: 'coding' } }));
invalidateSpendModeCache();

const CODING_INPUT = '实现并修复代码模块里的 bug，重构函数并补充测试';

function makeAgent({ mode = 'unattended' } = {}) {
  const a = {};
  a.maxTurns = 25;
  a.subTurns = { general: 8, tester: 4, committer: 4, 'skill-fixer': 8, office: 12, tdd: 10 };
  a.subOverrideCalls = [];
  a.context = { getTokenCount: () => 200 };
  a.provider = { model: 'm' };
  a.config = {
    getMaxTurns: () => a.maxTurns,
    getPermissions: () => ({ mode, allowlist: [], mcpAllowlist: [] }),
    getActiveProvider: () => 'scenario',
    getProvider: () => ({ baseUrl: 'http://localhost:9999', model: 'm' }),
    getSubAgentMaxTurnsSnapshot: (roles) =>
      Object.fromEntries(roles.map((r) => [r, a.subTurns[r] ?? 8])),
    setSubAgentMaxTurnsInMemory: (patch) => {
      a.subOverrideCalls.push({ ...patch });
      Object.assign(a.subTurns, patch);
    },
  };
  a.chat = async function chat() {
    a.maxTurnsDuringChat = a.maxTurns;
    a.subTurnsDuringChat = { ...a.subTurns };
  };
  a.abort = () => {};
  a.enqueueSteer = () => true;
  a.getCurrentSessionId = () => 'turn-relax-session';
  return a;
}

function makeService(agent) {
  const svc = new AgentService();
  svc.onEvent = () => {};
  svc.agent = agent;
  svc.rateLimiter.acquire = async () => {};
  return svc;
}

test('unattended + coding relaxes parent and sub-agent turns, then restores', async () => {
  const agent = makeAgent({ mode: 'unattended' });
  const original = { ...agent.subTurns };
  const svc = makeService(agent);

  await svc.runTurn(CODING_INPUT);

  assert.equal(agent.maxTurnsDuringChat, 200, 'parent maxTurns raised during chat');
  assert.ok(
    Object.values(agent.subTurnsDuringChat).every((v) => v >= 60),
    `sub-agent budgets raised during chat: ${JSON.stringify(agent.subTurnsDuringChat)}`,
  );
  assert.equal(agent.maxTurns, 25, 'parent maxTurns restored after chat');
  assert.deepEqual(agent.subTurns, original, 'sub-agent budgets restored after chat');
  assert.ok(agent.subOverrideCalls.length >= 2, 'relax + restore both wrote sub-agent overrides');
});

test('turn budgets are restored even when chat() throws', async () => {
  const agent = makeAgent({ mode: 'unattended' });
  const original = { ...agent.subTurns };
  agent.chat = async () => { throw new Error('boom'); };
  const svc = makeService(agent);

  await assert.rejects(() => svc.runTurn(CODING_INPUT), /boom/);

  assert.equal(agent.maxTurns, 25, 'parent maxTurns restored after throw');
  assert.deepEqual(agent.subTurns, original, 'sub-agent budgets restored after throw');
});

test('configured maxTurns above the 200 floor is not lowered by relaxation', async () => {
  // A user-configured baseline above the temporary-relaxation floor must be
  // preserved — relaxation is a floor, never a ceiling.
  const agent = makeAgent({ mode: 'unattended' });
  agent.maxTurns = 350;
  const svc = makeService(agent);

  await svc.runTurn(CODING_INPUT);

  assert.equal(agent.maxTurnsDuringChat, 350, 'configured 350 preserved during chat (not clamped to 200)');
  assert.equal(agent.maxTurns, 350, 'configured 350 restored after chat');
});

test('prompt mode does not relax any turn budget', async () => {
  const agent = makeAgent({ mode: 'prompt' });
  const original = { ...agent.subTurns };
  const svc = makeService(agent);

  await svc.runTurn(CODING_INPUT);

  assert.equal(agent.maxTurnsDuringChat, 25, 'no parent relaxation in prompt mode');
  assert.deepEqual(agent.subTurns, original, 'no sub-agent relaxation in prompt mode');
  assert.equal(agent.subOverrideCalls.length, 0, 'no sub-agent override writes in prompt mode');
});

test('unattended but non-coding task does not relax any turn budget', async () => {
  const agent = makeAgent({ mode: 'unattended' });
  const original = { ...agent.subTurns };
  const svc = makeService(agent);

  await svc.runTurn('你好，随便聊聊');

  assert.equal(agent.maxTurnsDuringChat, 25, 'no parent relaxation for non-coding task');
  assert.deepEqual(agent.subTurns, original, 'no sub-agent relaxation for non-coding task');
  assert.equal(agent.subOverrideCalls.length, 0, 'no sub-agent override writes for non-coding task');
});
