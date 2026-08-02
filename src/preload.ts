import { contextBridge, ipcRenderer } from 'electron';

const api = {
  chat: (input: string) => ipcRenderer.invoke('nexus:chat', { input }),
  abort: () => ipcRenderer.invoke('nexus:abort'),
  startSession: (name?: string, sessionId?: string) =>
    ipcRenderer.invoke('nexus:startSession', { name, sessionId }),
  listSessions: () => ipcRenderer.invoke('nexus:listSessions'),
  getMessages: (sessionId: string) => ipcRenderer.invoke('nexus:getMessages', { sessionId }),
  deleteSession: (id: string) => ipcRenderer.invoke('nexus:deleteSession', { id }),
  renameSession: (id: string, name: string) =>
    ipcRenderer.invoke('nexus:renameSession', { id, name }),
  getConfig: () => ipcRenderer.invoke('nexus:getConfig'),
  getProviders: () => ipcRenderer.invoke('nexus:getProviders'),
  getStatus: () => ipcRenderer.invoke('nexus:getStatus'),
  switchProvider: (name: string) => ipcRenderer.invoke('nexus:switchProvider', { name }),
  switchModel: (modelId: string) => ipcRenderer.invoke('nexus:switchModel', { modelId }),
  saveProvider: (name: string, fields: Record<string, unknown>) =>
    ipcRenderer.invoke('nexus:saveProvider', { name, fields }),
  setCwd: (cwd: string) => ipcRenderer.invoke('nexus:setCwd', { cwd }),
  openFolder: () => ipcRenderer.invoke('nexus:openFolder'),
  openConfigWeb: () => ipcRenderer.invoke('nexus:openConfigWeb'),
  respondPermission: (id: string, answer: string) =>
    ipcRenderer.invoke('nexus:respondPermission', { id, answer }),

  onEvent: (cb: (event: unknown) => void) => {
    ipcRenderer.on('nexus:event', (_e, event) => cb(event));
  },
  onPermission: (cb: (req: { id: string; question: string }) => void) => {
    ipcRenderer.on('nexus:permission', (_e, req) => cb(req));
  },
  onLog: (cb: (log: { level: string; message: string }) => void) => {
    ipcRenderer.on('nexus:log', (_e, log) => cb(log));
  },
};

contextBridge.exposeInMainWorld('nexusDesktop', api);

export type NexusDesktopApi = typeof api;
