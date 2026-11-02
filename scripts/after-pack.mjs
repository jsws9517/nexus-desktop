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
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));

function prebuildFile() {
  const { platform, arch } = process;
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${a}.node`;
}

export default function afterPack(context) {
  const file = prebuildFile();
  const releaseNode = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', file);
  const electronNode = join(root, '.native', 'electron', 'node_modules', 'better-sqlite3', 'prebuilds', file);
  if (!existsSync(electronNode)) {
    throw new Error(`[afterPack] Missing Electron-ABI build at ${electronNode}. Run \`npm run prepare:electron-native\` (or dist:win) first.`);
  }
  // The target .node may or may not already be present in the unpacked output:
  // build.files strips every non-Windows prebuild (linux-x64, …) to keep the
  // asar small, so on non-Windows builds there is NO placeholder to swap.
  // Create the directory if needed and write the Electron-ABI binary either way.
  mkdirSync(dirname(releaseNode), { recursive: true });
  copyFileSync(electronNode, releaseNode);
  console.log(`[afterPack] swapped in Electron-ABI better-sqlite3 (${file})`);
}
