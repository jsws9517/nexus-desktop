/**
 * T7 office write family — docx.write / pptx.write / pdf.write.
 *
 * These tools write Office-format files. When the `office-write` native
 * package is not installed, each tool returns a `needs_package` error code
 * with actionable install instructions instead of silently failing.
 *
 * The native package lives at `~/.nexus/native/extractors/office-write/`
 * (entry `index.mjs`) and is registered in `nexus-coder/src/config/native.ts` CATALOG.
 *
 * Zero new npm dependencies: all office formats go through the native
 * package (which bundles PptxGenJS / docx / pdfkit as its own deps,
 * not the desktop's).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { authorizePath } from 'nexus-coder/dist/src/security/path-authorizer.js';
import { revalidateSymlinkGuard } from 'nexus-coder/dist/src/security/path-authorizer.js';
import type { ToolDef, ToolResult, ToolContext } from '../tools/types.js';
import { toArtifactContent, type Artifact } from '../shared/artifact.js';

// ── constants ──────────────────────────────────────────────────────────────

/**
 * Path to the native office-write package directory.
 *
 * The core's CATALOG entry (`office-write` in nexus-coder/src/config/native.ts)
 * installs the package into `~/.nexus/native/extractors/office-write/` with
 * entry file `index.mjs` (the same layout as `doc-extract`).
 */
function officeWriteEntry(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.nexus', 'native', 'extractors', 'office-write', 'index.mjs');
}

function isOfficeWriteInstalled(): boolean {
  return existsSync(officeWriteEntry());
}

function needsPackageResult(toolName: string): ToolResult {
  return {
    content: JSON.stringify(
      {
        code: 'needs_package',
        install: 'office-write',
        tool: toolName,
        message:
          'The office-write native package is not installed. ' +
          'Install it via: Settings → Native Packages → office-write (one-click), ' +
          'or CLI: `nexus config tools native install office-write`. ' +
          'After installing, this tool will work without restarting.',
      },
      null,
      2,
    ),
    isError: true,
  };
}

function officeArtifact(
  type: 'docx' | 'ppt' | 'pdf' | 'image',
  title: string,
  skill: string,
  body: Record<string, unknown>,
  outputPath?: string,
): ToolResult {
  const artifact: Artifact = {
    id: `office-${randomUUID().slice(0, 8)}`,
    type,
    title,
    version: 1,
    status: outputPath ? 'done' : 'draft',
    meta: { sessionId: '', skill, origin: 'main' },
    body,
  };
  if (outputPath) {
    artifact.refs = [{ kind: 'file', path: outputPath }];
  }
  return { content: toArtifactContent(artifact), isError: !outputPath && body.error ? true : undefined };
}

// ── lazy office-write package loader ──────────────────────────────────────

interface OfficeWriteModule {
  writeDocx(input: unknown, outPath: string): Promise<void>;
  writePptx(input: unknown, outPath: string): Promise<void>;
  writePdf(input: unknown, outPath: string): Promise<void>;
}

let officeWritePromise: Promise<OfficeWriteModule> | null = null;
async function loadOfficeWrite(): Promise<OfficeWriteModule> {
  if (!officeWritePromise) {
    officeWritePromise = (async () => {
      const entry = officeWriteEntry();
      if (!existsSync(entry)) {
        throw new Error('office-write package entry not found at ' + entry);
      }
      // Dynamic import needs a file:// URL — on Windows a raw
      // `C:\...` path is rejected by the ESM loader ("Only URLs with a
      // scheme in: file, data, and node are supported").
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod;
    })();
  }
  return officeWritePromise;
}

// ── path guard ─────────────────────────────────────────────────────────────

async function guardOutputPath(raw: string): Promise<string | null> {
  const { isAbsolute, resolve: resolvePath } = await import('node:path');
  const p = isAbsolute(raw) ? raw : resolvePath(process.cwd(), raw);
  const authorized = await authorizePath(p);
  if (!authorized) return null;
  if (!revalidateSymlinkGuard(p)) return null;
  return p;
}

// ── schemas ────────────────────────────────────────────────────────────────

