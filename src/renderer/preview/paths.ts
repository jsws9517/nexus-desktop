/**
 * Previewable-path extraction for tool results — pure, dependency-free
 * (no DOM), so the renderer's history-restore path can be unit-tested by
 * importing this module directly.
 *
 * A tool's persisted result can mention local files in three shapes:
 *   1. structured args (path / file / filename / file_path / target fields),
 *   2. backticked absolute paths in the result text,
 *   3. JSON result fields (media / generation envelopes: files[], image_path,
 *      video_path, path, output, …) — generate_image & friends return a plain
 *      JSON object with no backticks, which shapes 1-2 miss entirely.
 */

import { classify, isPreviewable } from '../../shared/preview.js';

/** True when the value is an absolute local filesystem path string. */
export function isLocalFilePath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\') || v.startsWith('/'))
  );
}

/** Keys whose array values hold bare path strings (or {path} objects). */
const LIST_KEYS = new Set(['files', 'outputs', 'artifacts']);
/** Prefix match on the known path-bearing word stems. */
const FIELD_RE = /^(image|video|audio|path|file|output|dest|destination|result|artifact)/;

/**
 * Absolute paths embedded in a JSON tool result. Walks the whole object:
 *  - `files` / `outputs` / `artifacts` arrays contribute their bare string
 *    entries (and `path`/`file` fields of object entries);
 *  - any key starting with a known path stem (image_path, videoPath,
 *    output, result, …) contributes string values that look local.
 * Non-previewable strings are filtered by the caller (`findPreviewablePaths`).
 */
export function jsonPathFields(content: string): string[] {
  if (typeof content !== 'string' || !content.startsWith('{')) return [];
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }
  const out: string[] = [];
  const pushIfPath = (v: unknown, inKnownList: boolean): void => {
    if (typeof v === 'string') {
      // Bare strings only count inside known list fields — a random "name"
      // string that happens to look like a path is not a deliverable.
      if (inKnownList && isLocalFilePath(v)) out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) pushIfPath(item, inKnownList);
      return;
    }
    if (typeof v === 'object' && v !== null) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (LIST_KEYS.has(k)) pushIfPath(val, true);
        else if (FIELD_RE.test(k) && isLocalFilePath(val)) out.push(val as string);
      }
    }
  };
  pushIfPath(data, false);
  return out;
}

/**
 * Extract previewable absolute paths from a tool's args or result, in
 * priority order: structured args → backticked paths → JSON envelope fields.
 * Duplicates collapse; only paths whose extension classifies as previewable
 * survive.
 */
export function findPreviewablePaths(args: unknown, content: string): string[] {
  const candidates: string[] = [];
  // 1. Structured args.
  if (args && typeof args === 'object') {
    for (const key of ['path', 'file', 'filename', 'file_path', 'target']) {
      const v = (args as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.length > 0) candidates.push(v);
    }
  }
  // 2. Backticked absolute paths in the result text.
  const re = /`((?:[A-Za-z]:\\|\/|~\/)[^`\s]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) candidates.push(m[1]);
  // 3. JSON result envelope.
  candidates.push(...jsonPathFields(content));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of candidates) {
    if (seen.has(p)) continue;
    if (isPreviewable(classify(p))) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Split a set of previewable paths into an immediate-mount plan and a
 * deferred-mount plan.
 *
 *  - `eager` paths get their inline preview card built now, so a thumbnail /
 *    player is visible the moment the transcript renders. Images and videos
 *    always go here — they are visual content the user wants to see, not read.
 *  - `deferred` paths are only recorded on the tool card (as
 *    `dataset.previewPaths`); the caller mounts their cards lazily on first
 *    expand. This keeps the main-process token store from ballooning when a
 *    result lists many files (the store is capped at 32 tokens and evicts on
 *    overflow), and keeps collapsed tool cards cheap.
 *
 *  More than `EAGER_MEDIA_LIMIT` media (image + video) overflow into
 *  `deferred` so a result that lists a folder of clips doesn't request a token
 *  for every one of them at render time.
 */
const EAGER_KINDS = new Set<string>(['image', 'video']);
const EAGER_MEDIA_LIMIT = 4;

export interface PreviewPlan {
  /** Mount inline cards now. */
  eager: string[];
  /** Mount inline cards on first expand of the owning card. */
  deferred: string[];
}

export function partitionPreviewPaths(paths: string[]): PreviewPlan {
  const seen = new Set<string>();
  const eager: string[] = [];
  const deferred: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (EAGER_KINDS.has(classify(p)) && eager.length < EAGER_MEDIA_LIMIT) eager.push(p);
    else deferred.push(p);
  }
  return { eager, deferred };
}

// ----------------------------------------------------------------- prose
/**
 * Raw absolute local paths embedded in PLAIN prose (no backticks): Windows
 * drive paths (C:\…), UNC shares (\\server\share\…) and POSIX paths
 * (/tmp/…).
 *
 *  - A candidate only becomes a hit when `classify()` says it is previewable
 *    — so prose fragments and URLs stay inert: the drive branch refuses to
 *    start mid-word ("https:" never matches `s:/`), the POSIX branch refuses
 *    a slash preceded by word chars / `.` / `/` / `:`, and anything without
 *    a previewable extension is dropped.
 *  - Trailing prose punctuation ("…clip.mp4。" / "…clip.mp4,") is trimmed
 *    off the candidate so the extension survives classify(); the
 *    punctuation itself stays in the text (see `RawPathHit.end`).
 */
export interface RawPathHit {
  /** Index in the source text where the cleaned path starts. */
  start: number;
  /** Index just past the cleaned path's last char (trailing punctuation is outside). */
  end: number;
  /** The cleaned path. */
  path: string;
}

const RAW_PATH_RE =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|*?\[\]]+|\\\\[^\s"'`<>|*?\[\]]+|(?<![A-Za-z0-9./:])\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>|*?]+)*/g;
const TRAILING_PUNCT_RE = /[。.，、；：！？,;:!?）】)\]]+$/;

export function findRawPathHits(text: string): RawPathHit[] {
  const hits: RawPathHit[] = [];
  for (const m of text.matchAll(RAW_PATH_RE)) {
    const raw = m[0];
    const path = raw.replace(TRAILING_PUNCT_RE, '');
    if (path.length < 4 || !isPreviewable(classify(path))) continue;
    hits.push({ start: m.index, end: m.index + path.length, path });
  }
  return hits;
}
