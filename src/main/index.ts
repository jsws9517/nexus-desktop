import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkerHost } from './worker-host.js';
import { Updater } from './updater.js';
import { ResourceMonitor } from './resource-monitor.js';
import { SessionWorkers } from './session-workers.js';
import { mcpHub } from './mcp-hub.js';
import { createDesktopState } from './desktop-state.js';
import type { AgentEvent } from '../agent-service.js';
import { logger } from '../shared/logger.js';
import { EARLY_METHODS } from '../shared/constants.js';
import { registerIpc } from '../ipc/register.js';
import { CHANNELS } from '../ipc/channels.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function logf(msg: string): void {
  logger.info(msg);
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
// Per-session tab workers (true parallelism). The global `worker` above still
// hosts the shared session/providers/config/MCP surface for the sidebar and
// the settings UI; each opened tab runs its own WorkerHost via this registry.
const sessionWorkers = new SessionWorkers();
const updater = new Updater();
// System resource watchdog for the multi-session protection (see resource-monitor.ts).
const resourceMon = new ResourceMonitor({
  intervalMs: 5000,
  log: (msg) => logf(`resource: ${msg}`),
  // Session tabs + the pre-warmed spare (+1 for the main process).
  getWorkerCount: () => sessionWorkers.residentCount + 1,
});
// Desktop-only settings store (~/.nexus/desktop.json). Single owner of the
// read/write cache; IPC handlers and the bootstrap share this same instance.
const desktopState = createDesktopState();
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
    send(CHANNELS.log, { level: 'error', message: 'Core worker crashed repeatedly; please restart the app.' });
    return;
  }
  const delay = Math.min(30000, 1000 * Math.pow(2, restartAttempts));
  restartAttempts++;
  send(CHANNELS.log, {
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
    send(CHANNELS.workerRestarted, {});
  } else {
    scheduleRestart();
  }
}

// Full config Web UI (reuses core's src/config/web.ts). Started on demand and
// torn down when its BrowserWindow closes so the port is released.
type ConfigServer = { port: number; close: () => Promise<void> };
let configServer: ConfigServer | null = null;
let configWin: BrowserWindow | null = null;

const CONFIG_WEB_PATH = createRequire(import.meta.url).resolve(
  'nexus-coder/dist/src/config/web.js',
);

/**
 * Number of concurrently-open session tabs. In the multi-session design this
 * counts the per-session worker registry; while a single-window/single-worker
 * build is live it reflects that one active worker. Exposed so the resource
 * governor can surface atMax and pause new-tab creation before hitting max.
 */
function countOpenTabs(): number {
  return sessionWorkers.size;
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
  const saved = desktopState.loadWindowBounds();
  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 940,
    minHeight: 600,
    title: 'Nexus Desktop',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1b1e' : '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      v8CacheOptions: 'bypassHeatCheck' as const,
    },
  });

  win.loadFile(join(__dirname, '..', 'static', 'index.html'));
  // Navigation hardening: the window only ever loads the bundled index.html.
  // Block any navigation away from it (the renderer has no legitimate new-doc
  // navigation) and deny all window.open() / target=_blank popups, which would
  // otherwise inherit the privileged preload bridge.
  const mainWin = win;
  mainWin.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWin.webContents.getURL()) {
      event.preventDefault();
      logf(`blocked main-window navigation to ${url}`);
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    logf(`blocked window.open to ${url}`);
    return { action: 'deny' };
  });
  mainWin.webContents.on('console-message', (event) => {
    logf(`renderer[${event.level}]: ${event.message}`);
  });
  win.on('closed', () => {
    win = null;
  });

  // Persist window bounds (debounced) so position/size survive a restart.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return;
    desktopState.saveWindowBounds(win.getNormalBounds());
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
    send(CHANNELS.events, batch);
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
    send(CHANNELS.event, event);
  }
}

// ---- per-session tab event streaming ----
// Tab worker events are tagged with their bound sessionId and streamed on their
// own channels (nexus:tabEvent / nexux:tabEvents) so the renderer can route
// them to the owning tab without the global worker's events colliding.
let tabEventBatch: Array<{ sessionId: string; event: AgentEvent }> = [];
let tabEventBatchTimer: ReturnType<typeof setTimeout> | null = null;
function flushTabEventBatch(): void {
  if (tabEventBatchTimer) {
    clearTimeout(tabEventBatchTimer);
    tabEventBatchTimer = null;
  }
  if (tabEventBatch.length > 0) {
    const batch = tabEventBatch;
    tabEventBatch = [];
    send(CHANNELS.tabEvents, batch);
  }
}
function forwardTabEvent(sessionId: string, event: AgentEvent): void {
  // Parallel request events are now handled directly in the worker process
  // (chatParallel in service.ts handles decomposition and execution locally)
  // So we don't need to forward parallel_request events anymore
  
  if (event.type === 'text' || event.type === 'thinking') {
    tabEventBatch.push({ sessionId, event });
    if (!tabEventBatchTimer) {
      tabEventBatchTimer = setTimeout(flushTabEventBatch, STREAM_BATCH_MS);
    }
  } else {
    flushTabEventBatch();
    send(CHANNELS.tabEvent, { sessionId, event });
  }
}

