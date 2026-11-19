/**
 * Unit tests for the source-level rules-dedup patch applied to the installed
 * nexus-coder core by scripts/patch-core-rules-dedup.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { patchProjectContextSource, isDedupPatched, DEDUP_MARKER } = await import(
  pathToFileURL(join(__dirname, '..', 'scripts', 'patch-core-rules-dedup.mjs'))
);

const SAMPLE = `export class ProjectContext {
    async load(cwd) {
        this.loadProjectMd(cwd);
        this.loadRules(cwd);
        this.loadKnowledge(cwd);
    }
    loadRules(cwd) {
        const rulesDir = resolve(cwd, '.nexus', 'rules');
        if (!existsSync(rulesDir))
            return;
        try {
            const files = readdirSync(rulesDir, { withFileTypes: true });
            for (const file of files) {
                if (file.isFile()) {
                    this.config.rules.push({ name: file.name, content: 'x' });
                }
            }
        }
        catch {
            // Rules directory not accessible
        }
    }
    loadKnowledge(cwd) {
        // knowledge body kept
        this.config.knowledge.push({ key: 'k', value: 'v' });
    }
}
`;

test('patch replaces loadRules body with a no-op and keeps the rest of the class', () => {
  const result = patchProjectContextSource(SAMPLE);
  assert.equal(result.reason, 'patched');
  assert.equal(result.patched, true);
  assert.ok(result.code.includes(DEDUP_MARKER));
  assert.ok(result.code.includes('loadRules(_cwd)'));
  // knowledge and load() are untouched
  assert.ok(result.code.includes('loadKnowledge(cwd)'));
  assert.ok(result.code.includes('knowledge body kept'));
  assert.ok(result.code.includes('this.loadRules(cwd);'));
  // old reading logic is gone
  assert.ok(!result.code.includes('readdirSync(rulesDir'));
});

test('patched source reports isDedupPatched', () => {
  const { code } = patchProjectContextSource(SAMPLE);
  assert.equal(isDedupPatched(code), true);
  assert.equal(isDedupPatched(SAMPLE), false);
});

test('patch is idempotent (already-patched is a no-op)', () => {
  const once = patchProjectContextSource(SAMPLE).code;
  const twice = patchProjectContextSource(once);
  assert.equal(twice.reason, 'already-patched');
  assert.equal(twice.code, once);
});

test('patch fails loudly when the loadRules signature is absent', () => {
  const result = patchProjectContextSource('export class ProjectContext { /* reshaped */ }');
  assert.equal(result.reason, 'signature-not-found');
  assert.equal(result.patched, false);
  assert.equal(result.code, 'export class ProjectContext { /* reshaped */ }');
});

test('brace matching handles nested braces inside loadRules', () => {
  const src = `class X {
    loadRules(cwd) {
        if (true) { for (const f of []) { this.x(f); } }
    }
    loadKnowledge() {}
}`;
  const result = patchProjectContextSource(src);
  assert.equal(result.reason, 'patched');
  assert.ok(result.code.includes('loadKnowledge() {}'));
  assert.ok(!result.code.includes('this.x(f)'));
});
