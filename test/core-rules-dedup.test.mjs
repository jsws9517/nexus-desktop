/**
 * Unit tests for the source-level rules-dedup patch applied to the installed
 * nexus-coder core (build time) and to every downloaded core overlay
 * (activation time).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { patchProjectContextSource, isDedupPatched, DEDUP_MARKER } = await import(
  pathToFileURL(join(ROOT, 'scripts', 'patch-core-rules-dedup.mjs'))
);
const shared = await import(
  pathToFileURL(join(__dirname, '..', 'dist', 'shared', 'core-dedup.js')).href
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

test('build-time script and shared overlay patch stay in sync', () => {
  assert.equal(shared.DEDUP_MARKER, DEDUP_MARKER, 'marker drift between script and shared module');
  const scriptPatched = patchProjectContextSource(SAMPLE).code;
  const sharedPatched = shared.patchProjectContextSource(SAMPLE).code;
  assert.equal(shared.isDedupPatched(scriptPatched), true);
  assert.equal(isDedupPatched(sharedPatched), true);
  assert.equal(sharedPatched.includes('readdirSync(rulesDir'), false);
  assert.equal(shared.patchProjectContextSource(sharedPatched).reason, 'already-patched');
});

test('overlay activation patches the extracted core before promoting it', () => {
  const manager = readFileSync(join(ROOT, 'src', 'core-overlay', 'manager.ts'), 'utf8');
  assert.match(manager, /import \{ patchProjectContextSource, isDedupPatched \} from '\.\.\/shared\/core-dedup\.js'/);
  assert.match(manager, /isDedupPatched\(source\)/);
  assert.match(manager, /patchProjectContextSource\(source\)/);
  // The patch is applied to the scratch dir BEFORE it is renamed into place.
  assert.ok(
    manager.indexOf('patchProjectContextSource(source)') < manager.indexOf('fs.renameSync(extractDir, targetDir)'),
    'patch must run before the extracted core is promoted',
  );
});

test('active-rules detection inspects the real core file, overlay or bundled', () => {
  const register = readFileSync(join(ROOT, 'src', 'ipc', 'register.ts'), 'utf8');
  assert.match(register, /import \{ readState as readCoreOverlayState, coreDirFor \} from '\.\.\/bootstrap\/overlay\.js'/);
  assert.match(register, /isDedupPatched/);
  assert.match(register, /coreDirFor\(ctx\.coreOverlayRoot\(\), activeCore\)/);
  // The old unconditional "overlay active => false" assumption is gone.
  assert.equal(register.includes('whose project-context.js is NOT patched'), false);
});
