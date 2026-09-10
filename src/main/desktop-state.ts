/**
 * Desktop-only persisted settings (~/.nexus/desktop.json).
 *
 * The core's config.json is validated by a zod schema that strips unknown
 * fields, so a desktop-only flag would be dropped on the next config
 * save/parse. Desktop state therefore lives in its own file, behind a memory
 * cache so per-IPC reads never touch the disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ResourceMonitor } from './resource-monitor.js';

const DESKTOP_CONFIG_PATH = join(homedir(), '.nexus', 'desktop.json');

interface DesktopStateData {
  deferMcp?: boolean;
  lastCwd?: string;
  windowBounds?: WindowBounds;
  pinnedIds?: string[];
  minimizeToTray?: boolean;
  inputRows?: number;
  restoreSessionOnLaunch?: boolean;
  lastOpenTabs?: string[];
  // Resource/session governance (desktop-only; the core schema strips unknowns).
  maxTabs?: number;
  memThresholdPct?: number;
  cpuThresholdPct?: number;
  monitorEnabled?: boolean;
}

export type WindowBounds = { x?: number; y?: number; width?: number; height?: number };

const DEFAULT_MAX_TABS = 5;

/** Read/write surface the IPC layer depends on (kept narrow so registerIpc
 * never touches the store internals). */
export interface DesktopStateAccess {
  getDeferMcp(): boolean;
  setDeferMcp(enabled: boolean): void;
  getPinnedIds(): string[];
  setPinnedIds(ids: string[]): void;
  getMinimizeToTray(): boolean;
  setMinimizeToTray(enabled: boolean): void;
  getRestoreSessionOnLaunch(): boolean;
  setRestoreSessionOnLaunch(enabled: boolean): void;
  getLastOpenTabs(): string[];
  setLastOpenTabs(ids: string[]): void;
  getInputRows(): number;
  setInputRows(rows: number): void;
  getMaxTabs(): number;
  setMaxTabs(n: number): void;
  getMemThresholdPct(): number;
  setMemThresholdPct(n: number): void;
  getCpuThresholdPct(): number;
  setCpuThresholdPct(n: number): void;
  getMonitorEnabled(): boolean;
  setMonitorEnabled(enabled: boolean): void;
}

/** Full store: the 20 IPC accessors plus the app-bootstrap helpers. */
export interface DesktopStateStore extends DesktopStateAccess {
  loadSavedCwd(): string | undefined;
  saveSavedCwd(cwd: string): void;
  loadWindowBounds(): WindowBounds | undefined;
  saveWindowBounds(bounds: WindowBounds): void;
  applyResourceConfig(monitor: ResourceMonitor): void;
}

export function createDesktopState(): DesktopStateStore {
  let cache: DesktopStateData | null = null;

  const read = (): DesktopStateData => {
    if (cache) return cache;
    try {
      if (!existsSync(DESKTOP_CONFIG_PATH)) {
        cache = {};
        return cache;
      }
      cache = JSON.parse(readFileSync(DESKTOP_CONFIG_PATH, 'utf-8')) as DesktopStateData;
      return cache;
    } catch {
      cache = {};
      return cache;
    }
  };

  const write = (patch: DesktopStateData): void => {
    try {
      const cur = read();
      cache = { ...cur, ...patch };
      // Async write to disk (non-blocking); the in-memory cache is updated first.
      const payload = JSON.stringify(cache, null, 2);
      writeFile(DESKTOP_CONFIG_PATH, payload).catch(() => {});
    } catch {}
  };

  const getMaxTabs = (): number => {
    const v = read().maxTabs;
    return typeof v === 'number' && v >= 1 && v <= 20 ? Math.round(v) : DEFAULT_MAX_TABS;
  };
  const getMemThresholdPct = (): number => {
    const v = read().memThresholdPct;
    return typeof v === 'number' && v >= 50 && v <= 99 ? Math.round(v) : 80;
  };
  const getCpuThresholdPct = (): number => {
    const v = read().cpuThresholdPct;
    return typeof v === 'number' && v >= 50 && v <= 99 ? Math.round(v) : 70;
  };
  const getMonitorEnabled = (): boolean => {
    const v = read().monitorEnabled;
    return typeof v === 'boolean' ? v : true;
  };

  return {
    getDeferMcp(): boolean {
      return read().deferMcp === true;
    },
    setDeferMcp(enabled: boolean): void {
      write({ deferMcp: enabled });
    },
    getPinnedIds(): string[] {
      const ids = read().pinnedIds;
      return Array.isArray(ids) ? ids : [];
    },
    setPinnedIds(ids: string[]): void {
      write({ pinnedIds: ids });
    },
    getMinimizeToTray(): boolean {
      return read().minimizeToTray === true;
    },
    setMinimizeToTray(enabled: boolean): void {
      write({ minimizeToTray: enabled });
    },
    getRestoreSessionOnLaunch(): boolean {
      return read().restoreSessionOnLaunch !== false;
    },
    setRestoreSessionOnLaunch(enabled: boolean): void {
      write({ restoreSessionOnLaunch: enabled });
    },
    getLastOpenTabs(): string[] {
      const tabs = read().lastOpenTabs;
      return Array.isArray(tabs) ? tabs : [];
    },
    setLastOpenTabs(ids: string[]): void {
      write({ lastOpenTabs: ids.length > 0 ? ids : undefined });
    },
    getInputRows(): number {
      const v = read().inputRows;
      return typeof v === 'number' && v >= 1 && v <= 20 ? v : 4;
    },
    setInputRows(rows: number): void {
      const clamped = Math.max(1, Math.min(20, Math.round(rows)));
      write({ inputRows: clamped });
    },
    getMaxTabs,
    setMaxTabs(n: number): void {
      write({ maxTabs: Math.max(1, Math.min(20, Math.round(n))) });
    },
    getMemThresholdPct,
    setMemThresholdPct(n: number): void {
      write({ memThresholdPct: Math.max(50, Math.min(99, Math.round(n))) });
    },
    getCpuThresholdPct,
    setCpuThresholdPct(n: number): void {
      write({ cpuThresholdPct: Math.max(50, Math.min(99, Math.round(n))) });
    },
    getMonitorEnabled,
    setMonitorEnabled(enabled: boolean): void {
      write({ monitorEnabled: enabled });
    },
    loadSavedCwd(): string | undefined {
      const cwd = read().lastCwd;
      return typeof cwd === 'string' && cwd && existsSync(cwd) ? cwd : undefined;
    },
    saveSavedCwd(cwd: string): void {
      if (typeof cwd === 'string' && cwd) write({ lastCwd: cwd });
    },
    loadWindowBounds(): WindowBounds | undefined {
      const b = read().windowBounds;
      if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return undefined;
      return b;
    },
    saveWindowBounds(bounds: WindowBounds): void {
      write({ windowBounds: bounds });
    },
    applyResourceConfig(monitor: ResourceMonitor): void {
      monitor.apply({
        maxTabs: getMaxTabs(),
        memThresholdPct: getMemThresholdPct(),
        cpuThresholdPct: getCpuThresholdPct(),
        monitorEnabled: getMonitorEnabled(),
      });
    },
  };
}