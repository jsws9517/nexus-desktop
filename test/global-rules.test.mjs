/**
 * P0 tests — user-level (global) rules mechanism.
 *
 * The user-level rules file (`~/.nexus/rules/GLOBAL.md`) is loaded by
 * AgentService into EVERY session's system prompt under the `[Global Rules]`
 * marker, regardless of the active project (or the absence of one). This suite
 * verifies the loader/bootstrap/reset primitives and guards the wiring of the
 * injection + sub-agent inheritance against regressions.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Isolate the user data dir so tests never touch the developer's real ~/.nexus.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-global-rules-'));
process.env.LLMA_DATA_DIR = tmp;
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;

const {
  GLOBAL_RULES_MARKER,
  GLOBAL_RULES_FILENAME,
  DEFAULT_GLOBAL_RULES,
  globalRulesPath,
  ensureGlobalRules,
  loadGlobalRules,
  resetGlobalRules,
  MAX_CONSTITUTION_BYTES,
} = await import(pathToFileURL(join(dist, 'tools', 'agents.js')));

const rulesFile = join(tmp, '.nexus', 'rules', GLOBAL_RULES_FILENAME);

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ===========================================================================
// 1. Default template content
// ===========================================================================

test('default global rules carry the four working disciplines', () => {
  assert.ok(DEFAULT_GLOBAL_RULES.length > 0);
  assert.match(DEFAULT_GLOBAL_RULES, /## 1\. File Management/i);
  assert.match(DEFAULT_GLOBAL_RULES, /## 2\. Git Discipline/i);
  assert.match(DEFAULT_GLOBAL_RULES, /## 3\. Temporary File Recycling/i);
  assert.match(DEFAULT_GLOBAL_RULES, /## 4\. File Naming Conventions/i);
  assert.ok(DEFAULT_GLOBAL_RULES.length < MAX_CONSTITUTION_BYTES, 'default under the 32 KB cap');
});

test('global marker is distinct from the project constitution marker', () => {
  assert.equal(GLOBAL_RULES_MARKER, '[Global Rules]');
  assert.notEqual(GLOBAL_RULES_MARKER, '[Project Constitution]');
});

// ===========================================================================
// 2. Bootstrap (ensureGlobalRules)
// ===========================================================================

test('ensureGlobalRules writes the default template on first run', () => {
  // resolveGlobalRules is under the isolated data dir; start clean.
  assert.ok(!existsSync(rulesFile), 'precondition: file absent');
  ensureGlobalRules();
  assert.ok(existsSync(rulesFile), 'file created');
  assert.equal(readFileSync(rulesFile, 'utf8'), DEFAULT_GLOBAL_RULES);
});

test('ensureGlobalRules never overwrites user-edited content', () => {
  const custom = '# my own rules\nnever touch this\n';
  writeFileSync(rulesFile, custom, 'utf8');
  ensureGlobalRules();
  assert.equal(readFileSync(rulesFile, 'utf8'), custom, 'existing content preserved');
});

// ===========================================================================
// 3. Loader (loadGlobalRules)
// ===========================================================================

test('loadGlobalRules returns the file text with reason ok', async () => {
  writeFileSync(rulesFile, '# loaded rules\nbody\n', 'utf8');
  const res = await loadGlobalRules();
  assert.equal(res.reason, 'ok');
  assert.equal(res.file, rulesFile);
  assert.match(res.text, /loaded rules/);
});

test('loadGlobalRules refuses an oversized file (32 KB cap)', async () => {
  writeFileSync(rulesFile, 'x'.repeat(MAX_CONSTITUTION_BYTES + 1), 'utf8');
  const res = await loadGlobalRules();
  assert.equal(res.reason, 'too-large');
  assert.equal(res.text, null);
  assert.equal(res.file, rulesFile);
});

test('loadGlobalRules reports not-found when the file is absent', async () => {
  rmSync(rulesFile, { force: true });
  const res = await loadGlobalRules();
  assert.equal(res.reason, 'not-found');
  assert.equal(res.text, null);
});

// ===========================================================================
// 4. Reset (resetGlobalRules)
// ===========================================================================

test('resetGlobalRules backs up the old file and restores the default', () => {
  writeFileSync(rulesFile, '# custom to back up\n', 'utf8');
  const res = resetGlobalRules();
  assert.equal(res.ok, true);
  assert.equal(res.path, rulesFile);
  assert.ok(res.backup && existsSync(res.backup), 'backup created');
  assert.equal(readFileSync(res.backup, 'utf8'), '# custom to back up\n');
  assert.equal(readFileSync(rulesFile, 'utf8'), DEFAULT_GLOBAL_RULES);
});

test('resetGlobalRules works when no prior file exists (no backup)', () => {
  rmSync(rulesFile, { force: true });
  rmSync(`${rulesFile}.bak`, { force: true });
  const res = resetGlobalRules();
  assert.equal(res.ok, true);
  assert.equal(res.backup, undefined);
  assert.equal(readFileSync(rulesFile, 'utf8'), DEFAULT_GLOBAL_RULES);
});

// ===========================================================================
// 5. Wiring guards (injection + sub-agent inheritance)
// ===========================================================================

test('AgentService injects [Global Rules] into every model step', () => {
  const serviceSrc = readFileSync(join(dist, 'agent', 'service.js'), 'utf8');
  assert.ok(serviceSrc.includes('GLOBAL_RULES_MARKER'), 'global marker referenced in service');
  assert.ok(serviceSrc.includes('loadGlobalRules'), 'global loader called in service');
  // The injection must be inside the preLlmCall hook (the per-model-step choke point).
  const hookIdx = serviceSrc.indexOf('preLlmCall');
  assert.ok(hookIdx >= 0, 'preLlmCall hook present');
  const injectionIdx = serviceSrc.indexOf('GLOBAL_RULES_MARKER', hookIdx);
  assert.ok(injectionIdx > hookIdx, '[Global Rules] injected inside preLlmCall');
});

test('sub-agent path merges global rules with the project constitution', () => {
  const mainSrc = readFileSync(join(dist, 'main', 'index.js'), 'utf8');
  assert.ok(mainSrc.includes('loadGlobalRules'), 'global rules loaded for parallel runs');
  assert.ok(mainSrc.includes('GLOBAL_RULES_MARKER'), 'marker embedded in inherited constitution');
  assert.ok(mainSrc.includes('loadConstitution'), 'project constitution still merged');
});

test('ensureGlobalRules is bootstrapped during AgentService init', () => {
  const serviceSrc = readFileSync(join(dist, 'agent', 'service.js'), 'utf8');
  assert.ok(serviceSrc.includes('ensureGlobalRules()'), 'first-run bootstrap wired into init');
});

// ===========================================================================
// 6. Settings IPC surface
// ===========================================================================

test('settings exposes getGlobalRulesPath + resetGlobalRules channels', () => {
  const channels = readFileSync(join(dist, 'ipc', 'channels.js'), 'utf8');
  assert.ok(channels.includes('nexus:getGlobalRulesPath'));
  assert.ok(channels.includes('nexus:resetGlobalRules'));
  const preload = readFileSync(join(dist, 'preload.cjs'), 'utf8');
  assert.ok(preload.includes('nexus:getGlobalRulesPath'));
  assert.ok(preload.includes('nexus:resetGlobalRules'));
});
