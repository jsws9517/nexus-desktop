/**
 * Worker-side reader for desktop-only settings in `~/.nexus/desktop.json`.
 *
 * The main process owns the file (src/main/desktop-state.ts, mtime-aware
 * cache); this module gives workers the same view for values that gate
 * worker-side behaviour. Reads are mtime-cached (one `stat` per call,
 * re-parse only when the file changed) so a per-card read is cheap, and a
 * main-side settings write takes effect on the NEXT card — no worker
 * restart needed.
 *
 * Pattern mirrors src/agent/spend-mode-store.ts (the earlier worker-side
 * desktop.json surface).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clampPermissionTimeoutMs } from '../shared/permission-timeout.js';

// Resolved at call time so tests can point NEXUS_CONFIG_DIR at a temp dir.
function desktopPath(): string {
  return join(process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus'), 'desktop.json');
}

let cachedMtime = -1;
let cachedFile: Record<string, unknown> = {};

function readWhole(): Record<string, unknown> {
  const path = desktopPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readCached(): Record<string, unknown> {
  let mtime = -1;
  const path = desktopPath();
  if (existsSync(path)) {
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      mtime = -1;
    }
  }
  if (mtime !== cachedMtime) {
    cachedFile = readWhole();
    cachedMtime = mtime;
  }
  return cachedFile;
}

/** Test hook: drop the mtime cache so the next read re-hits disk. */
export function invalidateDesktopConfigCache(): void {
  cachedMtime = -1;
  cachedFile = {};
}

/**
 * H2: how long a permission card may wait for an answer (ms) before it
 * auto-denies. Loose clamp to 10 s–1 h; any invalid/absent value yields
 * the 10-minute default.
 */
export function readPermissionTimeoutMs(): number {
  return clampPermissionTimeoutMs(readCached().permissionTimeoutMs);
}
