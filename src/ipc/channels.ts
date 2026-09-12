/**
 * Single source for IPC channel names + the worker method id type.
 *
 * Channel strings are referenced from the main-process register layer and (via
 * string literals in the preload bridge) the renderer. Keeping them in one
 * catalog prevents typo drift between the two sides of the ipcMain.handle()
 * call sites, while `WorkerMethod` derives the worker-routed id union from the
 * single-source validation spec in src/shared/ipc-validation.ts.
 */

import type { WORKER_METHODS } from '../shared/ipc-validation.js';

/** Worker-routed method ids — derived, never hand-maintained. */
export type WorkerMethod = keyof typeof WORKER_METHODS;

/** All IPC channels used by the desktop app (main→renderer + renderer→main). */
export const CHANNELS = {
  // renderer → main: worker-routed invoke() channels.
  chat: 'nexus:chat',
  regenerate: 'nexus:regenerate',
  withdraw: 'nexus:withdraw',
  abort: 'nexus:abort',
  startSession: 'nexus:startSession',
  listSessions: 'nexus:listSessions',
  getMessages: 'nexus:getMessages',
  getSlashLog: 'nexus:getSlashLog',
  getSlashLogPath: 'nexus:getSlashLogPath',
  deleteSession: 'nexus:deleteSession',
  renameSession: 'nexus:renameSession',
  renameProject: 'nexus:renameProject',
  getConfig: 'nexus:getConfig',
  getProviders: 'nexus:getProviders',
  getStatus: 'nexus:getStatus',
  getPermissions: 'nexus:getPermissions',
  getLanguage: 'nexus:getLanguage',
  reloadConfig: 'nexus:reloadConfig',
  getSpeechVisionConfig: 'nexus:getSpeechVisionConfig',
  setActiveSpeechProvider: 'nexus:setActiveSpeechProvider',
  setActiveTtsProvider: 'nexus:setActiveTtsProvider',
  setActiveVisionProvider: 'nexus:setActiveVisionProvider',
  saveSpeechProvider: 'nexus:saveSpeechProvider',
  saveVisionProvider: 'nexus:saveVisionProvider',
  getSessionStats: 'nexus:getSessionStats',
  switchProvider: 'nexus:switchProvider',
  switchModel: 'nexus:switchModel',
  getModels: 'nexus:getModels',
  setDepthOverride: 'nexus:setDepthOverride',
  getActiveDepth: 'nexus:getActiveDepth',
  setPermissionsOverride: 'nexus:setPermissionsOverride',
  getActiveMode: 'nexus:getActiveMode',
  saveProvider: 'nexus:saveProvider',
  setCwd: 'nexus:setCwd',
  getDefaultProjectDir: 'nexus:getDefaultProjectDir',
  getSessionMetadata: 'nexus:getSessionMetadata',
  setSessionMetadata: 'nexus:setSessionMetadata',
  respondPermission: 'nexus:respondPermission',
  setMcpEnabled: 'nexus:setMcpEnabled',
  getMcpStatus: 'nexus:getMcpStatus',
  getMcpServers: 'nexus:getMcpServers',
  setMcpServer: 'nexus:setMcpServer',
  runSubAgent: 'nexus:runSubAgent',
  getSubAgentStatus: 'nexus:getSubAgentStatus',
  cancelSubAgent: 'nexus:cancelSubAgent',
  subAgentProgress: 'nexus:subAgentProgress',
  shutdown: 'nexus:shutdown',

  // renderer → main: desktop-only (desktop.json state) channels.
  getDeferMcp: 'nexus:getDeferMcp',
  setDeferMcp: 'nexus:setDeferMcp',
  getPinned: 'nexus:getPinned',
  setPinned: 'nexus:setPinned',
  getMinimizeToTray: 'nexus:getMinimizeToTray',
  setMinimizeToTray: 'nexus:setMinimizeToTray',
  getRestoreSessionOnLaunch: 'nexus:getRestoreSessionOnLaunch',
  setRestoreSessionOnLaunch: 'nexus:setRestoreSessionOnLaunch',
  getLastOpenTabs: 'nexus:getLastOpenTabs',
  setLastOpenTabs: 'nexus:setLastOpenTabs',
  getInputRows: 'nexus:getInputRows',
  setInputRows: 'nexus:setInputRows',
  readRecentLogs: 'nexus:readRecentLogs',
  getMaxTabs: 'nexus:getMaxTabs',
  setMaxTabs: 'nexus:setMaxTabs',
  getMemThreshold: 'nexus:getMemThreshold',
  setMemThreshold: 'nexus:setMemThreshold',
  getCpuThreshold: 'nexus:getCpuThreshold',
  setCpuThreshold: 'nexus:setCpuThreshold',
  getMonitorEnabled: 'nexus:getMonitorEnabled',
  setMonitorEnabled: 'nexus:setMonitorEnabled',
  getResourceState: 'nexus:getResourceState',

  // renderer → main: main-local (no worker round-trip) channels.
  openSession: 'nexus:openSession',
  openNewSession: 'nexus:openNewSession',
  closeSession: 'nexus:closeSession',
  getOpenTabs: 'nexus:getOpenTabs',
  getTabStatus: 'nexus:getTabStatus',
  openFolder: 'nexus:openFolder',
  openFile: 'nexus:openFile',
  revealFile: 'nexus:revealFile',
  getFileInfos: 'nexus:getFileInfos',
  readImagePreview: 'nexus:readImagePreview',
  pasteImage: 'nexus:pasteImage',
  saveArtifact: 'nexus:saveArtifact',
  openConfigWeb: 'nexus:openConfigWeb',
  getUpdateState: 'nexus:getUpdateState',
  getCurrentVersion: 'nexus:getCurrentVersion',
  checkForUpdate: 'nexus:checkForUpdate',
  downloadUpdate: 'nexus:downloadUpdate',
  installUpdate: 'nexus:installUpdate',

  // main → renderer: event pushes.
  events: 'nexus:events',
  event: 'nexus:event',
  tabEvents: 'nexus:tabEvents',
  tabEvent: 'nexus:tabEvent',
  permission: 'nexus:permission',
  log: 'nexus:log',
  workerRestarted: 'nexus:workerRestarted',
  tabsChanged: 'nexus:tabsChanged',
  resourceState: 'nexus:resourceState',
  updateState: 'nexus:updateState',
  configWindowClosed: 'nexus:configWindowClosed',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];