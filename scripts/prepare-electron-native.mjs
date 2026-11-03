import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
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
  const { cwdOverride, ...env } = opts ?? {};
  const res = spawnSync(cmd, args, {
    cwd: cwdOverride ?? nativeDir,
    env: env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: 15 * 60_000,
  });
  return res.status === 0;
}

/**
 * After `node-gyp rebuild`, better-sqlite3's compiled binary lands under
 * `.native/electron/node_modules/better-sqlite3/build/`. The exact layout
 * depends on platform:
 *   - Linux/macOS (make/Xcode):  build/Release/better_sqlite3.node
 *   - Windows (MSBuild):         build/better_sqlite3.node  (or sometimes
 *                                 the link step is skipped and only .obj
 *                                 files remain — in which case the user must
 *                                 use the prebuilds/ fallback path)
 *
 * The packaged app's `binding.js` only resolves `prebuilds/<plat>-<arch>.node`,
 * so we copy whichever compiled artifact exists into that slot. Without this
 * step the npm-shipped Node-ABI prebuild stays in place and the packaged app
 * crashes on load (V8 ABI mismatch).
 */
function placePrebuild(arch) {
  const plat = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  const moduleName = join(nativeDir, 'node_modules', nativeModuleName);
  const buildDir = join(moduleName, 'build');
  const target = join(moduleName, 'prebuilds', `${plat}-${a}.node`);
  // Recursively find any .node under build/ (covers build/Release/x.node,
  // build/x.node, build/obj/x.node, etc.).
  const found = existsSync(buildDir) ? findNodeArtifacts(buildDir) : [];
  // Prefer the one matching the target name (better_sqlite3.node) over
  // test_extension.node.
  const candidates = found
    .filter((f) => f.includes('better_sqlite3'))
    .concat(found.filter((f) => !f.includes('better_sqlite3')));
  for (const src of candidates) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(src, target);
    const size = statSync(target).size;
    console.log(`[prepare-electron-native] placed Electron-ABI ${plat}-${a}.node (${(size / 1048576).toFixed(2)} MiB) from ${src}`);
    return true;
  }
  console.error(`[prepare-electron-native] no compiled artifact found under ${buildDir}`);
  return false;
}

function findNodeArtifacts(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(findNodeArtifacts(p));
    else if (entry.isFile() && entry.name.endsWith('.node')) out.push(p);
  }
  return out;
}

function compile(modVersion) {
  mkdirSync(nativeDir, { recursive: true });
  const electronVersion = electronPkg.version;
  // Compile for an explicit target arch when NATIVE_ARCH is set (e.g. a CI
  // runner of one arch building for the other), otherwise the host arch.
  const arch = process.env.NATIVE_ARCH || process.arch;
  if (!existsSync(pkg)) {
    throw new Error(`Missing ${pkg}`);
  }
  const moduleDir = join(nativeDir, 'node_modules', nativeModuleName);
  // First ensure the package itself is installed (binding.gyp must exist).
  // --ignore-scripts: skip better-sqlite3's install script (prebuild-install)
  // which would download the system-Node-ABI binary into prebuilds/ — we
  // need the source tree only so node-gyp can compile the Electron-ABI build.
  if (!existsSync(join(moduleDir, 'binding.gyp'))) {
    console.log(`[prepare-electron-native] installing ${nativeModuleName} into ${nativeDir} (--ignore-scripts)...`);
    if (!run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwdOverride: nativeDir,
    })) {
      return false;
    }
  }
  if (!existsSync(join(moduleDir, 'binding.gyp'))) {
    console.error(`[prepare-electron-native] ${moduleDir}/binding.gyp still missing after npm install`);
    return false;
  }
  console.log(`[prepare-electron-native] compiling ${nativeModuleName}@${modVersion} for electron ${electronVersion} (${process.platform}-${arch})...`);
  // node-gyp rebuild: force a source compile against the Electron ABI.
  // The npm `prebuild-install` step (run by `npm install`) only fetches a
  // *system-Node* prebuild into `prebuilds/`; the Electron-ABI binary must be
  // compiled here into `build/Release/` and then moved into the prebuilds
  // slot by `placePrebuild()`.
  const nodeGypArgs = [
    'rebuild',
    '--runtime=electron',
    `--target=${electronVersion}`,
    `--arch=${arch}`,
    `--dist-url=https://electronjs.org/headers`,
    // node-gyp writes the artifact under build/Release/.
    '--build-dir=build',
  ];
  // Locate node-gyp via npx (works without a global install).
  if (!run(process.execPath === 'node' ? 'npx' : 'npx', ['node-gyp', ...nodeGypArgs], {
    // The build dir is the better-sqlite3 module dir itself.
    cwdOverride: moduleDir,
  })) {
    return false;
  }
  // The npm install above compiles into build/Release/, not prebuilds/.
  // Move the Electron-ABI artifact into the prebuilds slot that binding.js
  // resolves at runtime — otherwise the Node-ABI npm prebuild stays put and
  // the packaged app will crash on load.
  if (!placePrebuild(arch)) {
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
  const arch = process.env.NATIVE_ARCH || process.arch;
  if (stamp && stamp.modVersion === modVersion && stamp.electronVersion === electronPkg.version && stamp.arch === arch) {
    console.log('[prepare-electron-native] stamp matches  - skipping (force with `npm run rebuild:electron`)');
    return;
  }
  if (!compile(modVersion)) {
    process.exit(1);
  }
}

main();
