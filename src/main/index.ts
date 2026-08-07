import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { WorkerHost } from './worker-host.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function logf(msg: string): void {
  try {
    appendFileSync('C:/Users/pgw/AppData/Local/Temp/opencode/main.log', `${Date.now()} ${msg}\n`);
  } catch {}
}

// Single-instance lock: regenerate() truncates the session DB directly, so two
// windows on the same data dir must never run concurrently (context + DB would
// desync). A second launch focuses the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

let win: BrowserWindow | null = null;
let worker: WorkerHost | null = null;
let readyPromise: Promise<void> = Promise.resolve();
// Phase-1 readiness (Agent constructed): read-only session/config IPC can run
// while MCP/skills are still connecting in the background (see startWorker()).
let sessionReadyPromise: Promise<void> = Promise.resolve();

// IPC methods that only need the core's session/config layer and therefore gate
// on sessionReadyPromise (fast) instead of the full init (slow).
const EARLY_METHODS = new Set<string>([
  'listSessions', 'getMessages', 'getConfig', 'getProviders', 'getStatus',
  'getPermissions', 'getSpeechVisionConfig', 'getSessionStats',
  'getMcpServers', 'getMcpStatus',
]);

// Full config Web UI (reuses core's src/config/web.ts). Started on demand and
// torn down when its BrowserWindow closes so the port is released.
type ConfigServer = { port: number; close: () => Promise<void> };
let configServer: ConfigServer | null = null;
let configWin: BrowserWindow | null = null;

const CONFIG_WEB_PATH = createRequire(import.meta.url).resolve(
  '@jsws9517/nexus-core/dist/src/config/web.js',
);

function workerPath(): string {
  return join(__dirname, '..', 'agent-worker.js');
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
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
  };
  worker.start();
  // Phase 1 (fast): construct the Agent so session list + message reads respond
  // immediately. Phase 2 (slow): MCP/skills. Read-only IPC gates on phase 1,
  // mutations on phase 2 — see EARLY_METHODS above.
  sessionReadyPromise = Promise.race([
    worker
      .request('earlyInit')
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
  readyPromise = Promise.race([
    worker
      .request('init')
      .then(() => {
        send('nexus:log', { level: 'info', message: 'Core ready' });
      })
      .catch((err) => {
        send('nexus:log', { level: 'error', message: `Core init failed: ${err.message}` });
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
    await (EARLY_METHODS.has(method) ? sessionReadyPromise : readyPromise);
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
  ipcMain.handle('nexus:setCwd', call('setCwd'));
  ipcMain.handle('nexus:respondPermission', call('resolvePermission'));
  ipcMain.handle('nexus:setMcpEnabled', call('setMcpEnabled'));
  ipcMain.handle('nexus:getMcpStatus', call('getMcpStatus'));
  ipcMain.handle('nexus:getMcpServers', call('getMcpServers'));
  ipcMain.handle('nexus:setMcpServer', call('setMcpServer'));

  ipcMain.handle('nexus:openFolder', async (): Promise<{ canceled: boolean; path?: string }> => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open project folder',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('nexus:openFile', async (): Promise<{ canceled: boolean; path?: string }> => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      title: '添加附件',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('nexus:openConfigWeb', async (): Promise<{ ok: boolean; port?: number; error?: string }> => {
    try {
      await openConfigWindow();
      return { ok: true, port: configServer?.port };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

if (gotLock) {
  app.whenReady().then(async () => {
    // No default Electron window menu bar in any window (settings/config view
    // should not reuse the app's menu styling).
    Menu.setApplicationMenu(null);
    startWorker();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  worker?.stop();
});
