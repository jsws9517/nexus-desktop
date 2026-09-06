/**
 * Built-in (in-process) filesystem tools served from the worker.
 *
 * The external @modelcontextprotocol/server-filesystem MCP is disabled
 * (autoStart=false) on desktop; its valuable non-overlapping capabilities are
 * re-provided here with zero npx cold-start and the same authorization surface
 * as the core's builtin file tools:
 *
 *   - read_media_file           (read an image/media file → Markdown data-URI)
 *   - list_directory_with_sizes (1-level listing with recursive dir sizes)
 *   - list_allowed_directories  (canonical access roots / sandbox introspection)
 *
 * Every path argument goes through `authorizePath()` (path-authorizer), the
 * same interactive Allow/Deny gate the builtin file tools use, plus a
 * synchronous symlink-escape guard immediately before each fs call.
 */

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, normalize, resolve as resolvePath } from 'node:path';
import { authorizePath, getAuthorizedRoots, getSandboxRoots, revalidateSymlinkGuard } from 'nexus-coder/dist/src/security/path-authorizer.js';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;
const MAX_DEPTH = 3;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server?: string;
}

export interface FsToolResult {
  content: string;
  isError?: boolean;
}

export interface FsToolContext {
  /** Reads the live config (~/.nexus/config.json view); shape is duck-typed. */
  getConfig?: () => Record<string, unknown> | undefined;
}

function denormalize(p: string, cwd: string): string {
  return normalize(isAbsolute(p) ? p : resolvePath(cwd, p));
}

/** Authorize + symlink-guard a path; returns a normalized absolute path or null. */
async function guardPath(relOrAbs: string): Promise<string | null> {
  const p = denormalize(relOrAbs, process.cwd());
  const authorized = await authorizePath(p);
  if (!authorized) return null;
  if (!revalidateSymlinkGuard(p)) return null;
  return p;
}

const denied = (p: string): FsToolResult => ({
  content: `Access to this path has been denied by your permissions system: ${p}`,
  isError: true,
});

/** Verify file content actually matches a supported image format (magic bytes), not just its extension. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const gif = buf.subarray(0, 6).toString('ascii');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a))) return 'image/tiff';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis' || brand === 'AVIF' || brand === 'AVIS') return 'image/avif';
  }
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

// ---------------------------------------------------------------- media read

async function readMediaFile(args: Record<string, unknown>): Promise<FsToolResult> {
  const raw = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!raw) return { content: 'Provide a `path` to a media file.', isError: true };
  const p = await guardPath(raw);
  if (!p) return denied(raw);
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return {
      content: `Unsupported media type (.${ext || 'unknown'}). Supported: ${Object.keys(MIME_BY_EXT).join(', ')}.`,
      isError: true,
    };
  }
  let buf: Buffer;
  try {
    const { stat } = await import('node:fs/promises');
    const st = await stat(p);
    if (!st.isFile()) return { content: `Not a file: ${p}`, isError: true };
    if (st.size > MAX_MEDIA_BYTES) {
      return { content: `File too large for inline embedding (${st.size} bytes; cap ${MAX_MEDIA_BYTES}).`, isError: true };
    }
    buf = await readFile(p);
  } catch (e) {
    return { content: `Failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  const sniffed = sniffImageMime(buf);
  if (!sniffed) {
    return { content: `File "${basename(p)}" does not match a supported image format (extension says ${ext} but the content is not a known image).`, isError: true };
  }
  if (sniffed !== mime) {
    return { content: `MIME mismatch for "${basename(p)}": extension suggests ${ext} but the file content is ${sniffed}.`, isError: true };
  }
  const dataUri = `data:${sniffed};base64,${buf.toString('base64')}`;
  return { content: `![${basename(p)}](${dataUri})` };
}

// ------------------------------------------------------ directory with sizes

interface ListEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

async function recursiveSize(dir: string, budget: { n: number; truncated: boolean }, levels: number): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.n >= MAX_LIST_ENTRIES) {
      budget.truncated = true;
      break;
    }
    budget.n++;
    const full = resolvePath(dir, e.name);
    if (e.isDirectory()) {
      // Descend only while levels remain (maxDepth semantics). At level 1 the
      // immediate children of `dir` are still counted for size (the listing
      // level is the "1-level" case), but their own subdirs are not expanded.
      if (levels > 1) total += await recursiveSize(full, budget, levels - 1);
    } else if (e.isFile()) {
      try {
        const { stat } = await import('node:fs/promises');
        total += (await stat(full)).size;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return total;
}

async function listDirectoryWithSizes(args: Record<string, unknown>): Promise<FsToolResult> {
  const raw = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!raw) return { content: 'Provide a `path` to a directory.', isError: true };
  const rawDepth = Number(args?.maxDepth ?? 1);
  const maxDepth = Number.isFinite(rawDepth) ? Math.max(1, Math.min(Math.trunc(rawDepth), MAX_DEPTH)) : 1;
  const p = await guardPath(raw);
  if (!p) return denied(raw);
  let entries: import('node:fs').Dirent[];
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(p, { withFileTypes: true });
  } catch (e) {
    return { content: `Failed to list ${p}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  const out: ListEntry[] = [];
  const budget = { n: 0, truncated: false };
  for (const e of entries) {
    if (budget.n >= MAX_LIST_ENTRIES) {
      budget.truncated = true;
      break;
    }
    budget.n++;
    const full = resolvePath(p, e.name);
    if (e.isDirectory()) {
      const size = await recursiveSize(full, budget, maxDepth);
      out.push({ name: e.name, type: 'directory', size });
    } else if (e.isFile()) {
      let size = 0;
      try {
        const { stat } = await import('node:fs/promises');
        size = (await stat(full)).size;
      } catch { /* size 0 on stat failure */ }
      out.push({ name: e.name, type: 'file', size });
    }
  }
  const payload = { path: p, maxDepth, entries: out, truncated: budget.truncated };
  return { content: JSON.stringify(payload, null, 2) };
}
// ------------------------------------------------------ allowed directories

