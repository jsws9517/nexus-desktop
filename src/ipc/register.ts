/**
 * Main-process IPC registration (single owner of every `nexus:*` handler).
 *
 * Extracted from src/main/index.ts so the app bootstrap stays a thin harness:
 * it constructs services, wires event forwarding, then hands this module the
 * mutable bindings it needs via `IpcContext`. Every handler that existed before
 * the extraction behaves identically — channel names, payload shapes and the
 * early/full-ready gating rules are unchanged.
 */

import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { WorkerHost } from '../main/worker-host.js';
import type { SessionWorkers, OpenTabInfo } from '../main/session-workers.js';
import type { ResourceMonitor, ResourceState } from '../main/resource-monitor.js';
import { Updater } from '../main/updater.js';
import { recentLogLines } from '../shared/logger.js';
import { isBoolean, isFiniteNumber, isNonEmptyString, isString, isValidPathList } from '../shared/ipc-validation.js';
import { CHANNELS } from './channels.js';
import type { DesktopStateAccess } from '../main/desktop-state.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

async function imageDataUrl(path: string): Promise<string | undefined> {
  try {
    const st = await stat(path);
    if (st.size > 2 * 1024 * 1024) return undefined;
    const mime = IMAGE_MIME[extname(path).toLowerCase()];
    if (!mime) return undefined;
    return `data:${mime};base64,${(await readFile(path)).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Mutable app bindings injected by src/main/index.ts (worker is a `let` ref). */
export interface IpcContext extends DesktopStateAccess {
  worker: WorkerHost | null;
  sessionWorkers: SessionWorkers;
  resourceMon: ResourceMonitor;
  updater: Updater;
  /** Current full-init readiness promise (re-read at each request). */
  fullReady: () => Promise<void>;
  /** Current phase-1 (Agent-constructed) readiness promise. */
  earlyReady: () => Promise<void>;
  earlyMethods: ReadonlySet<string>;
  /** Main window (may be null) — used to parent modal dialogs. */
  getBrowserWindow: () => BrowserWindow | null;
  openConfigWindow: () => Promise<void>;
  configPort: () => number | undefined;
  saveSavedCwd: (cwd: string) => void;
  applyResourceConfig: (monitor: ResourceMonitor) => void;
  countOpenTabs: () => number;
  log: (msg: string) => void;
}

export function registerIpc(ctx: IpcContext): void {
  const { worker, sessionWorkers, resourceMon, updater, log } = ctx;
  const call = (method: string) => async (_e: unknown, params?: Record<string, unknown>) => {
    if (method === 'resolvePermission') log(`invoke resolvePermission params=${JSON.stringify(params)}`);
    await (ctx.earlyMethods.has(method) ? ctx.earlyReady() : ctx.fullReady());
    try {
      return await worker!.request(method, params);
    } catch (err) {
      log(`invoke ${method} error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
  // Session-scoped variant: route to the tab's own worker when that session has
  // one open; otherwise fall back to the global worker (back-compat path).
  const callForSession = (method: string, sessionParam = 'sessionId') =>
    async (_e: unknown, params?: Record<string, unknown>) => {
      const sid = params && typeof params[sessionParam] === 'string' ? params[sessionParam] : '';
      if (sid && sessionWorkers.has(sid)) {
        try {
          return await sessionWorkers.request(sid, method, params);
        } catch (err) {
          log(`session invoke ${method} error: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      }
      return call(method)(_e, params);
    };

  ipcMain.handle(CHANNELS.chat, callForSession('chat'));
  ipcMain.handle(CHANNELS.sideChat, call('sideChat'));
  ipcMain.handle(CHANNELS.regenerate, callForSession('regenerate'));
  ipcMain.handle(CHANNELS.withdraw, callForSession('withdraw'));
  ipcMain.handle(CHANNELS.abort, async (_e, params?: Record<string, unknown>) => {
    // Abort is bound to whichever tab is actively streaming; route to the
    // specific session if told which one, else abort all session workers + the
    // global worker (idempotent).
    const sid = params && typeof params.sessionId === 'string' ? params.sessionId : '';
    if (sid && sessionWorkers.has(sid)) {
      await sessionWorkers.request(sid, 'abort', params);
      await sessionWorkers.refreshState(sid);
      return;
    }
    for (const openId of sessionWorkers.tabs().map((t) => t.sessionId)) {
      try {
        await sessionWorkers.request(openId, 'abort', params);
      } catch {}
    }
    await call('abort')(_e, params);
  });
  ipcMain.handle(CHANNELS.startSession, call('startSession'));
  ipcMain.handle(CHANNELS.listSessions, call('listSessions'));
  ipcMain.handle(CHANNELS.getMessages, call('getMessages'));
  ipcMain.handle(CHANNELS.getSlashLog, call('getSlashLog'));
  ipcMain.handle(CHANNELS.getSlashLogPath, call('getSlashLogPath'));
  ipcMain.handle(CHANNELS.deleteSession, call('deleteSession'));
  ipcMain.handle(CHANNELS.renameSession, call('renameSession'));
  ipcMain.handle(CHANNELS.renameProject, call('renameProject'));
  ipcMain.handle(CHANNELS.getConfig, call('getConfig'));
  ipcMain.handle(CHANNELS.getProviders, call('getProviders'));
  ipcMain.handle(CHANNELS.getStatus, callForSession('getStatus'));
  ipcMain.handle(CHANNELS.getPermissions, call('getPermissions'));
  // Read language straight from config.json instead of routing through the
  // worker: getLanguage is only used to pick the UI language, and the worker is
  // gated behind fullReady (init can take 10-20s). Waiting would leave the
  // static (zh-CN) HTML on screen until core init finishes, flashing Chinese
  // before switching to the configured language.
  ipcMain.handle(CHANNELS.getLanguage, async (): Promise<string> => {
    try {
      const cfgPath = join(homedir(), '.nexus', 'config.json');
      await access(cfgPath);
      const raw = await readFile(cfgPath, 'utf-8');
      const cfg = JSON.parse(raw) as { language?: string };
      return typeof cfg.language === 'string' ? cfg.language : 'en';
    } catch {
      return 'en';
    }
  });
  ipcMain.handle(CHANNELS.reloadConfig, call('reloadConfig'));
  // Read the core intent-recognition toggle straight from config.json instead of
  // routing through the worker: the renderer needs it early (to decide whether
  // to supersede in-flight turns) and the worker is gated behind fullReady.
  ipcMain.handle(CHANNELS.getIntentRecognition, async (): Promise<boolean> => {
    try {
      const cfgPath = join(homedir(), '.nexus', 'config.json');
      await access(cfgPath);
      const raw = await readFile(cfgPath, 'utf-8');
      const cfg = JSON.parse(raw) as { contextWindow?: { intentRecognition?: boolean } };
      return cfg.contextWindow?.intentRecognition ?? true;
    } catch {
      return true;
    }
  });
  ipcMain.handle(CHANNELS.getSpeechVisionConfig, call('getSpeechVisionConfig'));
  ipcMain.handle(CHANNELS.setActiveSpeechProvider, call('setActiveSpeechProvider'));
  ipcMain.handle(CHANNELS.setActiveTtsProvider, call('setActiveTtsProvider'));
  ipcMain.handle(CHANNELS.setActiveVisionProvider, call('setActiveVisionProvider'));
  ipcMain.handle(CHANNELS.saveSpeechProvider, call('saveSpeechProvider'));
  ipcMain.handle(CHANNELS.saveVisionProvider, call('saveVisionProvider'));
  ipcMain.handle(CHANNELS.getSessionStats, call('getSessionStats'));
  ipcMain.handle(CHANNELS.switchProvider, async (_e, params?: Record<string, unknown>) => {
    const sid = params && typeof params.sessionId === 'string' ? params.sessionId : '';
    const name = params && typeof params.name === 'string' ? params.name : '';
    if (sid && sessionWorkers.has(sid)) {
      // Per-session override: never writes the shared global config.json.
      await sessionWorkers.request(sid, 'setProviderOverride', { name });
      await sessionWorkers.refreshState(sid);
      return;
    }
    await call('switchProvider')(_e, params);
  });
  ipcMain.handle(CHANNELS.switchModel, async (_e, params?: Record<string, unknown>) => {
    const sid = params && typeof params.sessionId === 'string' ? params.sessionId : '';
    const modelId = params && typeof params.modelId === 'string' ? params.modelId : '';
    if (sid && sessionWorkers.has(sid)) {
      // Per-session override: never writes the shared global config.json.
      const res = await sessionWorkers.request(sid, 'setModelOverride', { modelId });
      await sessionWorkers.refreshState(sid);
      return res;
    }
    return call('switchModel')(_e, params);
  });
  ipcMain.handle(CHANNELS.getModels, callForSession('getModels'));
  ipcMain.handle(CHANNELS.setDepthOverride, callForSession('setDepthOverride'));
  ipcMain.handle(CHANNELS.getActiveDepth, callForSession('getActiveDepth'));
  ipcMain.handle(CHANNELS.setPermissionsOverride, callForSession('setPermissionsOverride'));
  ipcMain.handle(CHANNELS.getActiveMode, callForSession('getActiveMode'));
  ipcMain.handle(CHANNELS.saveProvider, call('saveProvider'));
  ipcMain.handle(CHANNELS.setCwd, async (_e, params) => {
    // When a session tab is active, route setCwd to that tab's worker so the
    // agent's process.cwd() matches the opened project dir (not just the shared
    // global worker used by the sidebar). Fall back to the global worker.
    const res = await callForSession('setCwd')(_e, params);
    const cwd = (res as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd === 'string' && cwd) ctx.saveSavedCwd(cwd);
    return res;
  });
  ipcMain.handle(CHANNELS.getDefaultProjectDir, call('getDefaultProjectDir'));
  ipcMain.handle(CHANNELS.getSessionMetadata, call('getSessionMetadata'));
  ipcMain.handle(CHANNELS.setSessionMetadata, call('setSessionMetadata'));
  ipcMain.handle(CHANNELS.respondPermission, callForSession('resolvePermission'));
  ipcMain.handle(CHANNELS.setMcpEnabled, call('setMcpEnabled'));
  ipcMain.handle(CHANNELS.getMcpStatus, call('getMcpStatus'));
  ipcMain.handle(CHANNELS.getMcpServers, call('getMcpServers'));
  ipcMain.handle(CHANNELS.setMcpServer, call('setMcpServer'));

  // Desktop-only startup setting (persisted to ~/.nexus/desktop.json). Takes
  // effect on the next launch — the value is read by startWorker().
  ipcMain.handle(CHANNELS.getDeferMcp, (): boolean => ctx.getDeferMcp());
  ipcMain.handle(CHANNELS.setDeferMcp, (_e, enabled: unknown): { ok: boolean } => {
    if (!isBoolean(enabled)) return { ok: false };
    ctx.setDeferMcp(enabled);
    return { ok: true };
  });

  // E3: pinned sessions + minimize-to-tray, persisted to desktop.json.
  ipcMain.handle(CHANNELS.getPinned, (): string[] => ctx.getPinnedIds());
  ipcMain.handle(CHANNELS.setPinned, (_e, ids: unknown): { ok: boolean } => {
    if (!isValidPathList(ids)) return { ok: false };
    ctx.setPinnedIds(ids);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getMinimizeToTray, (): boolean => ctx.getMinimizeToTray());
  ipcMain.handle(CHANNELS.setMinimizeToTray, (_e, enabled: unknown): { ok: boolean } => {
    if (!isBoolean(enabled)) return { ok: false };
    ctx.setMinimizeToTray(enabled);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getRestoreSessionOnLaunch, (): boolean => ctx.getRestoreSessionOnLaunch());
  ipcMain.handle(CHANNELS.setRestoreSessionOnLaunch, (_e, enabled: unknown): { ok: boolean } => {
    if (!isBoolean(enabled)) return { ok: false };
    ctx.setRestoreSessionOnLaunch(enabled);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getLastOpenTabs, (): string[] => ctx.getLastOpenTabs());
  ipcMain.handle(CHANNELS.setLastOpenTabs, (_e, ids: unknown): { ok: boolean } => {
    if (!Array.isArray(ids)) return { ok: false };
    ctx.setLastOpenTabs(ids as string[]);
    return { ok: true };
  });

  // Appearance: input textarea row count.
  ipcMain.handle(CHANNELS.getInputRows, (): number => ctx.getInputRows());
  ipcMain.handle(CHANNELS.setInputRows, (_e, rows: unknown): { ok: boolean } => {
    if (!isFiniteNumber(rows)) return { ok: false };
    ctx.setInputRows(rows);
    return { ok: true };
  });

  // E4: read recent log lines for the in-app viewer.
  ipcMain.handle(CHANNELS.readRecentLogs, (_e, maxLines: unknown): string[] => {
    const n = isFiniteNumber(maxLines) ? Math.max(1, Math.floor(maxLines)) : 200;
    return recentLogLines(n);
  });

  // Resource / session governance (desktop.json + live resource watchdog).
  ipcMain.handle(CHANNELS.getMaxTabs, (): number => ctx.getMaxTabs());
  ipcMain.handle(CHANNELS.setMaxTabs, (_e, n: unknown): { ok: boolean } => {
    if (!isFiniteNumber(n)) return { ok: false };
    ctx.setMaxTabs(n);
    resourceMon.setAtMax(ctx.countOpenTabs() >= ctx.getMaxTabs());
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getMemThreshold, (): number => ctx.getMemThresholdPct());
  ipcMain.handle(CHANNELS.setMemThreshold, (_e, n: unknown): { ok: boolean } => {
    if (!isFiniteNumber(n)) return { ok: false };
    ctx.setMemThresholdPct(n);
    ctx.applyResourceConfig(resourceMon);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getCpuThreshold, (): number => ctx.getCpuThresholdPct());
  ipcMain.handle(CHANNELS.setCpuThreshold, (_e, n: unknown): { ok: boolean } => {
    if (!isFiniteNumber(n)) return { ok: false };
    ctx.setCpuThresholdPct(n);
    ctx.applyResourceConfig(resourceMon);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getMonitorEnabled, (): boolean => ctx.getMonitorEnabled());
  ipcMain.handle(CHANNELS.setMonitorEnabled, (_e, enabled: unknown): { ok: boolean } => {
    if (!isBoolean(enabled)) return { ok: false };
    ctx.setMonitorEnabled(enabled);
    ctx.applyResourceConfig(resourceMon);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getResourceState, (): ResourceState => resourceMon.getState());

  // ── Multi-tab: per-session worker lifecycle ──
  // openSession binds (and optionally spawns) a worker to a concrete session.
  // It honors the tab ceiling — when resourceMon reports overload OR the open
  // tab count already equals maxTabs, no new process is spawned.
  ipcMain.handle(
    CHANNELS.openSession,
    async (_e, params: { sessionId?: unknown; cwd?: unknown }): Promise<{ ok: boolean; tab?: OpenTabInfo; reason?: string }> => {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
      if (!sessionId) return { ok: false, reason: 'invalid session' };
      if (sessionWorkers.has(sessionId)) {
        return { ok: true, tab: sessionWorkers.get(sessionId) };
      }
      if (ctx.countOpenTabs() >= ctx.getMaxTabs()) {
        return { ok: false, reason: 'max-tabs' };
      }
      const stateInfo = resourceMon.getState();
      if (stateInfo.status === 'overloaded') {
        return { ok: false, reason: 'overloaded' };
      }
      const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : undefined;
      try {
        const tab = await sessionWorkers.open(sessionId, cwd ? { cwd } : undefined);
        return { ok: true, tab };
      } catch (err) {
        log(`openSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // Desktop /new: create a brand-new session in a fresh worker, optionally
  // carrying the parent session's project memory forward (see openNew()).
  // Shares the same tab ceiling / overload guards as openSession.
  ipcMain.handle(
    CHANNELS.openNewSession,
    async (_e, params: { cwd?: unknown; prevSessionId?: unknown }): Promise<{ ok: boolean; sessionId?: string; tab?: OpenTabInfo; reason?: string }> => {
      if (ctx.countOpenTabs() >= ctx.getMaxTabs()) {
        return { ok: false, reason: 'max-tabs' };
      }
      const stateInfo = resourceMon.getState();
      if (stateInfo.status === 'overloaded') {
        return { ok: false, reason: 'overloaded' };
      }
      const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : undefined;
      const prevSessionId = typeof params?.prevSessionId === 'string' && params.prevSessionId ? params.prevSessionId : undefined;
      try {
        const tab = await sessionWorkers.openNew({ cwd, prevSessionId });
        return { ok: true, sessionId: tab.sessionId, tab };
      } catch (err) {
        log(`openNewSession failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  ipcMain.handle(CHANNELS.closeSession, (_e, params: { sessionId?: unknown }): { ok: boolean } => {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) return { ok: false };
    sessionWorkers.close(sessionId);
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.getOpenTabs, (): OpenTabInfo[] => sessionWorkers.tabs());
  // Per-session provider/model/status reads for the active tab's override UI.
  ipcMain.handle(CHANNELS.getTabStatus, async (_e, params: { sessionId?: unknown }) => {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
    const tab = sessionId ? sessionWorkers.get(sessionId) : undefined;
    return tab ?? null;
  });

  ipcMain.handle(CHANNELS.openFolder, async (): Promise<{ canceled: boolean; path?: string }> => {
    const result = await dialog.showOpenDialog(ctx.getBrowserWindow()!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open project folder',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle(CHANNELS.openFile, async (): Promise<{ canceled: boolean; paths: string[] }> => {
    const result = await dialog.showOpenDialog(ctx.getBrowserWindow()!, {
      properties: ['openFile', 'multiSelections'],
      title: '添加附件',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, paths: [] };
    return { canceled: false, paths: result.filePaths };
  });

  ipcMain.handle(CHANNELS.revealFile, (_e, path: unknown): { ok: boolean } => {
    if (isNonEmptyString(path)) shell.showItemInFolder(path);
    return { ok: true };
  });

  // Write user-facing export bytes (chart PNG base64 / CSV text) to a
  // user-picked location via a save dialog. The renderer encodes the payload,
  // so the fs stays opaque to it and the target dir is user-chosen.
  ipcMain.handle(
    CHANNELS.saveArtifact,
    async (_e, params: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const p = params as { defaultName?: unknown; data?: unknown; encoding?: unknown } | null;
      if (!p || typeof p.data !== 'string') return { ok: false, error: 'Missing data' };
      const defaultName =
        typeof p.defaultName === 'string' && p.defaultName
          ? p.defaultName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200)
          : 'artifact';
      const encoding = p.encoding === 'text' ? 'text' : 'base64';
      const result = await dialog.showSaveDialog(ctx.getBrowserWindow()!, {
        title: encoding === 'text' ? '导出文本' : '导出产物',
        defaultPath: join(homedir(), defaultName),
      });
      if (result.canceled || !result.filePath) return { ok: false };
      try {
        const buffer =
          encoding === 'text' ? Buffer.from(p.data, 'utf8') : Buffer.from(p.data, 'base64');
        writeFileSync(result.filePath, buffer);
        return { ok: true, path: result.filePath };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  // Attachment metadata + inline image preview (≤2 MiB) so the UI can render
  // chips with size and thumbnails without exposing the fs to the renderer.
  ipcMain.handle(
    CHANNELS.getFileInfos,
    async (_e, paths: unknown): Promise<Array<{ path: string; name: string; size: number; isImage: boolean; preview?: string }>> => {
      if (!isValidPathList(paths)) return [];
      const out: Array<{ path: string; name: string; size: number; isImage: boolean; preview?: string }> = [];
      for (const p of paths) {
        try {
          const st = await stat(p);
          const ext = extname(p).toLowerCase();
          const isImage = IMAGE_EXT.has(ext);
          out.push({
            path: p,
            name: basename(p),
            size: st.size,
            isImage,
            preview: isImage ? await imageDataUrl(p) : undefined,
          });
        } catch {}
      }
      return out;
    },
  );

  // Load a local image as a data URL for markdown rendering (hydrateImages).
  ipcMain.handle(CHANNELS.readImagePreview, async (_e, path: unknown): Promise<string | undefined> => {
    if (!isString(path) || path.length === 0 || path.length > 4096) return undefined;
    return imageDataUrl(path);
  });

  // Paste image from system clipboard (consistent with coder-core ALT+V behavior).
  // Stores to TEMP directory (auto-cleaned by OS) and returns path + preview.
  ipcMain.handle(CHANNELS.pasteImage, async (): Promise<{ path: string; preview: string } | null> => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    try {
      const buffer = image.toPNG();
      const dir = mkdtempSync(join(tmpdir(), 'nexus-image-'));
      const filePath = join(dir, 'clipboard.png');
      writeFileSync(filePath, buffer);
      const preview = `data:image/png;base64,${buffer.toString('base64')}`;
      return { path: filePath, preview };
    } catch {
      return null;
    }
  });

  ipcMain.handle(CHANNELS.openConfigWeb, async (): Promise<{ ok: boolean; port?: number; error?: string }> => {
    try {
      await ctx.openConfigWindow();
      return { ok: true, port: ctx.configPort() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Opt-in updates (方案①: manual check → manual download → manual install) ──
  ipcMain.handle(CHANNELS.getUpdateState, () => updater.getState());
  ipcMain.handle(CHANNELS.getCurrentVersion, () => Updater.currentVersion());
  ipcMain.handle(CHANNELS.checkForUpdate, () => updater.check());
  ipcMain.handle(CHANNELS.downloadUpdate, () => updater.download());
  ipcMain.handle(CHANNELS.installUpdate, () => {
    updater.install();
  });
}