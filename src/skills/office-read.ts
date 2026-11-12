/**
 * T7 office read family — docx.read / office.read.
 *
 * These tools read EXISTING Office-format files into plain text. When the
 * `doc-extract` native package is not installed (or its extractor did not
 * register), each tool returns a `needs_package` error code with actionable
 * install instructions instead of silently failing.
 *
 * The native package lives at `~/.nexus/native/extractors/doc-extract/`
 * (entry `index.mjs`) and registers `pdf` / `docx` / `xlsx` / `pptx`
 * extractors into the core's RAG extractor registry
 * (nexus-coder/src/vault/extract/registry.ts). The agent worker loads
 * installed extractor packages at startup (`src/agent/extractor-loader.ts`,
 * idempotent + cross-registry sync), so the read path needs zero new
 * dependencies and no shell/python detour — which is exactly the gap the
 * unattended automation gate makes unbridgeable (Gate E blocks inline
 * interpreters, Gate D blocks the script-file escape in non-git projects).
 *
 * Both tools are read-only and path-guarded (authorizePath + symlink
 * revalidation, same contract as sheet.read / office-write).
 */
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, normalize, resolve as resolvePath } from 'node:path';
import { authorizePath, revalidateSymlinkGuard } from 'nexus-coder/dist/src/security/path-authorizer.js';
import { extractForRag, hasExtractor } from 'nexus-coder/dist/src/vault/extract/registry.js';
import { loadExtractorPackages } from '../agent/extractor-loader.js';
import type { ToolDef, ToolResult, ToolContext } from '../tools/types.js';

// ── constants ──────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_MAX_CHARS = 200_000;

/** Extensions the doc-extract extractor package covers. */
const SUPPORTED_EXTS = ['docx', 'xlsx', 'pptx', 'pdf'];

// ── error / package-missing results ────────────────────────────────────────

function needsPackageResult(toolName: string): ToolResult {
  return {
    content: JSON.stringify(
      {
        code: 'needs_package',
        install: 'doc-extract',
        tool: toolName,
        message:
          'The doc-extract native package is not installed (or its extractors are not active). ' +
          'Install it via: Settings → Native Packages → doc-extract (one-click), ' +
          'or CLI: `nexus config tools native install doc-extract`. ' +
          'After installing, this tool will work without restarting a new session.',
      },
      null,
      2,
    ),
    isError: true,
  };
}

function jsonError(message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: JSON.stringify({ error: message, ...extra }, null, 2), isError: true };
}

// ── extractor activation ───────────────────────────────────────────────────

/**
 * Ensure installed extractor packages are registered in THIS process's
 * extractor registry. `loadExtractorPackages` is idempotent (the registry is
 * process-global), so calling it per first-use is cheap and covers workers
 * that reached this tool before their startup pass (e.g. earlyInit fast
 * path followed straight by an automation chat).
 */
let extractorsEnsured = false;
async function ensureExtractors(): Promise<void> {
  if (extractorsEnsured) return;
  extractorsEnsured = true;
  try {
    await loadExtractorPackages();
  } catch {
    /* fall through: hasExtractor() below reports the real state */
  }
}

// ── path guard (mirrors sheet.read / office-write) ────────────────────────

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

// ── extraction core ────────────────────────────────────────────────────────

interface ExtractOpts {
  /** Restrict to these extensions; anything else is an error with a hint. */
  allowedExts: string[];
  /** Hint shown when the extension is not supported. */
  hint: string;
}

