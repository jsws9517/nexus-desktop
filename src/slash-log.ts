import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';

/**
 * Per-session slash-command output log.
 *
 * Slash results are deliberately kept OUT of the SQLite session DB (so they
 * never re-feed the LLM context on resume/regenerate). Instead each execution
 * is appended to `~/.nexus/slash-logs/<sessionId>.md` as a self-describing
 * block and the renderer rehydrates collapsible cards from this file on reload.
 */

export interface SlashLogEntry {
  /** ISO timestamp of the execution. */
  ts: string;
  /** The raw slash command line, e.g. "/plan foo". */
  command: string;
  /** DB id of the persisted user (slash-input) row, used to anchor the card
   *  next to the right message on reload. Absent for legacy/unknown rows. */
  anchorId?: number;
  /** Full textual output of the command. */
  content: string;
}

/** Mirrors core src/session/store.ts: LLMA_DATA_DIR overrides the data root. */
function baseDir(): string {
  const dir = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  return join(dir, 'slash-logs');
}

export function slashLogPath(sessionId: string): string {
  return join(baseDir(), `${sessionId}.md`);
}

/** Append one slash execution to the session's markdown log. */
export function appendSlashLog(sessionId: string, entry: SlashLogEntry): void {
  const dir = baseDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = slashLogPath(sessionId);
  // HTML comment header keeps the metadata machine-parseable while staying
  // invisible in a markdown viewer. cmd is JSON-encoded so quotes/slashes are safe.
  const header = `<!-- slash ts=${entry.ts} cmd=${JSON.stringify(entry.command)} anchor=${entry.anchorId ?? ''} -->\n`;
  appendFileSync(path, `${header}${entry.content}\n\n`, 'utf8');
}

/** Read all slash executions for a session (oldest first). Tolerant of a
 *  missing file (returns []) and of malformed trailing blocks. */
export function readSlashLog(sessionId: string): SlashLogEntry[] {
  const path = slashLogPath(sessionId);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: SlashLogEntry[] = [];
  const lines = text.split('\n');
  const headerRe = /^<!-- slash ts=([^\s]+) cmd=(.*?) anchor=(.*?) -->\s*$/;
  let cur: SlashLogEntry | null = null;
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      if (cur) {
        cur.content = cur.content.replace(/\s+$/, '');
        // Skip commands that produced no real output — nothing to show.
        if (cur.content.trim().length > 0) entries.push(cur);
      }
      let command = m[2];
      try {
        command = JSON.parse(m[2]) as string;
      } catch {
        /* keep raw if not valid JSON */
      }
      const anchorRaw = m[3].trim();
      cur = {
        ts: m[1],
        command,
        anchorId: anchorRaw ? Number(anchorRaw) : undefined,
        content: '',
      };
    } else if (cur) {
      cur.content += (cur.content ? '\n' : '') + line;
    }
  }
  if (cur) {
    cur.content = cur.content.replace(/\s+$/, '');
    if (cur.content.trim().length > 0) entries.push(cur);
  }
  return entries;
}
