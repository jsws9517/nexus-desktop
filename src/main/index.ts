import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { createRequire } from 'node:module';
import { basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { WorkerHost } from './worker-host.js';
import { Updater } from './updater.js';
import { logger, recentLogLines } from '../shared/logger.js';
import { EARLY_METHODS } from '../shared/constants.js';
import { isBoolean, isFiniteNumber, isNonEmptyString, isString, isValidPathList } from '../shared/ipc-validation.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function logf(msg: string): void {
  logger.info(msg);
}

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

function imageDataUrl(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (st.size > 2 * 1024 * 1024) return undefined;
    const mime = IMAGE_MIME[extname(path).toLowerCase()];
    if (!mime) return undefined;
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
  } catch {
    return undefined;
  }
}

// Single-instance lock: regenerate() truncates the session DB directly, so two
// windows on the same data dir must never run concurrently (context + DB would
// desync). A second launch focuses the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

let win: BrowserWindow | null = null;
let worker: WorkerHost | null = null;
const updater = new Updater();
let readyPromise: Promise<void> = Promise.resolve();
// Phase-1 readiness (Agent constructed): read-only session/config IPC can run
// while MCP/skills are still connecting in the background (see startWorker()).
let sessionReadyPromise: Promise<void> = Promise.resolve();
// Resolves true only when `init` actually succeeds (distinct from readyPromise's
// timeout). Used by the crash auto-restart to decide success vs. retry.
let initOkPromise: Promise<boolean> = Promise.resolve(true);

// ---- worker crash auto-restart ----
let intentionallyStopped = false;
let isQuitting = false;
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const RESTART_MAX_ATTEMPTS = 3;

function scheduleRestart(): void {
  if (intentionallyStopped) return;
  if (restartAttempts >= RESTART_MAX_ATTEMPTS) {
    send('nexus:log', { level: 'error', message: 'Core worker crashed repeatedly; please restart the app.' });
    return;
  }
  const delay = Math.min(30000, 1000 * Math.pow(2, restartAttempts));
  restartAttempts++;
  send('nexus:log', {
    level: 'warn',
    message: `Restarting core worker in ${delay}ms (attempt ${restartAttempts}/${RESTART_MAX_ATTEMPTS})`,
  });
  restartTimer = setTimeout(() => {
    void restartWorker();
  }, delay);
}

async function restartWorker(): Promise<void> {
  if (intentionallyStopped) return;
  try {
    worker?.stop();
  } catch {}
  worker = null;
  startWorker();
  const ok = await initOkPromise;
  if (ok) {
    restartAttempts = 0;
    send('nexus:workerRestarted', {});
  } else {
    scheduleRestart();
  }
}

// IPC methods that only need the core's session/config layer and therefore gate
// on sessionReadyPromise (fast) instead of the full init (slow). Single source:
// src/shared/constants.ts (shared with the worker's own gating set).
const EARLY_METHODS_SET = EARLY_METHODS;

// Full config Web UI (reuses core's src/config/web.ts). Started on demand and
// torn down when its BrowserWindow closes so the port is released.
type ConfigServer = { port: number; close: () => Promise<void> };
let configServer: ConfigServer | null = null;
let configWin: BrowserWindow | null = null;

const CONFIG_WEB_PATH = createRequire(import.meta.url).resolve(
  'nexus-coder/dist/src/config/web.js',
);

// Desktop-only settings live in ~/.nexus/desktop.json — the core's config.json
// is validated by a zod schema that strips unknown fields, so a desktop-only
// flag would be dropped on the next config save/parse.
const DESKTOP_CONFIG_PATH = join(homedir(), '.nexus', 'desktop.json');

function getDeferMcp(): boolean {
  try {
    if (!existsSync(DESKTOP_CONFIG_PATH)) return false;
    const cfg = JSON.parse(readFileSync(DESKTOP_CONFIG_PATH, 'utf-8')) as { deferMcp?: boolean };
    return cfg.deferMcp === true;
  } catch {
    return false;
  }
}

