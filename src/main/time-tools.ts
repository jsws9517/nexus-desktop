/**
 * In-process mirror of the official mcp-server-time server
 * (https://github.com/modelcontextprotocol/servers/tree/main/src/time).
 *
 * Tools: get_current_time, convert_time — schemas, JSON output and error
 * behavior aligned 1:1 with src/time/src/mcp_server_time/server.py.
 */

export type TimeToolResult = { content: string; isError: boolean };

export const TIME_TOOLS = new Set(['get_current_time', 'convert_time']);

export interface TimeToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server: string;
}

const LOCAL_TZ = ((): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export const TIME_TOOL_DEFS: TimeToolDef[] = [
  {
    name: 'get_current_time',
    description: 'Get current time in a specific timezone',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: `IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Use '${LOCAL_TZ}' as local timezone if no timezone provided by the user.`,
        },
      },
      required: ['timezone'],
    },
    server: 'time',
  },
  {
    name: 'convert_time',
    description: 'Convert time between timezones',
    inputSchema: {
      type: 'object',
      properties: {
        source_timezone: {
          type: 'string',
          description: `Source IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Use '${LOCAL_TZ}' as local timezone if no source timezone provided by the user.`,
        },
        time: {
          type: 'string',
          description: 'Time to convert in 24-hour format (HH:MM)',
        },
        target_timezone: {
          type: 'string',
          description: `Target IANA timezone name (e.g., 'Asia/Tokyo', 'America/San_Francisco'). Use '${LOCAL_TZ}' as local timezone if no target timezone provided by the user.`,
        },
      },
      required: ['source_timezone', 'time', 'target_timezone'],
    },
    server: 'time',
  },
];

function zone(n: string): Intl.DateTimeFormat {
  try {
    // Throws RangeError on an unknown IANA timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: n });
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: n,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch (e) {
    throw new Error(`Invalid timezone: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface WallClock { y: number; mo: number; d: number; h: number; mi: number; s: number; }

function wallClock(dtf: Intl.DateTimeFormat, date: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // Intl 'en-CA' gives year as e.g. 2026 (era-free) in the Gregorian calendar.
  return {
    y: parts.year,
    mo: parts.month - 1,
    d: parts.day,
    h: parts.hour,
    mi: parts.minute,
    s: parts.second,
  };
}

/** Offset of a timezone at an instant, in ms (local wall clock − UTC). */
function tzOffsetMs(zoneName: string, date: Date): number {
  const w = wallClock(zone(zoneName), date);
  const asUTC = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
  const utcSec = Math.floor(date.getTime() / 1000) * 1000;
  return asUTC - utcSec;
}

/** Python datetime.isoformat(timespec='seconds') for a tz-aware datetime. */
function pyIso(zoneName: string, date: Date): string {
  const w = wallClock(zone(zoneName), date);
  const off = tzOffsetMs(zoneName, date);
  const sign = off < 0 ? '-' : '+';
  const absMin = Math.abs(off) / 60000;
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(Math.floor(absMin % 60)).padStart(2, '0');
  const pad = (x: number, n = 2): string => String(x).padStart(n, '0');
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${sign}${hh}:${mm}`;
}

/** Python strftime('%A') — full English weekday name. */
function weekday(zoneName: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zoneName, weekday: 'long' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
  }
}

/** True when the zone is currently observing DST (standard = min of Jan/Jul offsets). */
function inDst(zoneName: string, date: Date): boolean {
  const off = tzOffsetMs(zoneName, date);
  const jan = tzOffsetMs(zoneName, new Date(date.getUTCFullYear(), 0, 1, 12));
  const jul = tzOffsetMs(zoneName, new Date(date.getUTCFullYear(), 6, 1, 12));
  const std = Math.min(jan, jul);
  return off - std > 30 * 60000; // DST differs from standard by well over 30min
}

interface TimeResult { timezone: string; datetime: string; day_of_week: string; is_dst: boolean; }

function currentTimeResult(zoneName: string, date: Date): TimeResult {
  return {
    timezone: zoneName,
    datetime: pyIso(zoneName, date),
    day_of_week: weekday(zoneName, date),
    is_dst: inDst(zoneName, date),
  };
}

function json2(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function getCurrentTime(timezone: string): TimeResult {
  if (!timezone) throw new Error('Missing required argument: timezone');
  return currentTimeResult(timezone, new Date());
}

function convertTime(sourceTz: string, timeStr: string, targetTz: string): { source: TimeResult; target: TimeResult; time_difference: string } {
  if (!sourceTz || !timeStr || !targetTz) throw new Error('Missing required arguments');
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!m) throw new Error('Invalid time format. Expected HH:MM [24-hour format]');
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error('Invalid time format. Expected HH:MM [24-hour format]');

  // Resolve the instant "today at HH:MM in the source zone" (mirrors Python's
  // datetime(now.y, now.mo, now.d, HH, MM, tzinfo=source_tz)).
  const dtfSrc = zone(sourceTz);
  const today = wallClock(dtfSrc, new Date());
  const srcWall = Date.UTC(today.y, today.mo, today.d, hour, minute, 0);
  const instant = new Date(srcWall - tzOffsetMs(sourceTz, new Date(srcWall)));

  const diff = (tzOffsetMs(targetTz, instant) - tzOffsetMs(sourceTz, instant)) / 3600000;
  let timeDiff: string;
  if (Number.isInteger(diff)) {
    timeDiff = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}h`;
  } else {
    let s = Math.abs(diff).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    timeDiff = `${diff >= 0 ? '+' : '-'}${s}h`;
  }

  return {
    source: {
      timezone: sourceTz,
      datetime: pyIso(sourceTz, instant),
      day_of_week: weekday(sourceTz, instant),
      is_dst: inDst(sourceTz, instant),
    },
    target: {
      timezone: targetTz,
      datetime: pyIso(targetTz, instant),
      day_of_week: weekday(targetTz, instant),
      is_dst: inDst(targetTz, instant),
    },
    time_difference: timeDiff,
  };
}

export function callTimeTool(name: string, args: unknown): TimeToolResult {
  try {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === 'get_current_time') {
      return { content: json2(getCurrentTime(typeof a.timezone === 'string' ? a.timezone : '')), isError: false };
    }
    if (name === 'convert_time') {
      return {
        content: json2(convertTime(
          typeof a.source_timezone === 'string' ? a.source_timezone : '',
          typeof a.time === 'string' ? a.time : '',
          typeof a.target_timezone === 'string' ? a.target_timezone : '',
        )),
        isError: false,
      };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (e) {
    return { content: `Error processing mcp-server-time query: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}