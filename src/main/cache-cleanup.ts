/**
 * Cache manifest management for ~/.nexus/caches/.
 *
 * Tracks which cache files belong to which session so they can be cleaned up
 * when the owning session is deleted.  The manifest lives at
 * `~/.nexus/caches/.manifest.json` and is read/written on every operation.
 *
 * File naming convention (new, post-consolidation):
 *   <sessionId>_<timestamp>_<description>.md   — agent long-response snapshots
 *   <slug>_<timestamp>.<ext>                   — TTS audio / other artifacts (no session)
 *
 * Legacy files (pre-consolidation) have no sessionId prefix and are treated as
 * session-less; they are never auto-deleted by session removal.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MANIFEST_NAME = '.manifest.json';

interface CacheEntry {
  file: string;
  sessionId: string | null;
  created: number;
}

interface CacheManifest {
  version: 1;
  entries: CacheEntry[];
}

function dataDir(): string {
  return process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus');
}

function manifestPath(): string {
  return join(dataDir(), 'caches', MANIFEST_NAME);
}

function readManifest(): CacheManifest {
  try {
    const raw = readFileSync(manifestPath(), 'utf-8');
    return JSON.parse(raw) as CacheManifest;
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeManifest(m: CacheManifest): void {
  const dir = join(dataDir(), 'caches');
  if (!existsSync(dir)) require('node:fs').mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(m, null, 2), 'utf-8');
}

/** Register a newly-created cache file.  sessionId=null for session-less artifacts (TTS). */
export function registerCacheFile(filePath: string, sessionId: string | null): void {
  const m = readManifest();
  const rel = filePath.replace(join(dataDir(), 'caches', ''), '');
  m.entries.push({ file: rel, sessionId, created: Date.now() });
  writeManifest(m);
}

/** Delete all cache files owned by a session and remove them from the manifest. Returns count. */
export function cleanupSessionCaches(sessionId: string): number {
  const m = readManifest();
  const toDelete: string[] = [];
  const kept: CacheEntry[] = [];
  for (const entry of m.entries) {
    if (entry.sessionId === sessionId) {
      toDelete.push(join(dataDir(), 'caches', entry.file));
    } else {
      kept.push(entry);
    }
  }
  m.entries = kept;
  writeManifest(m);
  let removed = 0;
  for (const p of toDelete) {
    try {
      rmSync(p, { force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}

/** List all manifest entries (for debugging / status). */
export function listManifest(): CacheEntry[] {
  return readManifest().entries;
}

// ---------------------------------------------------------------------------
// L3: spilled tool results.
//
// Results above the loose 1M-char threshold are written whole to
// `~/.nexus/tool-results/` (see AgentService.capToolResult) and the model is
// handed the path. The dir sits under the nexus data dir, which the desktop
// path sandbox ALWAYS allows, so the model can read its own spill without any
// new permission cards. Files are reaped by age at app startup below.
// ---------------------------------------------------------------------------

/** `~/.nexus/tool-results/` — parent of every spilled tool result. */
export function toolResultSpillDir(): string {
  return join(dataDir(), 'tool-results');
}

/**
 * L3: delete spilled tool results older than `maxAgeDays` (loose default 7).
 * Best-effort and cheap (one readdir + stat per file); called once at app
 * startup so a long-lived install does not accumulate multi-GB spill files.
 * Returns the number of files removed.
 */
export function cleanupStaleToolResultSpills(maxAgeDays = 7): number {
  const dir = toolResultSpillDir();
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    try {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        rmSync(p, { force: true });
        removed++;
      }
    } catch {
      /* best-effort: skip unreadable entries */
    }
  }
  return removed;
}
