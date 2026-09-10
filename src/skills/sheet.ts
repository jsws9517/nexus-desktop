/**
 * In-process `sheet` skills — deterministic office-tabulars for the P2
 * WorkBuddy pipeline.
 *
 * They follow the same ToolRegistry contract as every other built-in tool
 * (src/tools/types.ts) but return their payload as an *Artifact envelope*
 * (src/shared/artifact.ts) instead of plain text, so the renderer can preview
 * and re-use the result.
 *
 * - `sheet.read`:    parse a CSV or XLSX workbook into a sheet artifact
 *                    (columns + bounded rows + overview). Read-only: paths go
 *                    through authorizePath, sizes are capped (zip-bomb guard).
 * - `sheet.analyze`: column profiling (type / non-empty / unique / numeric
 *                    stats / top values) over inline data or the same file.
 *
 * Both are deterministic; the LLM only plans content, never structure.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { authorizePath, revalidateSymlinkGuard } from 'nexus-coder/dist/src/security/path-authorizer.js';
import type { ToolDef, ToolResult, ToolContext } from '../tools/types.js';
import { toArtifactContent, type Artifact } from '../shared/artifact.js';

export type { ToolDef as SheetToolDef, ToolResult as SheetToolResult, ToolContext as SheetToolContext };

// --- caps (zip-bomb / token-bomb guards) ---
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CELLS = 150_000;
const SAMPLE_ROWS = 50;

const err = (message: string, isError = true): ToolResult => ({
  content: JSON.stringify({ error: message }, null, 2),
  isError,
});

/** Build an artifact as a ToolResult; single-shot helpers for the skill. */
function artifactToResult(artifact: Artifact): ToolResult {
  return { content: toArtifactContent(artifact), isError: artifact.status === 'error' };
}

function failed(title: string, skill: string, message: string, isError = true): ToolResult {
  return artifactToResult({
    id: `sheet-${randomUUID().slice(0, 8)}`,
    type: 'sheet',
    title,
    version: 1,
    status: 'error',
    error: message,
    meta: { sessionId: '', skill, origin: 'main' },
    body: null,
  });
}

function sheetArtifact(title: string, skill: string, body: Record<string, unknown>): ToolResult {
  return artifactToResult({
    id: `sheet-${randomUUID().slice(0, 8)}`,
    type: 'sheet',
    title,
    version: 1,
    status: 'done',
    meta: { sessionId: '', skill, origin: 'main' },
    body,
  });
}

// --- path authorization (mirrors src/tools/filesystem.ts) ---
function denormalize(p: string): string {
  return normalize(isAbsolute(p) ? p : resolvePath(process.cwd(), p));
}

async function guardPath(relOrAbs: string): Promise<string | null> {
  const p = denormalize(relOrAbs);
  const authorized = await authorizePath(p);
  if (!authorized) return null;
  if (!revalidateSymlinkGuard(p)) return null;
  return p;
}

function coerceCell(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'boolean' || typeof cell === 'number') return cell;
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell === 'object') {
    const o = cell as Record<string, unknown>;
    const meta = o.result ?? o.text ?? o.hyperlink;
    if (meta !== undefined) return coerceCell(meta);
    return null;
  }
  const s = String(cell).trim();
  if (s === '') return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
}

// --- minimal RFC-4180-ish CSV parser (quotes + CRLF; no embedded newline fields) ---
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  const flush = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  const stripCr = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
    } else if (c === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      flush();
      i += 1;
    } else if (c === '\n') {
      flush();
      pushRow();
      i += 1;
    } else if (c === '\r') {
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field.length > 0 || row.length > 0) {
    flush();
    pushRow();
  }
  return rows.map((r) => r.map(stripCr));
}

