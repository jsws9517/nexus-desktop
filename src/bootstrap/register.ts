/**
 * Loaded into the core worker via `--import`. Registers the overlay resolve
 * hook only when the launcher supplied an overlay dir; otherwise a no-op.
 */
import { register } from 'node:module';
import type { HookData } from './resolve-hook.js';

const coreDir = process.env.NEXUS_OVERLAY_CORE_DIR;
const baseDir = process.env.NEXUS_APP_ROOT;

if (coreDir && baseDir) {
  const data: HookData = { coreDir, baseDir };
  register('./resolve-hook.js', { parentURL: import.meta.url, data });
}
