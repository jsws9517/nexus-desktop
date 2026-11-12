import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  chat: (input: string, opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:chat', { input, ...(opts ?? {}) }),
  // Mid-turn follow-up: merged into the running turn's context. Resolves false
  // when the turn had already ended, so the caller keeps the message queued.
  // `rollback` additionally discards the interrupted attempt (destructive).
  steer: (input: string, opts?: { sessionId?: string; rollback?: boolean }) =>
    ipcRenderer.invoke('nexus:steer', { input, ...(opts ?? {}) }),
  // Undo a rollback from a backup the core wrote under ~/.nexus/trash/rollback/.
  restore: (backupPath: string, opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:restore', { backupPath, ...(opts ?? {}) }),
  // Isolated scratch chat: worker completes the renderer-held transcript on a
  // throwaway AgentService — never the session's worker, never its context/db.
  sideChat: (messages: Array<{ role: string; content: string }>) =>
    ipcRenderer.invoke('nexus:sideChat', { messages }),
  regenerate: (sessionId: string, userIndex: number) =>
    ipcRenderer.invoke('nexus:regenerate', { sessionId, userIndex }),
  withdraw: (sessionId: string, userIndex: number) =>
    ipcRenderer.invoke('nexus:withdraw', { sessionId, userIndex }),
  abort: (opts?: { sessionId?: string }) => ipcRenderer.invoke('nexus:abort', opts ?? {}),
  startSession: (name?: string, sessionId?: string) =>
    ipcRenderer.invoke('nexus:startSession', { name, sessionId }),
  listSessions: (options?: { limit?: number; offset?: number; excludeMock?: boolean; excludeEmpty?: boolean }) =>
    ipcRenderer.invoke('nexus:listSessions', options),
  getMessages: (sessionId: string, options?: { last?: number; limit?: number; offset?: number }) =>
    ipcRenderer.invoke('nexus:getMessages', { sessionId, ...(options ?? {}) }),
  getSlashLog: (sessionId: string) => ipcRenderer.invoke('nexus:getSlashLog', { sessionId }),
  getSlashLogPath: (sessionId: string) => ipcRenderer.invoke('nexus:getSlashLogPath', { sessionId }),
  deleteSession: (id: string) => ipcRenderer.invoke('nexus:deleteSession', { id }),
  renameSession: (id: string, name: string) =>
    ipcRenderer.invoke('nexus:renameSession', { id, name }),
  getConfig: () => ipcRenderer.invoke('nexus:getConfig'),
  getProviders: () => ipcRenderer.invoke('nexus:getProviders'),
  getStatus: (opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:getStatus', opts ?? {}),
  getPermissions: () => ipcRenderer.invoke('nexus:getPermissions'),
  getLanguage: () => ipcRenderer.invoke('nexus:getLanguage'),
  reloadConfig: () => ipcRenderer.invoke('nexus:reloadConfig'),
  getSpeechVisionConfig: () => ipcRenderer.invoke('nexus:getSpeechVisionConfig'),
  setActiveSpeechProvider: (name: string) => ipcRenderer.invoke('nexus:setActiveSpeechProvider', { name }),
  setActiveTtsProvider: (name: string) => ipcRenderer.invoke('nexus:setActiveTtsProvider', { name }),
  setActiveVisionProvider: (name: string) => ipcRenderer.invoke('nexus:setActiveVisionProvider', { name }),
  saveSpeechProvider: (name: string, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('nexus:saveSpeechProvider', { name, fields }),
  saveVisionProvider: (name: string, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('nexus:saveVisionProvider', { name, fields }),
  getSessionStats: (sessionId: string) => ipcRenderer.invoke('nexus:getSessionStats', { sessionId }),
  switchProvider: (name: string, opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:switchProvider', { name, ...(opts ?? {}) }),
  switchModel: (modelId: string, opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:switchModel', { modelId, ...(opts ?? {}) }),
  getModels: (providerName?: string, opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:getModels', { providerName, ...(opts ?? {}) }) as Promise<{
      models: string[];
      ok: boolean;
      error?: string;
    }>,
  saveProvider: (name: string, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('nexus:saveProvider', { name, fields }),
  setCwd: (cwd: string, opts?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:setCwd', { cwd, ...(opts ?? {}) }),
  getDefaultProjectDir: () => ipcRenderer.invoke('nexus:getDefaultProjectDir'),
  getSessionMetadata: (sessionId: string) => ipcRenderer.invoke('nexus:getSessionMetadata', { sessionId }),
  setSessionMetadata: (sessionId: string, metadata: Record<string, unknown>) =>
    ipcRenderer.invoke('nexus:setSessionMetadata', { sessionId, metadata }),
  openFolder: () => ipcRenderer.invoke('nexus:openFolder'),
  openFile: () => ipcRenderer.invoke('nexus:openFile'),
  // One-time attachment RAG (separate from the `+` attach flow).
  ragIngest: (sessionId: string, paths: string[]) => ipcRenderer.invoke('nexus:ragIngest', { sessionId, paths }),
  ragRemove: (sessionId: string, path: string) => ipcRenderer.invoke('nexus:ragRemove', { sessionId, path }),
  ragClear: (sessionId: string) => ipcRenderer.invoke('nexus:ragClear', { sessionId }),
  ragStatus: (sessionId: string) => ipcRenderer.invoke('nexus:ragStatus', { sessionId }),
  ragCapabilities: () => ipcRenderer.invoke('nexus:ragCapabilities'),
  ragPickFile: () => ipcRenderer.invoke('nexus:ragPickFile'),
  revealFile: (path: string) => ipcRenderer.invoke('nexus:revealFile', path),
  getFileInfos: (paths: string[]) => ipcRenderer.invoke('nexus:getFileInfos', paths),
  listDirectory: (root: string, path: string) =>
    ipcRenderer.invoke('nexus:listDirectory', { root, path }) as Promise<{ ok: boolean; entries?: Array<{ name: string; type: 'file' | 'directory'; size: number }>; truncated?: boolean; error?: string }>,
  openExternalFile: (path: string) =>
    ipcRenderer.invoke('nexus:openExternalFile', path) as Promise<{ ok: boolean; error?: string }>,
  openInEditor: (path: string) =>
    ipcRenderer.invoke('nexus:openInEditor', path) as Promise<{ ok: boolean; error?: string }>,
  getGitStatus: (root: string) =>
    ipcRenderer.invoke('nexus:getGitStatus', root) as Promise<{
      ok: boolean;
      isRepo: boolean;
      branch?: string;
      statuses?: Array<{ path: string; state: 'untracked' | 'modified' | 'ignored' }>;
      error?: string;
    }>,
  readImagePreview: (path: string) => ipcRenderer.invoke('nexus:readImagePreview', path),
  // Paste image from system clipboard (consistent with coder-core ALT+V).
  pasteImage: () => ipcRenderer.invoke('nexus:pasteImage') as Promise<{ path: string; preview: string } | null>,
  // Linux-style clipboard actions: write a transcript selection, or replay the
  // native paste command into the focused composer (right-click paste).
  writeClipboard: (text: string) => ipcRenderer.invoke('nexus:writeClipboard', { text }) as Promise<{ ok: boolean }>,
  pasteClipboard: () => ipcRenderer.invoke('nexus:pasteClipboard') as Promise<{ ok: boolean }>,
  // Export an artifact payload (base64 bytes or text) via a save dialog.
  saveArtifact: (defaultName: string, data: string, encoding?: 'base64' | 'text') =>
    ipcRenderer.invoke('nexus:saveArtifact', { defaultName, data, encoding }) as Promise<{ ok: boolean; path?: string; error?: string }>,
  // Resolve a dropped/pasted File to its real path (Electron webUtils).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openConfigWeb: () => ipcRenderer.invoke('nexus:openConfigWeb'),
  respondPermission: (id: string, answer: string, sessionId?: string) =>
    ipcRenderer.invoke('nexus:respondPermission', { id, answer, sessionId }),
  setMcpEnabled: (enabled: boolean) => ipcRenderer.invoke('nexus:setMcpEnabled', { enabled }),
  getMcpStatus: () => ipcRenderer.invoke('nexus:getMcpStatus'),
  getMcpServers: () => ipcRenderer.invoke('nexus:getMcpServers'),
  setMcpServer: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('nexus:setMcpServer', { name, enabled }),
  getDeferMcp: () => ipcRenderer.invoke('nexus:getDeferMcp'),
  setDeferMcp: (enabled: boolean) => ipcRenderer.invoke('nexus:setDeferMcp', enabled),
  getIntentRecognition: () => ipcRenderer.invoke('nexus:getIntentRecognition') as Promise<boolean>,
  getPinned: () => ipcRenderer.invoke('nexus:getPinned'),
  setPinned: (ids: string[]) => ipcRenderer.invoke('nexus:setPinned', ids),
  getMinimizeToTray: () => ipcRenderer.invoke('nexus:getMinimizeToTray'),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('nexus:setMinimizeToTray', enabled),
  getRestoreSessionOnLaunch: () => ipcRenderer.invoke('nexus:getRestoreSessionOnLaunch'),
  setRestoreSessionOnLaunch: (enabled: boolean) => ipcRenderer.invoke('nexus:setRestoreSessionOnLaunch', enabled),
  getLastOpenTabs: () => ipcRenderer.invoke('nexus:getLastOpenTabs') as Promise<string[]>,
  setLastOpenTabs: (ids: string[]) => ipcRenderer.invoke('nexus:setLastOpenTabs', ids),
  setDepthOverride: (level: string) => ipcRenderer.invoke('nexus:setDepthOverride', { level }),
  getActiveDepth: () => ipcRenderer.invoke('nexus:getActiveDepth') as Promise<string>,
  setPermissionsOverride: (mode: string) => ipcRenderer.invoke('nexus:setPermissionsOverride', { mode }),
  getActiveMode: () => ipcRenderer.invoke('nexus:getActiveMode') as Promise<string>,
  getInputRows: () => ipcRenderer.invoke('nexus:getInputRows'),
  setInputRows: (rows: number) => ipcRenderer.invoke('nexus:setInputRows', rows),
  readRecentLogs: (maxLines?: number) => ipcRenderer.invoke('nexus:readRecentLogs', maxLines),
  getGlobalRulesPath: () =>
    ipcRenderer.invoke('nexus:getGlobalRulesPath') as Promise<{ ok: boolean; path: string }>,
  resetGlobalRules: () =>
    ipcRenderer.invoke('nexus:resetGlobalRules') as Promise<{ ok: boolean; path: string; backup?: string }>,

  // Background jobs — core bg_ shell jobs (worker-local JobManager).
  coreBgList: (params?: { sessionId?: string }) =>
    ipcRenderer.invoke('nexus:coreBgList', params ?? {}) as Promise<{ ok: boolean; jobs?: unknown[]; error?: string }>,
  coreBgKill: (jobId: string, sessionId?: string) =>
    ipcRenderer.invoke('nexus:coreBgKill', { jobId, sessionId }) as Promise<{ ok: boolean; text?: string; error?: string }>,
  coreBgTail: (jobId: string, lines?: number, sessionId?: string) =>
    ipcRenderer.invoke('nexus:coreBgTail', { jobId, lines, sessionId }) as Promise<{ ok: boolean; text?: string; error?: string }>,
  coreBgRemove: (jobId: string, sessionId?: string) =>
    ipcRenderer.invoke('nexus:coreBgRemove', { jobId, sessionId }) as Promise<{ ok: boolean; text?: string; error?: string }>,

  // P0 preview subsystem (main-process owned).
  previewOpen: (path: string) =>
    ipcRenderer.invoke('nexus:previewOpen', { path }) as Promise<{
      ok: boolean; token?: string; url?: string; kind?: string; mime?: string; size?: number; name?: string; error?: string;
    }>,
  previewClose: (token: string) =>
    ipcRenderer.invoke('nexus:previewClose', { token }) as Promise<{ ok: boolean; error?: string }>,
  previewRead: (token: string, maxBytes?: number) =>
    ipcRenderer.invoke('nexus:previewRead', { token, maxBytes }) as Promise<{
      ok: boolean; text?: string; truncated?: boolean; error?: string;
    }>,

  // PR2 browser tab — WebContentsView manager (main-process owned, isolated
  // session partition; local files bypass this via the nexus-preview iframe).
  webviewOpen: (url: string, bounds: { x: number; y: number; width: number; height: number }, viewId?: string, hidden?: boolean) =>
    ipcRenderer.invoke('nexus:webviewOpen', { url, bounds, viewId, hidden }) as Promise<{
      ok: boolean; viewId?: string; error?: string;
    }>,
  webviewBack: (viewId: string) =>
    ipcRenderer.invoke('nexus:webviewBack', { viewId }) as Promise<{ ok: boolean; error?: string }>,
  webviewForward: (viewId: string) =>
    ipcRenderer.invoke('nexus:webviewForward', { viewId }) as Promise<{ ok: boolean; error?: string }>,
  webviewReload: (viewId: string) =>
    ipcRenderer.invoke('nexus:webviewReload', { viewId }) as Promise<{ ok: boolean; error?: string }>,
  webviewClose: (viewId: string) =>
    ipcRenderer.invoke('nexus:webviewClose', { viewId }) as Promise<{ ok: boolean; error?: string }>,
  webviewBounds: (bounds: { x: number; y: number; width: number; height: number }, hidden?: boolean) =>
    ipcRenderer.invoke('nexus:webviewBounds', { bounds, hidden }) as Promise<{ ok: boolean }>,

  // T6 automation control plane (main-process owned; store lives in the
  // automation DB, no worker round-trip).
  automationList: () =>
    ipcRenderer.invoke('nexus:automationList') as Promise<{ ok: boolean; automations?: unknown[]; error?: string }>,
  automationUpsert: (params: {
    id?: string;
    name?: string;
    enabled?: boolean;
    schedule?: unknown;
    prompt?: string;
    cwd?: string;
    profile?: string;
    provider?: string;
    model?: string;
    missPolicy?: string;
  }) =>
    ipcRenderer.invoke('nexus:automationUpsert', params) as Promise<{ ok: boolean; id?: string; error?: string }>,
  automationDelete: (id: string) =>
    ipcRenderer.invoke('nexus:automationDelete', { id }) as Promise<{ ok: boolean; error?: string }>,
  automationRunNow: (id: string) =>
    ipcRenderer.invoke('nexus:automationRunNow', { id }) as Promise<{ ok: boolean; runId?: string; reason?: string; error?: string }>,
  automationRuns: (params?: { id?: string; limit?: number }) =>
    ipcRenderer.invoke('nexus:automationRuns', params ?? {}) as Promise<{ ok: boolean; runs?: unknown[]; error?: string }>,

  // Resource / session governance (desktop.json + live watchdog).
  getMaxTabs: () => ipcRenderer.invoke('nexus:getMaxTabs'),
  setMaxTabs: (n: number) => ipcRenderer.invoke('nexus:setMaxTabs', n),
  getMemThreshold: () => ipcRenderer.invoke('nexus:getMemThreshold'),
  setMemThreshold: (n: number) => ipcRenderer.invoke('nexus:setMemThreshold', n),
  getCpuThreshold: () => ipcRenderer.invoke('nexus:getCpuThreshold'),
  setCpuThreshold: (n: number) => ipcRenderer.invoke('nexus:setCpuThreshold', n),
  getMonitorEnabled: () => ipcRenderer.invoke('nexus:getMonitorEnabled'),
  setMonitorEnabled: (enabled: boolean) => ipcRenderer.invoke('nexus:setMonitorEnabled', enabled),
  getLazyWorker: () => ipcRenderer.invoke('nexus:getLazyWorker'),
  setLazyWorker: (enabled: boolean) => ipcRenderer.invoke('nexus:setLazyWorker', enabled),
  getPanelIdleMs: () => ipcRenderer.invoke('nexus:getPanelIdleMs'),
  setPanelIdleMs: (ms: number) => ipcRenderer.invoke('nexus:setPanelIdleMs', ms),
  getLinuxClipboard: () => ipcRenderer.invoke('nexus:getLinuxClipboard') as Promise<boolean>,
  setLinuxClipboard: (enabled: boolean) =>
    ipcRenderer.invoke('nexus:setLinuxClipboard', enabled) as Promise<{ ok: boolean }>,
  getAllowBetaUpdates: () => ipcRenderer.invoke('nexus:getAllowBetaUpdates') as Promise<boolean>,
  setAllowBetaUpdates: (enabled: boolean) =>
    ipcRenderer.invoke('nexus:setAllowBetaUpdates', enabled) as Promise<{ ok: boolean }>,
  getResourceState: () => ipcRenderer.invoke('nexus:getResourceState'),
  getRateLimitStatus: () => ipcRenderer.invoke('nexus:getRateLimitStatus'),

  // Multi-tab: per-session worker lifecycle.
  openSession: (sessionId: string, cwd?: string) =>
    ipcRenderer.invoke('nexus:openSession', { sessionId, cwd }),
  // Create a brand-new session in a fresh worker (/new), optionally carrying
  // the parent session's project memory forward.
  openNewSession: (opts?: { cwd?: string; prevSessionId?: string }) =>
    ipcRenderer.invoke('nexus:openNewSession', opts ?? {}),
  closeSession: (sessionId: string) =>
    ipcRenderer.invoke('nexus:closeSession', { sessionId }),
  getOpenTabs: () => ipcRenderer.invoke('nexus:getOpenTabs'),
  getTabStatus: (sessionId: string) =>
    ipcRenderer.invoke('nexus:getTabStatus', { sessionId }),

  getUpdateState: () => ipcRenderer.invoke('nexus:getUpdateState'),
  getCurrentVersion: () => ipcRenderer.invoke('nexus:getCurrentVersion'),
  getCoreVersion: () => ipcRenderer.invoke('nexus:getCoreVersion'),
  checkForUpdate: () => ipcRenderer.invoke('nexus:checkForUpdate'),
  downloadUpdate: () => ipcRenderer.invoke('nexus:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('nexus:installUpdate'),

  // Core overlay updates (phase 2).
  getCoreUpdateState: () => ipcRenderer.invoke('nexus:getCoreUpdateState'),
  checkCoreUpdate: () => ipcRenderer.invoke('nexus:checkCoreUpdate'),
  downloadCoreUpdate: () => ipcRenderer.invoke('nexus:downloadCoreUpdate'),
  activateCoreUpdate: () => ipcRenderer.invoke('nexus:activateCoreUpdate'),
  cancelCoreDownload: () => ipcRenderer.invoke('nexus:cancelCoreDownload'),
  onCoreUpdateState: (cb: (state: Record<string, unknown>) => void) => {
    ipcRenderer.on('nexus:coreUpdateState', (_e, state) => cb(state));
  },

  onEvent: (cb: (event: unknown) => void) => {
    ipcRenderer.on('nexus:event', (_e, event) => cb(event));
  },
  onEvents: (cb: (events: unknown[]) => void) => {
    ipcRenderer.on('nexus:events', (_e, events) => cb(events));
  },
  onPermission: (cb: (req: { id: string; question: string; sessionId?: string }) => void) => {
    ipcRenderer.on('nexus:permission', (_e, req) => cb(req));
  },
  onLog: (cb: (log: { level: string; message: string }) => void) => {
    ipcRenderer.on('nexus:log', (_e, log) => cb(log));
  },
  onConfigWindowClosed: (cb: () => void) => {
    ipcRenderer.on('nexus:configWindowClosed', () => cb());
  },
  onWorkerRestarted: (cb: () => void) => {
    ipcRenderer.on('nexus:workerRestarted', () => cb());
  },
  onResourceState: (cb: (state: unknown) => void) => {
    ipcRenderer.on('nexus:resourceState', (_e, state) => cb(state));
  },
  onTabEvent: (cb: (payload: { sessionId: string; event: unknown }) => void) => {
    ipcRenderer.on('nexus:tabEvent', (_e, payload) => cb(payload));
  },
  onTabEvents: (cb: (payloads: Array<{ sessionId: string; event: unknown }>) => void) => {
    ipcRenderer.on('nexus:tabEvents', (_e, payloads) => cb(payloads));
  },
  onTabsChanged: (cb: (tabs: Array<{ sessionId: string; provider: string; model: string; busy: boolean }>) => void) => {
    ipcRenderer.on('nexus:tabsChanged', (_e, tabs) => cb(tabs));
  },
  onRateLimitUpdate: (cb: (data: { providers: Array<{ family: string; providerName: string; baseUrl: string; rpm: number; recentRequests: number; backoffMs: number; status: string }> }) => void) => {
    ipcRenderer.on('nexus:rateLimitUpdate', (_e, data) => cb(data));
  },
  onUpdateState: (cb: (state: Record<string, unknown>) => void) => {
    ipcRenderer.on('nexus:updateState', (_e, state) => cb(state));
  },
  onWebviewEvent: (
    cb: (ev: {
      viewId: string;
      type: 'loading' | 'loaded' | 'navigated' | 'title' | 'fallback';
      url?: string;
      title?: string;
      canGoBack?: boolean;
      canGoForward?: boolean;
      error?: string;
    }) => void,
  ) => {
    ipcRenderer.on('nexus:webviewEvent', (_e, ev) => cb(ev));
  },
  blacklistRead: () => ipcRenderer.invoke('nexus:blacklistRead'),
  blacklistWrite: (data: Record<string, Record<string, string>>) => ipcRenderer.invoke('nexus:blacklistWrite', data),
};

contextBridge.exposeInMainWorld('nexusDesktop', api);

export type NexusDesktopApi = typeof api;
