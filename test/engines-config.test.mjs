import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const CANONICAL = join(repoRoot, 'config', 'engines.json');

const raw = readFileSync(CANONICAL, 'utf8');
const engines = JSON.parse(raw);

/**
 * `config/engines.json` is tracked, so anything secret-looking in it becomes
 * repo history. Engine specs are command / args / routing metadata and need no
 * credentials — an apiKey here would mean a tool is expected to read one from
 * the environment instead, and it must never be pasted in.
 */
const SECRET_KEYS = /key|token|secret|password|credential|authorization|bearer/i;

test('the tracked engine registry parses as a non-empty object', () => {
  assert.ok(raw.trim().length > 0, 'canonical engines file must not be empty');
  assert.equal(typeof engines, 'object');
  assert.ok(!Array.isArray(engines));
  assert.ok(Object.keys(engines).length > 0, 'no engines declared');
});

test('no engine spec carries a secret', () => {
  for (const [id, engine] of Object.entries(engines)) {
    for (const key of Object.keys(engine)) {
      assert.ok(
        !SECRET_KEYS.test(key),
        `engine "${id}" declares "${key}" — this file is tracked, so never put credentials here`,
      );
    }
  }
});

test('every engine has an id-shaped key, a command, and a valid mode', () => {
  for (const [id, engine] of Object.entries(engines)) {
    assert.match(id, /^[a-z][a-z0-9-]*$/, `engine key "${id}" must be a bare CLI-ish id`);
    assert.equal(typeof engine.command, 'string', `engine "${id}" needs a command`);
    assert.ok(engine.command.length > 0, `engine "${id}" has an empty command`);
    assert.ok(['native', 'forward'].includes(engine.mode), `engine "${id}" has a bad mode: ${engine.mode}`);
  }
});

test('every engine is explicitly enabled or disabled', () => {
  // `resolveAcpEngines` treats a missing `enabled` as enabled (it filters on
  // `enabled !== false`), so an omitted flag silently turns an engine on. Making
  // it explicit keeps "which agents can acp_route reach" readable from the file.
  for (const [id, engine] of Object.entries(engines)) {
    assert.equal(typeof engine.enabled, 'boolean', `engine "${id}" must state enabled explicitly`);
  }
});

test('capability tokens carry no stray whitespace', () => {
  // Regression: a hand-edited engines.json shipped ["chat", " code", " text"].
  // The leading spaces made every capability but the first fail the equality
  // match in the core's tool-forward path (nexus-coder/src/agent.ts), so the
  // agent looked uncapable while looking configured.
  for (const [id, engine] of Object.entries(engines)) {
    for (const cap of engine.capabilities ?? []) {
      assert.equal(
        cap,
        cap.trim(),
        `engine "${id}" capability "${cap}" has leading/trailing whitespace — trim it`,
      );
      assert.ok(cap.length > 0, `engine "${id}" has an empty capability`);
    }
  }
});

test('routing profiles are internally consistent', () => {
  // profile drives routeTask's agent selection, so a malformed one silently
  // misroutes delegation rather than erroring.
  for (const [id, engine] of Object.entries(engines)) {
    const profile = engine.profile;
    if (!profile) continue;
    assert.equal(typeof profile.latencyMs, 'number', `engine "${id}" profile needs latencyMs`);
    assert.ok(
      ['free', 'low', 'medium', 'high'].includes(profile.cost),
      `engine "${id}" profile has a bad cost: ${profile.cost}`,
    );
    assert.ok(Array.isArray(profile.strengths) && profile.strengths.length > 0, `engine "${id}" profile needs strengths`);
    assert.ok(
      ['simple', 'medium', 'complex'].includes(profile.maxComplexity),
      `engine "${id}" profile has a bad maxComplexity: ${profile.maxComplexity}`,
    );
  }
});

test('the live registry matches the tracked copy', () => {
  // Drift means someone edited ~/.nexus/engines.json by hand (or the app did)
  // and the repo no longer describes what will actually run. Skipped when the
  // live file is absent, which is the normal case on CI and on a fresh machine.
  const live = join(process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus'), 'engines.json');
  let liveRaw;
  try {
    liveRaw = readFileSync(live, 'utf8');
  } catch {
    return; // no live registry on this machine
  }
  assert.equal(
    liveRaw,
    raw,
    `${live} has drifted from config/engines.json — reconcile with: node scripts/sync-engines.mjs`,
  );
});