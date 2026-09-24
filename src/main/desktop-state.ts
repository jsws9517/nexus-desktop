/**
 * Desktop-only persisted settings (~/.nexus/desktop.json).
 *
 * The core's config.json is validated by a zod schema that strips unknown
 * fields, so a desktop-only flag would be dropped on the next config
 * save/parse. Desktop state therefore lives in its own file, behind a memory
 * cache so per-IPC reads never touch the disk.
 *
 * Also absorbs the former top-level jobs.json / model-blacklist.json as
 * namespaced sections so ~/.nexus keeps ~4 config-type JSON files
 * (config / engines / state / desktop). Legacy files are migrated on first
 * read with the crash-safe rename→rm retire pattern (a complete copy exists
 * at every instant; a failed write leaves the legacy file untouched).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ResourceMonitor } from './resource-monitor.js';

// Resolved at call time so tests can point NEXUS_CONFIG_DIR at a temp dir.
function configDir(): string {
  return process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus');
}
function desktopConfigPath(): string { return join(configDir(), 'desktop.json'); }

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
  lazyWorker?: boolean;
  // Namespaced sections absorbed from former top-level files.
  jobs?: unknown[];
  modelBlacklist?: Record<string, Record<string, string>>;
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
  getLazyWorker(): boolean;
  setLazyWorker(enabled: boolean): void;
  /** Background jobs (absorbed from jobs.json). */
  getJobs(): unknown[];
  setJobs(jobs: unknown[]): void;
  /** Model capability blacklist (absorbed from model-blacklist.json). */
  getModelBlacklist(): Record<string, Record<string, string>>;
  setModelBlacklist(data: Record<string, Record<string, string>>): void;
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

  /** Crash-safe legacy retire: rename → rm keeps a complete copy at every instant. */
  const retireLegacy = (legacyPath: string): void => {
    try {
      if (existsSync(`${legacyPath}.legacy`)) rmSync(`${legacyPath}.legacy`, { force: true });
      renameSync(legacyPath, `${legacyPath}.legacy`);
      rmSync(`${legacyPath}.legacy`, { force: true });
    } catch {
      // Rename failed — leave the original; next startup retries.
    }
  };

  /** One-time section migration from a former top-level file. */
  const migrateLegacy = <T>(
    section: keyof DesktopStateData,
    legacyPath: string,
    parse: (raw: string) => T,
  ): void => {
    if (!cache || cache[section] !== undefined) return;
    if (!existsSync(legacyPath)) return;
    let parsed: T;
    try {
      parsed = parse(readFileSync(legacyPath, 'utf-8'));
    } catch {
      try { renameSync(legacyPath, `${legacyPath}.corrupt.${Date.now()}`); } catch { /* best-effort */ }
      return;
    }
    // Durably write the section FIRST, then retire the legacy file.
    (cache as Record<string, unknown>)[section] = parsed;
    try {
      flushSync();
    } catch {
      // New write failed — leave legacy untouched (no config gap).
      return;
    }
    retireLegacy(legacyPath);
  };

  /** Synchronous durable write of the full cache (atomic tmp→rename). */
  const flushSync = (): void => {
    const path = desktopConfigPath();
    mkdirSync(configDir(), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    try {
      renameSync(tmp, path);
    } catch {
      try { writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8'); }
      finally { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }
    }
  };

  const read = (): DesktopStateData => {
    if (cache) return cache;
    const path = desktopConfigPath();
    try {
      if (!existsSync(path)) {
        cache = {};
      } else {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DesktopStateData;
        cache = parsed && typeof parsed === 'object' ? parsed : {};
      }
    } catch {
      // Corrupt desktop.json — quarantine (never delete) and start fresh.
      try { renameSync(path, `${path}.corrupt.${Date.now()}`); } catch { /* best-effort */ }
      cache = {};
    }
    const dir = configDir();
    migrateLegacy<unknown[]>('jobs', join(dir, 'jobs.json'), (raw) => {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    });
    migrateLegacy<Record<string, Record<string, string>>>(
      'modelBlacklist', join(dir, 'model-blacklist.json'),
      (raw) => {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      },
    );
    return cache;
  };

  const write = (patch: DesktopStateData): void => {
    try {
      const cur = read();
      cache = { ...cur, ...patch };
      flushSync();
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
  const getLazyWorker = (): boolean => {
    const v = read().lazyWorker;
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
    getLazyWorker,
    setLazyWorker(enabled: boolean): void {
      write({ lazyWorker: enabled });
    },
    getJobs(): unknown[] {
      const jobs = read().jobs;
      return Array.isArray(jobs) ? jobs : [];
    },
    setJobs(jobs: unknown[]): void {
      write({ jobs });
    },
    getModelBlacklist(): Record<string, Record<string, string>> {
      const bl = read().modelBlacklist;
      return bl && typeof bl === 'object' && !Array.isArray(bl) ? bl : {};
    },
    setModelBlacklist(data: Record<string, Record<string, string>>): void {
      write({ modelBlacklist: data });
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