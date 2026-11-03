import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * electron-builder `afterPack` hook.
 *
 * Swaps the better-sqlite3 native binary in the packaged output for the
 * Electron-ABI build produced by prepare-electron-native.mjs. Dev's
 * node_modules copy (system-Node ABI) is never modified, so the two runtimes
 * never clobber each other's binary.
 *
 * The .node lives outside the asar (see build.asarUnpack), so replacing the
 * unpacked file is enough — no asar repack needed.
 *
 * Better-sqlite3 13.x ships its binaries under `prebuilds/<platform>-<arch>.node`
 * (no `build/Release/better_sqlite3.node`), so both the source and target paths
 * are resolved from the prebuilds directory for the current platform/arch.
 *
 * IMPORTANT: resolve both the platform and the architecture from the electron-builder
 * `context`, never from `process`. On macOS the unpacked tree lives at
 * `<appOutDir>/<productName>.app/Contents/Resources` (the `nexus.app` bundle),
 * while on Windows/Linux it is `<appOutDir>/resources`. And when cross-building
 * (e.g. an arm64 runner producing an x64 target), `process.arch` is the host
 * architecture — the wrong one — so use `context.arch` instead.
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// electron-builder's `builder-util` Arch enum: ia32=0 x64=1 armv7l=2 arm64=3 universal=4
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
function contextArch(context) {
  return (typeof context.arch === 'number' && ARCH_NAMES[context.arch]) || context.arch;
}

function prebuildFile(platform, arch) {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${a}.node`;
}

export default function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux' | 'mas'
  const arch = contextArch(context);
  const file = prebuildFile(platform, arch);
  const releaseNode = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources',
        'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', file)
    : join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', file);
  const electronNode = join(root, '.native', 'electron', 'node_modules', 'better-sqlite3', 'prebuilds', file);
  if (!existsSync(electronNode)) {
    throw new Error(`[afterPack] Missing Electron-ABI build at ${electronNode}. Run \`npm run prepare:electron-native\` (or dist:win) first.`);
  }
  // The target .node (e.g. linux-x64.node) ships INSIDE app.asar on every
  // platform build so asarUnpack maps it and the asar loader redirects reads
  // to this unpacked path; binding.js resolves the prebuild only when
  // fs.existsSync() is true against the asar path. The asar header's unpacked
  // flag is fixed at pack time, so we swap the unpacked file in place (byte
  // replacement, same path — no repack needed). Create the directory if the
  // file was ever missing and write the Electron-ABI binary either way.
  mkdirSync(dirname(releaseNode), { recursive: true });
  copyFileSync(electronNode, releaseNode);
  console.log(`[afterPack] swapped in Electron-ABI better-sqlite3 (${file})`);
}
