/**
 * End-to-end verification of the /billing (spend-mode) slash command
 * (docs/spend-mode-and-protocol-compat.md §1.3–1.5).
 *
 * Drives the REAL AgentService.chat() slash bridge with a fake core agent,
 * exactly like thinking-guard-e2e.test.mjs, but the input is a desktop-only
 * slash command so NO core turn runs:
 *
 *   chat('/billing coding') -> handleDagCommand -> handleBillingSlash
 *     -> writeProviderMode (desktop.json) + onEvent({ type: 'spend_mode' })
 *
 *  - set:    /billing coding  → entry written, event mode=coding source=manual
 *  - status: after set, /billing status → source=manual, policy summary shown
 *  - auto:   /billing auto    → entry cleared, event mode=null source=default
 *  - host-change: repointing the provider to a different host makes status
 *    fall back to the global default with a hostChanged note (the safe
 *    direction — never silently keep a vendor's quota assumptions)
 *  - all writes land in the sandbox NEXUS_CONFIG_DIR (sandbox-env.mjs)
 */

import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { AgentService } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));
const store = await import(pathToFileURL(join(dist, 'agent', 'spend-mode-store.js')));

const PROVIDER = 'e2e-billing';
const BIGMODEL = 'https://open.bigmodel.cn/api/anthropic';
const AGNES = 'https://apihub.agnes-ai.com/v1';

function desktopPath() {
  return join(process.env.NEXUS_CONFIG_DIR, 'desktop.json');
}

/** Fake core agent exposing only what the slash bridge touches. `baseUrl` is
 *  a mutable field so a test can repoint the provider and observe the
 *  host-mismatch fallback. */
function makeService(initialBaseUrl) {
  const baseUrlState = { value: initialBaseUrl };
  const svc = new AgentService();
  const emitted = [];
  svc.onEvent = (e) => emitted.push(e);
  const fake = {
    config: {
      getActiveProvider: () => PROVIDER,
      getProvider: () => ({ baseUrl: baseUrlState.value }),
    },
    provider: { model: 'e2e-model' },
    isBusy: () => false,
  };
  svc.agent = fake; // private field, erased at runtime
  return { svc, emitted, setBaseUrl: (u) => { baseUrlState.value = u; } };
}

function readSpendFile() {
  if (!existsSync(desktopPath())) return {};
  return JSON.parse(readFileSync(desktopPath(), 'utf-8'));
}

// Reset the sandbox between the ordered tests so each starts clean.
function resetSandbox() {
  if (existsSync(desktopPath())) rmSync(desktopPath());
  store.invalidateSpendModeCache();
}

const spendEvents = (emitted) => emitted.filter((e) => e.type === 'spend_mode');

test('e2e /billing coding: writes the provider entry and emits the manual event', async () => {
  resetSandbox();
  const { svc, emitted } = makeService(BIGMODEL);

  await svc.chat('/billing coding');

  const ev = spendEvents(emitted);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].provider, PROVIDER);
  assert.equal(ev[0].mode, 'coding');
  assert.equal(ev[0].source, 'manual');

  const file = readSpendFile();
  const section = file.spendMode;
  assert.equal(section.default, 'token', 'global default untouched');
  assert.equal(section.providers[PROVIDER].mode, 'coding');
  assert.equal(section.providers[PROVIDER].host, 'open.bigmodel.cn');
});

test('e2e /billing status: reports manual source + policy summary after a set', async () => {
  resetSandbox();
  const { svc, emitted } = makeService(BIGMODEL);

  await svc.chat('/billing free');
  await svc.chat('/billing status');

  // The status card text was buffered into the slash channel (slash_start…
  // slash_end). Reconstruct it from the emitted stream.
  const slashText = emitted
    .filter((e) => e.type === 'slash' && typeof e.text === 'string')
    .map((e) => e.text)
    .join('');
  assert.match(slashText, /Spend mode: free/);
  assert.match(slashText, /manual/);

  // The second (status) event reports the manual source.
  const ev = spendEvents(emitted);
  assert.equal(ev.length, 2);
  assert.equal(ev[1].mode, 'free');
  assert.equal(ev[1].source, 'manual');
});

test('e2e /billing auto: clears the entry and falls back to the default', async () => {
  resetSandbox();
  // Seed a manual entry first.
  const seed = join(process.env.NEXUS_CONFIG_DIR);
  mkdirSync(seed, { recursive: true });
  writeFileSync(
    desktopPath(),
    JSON.stringify({ spendMode: { v: 1, default: 'token', providers: { [PROVIDER]: { mode: 'coding', host: 'open.bigmodel.cn' } } } }),
  );
  store.invalidateSpendModeCache();

  const { svc, emitted } = makeService(BIGMODEL);
  await svc.chat('/billing auto');

  const ev = spendEvents(emitted);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].mode, null);
  assert.equal(ev[0].source, 'default');
  assert.equal(readSpendFile().spendMode.providers?.[PROVIDER], undefined);
});

test('e2e /billing: unknown mode is rejected with a hint, nothing written', async () => {
  resetSandbox();
  const { svc, emitted } = makeService(BIGMODEL);

  await svc.chat('/billing ultra');

  assert.equal(spendEvents(emitted).length, 0, 'no spend_mode event for an invalid mode');
  assert.equal(readSpendFile().spendMode, undefined, 'no section written on failure');
});

test('e2e /billing status after a host change: falls back to default with a note', async () => {
  resetSandbox();
  const { svc, emitted, setBaseUrl } = makeService(BIGMODEL);

  // Set coding while on the bigmodel host…
  await svc.chat('/billing coding');
  // …then the provider is repointed to a different vendor endpoint.
  setBaseUrl(AGNES);
  store.invalidateSpendModeCache();

  await svc.chat('/billing status');

  const ev = spendEvents(emitted);
  assert.equal(ev.length, 2);
  // The stale entry (host open.bigmodel.cn) no longer matches apihub.agnes-ai.com
  // → the SAFE default (token) is in effect, flagged hostChanged.
  assert.equal(ev[1].mode, 'token');
  assert.equal(ev[1].source, 'default');
  assert.equal(ev[1].hostChanged, true);
});
