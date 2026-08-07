import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

/**
 * Builds the npm-distributable tarball (nexus-desktop-<ver>.tgz).
 *
 * Why a variant package.json: the repo package.json keeps `electron` in
 * devDependencies (electron-builder requires it there). But npm does NOT install
 * devDependencies of a package it installs, so for the npm distribution we
 * produce a copy with `electron` moved into `dependencies`. This way
 * `npm install -g nexus-desktop.tgz` installs Electron + core deps and the
 * `nexus-desktop` command / double-click launcher just works.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

if (!existsSync(join(root, 'dist', 'launcher.js'))) {
  console.error('[nexus-desktop] Build output missing. Run "npm run build" first.');
  process.exit(1);
}

const electron = pkg.devDependencies?.electron;
if (!electron) {
  console.error('[nexus-desktop] electron devDependency not found.');
  process.exit(1);
}

const variant = {
  ...pkg,
  dependencies: { ...pkg.dependencies, electron },
  devDependencies: Object.fromEntries(
    Object.entries(pkg.devDependencies ?? {}).filter(([k]) => k !== 'electron'),
  ),
  scripts: {},
  build: undefined,
};

const stage = join(root, '.npm-stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'nexus-desktop'), { recursive: true });

cpSync(join(root, 'dist'), join(stage, 'nexus-desktop', 'dist'), { recursive: true });
writeFileSync(join(stage, 'nexus-desktop', 'package.json'), JSON.stringify(variant, null, 2));

console.log('[nexus-desktop] npm pack (electron moved to dependencies)...');
const tarball = execSync('npm pack', { cwd: join(stage, 'nexus-desktop'), encoding: 'utf-8' }).trim();
cpSync(join(stage, 'nexus-desktop', tarball), join(root, tarball), { overwrite: true });
rmSync(stage, { recursive: true, force: true });
console.log(`[nexus-desktop] npm tarball: ${join(root, tarball)}`);
