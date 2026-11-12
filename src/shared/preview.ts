/**
 * Shared preview utilities — MIME mapping, file-type classification, and a
 * token-based opaque URL scheme (nexus-preview://). Zero Electron dependency
 * so these helpers are fully unit-testable under node --test without a shim.
 *
 * Convention: every exported function takes a string path and returns derived
 * metadata; nothing in here knows about IPC or file-access semantics. Path
 * containment is enforced in src/main/preview-protocol.ts.
 */

// ── MIME tables (subset sufficient for the preview layer) ──────────────────

const MIME_BY_EXT = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.ogg', 'video/ogg'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.mov', 'video/quicktime'],
  ['.avi', 'video/x-msvideo'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.mkv', 'video/x-matroska'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.xml', 'text/xml'],
  // Project text types (config / data / code) — all render as plain text.
  ['.sql', 'text/x-sql'],
  ['.toml', 'application/toml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
  ['.ini', 'text/x-ini'],
  ['.properties', 'text/x-properties'],
  ['.env', 'text/plain'],
  ['.log', 'text/plain'],
  ['.lock', 'text/plain'],
  ['.sh', 'text/x-sh'],
  ['.bash', 'text/x-sh'],
  ['.py', 'text/x-python'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/tsx'],
  ['.jsx', 'text/jsx'],
  ['.css', 'text/css'],
  ['.scss', 'text/x-scss'],
  ['.less', 'text/x-less'],
  ['.vue', 'text/x-vue'],
  ['.go', 'text/x-go'],
  ['.rs', 'text/x-rust'],
  ['.java', 'text/x-java'],
  ['.c', 'text/x-c'],
  ['.h', 'text/x-c'],
  ['.cpp', 'text/x-c++'],
  ['.hpp', 'text/x-c++'],
  ['.cs', 'text/x-csharp'],
  ['.rb', 'text/x-ruby'],
  ['.php', 'text/x-php'],
  ['.swift', 'text/x-swift'],
  ['.kt', 'text/x-kotlin'],
  ['.ps1', 'text/x-powershell'],
  ['.bat', 'text/x-batch'],
  ['.graphql', 'text/x-graphql'],
  ['.proto', 'text/x-proto'],
]);

export function mimeForPath(path: string): string {
  const ext = path.toLowerCase().slice(path.lastIndexOf('.'));
  return MIME_BY_EXT.get(ext) ?? '';
}

// ── Kind classification (pure, based on MIME + a few heuristics) ──────────

export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'html'
  | 'markdown'
  | 'text'
  | 'unsupported';

function classifyByMime(mime: string): PreviewKind {
  if (!mime) return 'unsupported';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime.includes('presentationml')) return 'pptx';
  if (mime.includes('spreadsheetml')) return 'xlsx';
  if (mime.startsWith('text/html')) return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (mime.startsWith('text/')) return 'text';
  // JSON / XML / TOML / YAML are text-like; render as plain text.
  if (
    mime === 'application/json' || mime === 'application/xml' ||
    mime === 'application/toml' || mime === 'application/yaml' ||
    mime === 'application/x-yaml'
  ) return 'text';
  return 'unsupported';
}

export function classify(path: string): PreviewKind {
  const mime = mimeForPath(path);
  return classifyByMime(mime);
}

export const PREVIEWABLE_KINDS: PreviewKind[] = [
  'image', 'video', 'audio', 'pdf', 'docx', 'pptx', 'xlsx',
  'html', 'markdown', 'text',
];

export function isPreviewable(kind: PreviewKind): boolean {
  return PREVIEWABLE_KINDS.includes(kind);
}

// ── Directory normalization for preview roots ───────────────────────────────

/**
 * Canonical form for allowed-preview-root entries: lowercase, forward slashes,
 * doubled slashes folded (JSON-escaped `\\` paths and UNC both normalize the
 * same way), no trailing slash, and a bare Windows drive root written as `e:`
 * so the containment check `norm === root || norm.startsWith(root + '/')`
 * matches `e:/x` against root `e:`.
 */
export function normalizePreviewDir(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s === '' ? '/' : s;
}

/**
 * Directory component of an absolute path, in `normalizePreviewDir`'s
 * lowercase-backslash-free form (drive roots stay bare, e.g. `E:`). Returns
 * '' when the path has no directory component (relative input — callers must
 * pass absolute paths).
 */
export function previewDirOf(p: string): string {
  const n = p.replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  const dir = i <= 0 ? (i === 0 ? '/' : n.replace(/\/+$/, '')) : n.slice(0, i);
  return dir.toLowerCase();
}

// ── Token ↔ real path map ─────────────────────────────────────────────────

export interface TokenEntry {
  readonly realPath: string;
  readonly createdAt: number;
}

/** Stable size limit for the token map per-session. */
export const MAX_TOKENS = 32;
/** Time-to-live per token in ms (30 minutes). */
export const TOKEN_TTL_MS = 30 * 60 * 1000;

/** Generate a hex token string. Not crypto-grade; unique enough per-process. */
export function randomToken(): string {
  return [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

// ── URL formatters / parsers ──────────────────────────────────────────────

export const PREVIEW_SCHEME = 'nexus-preview' as const;
export const PREVIEW_HOST = 'local' as const;

/** Build a stable nexus-preview:// URL carrying one token. */
export function buildPreviewUrl(token: string, baseName?: string): string {
  const encodedBase = typeof baseName === 'string' ? encodeURIComponent(baseName) : '';
  const path = PREVIEW_HOST + '/' + token + (encodedBase ? '/' + encodedBase : '');
  return PREVIEW_SCHEME + '://' + path;
}

/** Parse a nexus-preview:// URL back to its token (or null on malformed input). */
export function extractToken(url: string): string | null {
  if (!url.startsWith(`${PREVIEW_SCHEME}:/`)) return null;
  // After 'nexus-preview:', the remaining string is '//local/token/name...'
  // Slice off the scheme + ':' (length+1), leaving '//local/...'
  const afterScheme = url.slice(PREVIEW_SCHEME.length + 1);
  if (!afterScheme.startsWith(`//${PREVIEW_HOST}/`)) return null;
  const rest = afterScheme.slice(PREVIEW_HOST.length + 3); // skip '//local/'
  const token = rest.split('/')[0] ?? '';
  if (token.length < 8 || token.length > 32) return null;
  if (!/^[a-f0-9]{16}$/.test(token)) return null;
  return token;
}

// ── File-size helpers (used by callers before issuing tokens) ────────────

const ONE_MB = 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const MAX_PREVIEW_BYTES = 512 * ONE_MB;
export function exceedsPreviewCap(bytes: number): boolean {
  return bytes > MAX_PREVIEW_BYTES;
}