/**
 * Handle parallel execution request from a worker process.
 * The main process creates the OrchestratorAgent and executes the parallel tasks.
 */
async function handleParallelRequest(sessionId: string, event: { type: string; prompt: string }): Promise<void> {
  const { OrchestratorAgent } = await import('../agent/sub-agent/orchestrator.js');
  const { WorkerHost } = await import('./worker-host.js');
  const { workerScriptPath } = await import('./session-workers.js');
  const { loadConstitution } = await import('../tools/agents.js');
  
  // Send progress event to renderer
  send(CHANNELS.tabEvent, { sessionId, event: { type: 'parallel_start', sessionId, prompt: event.prompt } });
  
  try {
    // Load the project constitution ONCE here, in the main process, and pass
    // the text down into every sub-task prompt (§3.7). The child workers never
    // discover the constitution themselves — the Orchestrator passes it down.
    let constitutionText: string | null = null;
    try {
      const { dir } = await sessionWorkers.request<{ dir: string }>(sessionId, 'getDefaultProjectDir');
      const loaded = await loadConstitution(dir ?? process.cwd());
      if (loaded.reason === 'ok' && loaded.text) constitutionText = loaded.text;
    } catch {
      // Constitution is best-effort for parallel runs; never block the run.
    }

    const orchestrator = new OrchestratorAgent(
      null, // No AgentService in main process - use fallback decomposition
      {
        workerFactory: (scriptPath: string) => new WorkerHost(scriptPath),
        workerScriptPath: workerScriptPath(),
      }
    );
    
    const result = await orchestrator.orchestrate(event.prompt, sessionId, constitutionText ?? undefined);
    
    send(CHANNELS.tabEvent, { 
      sessionId, 
      event: { 
        type: 'parallel_end', 
        sessionId,
        tasks: result.tasks,
        tokenUsage: result.tokenUsage
      } 
    });
    
    // Output the aggregated result
    if (result.output) {
      send(CHANNELS.tabEvent, { 
        sessionId, 
        event: { type: 'text', text: result.output } 
      });
    }
  } catch (error) {
    send(CHANNELS.tabEvent, { 
      sessionId, 
      event: { 
        type: 'parallel_error', 
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      } 
    });
  }
}

function wireSessionWorkers(): void {
  sessionWorkers.onEvent = forwardTabEvent;
  sessionWorkers.onPermission = (sessionId, req) => {
    send(CHANNELS.permission, { ...req, sessionId });
  };
  sessionWorkers.onLog = (level, message) => send(CHANNELS.log, { level, message });
  sessionWorkers.onChange = () => {
    // Any tab open/close/hot-swap re-evaluates whether the tab ceiling is hit.
    resourceMon.setAtMax(countOpenTabs() >= desktopState.getMaxTabs());
    send(CHANNELS.tabsChanged, sessionWorkers.tabs());
  };
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
    // Navigation hardening: the config window only ever loads the localhost
    // config server bound to this process. Block navigation to any other origin
    // and deny popups, which would otherwise inherit the app's IPC surface.
    const configOrigin = `http://localhost:${port}`;
    configWin.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(configOrigin)) {
        event.preventDefault();
        console.error(`blocked config-window navigation to ${url}`);
      }
    });
    configWin.webContents.setWindowOpenHandler(({ url }) => {
      console.error(`blocked config-window popup to ${url}`);
      return { action: 'deny' };
    });
    configWin.on('closed', () => {
      configWin = null;
      // Free the port immediately when the settings window is closed.
      const server = configServer;
      configServer = null;
      void server?.close().catch(() => {});
      // The config Web UI may have written to ~/.nexus/config.json (language,
      // providers, etc.). Have the renderer reload core config + re-apply i18n.
      //
      // Every session worker keeps its own long-lived in-memory ConfigManager.
      // If one of them saved a stale copy (e.g. a provider that was just deleted
      // here), it would silently overwrite the shared file and the deleted entry
      // would re-appear in the UI. Reload all session workers FIRST so no stale
      // in-memory provider list is left to clobber disk.
      void sessionWorkers.reloadAll().finally(() => {
        send(CHANNELS.configWindowClosed, {});
      });
    });
  } catch (err) {
    console.error('Failed to open config web UI:', err);
  }
}

