/**
 * Main-process half of the preview subsystem. Registers a custom URI scheme
 * (`nexus-preview://`) so the renderer can load local images, video, audio,
 * PDFs and text via standard `<img>/<video>/<object><iframe>` tags without the
 * fs or paths crossing the preload bridge.
 *
 * Protocol contract:
 *   nexus-preview://local/<token>[/<basename>]
 * - `token` resolves to an absolute canonical path owned by the main process.
 * - Only paths inside the allowed roots (same list FileBrowser uses) or
 *   explicitly authorized-by-token can be served.
 * - Symlink-escape, executable-extension and outside-root attacks are rejected.
 * - Range requests return 206 so `<video>` seek bars work (video must seek).
 *
 * Nothing here touches `sessionWorkers`, MCP servers or the worker process —
 * the preview is pure main-process state. Tokens are cleaned up on window
 * close.
 */

import { app, BrowserWindow, ipcMain, protocol } from 'electron';

// Must run before app.whenReady() so Chromium marks the scheme as fetch-able
// (enables fetch() / XHR against nexus-preview:// URLs in the renderer).
protocol.registerSchemesAsPrivileged([
  { scheme: 'nexus-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { CHANNELS } from '../ipc/channels.js';
import {
  classify,
  isPreviewable,
  PREVIEW_HOST,
  PREVIEW_SCHEME,
  MAX_TOKENS,
  MAX_PREVIEW_BYTES,
  TOKEN_TTL_MS,
  type TokenEntry,
  randomToken,
  buildPreviewUrl,
  extractToken,
  exceedsPreviewCap,
  formatBytes,
  mimeForPath,
} from '../shared/preview.js';
import { logger } from '../shared/logger.js';

const log = (...args: unknown[]) => logger.debug(`preview[${process.pid}]: ${args.join(' ')}`);

// ── Safety mirrors from src/ipc/register.ts — stay in sync by review.        ──

const DANGEROUS_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.msi', '.msix', '.appx',
  '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
  '.lnk', '.url', '.reg', '.cpl', '.scf', '.jar',
  '.sh', '.bash', '.zsh', '.run', '.bin', '.desktop', '.command',
]);

async function isInsideAllowed(realPath: string): Promise<boolean> {
  const roots = await liveAllowedRoots();
  const norm = realPath.replace(/\\/g, '/').toLowerCase();
  return roots.some((root) => norm === root || norm.startsWith(root + '/'));
}

/** Resolve the allowed-roots list on every call so a newly-opened project
 *  directory is immediately previewable without waiting for a cache refresh.
 *  Delegates to the main-process context (same source as the IPC layer),
 *  falling back to the static list for tests that don't set one up. */
async function liveAllowedRoots(): Promise<string[]> {
  const c = ctx();
  if (c?.getAllowedRoots) {
    try {
      const roots = await c.getAllowedRoots();
      if (roots.length) {
        return roots.map((r: string) => r.replace(/\\/g, '/').toLowerCase());
      }
    } catch { /* fall through to static list */ }
  }
  if (cachedRoots) return cachedRoots;
  await ensureCachedRoots();
  return cachedRoots ?? [];
}

let cachedRoots: string[] | null = null;
/**
 * (Re)build the static fallback root list. Runs at launch and again after a
 * project directory switch so the cached fallback never serves a stale set.
 * Only matters when the live `getAllowedRoots` context yields nothing.
 */
async function ensureCachedRoots(force = false): Promise<void> {
  if (cachedRoots && !force) return;
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const raw: string[] = [];
  // 1. NEXUS_CONFIG_DIR (homedir) — always present
  try { raw.push(process.env.NEXUS_CONFIG_DIR || os.homedir()); } catch {}
  // 2. tmpdir — always present
  try { raw.push(os.tmpdir()); } catch {}
  // 3. cwd — always present at launch
  try { raw.push(process.cwd()); } catch {}
  // 4. homedir itself — covers all user files
  try { raw.push(os.homedir()); } catch {}
  // 5. the last known session/project cwd (refreshed via setPreviewCwd)
  try { if (previewCwd) raw.push(previewCwd); } catch {}
  // Realpath each candidate so per-request check is fast and symlink-safe.
  const resolved: string[] = [];
  for (const p of raw) {
    try {
      const r = await fs.realpath(p);
      if (!resolved.includes(r)) resolved.push(r);
    } catch { /* dir missing: skip */ }
  }
  cachedRoots = resolved.map((r) => r.replace(/\\/g, '/').toLowerCase());
  log('cachedRoots =', cachedRoots);
}

/** Last known session/project working directory; refreshed on cwd change. */
let previewCwd: string | null = null;

/**
 * Call whenever the active project/session cwd changes (new project, /setdir,
 * /chcwd) so the fallback allowed-roots cache reflects it immediately instead
 * of waiting for the next launch. The live `getAllowedRoots` path already reads
 * current session cwds; this covers the fallback branch.
 */
export function setPreviewCwd(cwd: string): void {
  if (typeof cwd === 'string' && cwd) {
    previewCwd = cwd;
    void ensureCachedRoots(true).catch(() => {});
  }
}

// ── Per-context token store ────────────────────────────────────────────────

interface ContextStore {
  readonly tokens: Map<string, TokenEntry>;
  lastAccess: Map<string, number>;
}

let stores: WeakMap<object, ContextStore> | null = null;
function getStore(ctx: object): ContextStore {
  if (!stores) stores = new WeakMap();
  let s = stores.get(ctx);
  if (!s) {
    s = { tokens: new Map(), lastAccess: new Map() };
    stores.set(ctx, s);
  }
  return s;
}

async function allocateToken(ctx: object, realPath: string): Promise<{ token: string; url: string } | null> {
  const b = basename(realPath);
  const store = getStore(ctx);
  // Evict LRU when at capacity.
  while (store.tokens.size >= MAX_TOKENS) {
    let oldest: string | undefined;
    let oldestAt = Infinity;
    for (const [tok, e] of store.tokens) {
      const ts = store.lastAccess.get(tok) ?? e.createdAt;
      if (ts < oldestAt) { oldestAt = ts; oldest = tok; }
    }
    if (!oldest) break;
    store.tokens.delete(oldest);
    store.lastAccess.delete(oldest);
  }
  const token = randomToken();
  store.tokens.set(token, { realPath, createdAt: Date.now() });
  store.lastAccess.set(token, Date.now());
  return { token, url: buildPreviewUrl(token, b) };
}

function revokeToken(ctx: object, token: string): void {
  const store = getStore(ctx);
  const ok = store.tokens.delete(token);
  store.lastAccess.delete(token);
  if (ok) log('revoked token:', token.slice(0, 4) + '…');
}

function refreshToken(ctx: object, token: string): void {
  const store = getStore(ctx);
  const e = store.tokens.get(token);
  if (e) store.lastAccess.set(token, Date.now());
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
function armSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    // Full cleanup pass across every known context.
    if (!stores || !ctxObj) return;
    const now = Date.now();
    const s = stores.get(ctxObj);
    if (!s) return;
    for (const [t, e] of s.tokens) {
      if (now - e.createdAt > TOKEN_TTL_MS) {
        s.tokens.delete(t);
        s.lastAccess.delete(t);
      }
    }
  }, 5 * 60 * 1000);
}
app.on('will-quit', () => { if (sweepTimer) clearInterval(sweepTimer); sweepTimer = null; });

