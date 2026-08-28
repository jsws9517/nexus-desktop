import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  chat: (input: string) => ipcRenderer.invoke('nexus:chat', { input }),
  regenerate: (sessionId: string, userIndex: number) =>
    ipcRenderer.invoke('nexus:regenerate', { sessionId, userIndex }),
  withdraw: (sessionId: string, userIndex: number) =>
    ipcRenderer.invoke('nexus:withdraw', { sessionId, userIndex }),
  abort: () => ipcRenderer.invoke('nexus:abort'),
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
  getStatus: () => ipcRenderer.invoke('nexus:getStatus'),
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
  switchProvider: (name: string) => ipcRenderer.invoke('nexus:switchProvider', { name }),
  switchModel: (modelId: string) => ipcRenderer.invoke('nexus:switchModel', { modelId }),
  getModels: (providerName?: string) => ipcRenderer.invoke('nexus:getModels', { providerName }),
  saveProvider: (name: string, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('nexus:saveProvider', { name, fields }),
  setCwd: (cwd: string) => ipcRenderer.invoke('nexus:setCwd', { cwd }),
  openFolder: () => ipcRenderer.invoke('nexus:openFolder'),
  openFile: () => ipcRenderer.invoke('nexus:openFile'),
  revealFile: (path: string) => ipcRenderer.invoke('nexus:revealFile', path),
  getFileInfos: (paths: string[]) => ipcRenderer.invoke('nexus:getFileInfos', paths),
  readImagePreview: (path: string) => ipcRenderer.invoke('nexus:readImagePreview', path),
  // Resolve a dropped/pasted File to its real path (Electron webUtils).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openConfigWeb: () => ipcRenderer.invoke('nexus:openConfigWeb'),
  respondPermission: (id: string, answer: string) =>
    ipcRenderer.invoke('nexus:respondPermission', { id, answer }),
  setMcpEnabled: (enabled: boolean) => ipcRenderer.invoke('nexus:setMcpEnabled', { enabled }),
  getMcpStatus: () => ipcRenderer.invoke('nexus:getMcpStatus'),
  getMcpServers: () => ipcRenderer.invoke('nexus:getMcpServers'),
  setMcpServer: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('nexus:setMcpServer', { name, enabled }),
  getDeferMcp: () => ipcRenderer.invoke('nexus:getDeferMcp'),
  setDeferMcp: (enabled: boolean) => ipcRenderer.invoke('nexus:setDeferMcp', enabled),
  getPinned: () => ipcRenderer.invoke('nexus:getPinned'),
  setPinned: (ids: string[]) => ipcRenderer.invoke('nexus:setPinned', ids),
  getMinimizeToTray: () => ipcRenderer.invoke('nexus:getMinimizeToTray'),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('nexus:setMinimizeToTray', enabled),
  getInputRows: () => ipcRenderer.invoke('nexus:getInputRows'),
  setInputRows: (rows: number) => ipcRenderer.invoke('nexus:setInputRows', rows),
  readRecentLogs: (maxLines?: number) => ipcRenderer.invoke('nexus:readRecentLogs', maxLines),

  getUpdateState: () => ipcRenderer.invoke('nexus:getUpdateState'),
  getCurrentVersion: () => ipcRenderer.invoke('nexus:getCurrentVersion'),
  checkForUpdate: () => ipcRenderer.invoke('nexus:checkForUpdate'),
  downloadUpdate: () => ipcRenderer.invoke('nexus:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('nexus:installUpdate'),

  onEvent: (cb: (event: unknown) => void) => {
    ipcRenderer.on('nexus:event', (_e, event) => cb(event));
  },
  onEvents: (cb: (events: unknown[]) => void) => {
    ipcRenderer.on('nexus:events', (_e, events) => cb(events));
  },
  onPermission: (cb: (req: { id: string; question: string }) => void) => {
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
  onUpdateState: (cb: (state: Record<string, unknown>) => void) => {
    ipcRenderer.on('nexus:updateState', (_e, state) => cb(state));
  },
};

contextBridge.exposeInMainWorld('nexusDesktop', api);

export type NexusDesktopApi = typeof api;