function setDeferMcp(enabled: boolean): void {
  try {
    const cur = existsSync(DESKTOP_CONFIG_PATH)
      ? (JSON.parse(readFileSync(DESKTOP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>)
      : {};
    writeFileSync(DESKTOP_CONFIG_PATH, JSON.stringify({ ...cur, deferMcp: enabled }, null, 2));
  } catch {}
}

// ---- E1: desktop-state persistence (~/.nexus/desktop.json) ----
interface DesktopState {
  deferMcp?: boolean;
  lastCwd?: string;
  windowBounds?: { x?: number; y?: number; width?: number; height?: number };
  pinnedIds?: string[];
  minimizeToTray?: boolean;
  inputRows?: number;
}

function readDesktopState(): DesktopState {
  try {
    if (!existsSync(DESKTOP_CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(DESKTOP_CONFIG_PATH, 'utf-8')) as DesktopState;
  } catch {
    return {};
  }
}

function writeDesktopState(patch: DesktopState): void {
  try {
    const next = { ...readDesktopState(), ...patch };
    writeFileSync(DESKTOP_CONFIG_PATH, JSON.stringify(next, null, 2));
  } catch {}
}

function loadSavedCwd(): string | undefined {
  const cwd = readDesktopState().lastCwd;
  return typeof cwd === 'string' && cwd && existsSync(cwd) ? cwd : undefined;
}

function saveSavedCwd(cwd: string): void {
  if (typeof cwd === 'string' && cwd) writeDesktopState({ lastCwd: cwd });
}

function loadWindowBounds(): { x?: number; y?: number; width?: number; height?: number } | undefined {
  const b = readDesktopState().windowBounds;
  if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return undefined;
  return b;
}

function saveWindowBounds(bounds: { x?: number; y?: number; width?: number; height?: number }): void {
  writeDesktopState({ windowBounds: bounds });
}

function getPinnedIds(): string[] {
  const ids = readDesktopState().pinnedIds;
  return Array.isArray(ids) ? ids : [];
}

function setPinnedIds(ids: string[]): void {
  writeDesktopState({ pinnedIds: ids });
}

function getMinimizeToTray(): boolean {
  return readDesktopState().minimizeToTray === true;
}

function setMinimizeToTray(enabled: boolean): void {
  writeDesktopState({ minimizeToTray: enabled });
}

function getInputRows(): number {
  const v = readDesktopState().inputRows;
  return typeof v === 'number' && v >= 1 && v <= 20 ? v : 4;
}

function setInputRows(rows: number): void {
  const clamped = Math.max(1, Math.min(20, Math.round(rows)));
  writeDesktopState({ inputRows: clamped });
}

function workerPath(): string {
  return join(__dirname, '..', 'agent-worker.js');
}

// ---- E3: system tray (embedded 16×16 icon, no file dependency) ----
let tray: Tray | null = null;
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARklEQVR4nGPw7/nPgA/PqniGF+PVTKkB/0F4VsUzGCbagP/IGMkArAbh1YzDgP80MwBDMx4D/g9TAwY+FqiSkKiSlOmbGwEPJVivUDv5XAAAAABJRU5ErkJggg==';

function showMainWindow(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip('Nexus Desktop');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Nexus', click: () => showMainWindow() },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => showMainWindow());
  } catch (err) {
    logf(`tray init failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function createWindow(): void {
  const saved = loadWindowBounds();
  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 940,
    minHeight: 600,
    title: 'Nexus Desktop',
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(join(__dirname, '..', 'static', 'index.html'));
  win.webContents.on('console-message', (_e, level, message) => {
    logf(`renderer[${level}]: ${message}`);
  });
  win.on('closed', () => {
    win = null;
  });

  // Persist window bounds (debounced) so position/size survive a restart.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    saveWindowBounds(win.getNormalBounds());
  };
  win.on('resize', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 500);
  });
  win.on('move', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 500);
  });
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// Coalesce the chatty streaming events (text/thinking) into periodic batches.
// The worker emits one JSON per token; forwarding each across the main→renderer
// IPC hop dominates the visible stream latency. Non-stream events (tool calls,
// turn_end, session_end, …) still pass through immediately so ordering and
// busy-state transitions stay exact — a batch is flushed first.
// 16ms ≈ 60 batches/s: snappy first paint with negligible IPC volume.
// Shared by main-agent and sub-agent streaming alike.
const STREAM_BATCH_MS = 16;
let eventBatch: Array<{ type: string } & Record<string, unknown>> = [];
let eventBatchTimer: ReturnType<typeof setTimeout> | null = null;
function flushEventBatch(): void {
  if (eventBatchTimer) {
    clearTimeout(eventBatchTimer);
    eventBatchTimer = null;
  }
  if (eventBatch.length > 0) {
    const batch = eventBatch;
    eventBatch = [];
    send('nexus:events', batch);
  }
}
function forwardEvent(event: { type: string } & Record<string, unknown>): void {
  if (event.type === 'text' || event.type === 'thinking') {
    eventBatch.push(event);
    if (!eventBatchTimer) {
      eventBatchTimer = setTimeout(flushEventBatch, STREAM_BATCH_MS);
    }
  } else {
    flushEventBatch();
    send('nexus:event', event);
  }
}

async function openConfigWindow(): Promise<void> {
  try {
    // Reuse the already-open window.
    if (configWin && !configWin.isDestroyed()) {
      configWin.focus();
      return;
    }
    if (!configServer) {
      const { startWebUi } = await import(pathToFileURL(CONFIG_WEB_PATH).href);
      configServer = await startWebUi();
    }
    configWin = new BrowserWindow({
      width: 1080,
      height: 760,
      title: 'Nexus 设置',
      backgroundColor: '#fafafa',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const port = configServer!.port;
    void configWin.loadURL(`http://localhost:${port}`);
    configWin.on('closed', () => {
      configWin = null;
      // Free the port immediately when the settings window is closed.
      const server = configServer;
      configServer = null;
      void server?.close().catch(() => {});
      // The config Web UI may have written to ~/.nexus/config.json (language,
      // providers, etc.). Have the renderer reload core config + re-apply i18n.
      send('nexus:configWindowClosed', {});
    });
  } catch (err) {
    console.error('Failed to open config web UI:', err);
  }
}

function startWorker(): void {
  worker = new WorkerHost(workerPath());
  worker.onEvent = forwardEvent;
  worker.onPermission = (req) => send('nexus:permission', req);
  worker.onLog = (level, message) => send('nexus:log', { level, message });
  worker.onExit = (code) => {
    send('nexus:log', { level: 'warn', message: `Core worker exited (code=${code})` });
    scheduleRestart();
  };
  worker.start();
  const savedCwd = loadSavedCwd();
  const earlyParams = savedCwd ? { cwd: savedCwd } : undefined;
  // Phase 1 (fast): construct the Agent so session list + message reads respond
  // immediately. Phase 2 (slow): MCP/skills. Read-only IPC gates on phase 1,
  // mutations on phase 2 — see EARLY_METHODS above.
  sessionReadyPromise = Promise.race([
    worker
      .request('earlyInit', earlyParams)
      .then(() => {})
      .catch((err) => {
        send('nexus:log', { level: 'error', message: `Core early-init failed: ${err.message}` });
      }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        send('nexus:log', { level: 'warn', message: 'Core early-init timed out; continuing without session reads.' });
        resolve();
      }, 8000);
    }),
  ]);
  // Core init connects MCP/skills and can take 10-20s (or stall on CN-network
  // marketplace/skill fetches). Gate renderer requests on it but NEVER let the
  // gate block the UI forever: resolve on success, on failure, or after a timeout.
  const init = worker
    .request('init', { deferMcp: getDeferMcp(), ...(earlyParams ?? {}) })
    .then(() => true)
    .catch(() => false);
  // Bounded initOkPromise for the auto-restart path (avoids awaiting forever
  // when the core hangs past the gate timeout).
  initOkPromise = Promise.race([
    init,
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 25000);
    }),
  ]);
  readyPromise = Promise.race([
    init.then((ok) => {
      if (ok) send('nexus:log', { level: 'info', message: 'Core ready' });
      else send('nexus:log', { level: 'error', message: 'Core init failed' });
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        send('nexus:log', { level: 'warn', message: 'Core init timed out; continuing without MCP/skills.' });
        resolve();
      }, 20000);
    }),
  ]);
}

