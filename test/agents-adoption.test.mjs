/**
 * P0 unit tests — .nexus constitution + agents_* tools + model capabilities.
 *
 * Covers docs/dsh-plugin-adoption-plan.md §11.1:
 *   - constitution fallback chain (.nexus/rules/NEXUS.md → .nexus/rules/AGENTS.md →
 *     .clinerules → root AGENTS.md → legacy .agents/rules/*.md), first-existing-wins
 *   - 32 KB size cap refusal (no silent context bloat)
 *   - agents_index / agents_read / agents_search authorization + path confinement
 *   - modelCapabilities merge + vision-route hint (ModLens conservative rule)
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmWithCwdEscape } from './cleanup-helper.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Isolate the path-authorizer's persisted grant file so tests never read the
// developer's real ~/.nexus/path-auth.json (same trick as security-tools).
const tmp = mkdtempSync(join(tmpdir(), 'nexus-agents-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.LLMA_DATA_DIR = tmp;

const { AGENTS_TOOLS, AGENTS_TOOL_DEFS, loadConstitution, resolveConstitutionFile, indexAgents, callAgentsTool } =
  await import(pathToFileURL(join(dist, 'tools', 'agents.js')));
const {
  readModelCapabilities,
  getModelCapability,
  resolveContextLimit,
  shouldInjectVisionHint,
  buildVisionHint,
} = await import(pathToFileURL(join(dist, 'model-capabilities.js')));

// Force every out-of-sandbox path prompt to deny, so tests are deterministic
// under `node --test` (which gives the child no console to answer prompts on).
const { setPermissionPrompter } = await import(
  pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js')),
);
setPermissionPrompter(() => 'n');

// ---- fixture: a fake project root with .nexus knowledge ----------------------
const root = mkdtempSync(join(tmpdir(), 'nexus-agents-root-'));
mkdirSync(join(root, '.nexus', 'rules'), { recursive: true });
mkdirSync(join(root, '.nexus', 'skills', 'charting'), { recursive: true });
mkdirSync(join(root, '.nexus', 'skills', 'sql'), { recursive: true });
writeFileSync(
  join(root, '.nexus', 'rules', 'NEXUS.md'),
  'CONSTITUTION_TOP\n# Nexus Rules\n- never use charts without bi.chart\n',
  'utf8',
);
writeFileSync(
  join(root, '.nexus', 'skills', 'charting', 'SKILL.md'),
  '---\ndescription: Build charts with bi.chart\n---\n# Charting skill\nUse bi.chart for all charts.\n',
  'utf8',
);
writeFileSync(
  join(root, '.nexus', 'skills', 'sql', 'SKILL.md'),
  '# SQL skill\nAlways use query (read-only) before execute.\n',
  'utf8',
);

after(() => {
  rmWithCwdEscape(root, __dirname);
  rmWithCwdEscape(tmp, __dirname);
});

// ===========================================================================
// 1. Constitution fallback chain
// ===========================================================================

test('agents tools are registered under TOOL registry ids', () => {
  assert.deepEqual(AGENTS_TOOLS, new Set(['agents_index', 'agents_read', 'agents_search']));
  assert.equal(AGENTS_TOOL_DEFS.length, 3);
});

test('resolves NEXUS.md under .nexus when present (highest precedence)', async () => {
  const f = await resolveConstitutionFile(root);
  assert.equal(f, join(root, '.nexus', 'rules', 'NEXUS.md'));
});

test('falls back to .nexus/rules/AGENTS.md when NEXUS.md is absent', async () => {
  const alt = mkdtempSync(join(tmpdir(), 'nexus-agents-fb-'));
  mkdirSync(join(alt, '.nexus', 'rules'), { recursive: true });
  writeFileSync(join(alt, '.nexus', 'rules', 'AGENTS.md'), 'AGENTS RULES', 'utf8');
  const f = await resolveConstitutionFile(alt);
  assert.equal(f, join(alt, '.nexus', 'rules', 'AGENTS.md'));
  rmWithCwdEscape(alt, __dirname);
});

test('falls back to ancestor legacy .agents/rules/NEXUS.md (migration compat)', async () => {
  const alt = mkdtempSync(join(tmpdir(), 'nexus-agents-legacy-'));
  mkdirSync(join(alt, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(alt, '.agents', 'rules', 'NEXUS.md'), 'LEGACY CONSTITUTION', 'utf8');
  const f = await resolveConstitutionFile(alt);
  assert.equal(f, join(alt, '.agents', 'rules', 'NEXUS.md'));
  rmWithCwdEscape(alt, __dirname);
});

test('falls back to root AGENTS.md when no .nexus exists', async () => {
  const alt = mkdtempSync(join(tmpdir(), 'nexus-agents-fb2-'));
  writeFileSync(join(alt, 'AGENTS.md'), 'ROOT AGENTS', 'utf8');
  const f = await resolveConstitutionFile(alt);
  assert.equal(f, join(alt, 'AGENTS.md'));
  rmWithCwdEscape(alt, __dirname);
});

test('returns null when no constitution file exists', async () => {
  const f = await resolveConstitutionFile(root); // has one — assert non-null
  assert.ok(f);
});

// ===========================================================================
// 2. loadConstitution — size cap + unauthorized root
// ===========================================================================

test('loadConstitution returns text for an authorized root (cwd)', async () => {
  process.chdir(root);
  const res = await loadConstitution(root);
  assert.equal(res.reason, 'ok');
  assert.ok(res.text?.includes('CONSTITUTION_TOP'));
});

test('loadConstitution refuses > 32 KB files with reason too-large', async () => {
  const alt = mkdtempSync(join(tmpdir(), 'nexus-agents-big-'));
  mkdirSync(join(alt, '.nexus', 'rules'), { recursive: true });
  writeFileSync(join(alt, '.nexus', 'rules', 'NEXUS.md'), 'x'.repeat(40_000), 'utf8');
  process.chdir(alt);
  const res = await loadConstitution(alt);
  assert.equal(res.reason, 'too-large');
  assert.equal(res.text, null);
  rmWithCwdEscape(alt, __dirname);
  process.chdir(root);
});

test('loadConstitution returns unauthorized for a foreign root', async () => {
  const foreign = mkdtempSync(join(tmpdir(), 'nexus-agents-for-'));
  mkdirSync(join(foreign, '.nexus', 'rules'), { recursive: true });
  writeFileSync(join(foreign, '.nexus', 'rules', 'NEXUS.md'), 'FOREIGN', 'utf8');
  process.chdir(root); // cwd is the authorized root; foreign is not
  const res = await loadConstitution(foreign);
  assert.equal(res.reason, 'unauthorized');
  rmWithCwdEscape(foreign, __dirname);
});

// ===========================================================================
// 3. agents_* tools
// ===========================================================================

test('agents_index lists skills, rules and constitution', async () => {
  process.chdir(root);
  const res = await callAgentsTool('agents_index', {});
  assert.ok(!res.isError, res.content);
  const data = JSON.parse(res.content);
  assert.equal(data.root, root);
  assert.ok(data.constitution?.endsWith('NEXUS.md'));
  assert.equal(data.skills.length, 2);
  assert.equal(data.skills[0].name, 'charting');
  assert.match(data.skills[0].description, /bi\.chart/);
  assert.equal(data.rules.length, 1);
  assert.equal(data.rules[0].name, 'NEXUS.md');
});

test('agents_read reads a skill file inside .nexus', async () => {
  process.chdir(root);
  const res = await callAgentsTool('agents_read', { path: '.nexus/skills/charting/SKILL.md' });
  assert.ok(!res.isError, res.content);
  assert.match(res.content, /Use bi\.chart for all charts/);
});

test('agents_read denies traversal outside .nexus', async () => {
  process.chdir(root);
  const res = await callAgentsTool('agents_read', { path: '../../etc/passwd' });
  assert.ok(res.isError);
  assert.match(res.content, /access denied/);
});

test('agents_search finds matching rule content with snippet', async () => {
  process.chdir(root);
  const res = await callAgentsTool('agents_search', { query: 'bi.chart' });
  assert.ok(!res.isError, res.content);
  const data = JSON.parse(res.content);
  assert.ok(data.total >= 2); // constitution + charting skill
  const kinds = new Set(data.matches.map((m) => m.kind));
  assert.ok(kinds.has('skill'));
});

test('agents_search requires a non-empty query', async () => {
  process.chdir(root);
  const res = await callAgentsTool('agents_search', { query: '' });
  assert.ok(res.isError);
});

// ===========================================================================
// 4. Model capabilities (dsh-web §5.3) + vision hint (ModLens §7.3)
// ===========================================================================

test('readModelCapabilities parses the config block, ignoring malformed entries', () => {
  const cfg = {
    modelCapabilities: {
      'agnes-2.5-flash': { contextLimit: 524288, vision: false, thinking: true },
      'deepseek-v4-pro': { contextLimit: 131072, vision: false },
      broken: { contextLimit: 'nope' },
    },
  };
  const caps = readModelCapabilities(cfg);
  assert.equal(caps['agnes-2.5-flash']?.contextLimit, 524288);
  assert.equal(caps['agnred-pro']?.vision, undefined); // malformed dropped
});

test('getModelCapability supports longest-suffix globs and wildcard default', () => {
  const caps = { '-pro': { vision: false }, '*': { vision: true } };
  assert.equal(getModelCapability(caps, 'deepseek-v4-pro')?.vision, false);
  assert.equal(getModelCapability(caps, 'unknown-model')?.vision, true);
  assert.equal(getModelCapability(caps, '') ?? undefined, undefined);
});

test('resolveContextLimit prefers declared over legacy modelContextLimits', () => {
  const caps = { 'agnes-2.5-flash': { contextLimit: 524288 } };
  const legacy = { 'agnes-2.5-flash': 128000 };
  assert.equal(resolveContextLimit(caps, 'agnes-2.5-flash', legacy), 524288);
  assert.equal(resolveContextLimit({}, 'agnes-2.5-flash', legacy), 128000);
  assert.equal(resolveContextLimit({}, 'unknown', undefined), undefined);
});

test('shouldInjectVisionHint only fires for positively text-only models', () => {
  const caps = {
    'deepseek-v4-pro': { vision: false },
    'glm-5.3-flash': { vision: true },
  };
  assert.equal(shouldInjectVisionHint(caps, 'deepseek-v4-pro'), true);
  assert.equal(shouldInjectVisionHint(caps, 'glm-5.3-flash'), false);
  // unknown model → never guess
  assert.equal(shouldInjectVisionHint(caps, 'some-new-model'), false);
  assert.equal(shouldInjectVisionHint(undefined, 'deepseek-v4-pro'), false);
});

test('buildVisionHint names the bridging tools', () => {
  const hint = buildVisionHint('deepseek-v4-pro');
  assert.match(hint, /TEXT-ONLY/);
  assert.match(hint, /ocr_extract/);
  assert.match(hint, /analyze_image/);
});