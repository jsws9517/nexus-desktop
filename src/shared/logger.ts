import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

export function log(level: LogLevel, message: string): void {
  if (level === 'debug' && !DEBUG_ENABLED) return;
  try {
    mkdirSync(logsDir(), { recursive: true });
    appendFileSync(logFile(level), `${Date.now()} [${level.toUpperCase()}] ${message}\n`);
  } catch {}
}

export const logger = {
  debug: (message: string): void => log('debug', message),
  info: (message: string): void => log('info', message),
  warn: (message: string): void => log('warn', message),
  error: (message: string): void => log('error', message),
};

/** Glob all `*.log` files under the log dir (any level, any day), newest first. */
export function listLogFiles(): string[] {
  try {
    const files = readdirSync(logsDir()).filter((f) => f.endsWith('.log'));
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