async function extractDocument(
  toolName: string,
  args: unknown,
  opts: ExtractOpts,
): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>;
  const raw = typeof a.path === 'string' ? a.path.trim() : '';
  if (!raw) return jsonError(`Provide a 'path' to a file (${opts.allowedExts.join(', ')}).`);

  let p: string | null;
  try {
    p = await guardPath(raw);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e));
  }
  if (!p) return jsonError(`Access denied by permissions system: ${raw}`);

  const ext = extname(p).toLowerCase().replace(/^\./, '');
  if (!opts.allowedExts.includes(ext)) {
    return jsonError(`Unsupported format "${ext}" for ${toolName}.`, { hint: opts.hint });
  }

  let st: import('node:fs').Stats;
  try {
    st = await stat(p);
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), { path: raw });
  }
  if (!st.isFile()) return jsonError(`Not a file: ${raw}`, { path: raw });
  if (st.size > MAX_FILE_BYTES) {
    return jsonError(`File exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB cap`, { path: raw });
  }

  await ensureExtractors();
  if (!hasExtractor(ext)) return needsPackageResult(toolName);

  const out = await extractForRag(p);
  if (!out.ok) {
    if (out.reason === 'unsupported') return needsPackageResult(toolName);
    if (out.reason === 'empty') {
      return jsonError(`No extractable text in ${raw}`, { path: raw, format: ext });
    }
    return jsonError(`Extraction failed: ${out.message ?? out.reason}`, { path: raw });
  }

  const maxChars = Math.min(
    MAX_MAX_CHARS,
    Math.max(1000, Number.isFinite(Number(a.maxChars)) ? Number(a.maxChars) : DEFAULT_MAX_CHARS),
  );
  const truncated = out.text.length > maxChars;
  const text = truncated ? out.text.slice(0, maxChars) : out.text;
  return {
    content:
      `Extracted ${ext} from ${raw} (${out.text.length} chars` +
      `${truncated ? `, truncated to ${maxChars}` : ''}; format: ${out.format})\n\n${text}`,
  };
}

// ── schemas ────────────────────────────────────────────────────────────────

const DOCX_READ_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute or cwd-relative path to a .docx file' },
    maxChars: {
      type: 'number',
      description: `Maximum characters of extracted text to return (default ${DEFAULT_MAX_CHARS}, minimum 1000, capped at ${MAX_MAX_CHARS})`,
    },
  },
  required: ['path'],
} as const;

const OFFICE_READ_SCHEMA = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute or cwd-relative path to a .pdf, .pptx, .docx or .xlsx file',
    },
    maxChars: {
      type: 'number',
      description: `Maximum characters of extracted text to return (default ${DEFAULT_MAX_CHARS}, minimum 1000, capped at ${MAX_MAX_CHARS})`,
    },
  },
  required: ['path'],
} as const;

// ── tool defs ──────────────────────────────────────────────────────────────

export const OFFICE_READ_TOOL_DEFS: ToolDef[] = [
  {
    name: 'docx.read',
    description:
      'Extract plain text from an existing .docx Word document (paragraphs, in document order). ' +
      'Use this to READ Word documents: read_text_file cannot parse .docx (it is a zip of XML), ' +
      'and no shell or python is needed when the doc-extract native package is installed ' +
      '(Settings → Native Packages). Prefer sheet.read for structured .xlsx tables.',
    inputSchema: DOCX_READ_SCHEMA,
    server: 'office-read',
  },
  {
    name: 'office.read',
    description:
      'Extract plain text from an Office/PDF file (.pdf, .pptx, .docx, .xlsx as tab-separated text). ' +
      'Read-only; no shell needed when the doc-extract native package is installed. ' +
      'Prefer sheet.read for structured .xlsx analysis (columns, row bounds, stats).',
    inputSchema: OFFICE_READ_SCHEMA,
    server: 'office-read',
  },
];

export const OFFICE_READ_TOOLS: Set<string> = new Set(OFFICE_READ_TOOL_DEFS.map((d) => d.name));

// ── dispatch ───────────────────────────────────────────────────────────────

export async function callOfficeReadTool(
  name: string,
  args: unknown,
  _ctx?: ToolContext,
): Promise<ToolResult> {
  if (name === 'docx.read') {
    return extractDocument('docx.read', args, {
      allowedExts: ['docx'],
      hint:
        'docx.read handles .docx only. Use office.read for .pdf/.pptx/.xlsx, sheet.read for tabular .xlsx, ' +
        'or read_text_file for .md/.txt.',
    });
  }
  if (name === 'office.read') {
    return extractDocument('office.read', args, {
      allowedExts: SUPPORTED_EXTS,
      hint:
        'office.read handles .pdf/.pptx/.docx/.xlsx. For structured .xlsx analysis use sheet.read; ' +
        'for plain .md/.txt use read_text_file.',
    });
  }
  return jsonError(`Unknown office-read tool "${name}"`);
}
