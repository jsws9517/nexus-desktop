/**
 * File-reference artifacts — regular attachments and produced deliverables that
 * live on disk rather than in a skill's structured body.
 *
 * The Artifact protocol (src/shared/artifact.ts) originally only covered tool
 * results that a skill explicitly wrapped in an envelope (`docx.write`,
 * `bi.chart`, …). Anything else — a file the user attached with `+`, a `.docx`
 * a `spawn_office` sub-agent wrote, an image from `generate_image` — stayed
 * invisible to "My Artifacts" even though the file was right there.
 *
 * These helpers turn a path into the SAME envelope shape, so the existing
 * index/export/preview chain keeps working with zero protocol changes:
 *
 *   message content ──extract──▶ absolute paths ──envelope──▶ ArtifactListItem
 *
 * Everything here is pure and dependency-free so both the main process and the
 * renderer bundles can import it.
 */

import { toArtifactContent, type Artifact, type ArtifactType } from './artifact.js';

/** Extension → artifact type for deliverable formats we know how to label. */
const TYPE_BY_EXT: Record<string, ArtifactType> = {
  docx: 'docx',
  pptx: 'ppt',
  pdf: 'pdf',
  xlsx: 'sheet',
  xls: 'sheet',
  csv: 'csv',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
};

/**
 * Extensions distinctive enough to prefilter tool/assistant rows in SQL before
 * parsing them in JS. Deliberately excludes `.md`/`.ts`/… because those tokens
 * appear in ordinary prose and would turn the prefilter into a full scan of
 * every message body.
 */
export const FILE_ARTIFACT_SQL_EXTENSIONS = [
  '.docx', '.pptx', '.pdf', '.xlsx', '.xls', '.csv', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
] as const;

/** One message should never contribute more than this many file artifacts. */
export const MAX_FILE_REFS_PER_MESSAGE = 50;

/** Stride used to encode (messageId, pathIndex) into a single negative id. */
export const FILE_ITEM_STRIDE = 100;

export function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function extensionOf(path: string): string {
  const base = baseNameOf(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

/** Absolute Windows drive / UNC / POSIX path. Relative paths are ignored: the
 *  index has no session cwd to resolve them against. */
export function isAbsoluteFilePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/');
}

export function artifactTypeForPath(path: string): ArtifactType {
  return TYPE_BY_EXT[extensionOf(path)] ?? 'file';
}

/** True for formats we can label with a concrete artifact type. */
export function isDeliverablePath(path: string): boolean {
  return TYPE_BY_EXT[extensionOf(path)] !== undefined;
}

/** FNV-1a: stable, short, dependency-free id for a path. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic artifact id so re-registering the same file never duplicates. */
export function fileArtifactId(path: string): string {
  return `file-${hash32(path.trim().toLowerCase())}`;
}

/**
 * Build the Artifact envelope for one on-disk file. `origin` is `user` for
 * attachments the user picked, `task`/`main` for tool- or model-produced files.
 */
export function fileArtifactEnvelope(
  path: string,
  opts: { sessionId: string; origin: 'user' | 'main' | 'task'; size?: number },
): string {
  const artifact: Artifact = {
    id: fileArtifactId(path),
    type: artifactTypeForPath(path),
    title: baseNameOf(path),
    version: 1,
    status: 'done',
    meta: {
      sessionId: opts.sessionId,
      skill: opts.origin === 'user' ? 'attachment' : 'file-output',
      origin: opts.origin,
    },
    body: { path, ...(opts.size !== undefined ? { size: opts.size } : {}) },
    refs: [{ kind: 'file', path }],
  };
  return toArtifactContent(artifact);
}

// ── extraction ─────────────────────────────────────────────────────────────

const unquote = (s: string): string => s.trim().replace(/^[`"']+/, '').replace(/[`"']+$/, '').trim();

/**
 * Windows paths echoed from a JSON string body arrive with doubled separators
 * (`C:\\dir\\file.docx`) when the JSON parse was skipped for size reasons.
 */
const normalizePath = (s: string): string =>
  /^[A-Za-z]:\\\\/.test(s) ? s.replace(/\\\\/g, '\\') : s;

/**
 * The `+` attach / @-mention flow composes the prompt as one `@<absolute path>`
 * line per file (renderer.ts sendMessage). That line is the exact, unambiguous
 * record of what the user attached, so parse it verbatim.
 */
export function extractAttachmentPaths(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('@')) continue;
    const path = unquote(line.slice(1));
    if (!path || !isAbsoluteFilePath(path)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
    if (out.length >= MAX_FILE_REFS_PER_MESSAGE) break;
  }
  return out;
}

const PATH_KEYS = new Set([
  'files', 'file', 'outputs', 'output', 'artifacts', 'artifact',
  'path', 'paths', 'file_path', 'filepath', 'output_path', 'target',
  'image_path', 'video_path', 'audio_path', 'saved_path', 'generated',
]);

function collectJsonPaths(value: unknown, push: (p: string) => void, depth: number): void {
  if (depth > 6 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonPaths(item, push, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const pathKey = PATH_KEYS.has(key.toLowerCase());
    if (typeof val === 'string') {
      if (pathKey) push(val);
      continue;
    }
    // `{"files": ["C:\\out\\a.png", …]}` is the shape every image/media tool
    // returns — a path key holding an array of plain strings. Arrays of objects
    // (`files: [{path}]`) still need the recursive pass.
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') {
          if (pathKey) push(item);
        } else if (item && typeof item === 'object') {
          collectJsonPaths(item, push, depth + 1);
        }
      }
      continue;
    }
    if (val && typeof val === 'object') collectJsonPaths(val, push, depth + 1);
  }
}