function startWorker(): void {
  worker = new WorkerHost(workerPath());
  worker.onEvent = forwardEvent;
  worker.onPermission = (req) => send(CHANNELS.permission, req);
  worker.onLog = (level, message) => send(CHANNELS.log, { level, message });
  worker.onMcpRequest = (op, params) => mcpHub.handle(op, params);
  worker.onExit = (code) => {
    send(CHANNELS.log, { level: 'warn', message: `Core worker exited (code=${code})` });
    scheduleRestart();
  };
  worker.start();
  const savedCwd = desktopState.loadSavedCwd();
  const earlyParams = savedCwd ? { cwd: savedCwd } : undefined;
  // Phase 1 (fast): construct the Agent so session list + message reads respond
  // immediately. Phase 2 (slow): MCP/skills. Read-only IPC gates on phase 1,
  // mutations on phase 2 — see EARLY_METHODS above.
  sessionReadyPromise = Promise.race([
    worker
      .request('earlyInit', earlyParams)
      .then(() => {})
      .catch((err) => {
        send(CHANNELS.log, { level: 'error', message: `Core early-init failed: ${err.message}` });
      }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        send(CHANNELS.log, { level: 'warn', message: 'Core early-init timed out; continuing without session reads.' });
        resolve();
      }, 8000);
    }),
  ]);
  // Core init connects MCP/skills and can take 10-20s (or stall on CN-network
  // marketplace/skill fetches). Gate renderer requests on it but NEVER let the
  // gate block the UI forever: resolve on success, on failure, or after a timeout.
  const init = worker
    .request('init', { deferMcp: desktopState.getDeferMcp(), ...(earlyParams ?? {}) })
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
      if (ok) send(CHANNELS.log, { level: 'info', message: 'Core ready' });
      else send(CHANNELS.log, { level: 'error', message: 'Core init failed' });
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        send(CHANNELS.log, { level: 'warn', message: 'Core init timed out; continuing without MCP/skills.' });
        resolve();
      }, 20000);
    }),
  ]);
}

if (gotLock) {
  app.whenReady().then(async () => {
    // No default Electron window menu bar in any window (settings/config view
    // should not reuse the app's menu styling).
    Menu.setApplicationMenu(null);
    updater.init();
    updater.onState = (state) => send(CHANNELS.updateState, state);
    createTray();
    startWorker();
    wireSessionWorkers();
    // Kick the shared MCP hub (single owner of all MCP server processes).
    void mcpHub.ensureConnected().catch(() => {});
    desktopState.applyResourceConfig(resourceMon);
    resourceMon.onState = (state) => send(CHANNELS.resourceState, state);
    resourceMon.setAtMax(countOpenTabs() >= desktopState.getMaxTabs());
    // Pre-warmed spare worker: a session-unbound process ready to become the next
    // tab (avoids a cold spawn + Agent construction on open). Never attached to a
    // session until bound, so it cannot carry an in-flight turn. Gated on resource
    // health + tab headroom; reused by the open()/close() top-up paths.
    sessionWorkers.canWarm = () =>
      desktopState.getLazyWorker() &&
      resourceMon.getState().status !== 'overloaded' &&
      sessionWorkers.size < desktopState.getMaxTabs();
    resourceMon.start();
    void sessionWorkers.warmSpare();
    registerIpc({
      worker,
      sessionWorkers,
      resourceMon,
      updater,
      fullReady: () => readyPromise,
      earlyReady: () => sessionReadyPromise,
      earlyMethods: EARLY_METHODS,
      getBrowserWindow: () => win,
      openConfigWindow,
      configPort: () => configServer?.port,
      saveSavedCwd: desktopState.saveSavedCwd,
      applyResourceConfig: desktopState.applyResourceConfig,
      countOpenTabs,
      log: logf,
      getDeferMcp: desktopState.getDeferMcp,
      setDeferMcp: desktopState.setDeferMcp,
      getPinnedIds: desktopState.getPinnedIds,
      setPinnedIds: desktopState.setPinnedIds,
      getMinimizeToTray: desktopState.getMinimizeToTray,
      setMinimizeToTray: desktopState.setMinimizeToTray,
      getRestoreSessionOnLaunch: desktopState.getRestoreSessionOnLaunch,
      setRestoreSessionOnLaunch: desktopState.setRestoreSessionOnLaunch,
      getLastOpenTabs: desktopState.getLastOpenTabs,
      setLastOpenTabs: desktopState.setLastOpenTabs,
      getInputRows: desktopState.getInputRows,
      setInputRows: desktopState.setInputRows,
      getMaxTabs: desktopState.getMaxTabs,
      setMaxTabs: desktopState.setMaxTabs,
      getMemThresholdPct: desktopState.getMemThresholdPct,
      setMemThresholdPct: desktopState.setMemThresholdPct,
      getCpuThresholdPct: desktopState.getCpuThresholdPct,
      setCpuThresholdPct: desktopState.setCpuThresholdPct,
      getMonitorEnabled: desktopState.getMonitorEnabled,
      setMonitorEnabled: desktopState.setMonitorEnabled,
      getLazyWorker: desktopState.getLazyWorker,
      setLazyWorker: desktopState.setLazyWorker,
    });
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // Minimize-to-tray: keep the app alive when the last window closes.
  if (desktopState.getMinimizeToTray() && !isQuitting) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  intentionallyStopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  resourceMon.stop();
  desktopState.setLastOpenTabs(sessionWorkers.tabs().map((t) => t.sessionId));
  sessionWorkers.closeAll();
  worker?.stop();
});
