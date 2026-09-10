/**
 * In-process `bi.chart` skill — Vega-Lite as the LLM's chart intermediate
 * representation (a.k.a. the WorkBuddy two-stage rule: the LLM plans a spec,
 * deterministic code validates + compiles it for the renderer).
 *
 * The LLM provides high-level `mark` + `encoding` (or convenience `x`/`y`
 * fields) plus inline `data`; this module whitelists the structure, then lets
 * vega-lite.compile() be the authoritative gate. The renderer consumes the
 * final compiled vega spec directly via vega-embed.
 */

import { randomUUID } from 'node:crypto';
import * as vegaLite from 'vega-lite';
import type { ToolDef, ToolResult, ToolContext } from '../tools/types.js';
import { toArtifactContent, type Artifact } from '../shared/artifact.js';

export type { ToolDef as ChartToolDef, ToolResult as ChartToolResult, ToolContext as ChartToolContext };

const MAX_CHART_ROWS = 5000;

const VL_SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json';

const ALLOWED_MARKS = new Set([
  'bar',
  'line',
  'point',
  'area',
  'circle',
  'square',
  'tick',
  'rect',
  'arc',
  'rule',
  'text',
  'image',
  'trail',
  'geoshape',
  'boxplot',
]);

const ALLOWED_ENC_CHANNELS = new Set(['x', 'y', 'color', 'size', 'shape', 'row', 'column', 'tooltip', 'opacity', 'theta', 'radius']);
const ALLOWED_ENC_KEYS = new Set([
  'field',
  'type',
  'aggregate',
  'title',
  'timeUnit',
  'stack',
  'sort',
  'scale',
  'bin',
]);
const ALLOWED_FIELD_TYPES = new Set(['quantitative', 'nominal', 'ordinal', 'temporal', 'geojson']);
const ALLOWED_AGGS = new Set(['sum', 'mean', 'avg', 'median', 'min', 'max', 'count', 'distinct']);
const ALLOWED_TOP_KEYS = new Set(['$schema', 'data', 'mark', 'encoding', 'title', 'width', 'height']);

const err = (message: string, isError = true): ToolResult => ({
  content: JSON.stringify({ error: message }, null, 2),
  isError,
});

function chartResult(artifact: Artifact): ToolResult {
  return { content: toArtifactContent(artifact), isError: artifact.status === 'error' };
}

