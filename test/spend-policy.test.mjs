/**
 * Spend-mode policy + store (Issue 1, docs/spend-mode-and-protocol-compat.md).
 *
 *  - src/shared/spend-policy.ts   — tier table + selectors (pure, no Node APIs)
 *  - src/agent/spend-mode-store.ts — desktop.json read/write, host resolver
 *  - correction-config.applySpendScale — correction-budget scaling
 *
 * The store tests run against the sandbox NEXUS_CONFIG_DIR (sandbox-env.mjs),
 * so the real ~/.nexus/desktop.json is never touched.
 */

import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const {
  SPEND_POLICIES,
  SPEND_MODES,
  DEFAULT_SPEND_MODE,
  isSpendMode,
  resolveSpendPolicy,
  describeSpendPolicy,
} = await import(pathToFileURL(join(dist, 'shared', 'spend-policy.js')));

const store = await import(pathToFileURL(join(dist, 'agent', 'spend-mode-store.js')));
const {
  hostOf,
  suggestForHost,
  resolveSpendMode,
  readSpendModeState,
  writeProviderMode,
  writeDefaultMode,
  invalidateSpendModeCache,
} = store;

const { DEFAULT_CORRECTION_CONFIG, applySpendScale, configForTaskKind } = await import(
  pathToFileURL(join(dist, 'agent', 'correction-config.js'))
);

// ===========================================================================
// Tier table invariants
// ===========================================================================

test('tier table: all three tiers present, token is the safe default', () => {
  assert.deepEqual([...SPEND_MODES], ['token', 'coding', 'free']);
  assert.equal(DEFAULT_SPEND_MODE, 'token');
  for (const m of SPEND_MODES) {
    const p = SPEND_POLICIES[m];
    assert.ok(p.rpm > 0 && p.backoffBaseMs > 0 && p.backoffCapMs >= p.backoffBaseMs);
    assert.ok(p.maxRepeat >= 1 && p.idleThinkingTokens > 0);
    assert.ok(p.fanoutCap >= 1 && p.retryBudget >= 0 && p.correctionScale > 0);
  }
});

test('tier ordering: free is tightest on RPM, coding is the most generous', () => {
  assert.ok(SPEND_POLICIES.free.rpm < SPEND_POLICIES.token.rpm);
  assert.ok(SPEND_POLICIES.token.rpm < SPEND_POLICIES.coding.rpm);
  assert.equal(SPEND_POLICIES.coding.correctionScale, 1.0);
});

test('isSpendMode / resolveSpendPolicy: unknown input falls back to the safe default', () => {
  assert.equal(isSpendMode('token'), true);
  assert.equal(isSpendMode('coding'), true);
  assert.equal(isSpendMode('free'), true);
  assert.equal(isSpendMode('plan'), false);
  assert.equal(isSpendMode(undefined), false);
  assert.deepEqual(resolveSpendPolicy('bogus'), SPEND_POLICIES.token);
});

test('describeSpendPolicy: one-line summary carries the tier knobs', () => {
  const line = describeSpendPolicy('token');
  assert.match(line, /RPM 5/);
  assert.match(line, /fan-out ≤ 2/);
  assert.match(line, /retry ≤ 1/);
});

// ===========================================================================
// hostOf / suggestForHost
// ===========================================================================

