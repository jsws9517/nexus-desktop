/**
 * T1-2 (FR-2.3): unit tests for the metadata-only projection of project rule
 * files used by the `@Rule` mention source. Runs against compiled dist, so
 * `npm run build` must precede it. No Electron / filesystem is involved —
 * sizes are injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const { buildProjectRuleEntries, MAX_RULE_ENTRY_BYTES } = await import(
  pathToFileURL(join(dist, 'shared', 'project-rules.js'))
);

const ROOT = 'D:/proj';

test('returns only metadata (name / path / size) — never a rule body', () => {
  const p = `${ROOT}/.nexus/rules/NEXUS.md`;
  const out = buildProjectRuleEntries(ROOT, [p], new Map([[p, 100]]));
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['name', 'path', 'size']);
  assert.equal(out[0].name, '.nexus/rules/NEXUS.md');
  assert.equal(out[0].path, p);
  assert.equal(out[0].size, 100);
});

test('preserves the scanner’s deterministic order', () => {
  const paths = [
    `${ROOT}/.nexus/rules/NEXUS.md`,
    `${ROOT}/.nexus/rules/style.md`,
    `${ROOT}/.trae/rules/AGENTS.md`,
    `${ROOT}/AGENTS.md`,
  ];
  const sizes = new Map(paths.map((p) => [p, 50]));
  const out = buildProjectRuleEntries(ROOT, paths, sizes);
  assert.deepEqual(out.map((e) => e.name), [
    '.nexus/rules/NEXUS.md',
    '.nexus/rules/style.md',
    '.trae/rules/AGENTS.md',
    'AGENTS.md',
  ]);
});

test('skips files above the 32 KB per-file cap', () => {
  const ok = `${ROOT}/.nexus/rules/ok.md`;
  const big = `${ROOT}/.nexus/rules/huge.md`;
  const out = buildProjectRuleEntries(ROOT, [ok, big], new Map([
    [ok, MAX_RULE_ENTRY_BYTES],
    [big, MAX_RULE_ENTRY_BYTES + 1],
  ]));
  assert.deepEqual(out.map((e) => e.name), ['.nexus/rules/ok.md']);
});

test('skips missing / non-finite sizes', () => {
  const p = `${ROOT}/AGENTS.md`;
  assert.deepEqual(buildProjectRuleEntries(ROOT, [p], new Map()), []);
  assert.deepEqual(buildProjectRuleEntries(ROOT, [p], new Map([[p, Number.NaN]])), []);
});

test('rejects paths outside the project root (symlink escape / traversal)', () => {
  const inside = `${ROOT}/AGENTS.md`;
  const outside = 'D:/other/.nexus/rules/NEXUS.md';
  const siblingPrefix = 'D:/project-evil/AGENTS.md';
  const out = buildProjectRuleEntries(ROOT, [outside, siblingPrefix, inside], new Map([
    [outside, 10], [siblingPrefix, 10], [inside, 10],
  ]));
  assert.deepEqual(out.map((e) => e.name), ['AGENTS.md']);
});

test('normalizes backslashes to forward-slash relative names', () => {
  const p = `${ROOT}\\.nexus\\rules\\NEXUS.md`;
  const out = buildProjectRuleEntries(ROOT, [p], new Map([[p, 10]]));
  assert.equal(out[0].name, '.nexus/rules/NEXUS.md');
  assert.equal(out[0].path, p); // absolute path is passed through untouched
});

test('honours a custom byte cap argument', () => {
  const p = `${ROOT}/AGENTS.md`;
  assert.equal(buildProjectRuleEntries(ROOT, [p], new Map([[p, 60]]), 50).length, 0);
  assert.equal(buildProjectRuleEntries(ROOT, [p], new Map([[p, 40]]), 50).length, 1);
});
