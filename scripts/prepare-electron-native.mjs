import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prepares the Electron-ABI build of better-sqlite3 used by the packaged app.
 *
 * The desktop dev flow runs the worker under system Node (ABI 141) and the
 * packaged exe under Electron 43 (ABI 148)  - the same .node binary can never
 * serve both. Instead of rebuilding dev's node_modules back and forth, we
 * compile a dedicated copy under `.native/electron` and have electron-builder's
 * afterPack hook swap it into the output. Dev's node_modules is never touched.
 *
 * Compiled here:
 *   .native/electron/node_modules/better-sqlite3/build/Release/better_sqlite3.node
 *
 * Idempotent: a stamp file records (better-sqlite3 version, electron version,
 * arch) and skips the (slow, toolchain-heavy) source compile when it matches.
 * Remove `.native/electron` (or run `npm run rebuild:electron`) to force it.
 */
const require_ = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeDir = join(root, '.native', 'electron');
const pkg = join(nativeDir, 'package.json');
const stampFile = join(nativeDir, '.stamp.json');
const electronPkg = require_('electron/package.json');
const nativeModuleName = 'better-sqlite3';

function getModuleVersion() {
  const target = join(root, 'node_modules', nativeModuleName, 'package.json');
  return JSON.parse(readFileSync(target, 'utf8')).version;
}

function getStamp() {
  try {
    return JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeStamp(modVersion, electronVersion, arch) {
  writeFileSync(stampFile, JSON.stringify({ modVersion, electronVersion, arch }, null, 2) + '\n');
}

function electronBinaryPath() {
  // require('electron') exports the path to the electron executable.
  return require_('electron');
}

function probeUnderElectron() {
  const moduleRoot = join(nativeDir, 'node_modules', nativeModuleName);
  const probe = `
    const { createRequire } = require('module');
    try {
      createRequire(${JSON.stringify(moduleRoot + '/package.json')})('${nativeModuleName}');
      console.log('PROBE_OK');
    } catch (e) {
      console.error(String(e && e.message).split('\\n')[0]);
      process.exit(1);
    }
  `;
  const res = spawnSync(electronBinaryPath(), ['-e', probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return res.status === 0 && /PROBE_OK/.test(res.stdout || '');
}

function run(cmd, args, opts) {
  // npm 11 forwards the user-level `allow-scripts` config as npm_config_allow_scripts
  // into this process's env, which the inner `npm install` then treats as a
  // CLI/env-layer policy and rejects (EALLOWSCRIPTS) for project-scoped installs.
  // The compile must run regardless, so strip it before spawning.
  const env = { ...process.env, ...opts };
  delete env.npm_config_allow_scripts;
  const res = spawnSync(cmd, args, {
    cwd: nativeDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: 15 * 60_000,
  });
  return res.status === 0;
}

function compile(modVersion) {
  mkdirSync(nativeDir, { recursive: true });
  const electronVersion = electronPkg.version;
  const arch = process.arch;
  if (!existsSync(pkg)) {
    throw new Error(`Missing ${pkg}`);
  }
  const env = {
    // Force a source compile: no prebuild exists for electron-v148, and we want
    // to skip prebuild-install's attempt to hit the blocked GitHub host.
    npm_config_build_from_source: 'true',
    npm_config_runtime: 'electron',
    npm_config_target: electronVersion,
    // electronjs.org headers host has a correct SHASUMS256.txt for node-gyp
    // checksum verification; npmmirror's SHASUMS256.txt is missing the
    // node-v43.2.0-headers.tar.gz entry and fails the check.
    npm_config_disturl: 'https://electronjs.org/headers',
    npm_config_arch: arch,
    npm_config_platform: process.platform,
  };
  console.log(`[prepare-electron-native] compiling ${nativeModuleName}@${modVersion} for electron ${electronVersion} (${process.platform}-${arch})...`);
  // install runs prebuild-install || node-gyp rebuild; build_from_source makes
  // it compile for the electron runtime using the npmmirror headers mirror.
  if (!run('npm', ['install', '--no-audit', '--no-fund'], env)) {
    return false;
  }
  if (!probeUnderElectron()) {
    console.error('[prepare-electron-native] compiled binary does NOT load under Electron  - rebuild failed');
    return false;
  }
  writeStamp(modVersion, electronVersion, arch);
  console.log('[prepare-electron-native] OK');
  return true;
}

function main() {
  const modVersion = getModuleVersion();
  const stamp = getStamp();
  if (stamp && stamp.modVersion === modVersion && stamp.electronVersion === electronPkg.version && stamp.arch === process.arch) {
    console.log('[prepare-electron-native] stamp matches  - skipping (force with `npm run rebuild:electron`)');
    return;
  }
  if (!compile(modVersion)) {
    process.exit(1);
  }
}

main();