test('hostOf: strips scheme/port/path, lowercases; falls back for non-URLs', () => {
  assert.equal(hostOf('https://open.bigmodel.cn/api/anthropic'), 'open.bigmodel.cn');
  assert.equal(hostOf('http://127.0.0.1:8080/v1'), '127.0.0.1');
  assert.equal(hostOf('HTTPS://ApiHub.Agnes-AI.com/x'), 'apihub.agnes-ai.com');
  assert.equal(hostOf('not-a-url'), 'not-a-url');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('suggestForHost: vendor hints, no guessing for zen, null for unknown', () => {
  assert.equal(suggestForHost('open.bigmodel.cn'), 'coding');
  assert.equal(suggestForHost('apihub.agnes-ai.com'), 'coding');
  assert.equal(suggestForHost('localhost'), 'coding');
  assert.equal(suggestForHost('127.0.0.1'), 'coding');
  // Mixed free+paid endpoint — never guess.
  assert.equal(suggestForHost('opencode.ai'), null);
  // Local servers the user self-hosts.
  assert.equal(suggestForHost('10.0.0.5'), null);
});

// ===========================================================================
// resolveSpendMode: the four resolution paths
// ===========================================================================

test('resolveSpendMode: manual entry with matching host wins', () => {
  const state = {
    default: 'token',
    providers: { zhipu: { mode: 'coding', host: 'open.bigmodel.cn' } },
  };
  assert.deepEqual(resolveSpendMode(state, 'zhipu', 'https://open.bigmodel.cn/api'), {
    mode: 'coding',
    source: 'manual',
  });
});

test('resolveSpendMode: no entry → global default', () => {
  const state = { default: 'coding' };
  assert.deepEqual(resolveSpendMode(state, 'newbie', 'open.bigmodel.cn'), {
    mode: 'coding',
    source: 'default',
  });
});

test('resolveSpendMode: host mismatch → safe default + hostChanged flag', () => {
  const state = {
    default: 'token',
    providers: { p: { mode: 'coding', host: 'open.bigmodel.cn' } },
  };
  assert.deepEqual(resolveSpendMode(state, 'p', 'https://apihub.agnes-ai.com/v1'), {
    mode: 'token',
    source: 'default',
    hostChanged: true,
  });
});

test('resolveSpendMode: entry without a host matches any host (legacy rows)', () => {
  const state = {
    default: 'token',
    providers: { p: { mode: 'free' } },
  };
  assert.deepEqual(resolveSpendMode(state, 'p', 'localhost'), {
    mode: 'free',
    source: 'manual',
  });
});

// ===========================================================================
// Store: atomic writes + mtime cache
// ===========================================================================

function configDir() {
  return process.env.NEXUS_CONFIG_DIR;
}
function desktopPath() {
  return join(configDir(), 'desktop.json');
}

test('store: writeProviderMode persists and preserves unrelated sections', () => {
  // Seed an unrelated section first.
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(desktopPath(), JSON.stringify({ jobs: { keep: true } }));
  invalidateSpendModeCache();

  const res = writeProviderMode('zhipu', 'https://open.bigmodel.cn/api', 'coding');
  assert.equal(res.ok, true);

  const file = JSON.parse(readFileSync(desktopPath(), 'utf-8'));
  assert.deepEqual(file.jobs, { keep: true }, 'unrelated section must survive');
  assert.equal(file.spendMode.v, 1);
  assert.equal(file.spendMode.default, 'token');
  assert.equal(file.spendMode.providers.zhipu.mode, 'coding');
  assert.equal(file.spendMode.providers.zhipu.host, 'open.bigmodel.cn');
  assert.ok(file.spendMode.providers.zhipu.updatedAt);

  // The mtime cache picked up the write.
  const st = readSpendModeState();
  assert.equal(st.providers.zhipu.mode, 'coding');
});

test('store: an external writer bumping mtime invalidates the cache', () => {
  // Prime the cache (default: token — the first test's write fell back to the
  // section default because the seeded file had no spendMode section yet).
  invalidateSpendModeCache();
  const primed = readSpendModeState();
  assert.equal(primed.default, 'token');

  // Simulate the MAIN process (settings page) writing the same section
  // directly to disk — it bypasses the store's invalidate hook. Only the
  // mtime change may trigger the re-read; the value must not stay cached.
  const file = JSON.parse(readFileSync(desktopPath(), 'utf-8'));
  file.spendMode.default = 'free';
  writeFileSync(desktopPath(), JSON.stringify(file, null, 2));

  const observed = readSpendModeState();
  assert.equal(observed.default, 'free', 'mtime bump from an external writer must invalidate the cache');
});

test('store: writeDefaultMode writes through atomically', () => {
  const res = writeDefaultMode('coding');
  assert.equal(res.ok, true);
  assert.equal(readSpendModeState().default, 'coding');
});

test('store: writeProviderMode(null) clears the entry, default stays', () => {
  const res = writeProviderMode('zhipu', 'open.bigmodel.cn', null);
  assert.equal(res.ok, true);
  const st = readSpendModeState();
  assert.equal(st.providers?.zhipu, undefined);
  assert.equal(st.default, 'coding');
});

test('store: invalid mode is rejected without touching the file', () => {
  const before = readFileSync(desktopPath(), 'utf-8');
  const res = writeProviderMode('zhipu', 'open.bigmodel.cn', 'ultra');
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid mode/);
  assert.equal(readFileSync(desktopPath(), 'utf-8'), before);
});

test('store: readSpendModeState on a missing file returns an empty state', () => {
  // Fresh sandbox dir without a desktop.json.
  const dir = join(configDir(), 'no-desktop-json');
  mkdirSync(dir, { recursive: true });
  const saved = process.env.NEXUS_CONFIG_DIR;
  process.env.NEXUS_CONFIG_DIR = dir;
  try {
    invalidateSpendModeCache();
    const st = readSpendModeState();
    assert.deepEqual(st, {});
  } finally {
    process.env.NEXUS_CONFIG_DIR = saved;
    invalidateSpendModeCache();
  }
});

// ===========================================================================
// applySpendScale: correction budgets scale with the tier, clamp ≥ 1
// ===========================================================================

test('applySpendScale: coding scale 1.0 is the identity', () => {
  const scaled = applySpendScale(DEFAULT_CORRECTION_CONFIG, 1.0);
  assert.deepEqual(scaled.budget, DEFAULT_CORRECTION_CONFIG.budget);
  assert.equal(scaled.thresholds.dilution.minThinkingTokens, 800);
});

test('applySpendScale: token 0.6 scales budgets down, clamps at 1', () => {
  const scaled = applySpendScale(DEFAULT_CORRECTION_CONFIG, 0.6);
  // l2PerTurn 1 * 0.6 = 0.6 → round → 1 (never below 1).
  assert.equal(scaled.budget.l2PerTurn, 1);
  // l1PerTurn 2 * 0.6 = 1.2 → 1.
  assert.equal(scaled.budget.l1PerTurn, 1);
  // dilution floor: 800 * 0.6 = 480.
  assert.equal(scaled.thresholds.dilution.minThinkingTokens, 480);
  // Non-spend knobs stay put.
  assert.equal(scaled.thresholds.loop.frozenSteps, 4);
  assert.equal(scaled.deescalation.progressRequired, 2);
});

test('applySpendScale: a zero base budget stays zero; bad scale falls back to 1', () => {
  const zeroed = { ...DEFAULT_CORRECTION_CONFIG, budget: { ...DEFAULT_CORRECTION_CONFIG.budget, l3PerTurn: 0 } };
  const scaled = applySpendScale(zeroed, 0.6);
  assert.equal(scaled.budget.l3PerTurn, 0);
  assert.deepEqual(applySpendScale(DEFAULT_CORRECTION_CONFIG, -2), DEFAULT_CORRECTION_CONFIG);
  assert.deepEqual(
    applySpendScale(configForTaskKind(DEFAULT_CORRECTION_CONFIG, 'research'), 1.0).thresholds.loop.frozenSteps,
    6,
  );
});

// ---------------------------------------------------------------------------
// Housekeeping: ensure the seeded file above can't leak into later tests.
// ---------------------------------------------------------------------------
test('store: seeded sandbox desktop.json present (sanity)', () => {
  assert.ok(existsSync(desktopPath()));
});
