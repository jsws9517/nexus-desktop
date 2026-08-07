import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Force-recompiles the Electron-ABI better-sqlite3 copy. Used when upgrading
// Electron or better-sqlite3, or after a failed prepare. Just clears the cache
// and delegates to the idempotent prepare script.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeDir = join(root, '.native', 'electron');
rmSync(nativeDir, { recursive: true, force: true });
console.log('[rebuild-electron] cleared .native/electron, recompiling...');
const { spawnSync } = await import('node:child_process');
const res = spawnSync(process.execPath, [join(root, 'scripts', 'prepare-electron-native.mjs')], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