function chartFailed(skill: string, message: string): ToolResult {
  return chartResult({
    id: `chart-${randomUUID().slice(0, 8)}`,
    type: 'chart',
    title: 'Chart',
    version: 1,
    status: 'error',
    error: message,
    meta: { sessionId: '', skill, origin: 'main' },
    body: null,
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Convert { columns, rows } into vega "values" objects, capped. */
function dataToValues(columns: string[], rows: unknown[][]): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  for (const r of rows.slice(0, MAX_CHART_ROWS)) {
    const obj: Record<string, unknown> = {};
    for (let ci = 0; ci < columns.length; ci += 1) {
      obj[columns[ci]] = ci < r.length ? r[ci] : null;
    }
    values.push(obj);
  }
  return values;
}

/** Structural whitelist — first line of defense before vega-lite.compile(). */
function validateSpecStructure(spec: unknown): string | null {
  if (!isRecord(spec)) return 'spec must be an object';
  for (const k of Object.keys(spec)) {
    if (!ALLOWED_TOP_KEYS.has(k)) return `untracked top-level key "${k}"`;
  }
  const data = spec.data;
  if (!isRecord(data) || !Array.isArray(data.values) || !isRecord(data.values[0] ?? {}))
    return 'data.values must be a non-empty array of objects';
  if (data.values.length > MAX_CHART_ROWS)
    return `data exceeds ${MAX_CHART_ROWS} rows; pass a filtered/sampled subset`;
  const mark = spec.mark;
  if (typeof mark !== 'string' || !ALLOWED_MARKS.has(mark))
    return `mark must be one of: ${[...ALLOWED_MARKS].join(', ')}`;
  const enc = spec.encoding;
  if (!isRecord(enc) || Object.keys(enc).length === 0) return 'encoding must be a non-empty object';
  for (const [channel, cdef] of Object.entries(enc)) {
    if (!ALLOWED_ENC_CHANNELS.has(channel)) return `untracked encoding channel "${channel}"`;
    if (!isRecord(cdef)) return `encoding.${channel} must be an object`;
    for (const k of Object.keys(cdef)) {
      if (!ALLOWED_ENC_KEYS.has(k)) return `encoding.${channel} has untracked key "${k}"`;
    }
    if (cdef.field !== undefined && typeof cdef.field !== 'string')
      return `encoding.${channel}.field must be a string`;
    if (cdef.type !== undefined && typeof cdef.type !== 'string')
      return `encoding.${channel}.type must be a string`;
    if (cdef.type !== undefined && !ALLOWED_FIELD_TYPES.has(cdef.type as string))
      return `encoding.${channel}.type must be one of: ${[...ALLOWED_FIELD_TYPES].join(', ')}`;
    if (cdef.aggregate !== undefined && !ALLOWED_AGGS.has(cdef.aggregate as string))
      return `encoding.${channel}.aggregate must be one of: ${[...ALLOWED_AGGS].join(', ')}`;
  }
  return null;
}

function inferFieldType(rows: unknown[][], colIdx: number): 'quantitative' | 'nominal' {
  if (rows.length === 0) return 'nominal';
  const sample = rows.slice(0, 40).map((r) => r[colIdx]).filter((v) => v !== null && v !== '');
  if (sample.length === 0) return 'nominal';
  return sample.every((v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v as string)))
    ? 'quantitative'
    : 'nominal';
}

const CHART_SCHEMA = {
  type: 'object',
  properties: {
    data: {
      type: 'object',
      description: 'Inline data as { columns: string[], rows: unknown[][] }',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
      },
      required: ['columns', 'rows'],
    },
    mark: {
      type: 'string',
      description: 'Vega-Lite mark (bar, line, point, area, …). Defaults to bar.',
    },
    x: { type: 'string', description: 'Field name for the x channel (convenience form)' },
    y: { type: 'string', description: 'Field name for the y channel (convenience form)' },
    aggregate: {
      type: 'string',
      description: 'Aggregation for y when x/y convenience form is used (sum, mean, count, …)',
    },
    encoding: {
      type: 'object',
      description:
        'Full Vega-Lite encoding object, e.g. { x: { field: "month", type: "nominal" }, y: { field: "sales", type: "quantitative", aggregate: "sum" } }',
    },
    title: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  required: ['data'],
} as const;

export const CHART_TOOL_DEFS: ToolDef[] = [
  {
    name: 'bi.chart',
    description:
      'Render a chart from tabular data. Pass inline `data` ({ columns, rows }) plus either a ' +
      'full Vega-Lite `encoding` or convenience `x`/`y` field names with an optional `aggregate`. ' +
      'Defaults to a bar chart. The result is a previewable chart artifact.',
    inputSchema: CHART_SCHEMA,
    server: 'chart-internal',
  },
];

export const CHART_TOOLS: Set<string> = new Set(CHART_TOOL_DEFS.map((d) => d.name));

export async function callChartTool(name: string, args: unknown, _ctx?: ToolContext): Promise<ToolResult> {
  if (name !== 'bi.chart') return chartFailed(name, `Unknown chart skill "${name}"`);
  const a = (args ?? {}) as Record<string, unknown>;
  const data = a.data as { columns?: unknown; rows?: unknown } | undefined;
  if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    return chartFailed('bi.chart', 'Provide `data` as { columns: string[], rows: unknown[][] }');
  }
  const columns = data.columns.map((c) => String(c));
  const rows = data.rows as unknown[][];
  if (columns.length === 0) return chartFailed('bi.chart', 'data.columns must not be empty');
  const values = dataToValues(columns, rows);

  let encoding: Record<string, unknown>;
  if (isRecord(a.encoding)) {
    encoding = a.encoding as Record<string, unknown>;
  } else {
    // Convenience form: derive a single-axis encoding from x / y.
    if (typeof a.x !== 'string' && typeof a.y !== 'string') {
      return chartFailed('bi.chart', 'Provide either `encoding` or at least one of `x`/`y`');
    }
    encoding = {};
    if (typeof a.x === 'string') {
      const xi = columns.indexOf(a.x);
      encoding.x = {
        field: a.x,
        type: xi >= 0 ? inferFieldType(rows, xi) : 'nominal',
      };
    }
    if (typeof a.y === 'string') {
      const yi = columns.indexOf(a.y);
      encoding.y = {
        field: a.y,
        type: yi >= 0 ? inferFieldType(rows, yi) : 'quantitative',
        ...(a.aggregate !== undefined ? { aggregate: a.aggregate } : {}),
      };
    }
  }

  const mark = typeof a.mark === 'string' ? a.mark : 'bar';
  const spec: Record<string, unknown> = {
    $schema: VL_SCHEMA,
    data: { name: 'table', values: values as unknown },
    mark,
    encoding,
  };
  if (a.title !== undefined) spec.title = a.title;
  if (typeof a.width === 'number') spec.width = a.width;
  if (typeof a.height === 'number') spec.height = a.height;

  const structuralError = validateSpecStructure(spec);
  if (structuralError) return chartFailed('bi.chart', `Invalid chart spec: ${structuralError}`);

  let compiled: unknown;
  try {
    const result = vegaLite.compile(spec as never);
    // vega-lite v5 compile() returns { spec, normalized }; we keep the compiled
    // Vega spec, which vega-embed consumes directly.
    compiled = (result as { spec?: unknown }).spec ?? result;
  } catch (e) {
    return chartFailed('bi.chart', `Vega-Lite rejected the spec: ${e instanceof Error ? e.message : String(e)}`);
  }

  return chartResult({
    id: `chart-${randomUUID().slice(0, 8)}`,
    type: 'chart',
    title: typeof a.title === 'string' && a.title ? a.title : 'Chart',
    version: 1,
    status: 'done',
    meta: { sessionId: '', skill: 'bi.chart', origin: 'main' },
    body: { spec: compiled, mark, columns },
  });
}