// ── Public API ──────────────────────────────────────────────────────────────

// Global context instance (single-window invariant).
let ctxObj: object | null = null;

export interface PreviewIpcContext {
  readonly getWin: () => import('electron').BrowserWindow | null;
  /** Live allowed-roots list (session cwds + saved cwd + nexus root + tmp + cwd),
   *  mirroring the IPC layer so the preview check never out-of-syncs with
   *  the FileBrowser path guard. Must be async (reads disk for realpath). */
  readonly getAllowedRoots?: () => Promise<string[]>;
}

function ctx(): PreviewIpcContext | null {
  return ctxObj ? (ctxObj as PreviewIpcContext) : null;
}

export function setPreviewCtx(c: PreviewIpcContext): void {
  ctxObj = c;
}

/** Must be called after app.whenReady() (Electron 25+ requirement). */
export async function registerPreviewProtocol(): Promise<void> {
  await ensureCachedRoots();

  protocol.handle(PREVIEW_SCHEME, async (req) => {
    const w = ctx()?.getWin?.() ?? null;
    if (!w || w.isDestroyed()) {
      return new Response('Forbidden', { status: 403 });
    }

    const urlStr = req.url;
    const token = extractToken(urlStr);
    if (!token) {
      log('invalid token in url:', urlStr.slice(0, 40));
      return new Response('Forbidden', { status: 403 });
    }
    const store = getStore(ctxObj!);
    const entry = store.tokens.get(token);
    if (!entry) return new Response('Forbidden', { status: 403 });
    refreshToken(ctxObj!, token);

    const realPath = entry.realPath;
    const ext = realPath.toLowerCase().slice(realPath.lastIndexOf('.'));
    if (DANGEROUS_EXT.has(ext)) return new Response('Forbidden', { status: 403 });

    const ok = await isInsideAllowed(realPath);
    if (!ok) return new Response('Forbidden', { status: 403 });

    let st: import('node:fs').Stats;
    try { st = await stat(realPath); } catch { return new Response('Not found', { status: 404 }); }
    if (!st.isFile()) return new Response('Not found', { status: 404 });
    const mime = mimeForPath(realPath);
    if (!mime) return new Response('Not found', { status: 404 });

    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };

    // Range support so <video> seek bars and partial loads work.
    const rangeHeader = req.headers?.get?.('range') ?? '';
    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (rangeMatch) {
      const lo = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0;
      const hi = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : st.size - 1;
      const length = hi - lo + 1;
      const buf = await import('node:fs/promises').then((fs) =>
        fs.open(realPath, 'r').then((fd) => {
          const ab = new ArrayBuffer(length);
          const view = new Uint8Array(ab);
          return fd.read(view, 0, length, lo).then(() => fd.close().then(() => view));
        })
      );
      headers['Content-Range'] = `bytes ${lo}-${hi}/${st.size}`;
      headers['Content-Length'] = String(length);
      return new Response(buf, { status: 206, headers });
    }

    headers['Content-Length'] = String(st.size);
    const buf = await import('node:fs/promises').then((fs) => fs.readFile(realPath));
    return new Response(buf, { status: 200, headers });
  });

  armSweep();
}

