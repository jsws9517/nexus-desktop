import { copyFileSync, existsSync } from 'node:fs';
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
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));

export default function afterPack(context) {
  const releaseNode = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const electronNode = join(root, '.native', 'electron', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(electronNode)) {
    throw new Error(`[afterPack] Missing Electron-ABI build at ${electronNode}. Run \`npm run prepare:electron-native\` (or dist:win) first.`);
  }
  if (!existsSync(releaseNode)) {
    throw new Error(`[afterPack] Expected packaged binary not found at ${releaseNode}`);
  }
  copyFileSync(electronNode, releaseNode);
  const pdb = join(dirname(electronNode), 'better_sqlite3.pdb');
  if (existsSync(pdb)) {
    copyFileSync(pdb, join(dirname(releaseNode), 'better_sqlite3.pdb'));
  }
  console.log('[afterPack] swapped in Electron-ABI better_sqlite3.node');
}
