/**
 * Regression tests — [Debugging Discipline Override] (RULE 1 relaxation).
 *
 * The nexus-coder core base prompt (dist/src/agent.js) unconditionally appends a
 * "[Debugging Discipline]" block whose RULE 1 forbids reading source files until
 * a runnable reproduction exists (code is "NOT reproduction"; "do NOT read
 * source files"). For an agent IDE that rule is unsatisfiable and contradicts the
 * injected [Project Directory] + constitution blocks. AgentService neutralizes it
 * by appending a superseding section via buildDebugDisciplineOverride().
 *
 * Verifies:
 *   - the override block exists and carries its marker
 *   - it explicitly REALLOWS source reading (inverts the core RULE 1 clause)
 *   - it keeps the runnable-reproduction preference when feasible
 *   - it keeps the throwaway-script cleanup rule from the core block
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { DEBUG_OVERRIDE_MARKER, buildDebugDisciplineOverride } = await import(
  pathToFileURL(join(dist, 'agent', 'service.js')),
);

// The core prompt text we are neutralizing (shipped inside node_modules).
const CORE_AGENT_JS = join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'agent.js');

test('override block carries its marker and is non-empty', () => {
  const block = buildDebugDisciplineOverride();
  assert.ok(block.length > 0, 'override block is not empty');
  assert.ok(block.includes(DEBUG_OVERRIDE_MARKER), 'block embeds its marker');
});

test('override explicitly reallows reading source files (inverts core RULE 1 hard-block)', () => {
  const block = buildDebugDisciplineOverride();
  // The core rule the override must defeat textually.
  assert.match(block, /never forbidden from reading source files/i, 'source reading reallowed');
  assert.match(block, /explicit user request to read/i, 'user request exemption present');
  assert.match(block, /no reproduction gate/, 'no gate on explicit source-analysis requests');
  assert.doesNotMatch(block, /Reading source code is NOT reproduction/, 'core absolute claim not propagated');
});

test('override keeps reproduction-first preference when feasible, plus cleanup rule', () => {
  const block = buildDebugDisciplineOverride();
  assert.match(block, /runnable reproduction/i, 'reproduction preference retained');
  assert.match(block, /when a bug is cheaply reproducible/i, 'preference is conditional, not absolute');
  assert.match(block, /\.trash\//, 'throwaway-script cleanup rule retained');
  assert.match(block, /never write a(n)? new script to delete the old one/i, 'cleanup rule stays consistent');
});

test('guards the upstream premise: core still ships RULE 1 hard-block we neutralize', () => {
  let core;
  try {
    core = readFileSync(CORE_AGENT_JS, 'utf8');
  } catch {
    core = null;
  }
  if (!core) {
    // Core package absent (e.g. bare npm install) — nothing to neutralize; the
    // override itself is still validated by the other tests above.
    return;
  }
  assert.ok(core.includes('[Debugging Discipline]'), 'core base prompt has the discipline block');
  assert.ok(
    core.includes('RULE 1') && core.includes(/do NOT read source files/.source),
    'core still emits the hard RULE 1 clause the override must defeat',
  );
});