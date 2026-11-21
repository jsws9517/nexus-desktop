/**
 * Subagent structured failure codes — [subagent:<kind>] payload encoding.
 *
 * Pins the whole pipeline:
 *   - buildSubagentFailure / parseSubagentFailureKind round-trip;
 *   - callAcpRouterTool's not_found branches carry the code;
 *   - capability-gate.classifyToolResult short-circuits to `blocked` on the
 *     structured code (and falls back to the regex only when prose is the
 *     sole signal);
 *   - subagentFailureKey: the fail_seq circuit-breaker key mapping
 *     (blocked_* → excluded, not_found → arg-level, rest → class-level).
 *
 * Vanilla node:test, built dist, mirrors session-worker-acp.test.mjs.
 */

import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distRoot = join(__dirname, '..', 'dist');

const {
  buildSubagentFailure,
  parseSubagentFailureKind,
  subagentFailureKey,
  formatSubagentSteer,
  callAcpRouterTool,
} = await import(pathToFileURL(join(distRoot, 'tools', 'acp-router.js')));

const { classifyToolResult } = await import(
  pathToFileURL(join(distRoot, 'agent', 'capability-gate.js'))
);

// ---------------------------------------------------------------------------
// buildSubagentFailure / parseSubagentFailureKind
// ---------------------------------------------------------------------------

test('buildSubagentFailure: content prefix + isError=true', () => {
  const { content, isError } = buildSubagentFailure('not_found', 'x');
  assert.equal(content, '[subagent:not_found] x');
  assert.equal(isError, true);
});

test('parseSubagentFailureKind: known kind round-trips', () => {
  assert.equal(parseSubagentFailureKind('[subagent:timeout] boom'), 'timeout');
});

test('parseSubagentFailureKind: plain error → null', () => {
  assert.equal(parseSubagentFailureKind('plain error'), null);
});

test('parseSubagentFailureKind: bogus kind → unknown (fallback)', () => {
  assert.equal(parseSubagentFailureKind('[subagent:bogus_kind]'), 'unknown');
});

// ---------------------------------------------------------------------------
// formatSubagentSteer: one distinct, non-empty banner per kind
// ---------------------------------------------------------------------------

test('formatSubagentSteer: 6 kinds, non-empty, all distinct', () => {
  const kinds = [
    'blocked_policy',
    'blocked_quota',
    'not_found',
    'exec_error',
    'timeout',
    'unknown',
  ];
  const seen = new Set();
  for (const k of kinds) {
    const s = formatSubagentSteer(k, 'acp_router');
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0, `steer for ${k} must be non-empty`);
    assert.ok(!seen.has(s), `steer for ${k} must be distinct`);
    seen.add(s);
  }
});

// ---------------------------------------------------------------------------
// callAcpRouterTool: not_found branches carry the structured code
// ---------------------------------------------------------------------------

