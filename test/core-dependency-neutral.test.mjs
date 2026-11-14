/**
 * §2.5 dependency-neutrality gate: the publish-core static check that the
 * overlay's dist never imports a bare package the desktop baseline does not
 * cover (bare imports from overlay files resolve from the base app's
 * node_modules — see src/bootstrap/resolve-hook.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  collectBareSpecifiers,
  dependencyNeutralityOffenders,
} from '../scripts/publish-core.mjs';

test('scanner captures real imports, ignores string/template/comment contents', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-scan-'));
  const f = path.join(dir, 'a.js');
  writeFileSync(f, [
    `const script = "import { Document } from 'docx';";`, // string literal: NOT counted
    'const t = `import x from \'pdfkit\';`;',             // template literal: NOT counted
    `import fs2 from 'node:fs';`,                          // builtin: NOT counted
    `const rel = await import('./local.js');`,             // relative: NOT counted
    `import { leftPad } from 'left-pad';`,                  // real bare: counted
    `void import('unobtainium');`,                          // dynamic bare: counted
    `const r = require('chalk');`,                          // CJS bare: counted
    `// import 'commented-out';`,                           // line comment: NOT counted
    `/** import 'in-doc' */`,                                // block comment: NOT counted
    'const ok = true;',
  ].join('\n'));
  const found = collectBareSpecifiers([f]);
  assert.ok(found.has('left-pad'), 'static import not captured');
  assert.ok(found.has('unobtainium'), 'dynamic import not captured');
  assert.ok(found.has('chalk'), 'require() import not captured');
  assert.ok(!found.has('docx'), 'string-literal import syntax must not count');
  assert.ok(!found.has('pdfkit'), 'template-literal import syntax must not count');
  assert.ok(!found.has('commented-out'), 'line-comment import must not count');
  assert.ok(!found.has('in-doc'), 'block-comment import must not count');
  assert.ok(!found.has('local'), 'relative imports must not count');
});

test('gate refuses a dist that imports a package outside the baseline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dep-off-'));
  writeFileSync(path.join(dir, 'x.js'), "import { o } from 'never-heard-of-pkg';\n");
  const offenders = dependencyNeutralityOffenders(dir);
  assert.ok(
    offenders.some((o) => o.startsWith('never-heard-of-pkg')),
    `offender not reported: ${offenders.join(', ')}`,
  );
});

test('the shipped core dist is dependency-neutral against the desktop baseline', () => {
  const offenders = dependencyNeutralityOffenders(
    path.resolve('node_modules/nexus-coder/dist'),
  );
  assert.deepEqual(
    offenders,
    [],
    `core dist imports packages the desktop baseline does not cover: ${offenders.join(', ')} — add them to the desktop package.json or CORE_BUNDLE_ALLOWLIST`,
  );
});