const DOCX_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Output .docx file path' },
    content: {
      type: 'object',
      description:
        'Document content. PREFERRED for structured reports: `blocks` — an ordered array of ' +
        '{ type:"heading", text, level } | { type:"paragraph", text } | { type:"table", columns: string[], rows: string[][] } ' +
        'that interleave in document order (one call, no temp code, no exec). ' +
        'Legacy flat shape also accepted: { title?, paragraphs?: string[], headings?: { text, level }[], tables?: { columns, rows }[] }.',
      properties: {
        title: { type: 'string' },
        paragraphs: { type: 'array', items: { type: 'string' } },
        headings: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, level: { type: 'number' } },
            required: ['text'],
          },
        },
        tables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              columns: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array' } },
            },
          },
        },
        blocks: {
          type: 'array',
          description:
            'Ordered document blocks (preferred for reports). Each: { type:"heading", text, level } | { type:"paragraph", text } | { type:"table", columns: string[], rows: string[][] }.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'paragraph', 'table'] },
              text: { type: 'string' },
              level: { type: 'number' },
              columns: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
  },
  required: ['path', 'content'],
} as const;

const PPTX_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Output .pptx file path' },
    slides: {
      type: 'array',
      description:
        'Slide definitions: [{ title?, bullets?: string[], notes? }]. First slide is the title slide.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
      },
      minItems: 1,
    },
  },
  required: ['path', 'slides'],
} as const;

const PDF_WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Output .pdf file path' },
    content: {
      type: 'object',
      description:
        'PDF content: { title?, text?: string, markdown?: string, pages?: number }',
      properties: {
        title: { type: 'string' },
        text: { type: 'string' },
        markdown: { type: 'string' },
        pages: { type: 'number' },
      },
      required: ['text'],
    },
  },
  required: ['path', 'content'],
} as const;

// ── tool defs ──────────────────────────────────────────────────────────────

export const OFFICE_WRITE_TOOL_DEFS: ToolDef[] = [
  {
    name: 'docx.write',
    description:
      'Write a structured .docx in ONE deterministic call — title, headings, paragraphs, tables, and ordered `blocks` ' +
      '(interleaved heading/paragraph/table in document order). PREFER this over spawn_office for a single .docx ' +
      'report: it is fast, has no temp code, and no exec/verify loop. Requires the office-write native package ' +
      '(Settings → Native Packages). Returns a docx artifact with the written file path for preview.',
    inputSchema: DOCX_WRITE_SCHEMA,
    server: 'office-write',
  },
  {
    name: 'pptx.write',
    description:
      'Write a .pptx presentation (title slide + content slides with bullets) to a file. ' +
      'Requires the office-write native package. ' +
      'Returns a ppt artifact with the written file path for preview.',
    inputSchema: PPTX_WRITE_SCHEMA,
    server: 'office-write',
  },
  {
    name: 'pdf.write',
    description:
      'Write a .pdf document (title + text) to a file. ' +
      'Requires the office-write native package. ' +
      'Returns an image/pdf artifact with the written file path for preview.',
    inputSchema: PDF_WRITE_SCHEMA,
    server: 'office-write',
  },
];

export const OFFICE_WRITE_TOOLS: Set<string> = new Set(OFFICE_WRITE_TOOL_DEFS.map((d) => d.name));

// ── dispatch ───────────────────────────────────────────────────────────────

export async function callOfficeWriteTool(
  name: string,
  args: unknown,
  _ctx?: ToolContext,
): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>;

  // Gate: check package availability first for all three tools.
  if (!isOfficeWriteInstalled()) {
    return needsPackageResult(name);
  }

  let output: string;
  try {
    const rawPath = typeof a.path === 'string' ? a.path.trim() : '';
    if (!rawPath) return officeArtifact(name.includes('docx') ? 'docx' : 'ppt', 'Office write', name, { error: 'No output path provided' });
    const p = await guardOutputPath(rawPath);
    if (!p) return officeArtifact('docx', 'Office write', name, { error: `Access denied: ${rawPath}` });
    output = p;
  } catch (e) {
    return officeArtifact('docx', 'Office write', name, { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    const mod = await loadOfficeWrite();
    if (name === 'docx.write') {
      await mod.writeDocx(a.content, output);
      return officeArtifact('docx', 'Document written', 'docx.write', { path: output, content: a.content }, output);
    }
    if (name === 'pptx.write') {
      const slides = Array.isArray(a.slides) ? a.slides : [];
      await mod.writePptx(slides, output);
      return officeArtifact('ppt', 'Presentation written', 'pptx.write', { path: output, slideCount: slides.length, slides }, output);
    }
    if (name === 'pdf.write') {
      await mod.writePdf(a.content, output);
      return officeArtifact('pdf', 'PDF written', 'pdf.write', { path: output, content: a.content }, output);
    }
    return officeArtifact('docx', 'Unknown tool', name, { error: `Unknown office-write tool "${name}"` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return officeArtifact('docx', 'Office write failed', name, { error: msg, path: output });
  }
}
