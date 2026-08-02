#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * One-click launcher for the npm distribution.
 * Spawns the Electron binary with this package's app dir.
 * Running `nexus-desktop` (or double-clicking the generated .cmd shim)
 * launches the desktop GUI directly — no CLI commands required.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');

const electronModule = (await import('electron')) as unknown as { default?: string; [k: string]: unknown };
const electronPath =
  typeof electronModule === 'string' ? electronModule : (electronModule.default as string);

console.log('[nexus-desktop] launching...');
const child = spawn(electronPath, [appDir], {
  cwd: appDir,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(`[nexus-desktop] failed to launch Electron: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