function csvToGrid(text: string, hasHeader: boolean): { columns: string[]; rows: unknown[][] } {
  const raw = parseCsv(text);
  if (raw.length === 0) return { columns: [], rows: [] };
  const width = raw.reduce((w, r) => Math.max(w, r.length), 1);
  if (hasHeader && raw.length > 1) {
    const columns = raw[0].map((h, idx) => h.trim() || `col${idx + 1}`);
    const rows = raw.slice(1).map((r) => {
      const padded = [...r];
      while (padded.length < width) padded.push('');
      return padded.map(coerceCell);
    });
    return { columns, rows };
  }
  const columns = Array.from({ length: width }, (_, idx) => `col${idx + 1}`);
  const rows = raw.map((r) => {
    const padded = [...r];
    while (padded.length < width) padded.push('');
    return padded.map(coerceCell);
  });
  return { columns, rows };
}

async function readCsv(path: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const st = await stat(path);
  if (st.size > MAX_CSV_BYTES) throw new Error(`CSV exceeds ${Math.round(MAX_CSV_BYTES / 1024 / 1024)}MB cap`);
  const text = await readFile(path, 'utf8');
  return csvToGrid(text, true);
}

async function readXlsx(path: string, sheetName?: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const st = await stat(path);
  if (st.size > MAX_FILE_BYTES) throw new Error(`XLSX exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB cap`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = sheetName ? (wb.getWorksheet(sheetName) ?? wb.worksheets[0]) : wb.worksheets[0];
  if (!ws) throw new Error('Workbook has no worksheets');
  const values = ws.getSheetValues() as Array<Array<unknown> | undefined>;
  const rowCount = Math.min(ws.rowCount, MAX_ROWS + 1);
  const grid: unknown[][] = [];
  for (let r = 1; r <= rowCount; r += 1) {
    const src = values[r];
    if (!src) {
      grid.push([]);
      continue;
    }
    grid.push(Array.from({ length: Math.max(src.length - 1, 0) }, (_, idx) => coerceCell(src[idx + 1])));
  }
  const width = grid.reduce((w, r) => Math.max(w, r.length), 1);
  const pad = (r: unknown[]) => {
    while (r.length < width) r.push(null);
    return r;
  };
  if (grid.length > 1) {
    return {
      columns: grid[0].map((h, idx) => (h == null ? `col${idx + 1}` : String(h))).slice(0, width),
      rows: grid.slice(1).map(pad),
    };
  }
  return { columns: Array.from({ length: width }, (_, idx) => `col${idx + 1}`), rows: [] };
}

/** Read a sheet by path (authorized, capped) or inline `data`. */
async function loadGrid(
  args: Record<string, unknown>,
): Promise<{ columns: string[]; rows: unknown[][]; source: string }> {
  const data = args.data as { columns?: unknown; rows?: unknown } | undefined;
  if (data && Array.isArray(data.columns) && Array.isArray(data.rows)) {
    const columns = data.columns.map((c) => String(c));
    const rows = (data.rows as unknown[][]).slice(0, MAX_ROWS).map((r) => r.map(coerceCell));
    return { columns, rows, source: 'inline' };
  }
  const raw = typeof args.path === 'string' ? args.path.trim() : '';
  if (!raw) throw new Error('Provide `path` (or inline `data`)');
  const p = await guardPath(raw);
  if (!p) throw new Error(`Access denied by permissions system: ${raw}`);
  const st = await stat(p);
  if (!st.isFile()) throw new Error(`Not a file: ${raw}`);
  const sheetName = typeof args.sheet === 'string' ? args.sheet : undefined;
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const grid = ext === 'xlsx' || ext === 'xlsm' ? await readXlsx(p, sheetName) : await readCsv(p);
  return { ...grid, source: p };
}

// ---------------------------------------------------------------- stats
type CellType = 'number' | 'boolean' | 'date' | 'string';

function cellTypeOf(v: unknown): CellType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return 'date';
  return 'string';
}

