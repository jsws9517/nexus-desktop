import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { WorkerHost } from './worker-host.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function logf(msg: string): void {
  try {
    appendFileSync('C:/Users/pgw/AppData/Local/Temp/opencode/main.log', `${Date.now()} ${msg}\n`);
  } catch {}
}

let win: BrowserWindow | null = null;
let worker: WorkerHost | null = null;
let readyPromise: Promise<void> = Promise.resolve();

// Full config Web UI (reuses core's src/config/web.ts). Started on demand and
// torn down when its BrowserWindow closes so the port is released.
type ConfigServer = { port: number; close: () => Promise<void> };
let configServer: ConfigServer | null = null;
let configWin: BrowserWindow | null = null;

const CONFIG_WEB_PATH = join(
  __dirname, '..', '..', 'vendor', 'core', 'src', 'config', 'web.js'
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
    });
  } catch (err) {
    console.error('Failed to open config web UI:', err);
  }
}

function startWorker(): void {
  worker = new WorkerHost(workerPath());
  worker.onEvent = (event) => send('nexus:event', event);
  worker.onPermission = (req) => send('nexus:permission', req);
  worker.onLog = (level, message) => send('nexus:log', { level, message });
  worker.onExit = (code) => {
    send('nexus:log', { level: 'warn', message: `Core worker exited (code=${code})` });
  };
  worker.start();
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
    await readyPromise;
    try {
      return await worker!.request(method, params);
    } catch (err) {
      logf(`invoke ${method} error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };

  ipcMain.handle('nexus:chat', call('chat'));
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
  ipcMain.handle('nexus:getLanguage', call('getLanguage'));
  ipcMain.handle('nexus:getSpeechVisionConfig', call('getSpeechVisionConfig'));
  ipcMain.handle('nexus:setActiveSpeechProvider', call('setActiveSpeechProvider'));
  ipcMain.handle('nexus:setActiveTtsProvider', call('setActiveTtsProvider'));
  ipcMain.handle('nexus:setActiveVisionProvider', call('setActiveVisionProvider'));
  ipcMain.handle('nexus:saveSpeechProvider', call('saveSpeechProvider'));
  ipcMain.handle('nexus:saveVisionProvider', call('saveVisionProvider'));
  ipcMain.handle('nexus:getSessionStats', call('getSessionStats'));
  ipcMain.handle('nexus:switchProvider', call('switchProvider'));
  ipcMain.handle('nexus:switchModel', call('switchModel'));
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  worker?.stop();
});