function registerIpc(): void {
  const call = (method: string) => async (_e: unknown, params?: Record<string, unknown>) => {
    if (method === 'resolvePermission') logf(`invoke resolvePermission params=${JSON.stringify(params)}`);
    await (EARLY_METHODS_SET.has(method) ? sessionReadyPromise : readyPromise);
    try {
      return await worker!.request(method, params);
    } catch (err) {
      logf(`invoke ${method} error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };

  ipcMain.handle('nexus:chat', call('chat'));
  ipcMain.handle('nexus:regenerate', call('regenerate'));
  ipcMain.handle('nexus:withdraw', call('withdraw'));
  ipcMain.handle('nexus:abort', call('abort'));
  ipcMain.handle('nexus:startSession', call('startSession'));
  ipcMain.handle('nexus:listSessions', call('listSessions'));
  ipcMain.handle('nexus:getMessages', call('getMessages'));
  ipcMain.handle('nexus:getSlashLog', call('getSlashLog'));
  ipcMain.handle('nexus:getSlashLogPath', call('getSlashLogPath'));
  ipcMain.handle('nexus:deleteSession', call('deleteSession'));
  ipcMain.handle('nexus:renameSession', call('renameSession'));
  ipcMain.handle('nexus:getConfig', call('getConfig'));
  ipcMain.handle('nexus:getProviders', call('getProviders'));
  ipcMain.handle('nexus:getStatus', call('getStatus'));
  ipcMain.handle('nexus:getPermissions', call('getPermissions'));
  // Read language straight from config.json instead of routing through the
  // worker: getLanguage is only used to pick the UI language, and the worker is
  // gated behind readyPromise (init can take 10-20s). Waiting would leave the
  // static (zh-CN) HTML on screen until core init finishes, flashing Chinese
  // before switching to the configured language.
  ipcMain.handle('nexus:getLanguage', async (): Promise<string> => {
    try {
      const cfgPath = join(homedir(), '.nexus', 'config.json');
      if (!existsSync(cfgPath)) return 'en';
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { language?: string };
      return typeof cfg.language === 'string' ? cfg.language : 'en';
    } catch {
      return 'en';
    }
  });
  ipcMain.handle('nexus:reloadConfig', call('reloadConfig'));
  ipcMain.handle('nexus:getSpeechVisionConfig', call('getSpeechVisionConfig'));
  ipcMain.handle('nexus:setActiveSpeechProvider', call('setActiveSpeechProvider'));
  ipcMain.handle('nexus:setActiveTtsProvider', call('setActiveTtsProvider'));
  ipcMain.handle('nexus:setActiveVisionProvider', call('setActiveVisionProvider'));
  ipcMain.handle('nexus:saveSpeechProvider', call('saveSpeechProvider'));
  ipcMain.handle('nexus:saveVisionProvider', call('saveVisionProvider'));
  ipcMain.handle('nexus:getSessionStats', call('getSessionStats'));
  ipcMain.handle('nexus:switchProvider', call('switchProvider'));
  ipcMain.handle('nexus:switchModel', call('switchModel'));
  ipcMain.handle('nexus:getModels', call('getModels'));
  ipcMain.handle('nexus:saveProvider', call('saveProvider'));
  ipcMain.handle('nexus:setCwd', async (_e, params) => {
    const res = await call('setCwd')(_e, params);
    const cwd = (res as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd === 'string' && cwd) saveSavedCwd(cwd);
    return res;
  });
  ipcMain.handle('nexus:getDefaultProjectDir', call('getDefaultProjectDir'));
  ipcMain.handle('nexus:getSessionMetadata', call('getSessionMetadata'));
  ipcMain.handle('nexus:setSessionMetadata', call('setSessionMetadata'));
  ipcMain.handle('nexus:respondPermission', call('resolvePermission'));
  ipcMain.handle('nexus:setMcpEnabled', call('setMcpEnabled'));
  ipcMain.handle('nexus:getMcpStatus', call('getMcpStatus'));
  ipcMain.handle('nexus:getMcpServers', call('getMcpServers'));
  ipcMain.handle('nexus:setMcpServer', call('setMcpServer'));

  // Desktop-only startup setting (persisted to ~/.nexus/desktop.json). Takes
  // effect on the next launch — the value is read by startWorker().
  ipcMain.handle('nexus:getDeferMcp', (): boolean => getDeferMcp());
  ipcMain.handle('nexus:setDeferMcp', (_e, enabled: unknown): { ok: boolean } => {
    if (!isBoolean(enabled)) return { ok: false };
    setDeferMcp(enabled);
    return { ok: true };
  });

  // E3: pinned sessions + minimize-to-tray, persisted to desktop.json.
  ipcMain.handle('nexus:getPinned', (): string[] => getPinnedIds());
  ipcMain.handle('nexus:setPinned', (_e, ids: unknown): { ok: boolean } => {
    if (!isValidPathList(ids)) return { ok: false };
    setPinnedIds(ids);
    return { ok: true };
  });
  ipcMain.handle('nexus:getMinimizeToTray', (): boolean => getMinimizeToTray());
  ipcMain.handle('nexus:setMinimizeToTray', (_e, enabled: unknown): { ok: boolean } => {
    if (!isBoolean(enabled)) return { ok: false };
    setMinimizeToTray(enabled);
    return { ok: true };
  });

  // Appearance: input textarea row count.
  ipcMain.handle('nexus:getInputRows', (): number => getInputRows());
  ipcMain.handle('nexus:setInputRows', (_e, rows: unknown): { ok: boolean } => {
    if (!isFiniteNumber(rows)) return { ok: false };
    setInputRows(rows);
    return { ok: true };
  });

  // E4: read recent log lines for the in-app viewer.
  ipcMain.handle('nexus:readRecentLogs', (_e, maxLines: unknown): string[] => {
    const n = isFiniteNumber(maxLines) ? Math.max(1, Math.floor(maxLines)) : 200;
    return recentLogLines(n);
  });

  ipcMain.handle('nexus:openFolder', async (): Promise<{ canceled: boolean; path?: string }> => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open project folder',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('nexus:openFile', async (): Promise<{ canceled: boolean; paths: string[] }> => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      title: '添加附件',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, paths: [] };
    return { canceled: false, paths: result.filePaths };
  });

  ipcMain.handle('nexus:revealFile', (_e, path: unknown): { ok: boolean } => {
    if (isNonEmptyString(path)) shell.showItemInFolder(path);
    return { ok: true };
  });

  // Attachment metadata + inline image preview (≤2 MiB) so the UI can render
  // chips with size and thumbnails without exposing the fs to the renderer.
  ipcMain.handle(
    'nexus:getFileInfos',
    (_e, paths: unknown): Array<{ path: string; name: string; size: number; isImage: boolean; preview?: string }> => {
      if (!isValidPathList(paths)) return [];
      const out: Array<{ path: string; name: string; size: number; isImage: boolean; preview?: string }> = [];
      for (const p of paths) {
        try {
          const st = statSync(p);
          const ext = extname(p).toLowerCase();
          const isImage = IMAGE_EXT.has(ext);
          out.push({
            path: p,
            name: basename(p),
            size: st.size,
            isImage,
            preview: isImage ? imageDataUrl(p) : undefined,
          });
        } catch {}
      }
      return out;
    },
  );

  // Load a local image as a data URL for markdown rendering (hydrateImages).
  ipcMain.handle('nexus:readImagePreview', (_e, path: unknown): string | undefined => {
    if (!isString(path) || path.length === 0 || path.length > 4096) return undefined;
    return imageDataUrl(path);
  });

  ipcMain.handle('nexus:openConfigWeb', async (): Promise<{ ok: boolean; port?: number; error?: string }> => {
    try {
      await openConfigWindow();
      return { ok: true, port: configServer?.port };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Opt-in updates (方案①: manual check → manual download → manual install) ──
  ipcMain.handle('nexus:getUpdateState', () => updater.getState());
  ipcMain.handle('nexus:getCurrentVersion', () => Updater.currentVersion());
  ipcMain.handle('nexus:checkForUpdate', () => updater.check());
  ipcMain.handle('nexus:downloadUpdate', () => updater.download());
  ipcMain.handle('nexus:installUpdate', () => {
    updater.install();
  });
}

if (gotLock) {
  app.whenReady().then(async () => {
    // No default Electron window menu bar in any window (settings/config view
    // should not reuse the app's menu styling).
    Menu.setApplicationMenu(null);
    updater.init();
    updater.onState = (state) => send('nexus:updateState', state);
    createTray();
    startWorker();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // Minimize-to-tray: keep the app alive when the last window closes.
  if (getMinimizeToTray() && !isQuitting) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  intentionallyStopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  worker?.stop();
});