/** Quoted / backticked absolute path with a deliverable extension. */
const QUOTED_PATH_RE =
  /[`"']((?:[A-Za-z]:[\\/]|\\\\|\/)[^`"'\r\n]{1,400}?\.(?:docx|pptx|pdf|xlsx|xls|csv|md|markdown|html?|png|jpe?g|gif|webp|bmp|svg))[`"']/gi;
/** Bare absolute path (no spaces) at a token boundary. */
const BARE_PATH_RE =
  /(?:^|[\s(\[<"'`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>|]*?\.(?:docx|pptx|pdf|xlsx|xls|csv|md|markdown|html?|png|jpe?g|gif|webp|bmp|svg))/gi;

/** Above this size, or with inline base64, parsing JSON costs more than the
 *  regex pass and can stall the artifacts poll on large image results. */
const MAX_JSON_PARSE_CHARS = 120_000;
/** Bodies bigger than this are never scanned at all (inline images and blobs). */
const MAX_EXTRACT_CHARS = 400_000;

/**
 * Paths produced by a tool result or mentioned by the assistant: JSON file
 * fields (`files[]`, `path`, `image_path`, …) plus quoted/bare absolute paths
 * in free text. Only deliverable formats are accepted so prose like
 * "see src/main.ts" never lands in the archive.
 */
export function extractProducedPaths(content: string): string[] {
  if (!content || content.length > MAX_EXTRACT_CHARS) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    if (out.length >= MAX_FILE_REFS_PER_MESSAGE) return;
    const path = normalizePath(unquote(raw));
    if (!path || !isAbsoluteFilePath(path) || !isDeliverablePath(path)) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path);
  };

  const trimmed = content.trim();
  let parsedJson = false;
  if (
    (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
    trimmed.length <= MAX_JSON_PARSE_CHARS &&
    !trimmed.includes('"data:')
  ) {
    try {
      collectJsonPaths(JSON.parse(trimmed), push, 0);
      parsedJson = true;
    } catch {
      /* plain-text result that merely starts with a brace */
    }
  }
  // A JSON result already yielded its paths in unescaped form. Running the text
  // regexes over the raw string would re-add `C:\\dir\\file.docx` variants and
  // defeat path dedupe, so the text pass is only for non-JSON output.
  if (!parsedJson) {
    for (const re of [QUOTED_PATH_RE, BARE_PATH_RE]) {
      re.lastIndex = 0;
      for (let m = re.exec(content); m; m = re.exec(content)) {
        push(m[1]);
        if (out.length >= MAX_FILE_REFS_PER_MESSAGE) break;
      }
    }
  }
  return out;
}

/** Role-aware extraction used by the index and by `getArtifact`. */
export function extractPathsForMessage(role: string, content: string): string[] {
  if (!content) return [];
  if (role === 'user') return extractAttachmentPaths(content);
  if (role === 'tool' || role === 'assistant') return extractProducedPaths(content);
  return [];
}

/** Decode a negative artifact-row id back into (messageId, pathIndex). */
export function decodeFileItemId(id: number): { messageId: number; index: number } | null {
  if (!Number.isInteger(id) || id >= 0) return null;
  const mid = Math.floor(-id / FILE_ITEM_STRIDE);
  const index = (-id) % FILE_ITEM_STRIDE;
  if (mid <= 0 || index >= MAX_FILE_REFS_PER_MESSAGE) return null;
  return { messageId: mid, index };
}