function listAllowedDirectories(ctx?: FsToolContext): FsToolResult {
  const cfg = ctx?.getConfig?.();
  const allowedRoots = (cfg as { acp?: { allowedRoots?: string[] } })?.acp?.allowedRoots ?? [];
  const fsServerArgs = (cfg as { mcpServers?: Record<string, { args?: string[] }> })?.mcpServers?.filesystem?.args ?? [];
  const configured: string[] = [];
  const seen = new Set<string>();
  const push = (p?: string) => {
    if (!p || typeof p !== 'string' || !p.trim()) return;
    const norm = normalize(p.trim());
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      configured.push(norm);
    }
  };
  allowedRoots.forEach(push);
  fsServerArgs
    .map((a) => a.trim())
    .filter((a) => /^[A-Za-z]:[\\/]/.test(a) || a.startsWith('\\') || a.startsWith('/'))
    .forEach(push);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const sandboxActive = (getSandboxRoots() ?? []).length > 0;
  const payload = {
    cwd: process.cwd(),
    dataDir: home ? normalize(`${home}\\.nexus`) : null,
    sandboxActive,
    // Explicitly configured roots (acp.allowedRoots + legacy filesystem-MCP
    // dirs). They are the config intent; this desktop worker is not an ACP
    // server and never activates setSandboxRoots, so they are informational —
    // actual enforcement comes from the path-authorizer's effective roots.
    configuredRoots: [...new Set(configured)],
    // Persisted user grants from ~/.nexus/path-auth.json ("always" answers).
    // Project dir (cwd) is always allowed without a grant; anything outside it
    // requires a grant or an explicit Allow/Deny prompt for THIS call.
    grantedRoots: getAuthorizedRoots(),
    note: sandboxActive
      ? 'Path sandbox active: file access is confined to cwd + the nexus data dir + the configured roots; out-of-sandbox paths raise an Allow/Deny card.'
      : 'No path sandbox active: cwd (project dir) is always allowed; any other path needs a persisted grant or an Allow/Deny prompt for the call.',
  };
  return { content: JSON.stringify(payload, null, 2) };
}

// ----------------------------------------------------------------- dispatch

export function callFsTool(
  name: string,
  args: unknown,
  ctx?: FsToolContext,
): Promise<FsToolResult> | FsToolResult {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'read_media_file':
      return readMediaFile(a);
    case 'list_directory_with_sizes':
      return listDirectoryWithSizes(a);
    case 'list_allowed_directories':
      return listAllowedDirectories(ctx);
    default:
      return { content: `Tool "${name}" not found`, isError: true };
  }
}

export const FILESYSTEM_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'read_media_file',
    description:
      'Read an image or media file (png/jpg/gif/webp/bmp/ico/tiff/avif/svg) and return it as an inline Markdown data-URI so it renders in the chat. Path is authorized like other file tools (out-of-sandbox paths raise an Allow/Deny prompt).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path (or cwd-relative) to the media file' } },
      required: ['path'],
    },
    server: 'filesystem-internal',
  },
  {
    name: 'list_directory_with_sizes',
    description:
      'List the entries of a directory with per-entry size in bytes (directories show the recursive total size of all descendants). Returns JSON: { path, maxDepth, entries: [{name,type,size}], truncated }. maxDepth controls how many directory levels are expanded (default 1, max 3).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path (or cwd-relative) of the directory' },
        maxDepth: { type: 'number', description: 'How deep to expand directory entries (default 1, max 3)' },
      },
      required: ['path'],
    },
    server: 'filesystem-internal',
  },
  {
    name: 'list_allowed_directories',
    description:
      'Report the current file-access boundary as JSON: cwd (project dir, always allowed), dataDir, sandboxActive, configuredRoots (from acp.allowedRoots + legacy filesystem-MCP dirs — informational on desktop), grantedRoots (persisted user grants) and a note. No arguments. Use this to learn which paths are authorized before writing files elsewhere.',
    inputSchema: { type: 'object', properties: {} },
    server: 'filesystem-internal',
  },
];

export const FILESYSTEM_TOOLS: Set<string> = new Set(FILESYSTEM_TOOL_DEFS.map((t) => t.name));