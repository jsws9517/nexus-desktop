// PoC fixture builder: creates a base app dir, an overlay core dir, and a desktop overlay asar.
// Output goes to POC_ROOT (default: %TEMP%/opencode/poc-decouple), never into the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const ROOT = process.env.POC_ROOT
  ?? path.join(os.tmpdir(), 'opencode', 'poc-decouple');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

fs.rmSync(ROOT, { recursive: true, force: true });

// 1) base app (plain directory, stands in for app.asar contents)
const base = path.join(ROOT, 'base');
write(path.join(base, 'package.json'), JSON.stringify({ name: 'poc-base', type: 'module' }));
write(path.join(base, 'index.js'), 'export {};\n');
// base nexus-coder 1.0.0
write(path.join(base, 'node_modules/nexus-coder/package.json'),
  JSON.stringify({ name: 'nexus-coder', version: '1.0.0', type: 'module' }));
write(path.join(base, 'node_modules/nexus-coder/dist/src/version.js'),
  "export const v = 'base';\n");
write(path.join(base, 'node_modules/nexus-coder/dist/src/base-only.js'),
  "export const v = 'base-only';\n");
// a bare dependency that only exists in the base node_modules
write(path.join(base, 'node_modules/poc-dep/package.json'),
  JSON.stringify({ name: 'poc-dep', version: '1.0.0', type: 'module', exports: './index.js' }));
write(path.join(base, 'node_modules/poc-dep/index.js'),
  "export default 'dep-from-base';\n");

// 2) overlay core 2.0.0-poc (unpacked directory)
const core = path.join(ROOT, 'overlay', 'core', '2.0.0-poc');
write(path.join(core, 'package.json'),
  JSON.stringify({ name: 'nexus-coder', version: '2.0.0-poc', type: 'module' }));
write(path.join(core, 'dist/src/version.js'),
  "import dep from 'poc-dep';\nexport const v = 'overlay';\nexport const dep2 = dep;\n");

// 3) desktop overlay asar: source tree packed with @electron/asar
const deskSrc = path.join(ROOT, 'desktop-src');
write(path.join(deskSrc, 'package.json'),
  JSON.stringify({ name: 'nexus-desktop', version: '0.2.21-poc', type: 'module', main: 'dist/main/index.js' }));
write(path.join(deskSrc, 'dist/main/index.js'),
  "export const marker = 'desktop-0.2.21-poc';\nexport const electronVersion = process.versions.electron;\n");
const deskAsar = path.join(ROOT, 'overlay', 'desktop-0.2.21-poc.asar');
fs.mkdirSync(path.dirname(deskAsar), { recursive: true });
await asar.createPackage(deskSrc, deskAsar);

console.log(JSON.stringify({ ROOT, core, deskAsar, base }, null, 2));