export function installPreviewHandlers(): void {
  ipcMain.handle(CHANNELS.previewOpen, async (_event, params: unknown) => {
    const p = params as { path?: unknown } | undefined;
    if (!p || typeof p.path !== 'string' || p.path.length > 4096) {
      return { ok: false, error: 'missing path' };
    }
    // Use realpath from node:fs/promises directly here; it stays consistent with
    // the entry stored during allocation.
    let real: string;
    try {
      const { realpath } = await import('node:fs/promises');
      real = await realpath(p.path);
    } catch { return { ok: false, error: 'invalid path' }; }
    const ext = real.toLowerCase().slice(real.lastIndexOf('.'));
    if (DANGEROUS_EXT.has(ext)) return { ok: false, error: `executable not allowed: ${ext}` };
    if (!(await isInsideAllowed(real))) return { ok: false, error: 'path outside allowed roots' };
    const kind = classify(real);
    if (!isPreviewable(kind)) return { ok: false, error: `unsupported type: ${kind}` };
    let st: import('node:fs').Stats;
    try { st = await stat(real); } catch { return { ok: false, error: 'stat failed' }; }
    if (exceedsPreviewCap(st.size)) return { ok: false, error: `preview too large: ${formatBytes(st.size)} exceeds the ${formatBytes(MAX_PREVIEW_BYTES)} cap` };
    const alloc = await allocateToken(ctxObj!, real);
    if (!alloc) return { ok: false, error: 'token allocation failed' };
    return {
      ok: true,
      token: alloc.token,
      url: alloc.url,
      kind,
      mime: mimeForPath(real),
      size: st.size,
      name: real.split(/[\\/]/).pop() ?? '',
    };
  });

  ipcMain.handle(CHANNELS.previewClose, async (_event, params: unknown) => {
    const p = params as { token?: unknown } | undefined;
    if (!p || typeof p.token !== 'string') return { ok: false, error: 'missing token' };
    revokeToken(ctxObj!, p.token);
    return { ok: true };
  });

  // Read up to `maxBytes` of file content for text/markdown viewers (IPC path
  // is reliable in sandboxed renderers where fetch() on custom schemes may not
  // be available).
  ipcMain.handle(CHANNELS.previewRead, async (_event, params: unknown) => {
    const p = params as { token?: unknown; maxBytes?: unknown } | undefined;
    if (!p || typeof p.token !== 'string') return { ok: false, error: 'missing token' };
    const maxBytes = typeof p.maxBytes === 'number' && p.maxBytes > 0 ? Math.min(p.maxBytes, 4 * 1024 * 1024) : 2 * 1024 * 1024;
    const store = getStore(ctxObj!);
    const entry = store.tokens.get(p.token);
    if (!entry) return { ok: false, error: 'unknown token' };
    const realPath = entry.realPath;
    try {
      const fs = await import('node:fs/promises');
      const st = await fs.stat(realPath);
      if (st.size > maxBytes) {
        // Read only the first `maxBytes` to avoid loading the whole file into IPC.
        const { open } = await import('node:fs/promises');
        const fd = await open(realPath, 'r');
        const buf = Buffer.alloc(maxBytes);
        await fd.read(buf, 0, maxBytes, 0);
        await fd.close();
        return { ok: true, text: buf.toString('utf8'), truncated: true };
      }
      const buf = await fs.readFile(realPath);
      return { ok: true, text: buf.toString('utf8'), truncated: false };
    } catch {
      return { ok: false, error: 'read failed' };
    }
  });
}

export function destroyPreviewContext(): void {
  if (!ctxObj || !stores) return;
  const s = stores.get(ctxObj);
  if (!s) return;
  s.tokens.clear();
  s.lastAccess.clear();
}