function analyzeColumns(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  return columns.map((name, ci) => {
    const typeCounts = { number: 0, boolean: 0, date: 0, string: 0 };
    let nonEmpty = 0;
    let numSum = 0;
    let numMin = Infinity;
    let numMax = -Infinity;
    const valueCounts = new Map<string, number>();
    for (const r of rows) {
      const v = ci < r.length ? r[ci] : null;
      if (v === null || v === undefined || v === '') continue;
      nonEmpty += 1;
      const t = cellTypeOf(v);
      typeCounts[t] += 1;
      if (t === 'number') {
        const n = v as number;
        numSum += n;
        if (n < numMin) numMin = n;
        if (n > numMax) numMax = n;
      }
      const key = typeof v === 'string' ? v : String(v);
      valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
    }
    const top = [...valueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([value, count]) => ({ value, count }));
    const withNums = typeCounts.number > 0;
    const dominant: CellType = withNums
      ? 'number'
      : typeCounts.string > 0
        ? 'string'
        : typeCounts.boolean > 0
          ? 'boolean'
          : typeCounts.date > 0
            ? 'date'
            : 'string';
    const stats: Record<string, unknown> = {
      name,
      type: dominant,
      nonEmpty,
      unique: valueCounts.size,
      top,
    };
    if (withNums && nonEmpty > 0) {
      stats.min = numMin;
      stats.max = numMax;
      stats.sum = numSum;
      stats.avg = numSum / nonEmpty;
    }
    return stats;
  });
}

// ---------------------------------------------------------------- handlers
const SHEET_READ_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute or cwd-relative path to a .csv or .xlsx file' },
    sheet: { type: 'string', description: 'Worksheet name (xlsx only); defaults to the first sheet' },
    hasHeader: { type: 'boolean', description: 'Treat the first row as a header (default true)' },
  },
  required: ['path'],
} as const;

const SHEET_ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      description: 'Inline data ({ columns: string[], rows: unknown[][] }); mutually exclusive with path',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
      },
    },
    path: { type: 'string', description: 'Re-read a file instead of inline data' },
    sheet: { type: 'string' },
  },
} as const;

export const SHEET_TOOL_DEFS: ToolDef[] = [
  {
    name: 'sheet.read',
    description:
      'Parse a CSV or XLSX file into a structured table (columns + bounded rows + overview). ' +
      'Use this before asking for charts or analysis so the data is loaded once.',
    inputSchema: SHEET_READ_SCHEMA,
    server: 'sheet-internal',
  },
  {
    name: 'sheet.analyze',
    description:
      'Profile a table (from inline `data` or the same `path` as sheet.read): per-column type, ' +
      'non-empty count, unique count, numeric min/max/sum/avg and top values. Deterministic.',
    inputSchema: SHEET_ANALYZE_SCHEMA,
    server: 'sheet-internal',
  },
];

export const SHEET_TOOLS: Set<string> = new Set(SHEET_TOOL_DEFS.map((d) => d.name));

export async function callSheetTool(name: string, args: unknown, _ctx?: ToolContext): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === 'sheet.read') {
    const raw = typeof a.path === 'string' ? a.path.trim() : '';
    if (!raw) return failed('sheet.read', 'sheet.read', 'Provide a `path` to a CSV/XLSX file.');
    try {
      const { columns, rows, source } = await loadGrid({ path: raw, sheet: a.sheet });
      const capped = rows.slice(0, SAMPLE_ROWS);
      const overview = {
        rowCount: rows.length,
        colCount: columns.length,
        source,
        truncated: rows.length > SAMPLE_ROWS,
      };
      return sheetArtifact('Sheet read', 'sheet.read', { columns, rows: capped, ...overview });
    } catch (e) {
      return failed('sheet.read', 'sheet.read', e instanceof Error ? e.message : String(e));
    }
  }
  if (name === 'sheet.analyze') {
    try {
      const { columns, rows, source } = await loadGrid({ ...a });
      if (columns.length === 0) return failed('sheet.analyze', 'sheet.analyze', 'Table has no columns.');
      const analysis = analyzeColumns(columns, rows);
      const overview = { rowCount: rows.length, colCount: columns.length, source };
      return sheetArtifact('Sheet analysis', 'sheet.analyze', {
        ...overview,
        columns,
        analysis,
        rows: rows.slice(0, SAMPLE_ROWS),
      });
    } catch (e) {
      return failed('sheet.analyze', 'sheet.analyze', e instanceof Error ? e.message : String(e));
    }
  }
  return failed('sheet.read', 'sheet', `Unknown sheet skill "${name}"`);
}