import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Desktop-only log writer. Replaces the hardcoded per-machine debug paths
 * (`C:/Users/<user>/AppData/Local/Temp/opencode/...`) with a platform-neutral
 * location under the app data root:
 *
 *   ~/.nexus/logs/<YYYY-MM-DD>.<level>.log   (or $LLMA_DATA_DIR/.nexus/logs/...)
 *
 * Levels are routed to per-day files; `debug` lines only appear when
 * NEXUS_DEBUG=1. All writes are best-effort (never throw into the caller).
 *
 * Lifecycle discipline (kept in sync with `.nexus/rules/NEXUS.md` §3):
 *   - A single day-level file that grows past MAX_LOG_FILE_BYTES rolls over to
 *     `<day>.<level>.log.N` shards, keeping at most MAX_LOG_ROTATIONS of them.
 *   - Log files older than LOG_RETENTION_DAYS are pruned (checked at most
 *     once per CLEANUP_MIN_INTERVAL_MS per process).
 *   - Every line passes `redactLogLine()` before hitting disk so secrets
 *     (API keys, Bearer tokens, authorization headers) never persist.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_ROTATIONS = 3;
export const LOG_RETENTION_DAYS = 30;
const CLEANUP_MIN_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEBUG_ENABLED = process.env.NEXUS_DEBUG === '1';

function logsDir(): string {
  const base = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  return join(base, 'logs');
}

function logFile(level: LogLevel, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return join(logsDir(), `${day}.${level}.log`);
}

/** Mask bearer credentials, keys, and common `?key=...` query values. */
export function redactLogLine(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/\b(api[_-]?key\s*[:=]\s*['"]?)[^\s'",}]{6,}/gi, '$1***')
    .replace(/([?&](?:key|token|api_key|apikey|secret)=)[^&#\s"]+/gi, '$1***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1***')
    .replace(/\b(authorization\s*[:=]\s*)(?!Bearer\b)[^\s'",}]{6,}/gi, '$1***');
}

/** Rename an overgrown day-level file down the shard chain (`...log.1`, `.2`, …). */
function maybeRotate(level: LogLevel): void {
  const base = logFile(level);
  try {
    const st = statSync(base);
    if (st.size <= MAX_LOG_FILE_BYTES) return;
    for (let i = MAX_LOG_ROTATIONS - 1; i >= 1; i--) {
      const from = `${base}.${i}`;
      const to = `${base}.${i + 1}`;
      try {
        renameSync(from, to);
      } catch {
        /* no shard at this depth yet */
      }
    }
    try {
      rmSync(`${base}.${MAX_LOG_ROTATIONS}`);
    } catch {
      /* nothing beyond the cap */
    }
    renameSync(base, `${base}.1`);
  } catch {
    // Base file gone between stat and rename — next append recreates it.
  }
}

/** Hard-delete every retired log file (older than the retention window). */
export function pruneRetiredLogs(nowMs = Date.now()): number {
  const cutoff = nowMs - LOG_RETENTION_DAYS * DAY_MS;
  let removed = 0;
  try {
    const dir = logsDir();
    for (const f of readdirSync(dir)) {
      if (!/\.log(\.\d+)?$/.test(f)) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p);
          removed++;
        }
      } catch {
        // stat/rm race — skip
      }
    }
  } catch {
    // no log dir — nothing to prune
  }
  return removed;
}

let lastCleanup = 0;

function maybePruneRetired(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_MIN_INTERVAL_MS) return;
  lastCleanup = now;
  pruneRetiredLogs(now);
}

export function log(level: LogLevel, message: string): void {
  if (level === 'debug' && !DEBUG_ENABLED) return;
  try {
    mkdirSync(logsDir(), { recursive: true });
    maybePruneRetired();
    maybeRotate(level);
    appendFileSync(logFile(level), `${Date.now()} [${level.toUpperCase()}] ${redactLogLine(message)}\n`);
  } catch {}
}

export const logger = {
  debug: (message: string): void => log('debug', message),
  info: (message: string): void => log('info', message),
  warn: (message: string): void => log('warn', message),
  error: (message: string): void => log('error', message),
};

/** Glob all `*.log` / `*.log.N` files under the log dir, newest first. */
export function listLogFiles(): string[] {
  try {
    const files = readdirSync(logsDir()).filter((f) => /\.log(\.\d+)?$/.test(f));
    return files
      .map((f) => join(logsDir(), f))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}

/** Last `maxLines` lines across log files (most recent first), for the in-app viewer. */
export function recentLogLines(maxLines = 200): string[] {
  const out: string[] = [];
  for (const file of listLogFiles()) {
    if (out.length >= maxLines) break;
    try {
      const text = readFileSync(file, 'utf-8');
      const lines = text.trimEnd().split('\n');
      const take = Math.min(maxLines - out.length, lines.length);
      out.push(...lines.slice(-take));
    } catch {}
  }
  return out;
}