test('callAcpRouterTool route: unknown role → [subagent:not_found]', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nexus-acp-route-'));
  // Empty .nexus/agents dir → discoverRoles returns [] → role not found.
  try {
    const res = await callAcpRouterTool('acp_router', {
      action: 'route',
      role: 'nope',
      prompt: 'hi',
      root: tmp,
    });
    assert.equal(res.isError, true);
    assert.ok(
      res.content.startsWith('[subagent:not_found] '),
      `expected [subagent:not_found] prefix, got: ${res.content}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('callAcpRouterTool lookup: missing role → [subagent:not_found]', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nexus-acp-lookup-'));
  try {
    const res = await callAcpRouterTool('acp_router', {
      action: 'lookup',
      role: 'nope',
      root: tmp,
    });
    assert.equal(res.isError, true);
    assert.ok(
      res.content.startsWith('[subagent:not_found] '),
      `expected [subagent:not_found] prefix, got: ${res.content}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('callAcpRouterTool lookup: unknown action → [subagent:unknown]', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nexus-acp-unknown-'));
  try {
    const res = await callAcpRouterTool('acp_router', {
      action: 'frobnicate',
      root: tmp,
    });
    assert.equal(res.isError, true);
    assert.ok(
      res.content.startsWith('[subagent:unknown] '),
      `expected [subagent:unknown] prefix, got: ${res.content}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('callAcpRouterTool route: existing role resolves (no error code)', async () => {
  // Build a role fixture so the success path stays unencoded.
  const tmp = mkdtempSync(join(tmpdir(), 'nexus-acp-ok-'));
  const agentsDir = join(tmp, '.nexus', 'agents', 'researcher');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, 'SKILL.md'),
    '---\nrole: researcher\ntools: [query]\n---\nYou are a researcher.\n',
  );
  try {
    const res = await callAcpRouterTool('acp_router', {
      action: 'route',
      role: 'researcher',
      prompt: 'find me a paper',
      root: tmp,
    });
    assert.equal(res.isError, undefined, 'success path must not flag error');
    assert.ok(!String(res.content).startsWith('[subagent:'), 'success must not carry a code');
    const parsed = JSON.parse(res.content);
    assert.equal(parsed.roleId, 'researcher');
    assert.equal(parsed.roleConfig.systemPrompt, 'You are a researcher.');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// capability-gate.classifyToolResult: structured code wins over prose
// ---------------------------------------------------------------------------

test('classifyToolResult: [subagent:blocked_policy] → blocked', () => {
  assert.equal(
    classifyToolResult(true, '[subagent:blocked_policy] denied'),
    'blocked',
  );
});

test('classifyToolResult: [subagent:exec_error] → failed', () => {
  assert.equal(
    classifyToolResult(true, '[subagent:exec_error] crash'),
    'failed',
  );
});

test('classifyToolResult: [subagent:blocked_quota] → blocked (quota is a policy no)', () => {
  assert.equal(
    classifyToolResult(true, '[subagent:blocked_quota] token budget exhausted'),
    'blocked',
  );
});

test('classifyToolResult: success path stays ok', () => {
  assert.equal(classifyToolResult(false, 'all good'), 'ok');
});

test('classifyToolResult: legacy prose still classifies blocked', () => {
  // Backward compat: the regex set must keep working when no structured code
  // is present.
  assert.equal(
    classifyToolResult(true, 'unattended mode blocked: write to /etc/hosts'),
    'blocked',
  );
});

// ---------------------------------------------------------------------------
// subagentFailureKey: the fail_seq circuit-breaker mapping
// ---------------------------------------------------------------------------

test('subagentFailureKey: blocked_policy → null (excluded from storm counter)', () => {
  assert.equal(subagentFailureKey('blocked_policy', 'acp_router', '{"a":1}'), null);
});

test('subagentFailureKey: blocked_quota → null (excluded from storm counter)', () => {
  assert.equal(subagentFailureKey('blocked_quota', 'spawn_subagent', '{"a":1}'), null);
});

test('subagentFailureKey: not_found → arg-level key', () => {
  const key = subagentFailureKey('not_found', 'acp_router', '{"role":"nope"}');
  assert.equal(key, 'acp_router:subagent-not-found:{"role":"nope"}');
});

test('subagentFailureKey: exec_error / timeout / unknown → class-level keys', () => {
  assert.equal(subagentFailureKey('exec_error', 'spawn_subagent', '{}'), 'spawn_subagent:subagent-exec_error');
  assert.equal(subagentFailureKey('timeout', 'spawn_subagent', '{}'), 'spawn_subagent:subagent-timeout');
  assert.equal(subagentFailureKey('unknown', 'spawn_subagent', '{}'), 'spawn_subagent:subagent-unknown');
});

test('subagentFailureKey: not_found distinguishes arg digests', () => {
  const k1 = subagentFailureKey('not_found', 'acp_router', '{"role":"a"}');
  const k2 = subagentFailureKey('not_found', 'acp_router', '{"role":"b"}');
  assert.notEqual(k1, k2, 'different args must not share a spin key');
  const k3 = subagentFailureKey('not_found', 'acp_router', '{"role":"a"}');
  assert.equal(k1, k3, 'same bad args must share the spin key');
});
