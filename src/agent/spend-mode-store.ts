/**
 * Worker-side store for the spend-mode preferences in `~/.nexus/desktop.json`.
 *
 * The desktop owns this file (the core's config.json is zod-validated and
 * strips unknown keys), so the billing tier per provider lives here. The main
 * process has its own cache in src/main/desktop-state.ts (mtime-aware); this
 * module is the worker's read/write surface for the same section.
 *
 * Reads are mtime-cached so a per-turn read is one `stat` (not a re-parse).
 * Writes are atomic (tmp + rename) and read-modify-write the WHOLE file so
 * other desktop.json sections are never clobbered.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SPEND_MODE,
  isSpendMode,
  type SpendMode,
} from '../shared/spend-policy.js';

export interface SpendModeEntry {
  mode: SpendMode;
  host?: string;
  updatedAt?: string;
}

export interface SpendModeState {
  v?: number;
  default?: SpendMode;
  providers?: Record<string, SpendModeEntry>;
}

export type SpendSource = 'manual' | 'default';

export interface ResolvedSpendMode {
  mode: SpendMode;
  source: SpendSource;
  /** True when a manual entry exists but its host no longer matches (→ fell back to default). */
  hostChanged?: boolean;
}

// Resolved at call time so tests can point NEXUS_CONFIG_DIR at a temp dir.
function configDir(): string {
  return process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus');
}
function desktopPath(): string {
  return join(configDir(), 'desktop.json');
}

/** Normalized host: lowercased hostname (no port / path / scheme). Falls back to the raw string. */
export function hostOf(baseUrl?: string): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Not a full URL — take the host-looking portion after any scheme.
    const s = baseUrl.trim().toLowerCase();
    return s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0] || s;
  }
}

/** Best-effort per-vendor suggestion when a provider is first configured. Never writes. */
export function suggestForHost(host: string): SpendMode | null {
  const h = host.toLowerCase();
  if (h.includes('open.bigmodel.cn') || h.includes('bigmodel')) return 'coding';
  if (h.includes('apihub.agnes-ai') || h.includes('agnes-ai')) return 'coding';
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return 'coding';
  // opencode-zen mixes free and paid models on one endpoint — do not guess.
  return null;
}

// ---------------------------------------------------------------------------
// Mtime-cached read of the spendMode section.
// ---------------------------------------------------------------------------

let cachedMtime = -1;
let cachedState: SpendModeState = {};

function readWhole(): Record<string, unknown> {
  const path = desktopPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sectionOf(file: Record<string, unknown>): SpendModeState {
  const v = file.spendMode;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as SpendModeState;
  return {};
}

export function readSpendModeState(): SpendModeState {
  let mtime = -1;
  const path = desktopPath();
  if (existsSync(path)) {
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      mtime = -1;
    }
  }
  if (mtime !== cachedMtime) {
    cachedState = sectionOf(readWhole());
    cachedMtime = mtime;
  }
  return cachedState;
}

/** Test hook: drop the mtime cache so the next read re-hits disk. */
export function invalidateSpendModeCache(): void {
  cachedMtime = -1;
  cachedState = {};
}

/** Resolve the effective mode + source for a provider, given its current host. */
export function resolveSpendMode(state: SpendModeState, provider: string, host: string): ResolvedSpendMode {
  const defaultMode: SpendMode = isSpendMode(state.default) ? state.default : DEFAULT_SPEND_MODE;
  const entry = state.providers?.[provider];
  if (!entry) return { mode: defaultMode, source: 'default' };
  const entryHost = entry.host ? hostOf(entry.host) : '';
  const curHost = hostOf(host);
  // A manual entry whose host no longer matches has been repointed to another
  // vendor — fall back to the (safe) default but keep the entry for re-use.
  if (entryHost && curHost && entryHost !== curHost) {
    return { mode: defaultMode, source: 'default', hostChanged: true };
  }
  return { mode: isSpendMode(entry.mode) ? entry.mode : defaultMode, source: 'manual' };
}

// ---------------------------------------------------------------------------
// Atomic read-modify-write of the whole desktop.json (never clobbers sections).
// ---------------------------------------------------------------------------

function atomicWrite(next: Record<string, unknown>): void {
  const path = desktopPath();
  mkdirSync(configDir(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  try {
    renameSync(tmp, path);
  } catch {
    try {
      writeFileSync(path, JSON.stringify(next, null, 2), 'utf-8');
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  invalidateSpendModeCache();
}

interface WriteResult {
  ok: boolean;
  mode: SpendMode | null;
  error?: string;
}

/** Set (or clear, when mode === null) the spend mode for one provider. */
export function writeProviderMode(provider: string, host: string, mode: SpendMode | null): WriteResult {
  if (!provider) return { ok: false, mode: null, error: 'no provider' };
  const file = readWhole();
  const section = sectionOf(file);
  const providers = section.providers && typeof section.providers === 'object' ? section.providers : {};
  if (mode === null) {
    delete providers[provider];
    section.providers = providers;
  } else if (isSpendMode(mode)) {
    providers[provider] = { mode, host: hostOf(host), updatedAt: new Date().toISOString() };
    section.providers = providers;
  } else {
    return { ok: false, mode: null, error: `invalid mode: ${String(mode)}` };
  }
  file.spendMode = { v: 1, default: section.default ?? DEFAULT_SPEND_MODE, ...section };
  try {
    atomicWrite(file);
    return { ok: true, mode };
  } catch (err) {
    return { ok: false, mode: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Set the global default spend mode. */
export function writeDefaultMode(mode: SpendMode): WriteResult {
  if (!isSpendMode(mode)) return { ok: false, mode: null, error: `invalid mode: ${String(mode)}` };
  const file = readWhole();
  const section = sectionOf(file);
  file.spendMode = {
    v: 1,
    default: mode,
    providers: section.providers ?? {},
  };
  try {
    atomicWrite(file);
    return { ok: true, mode };
  } catch (err) {
    return { ok: false, mode: null, error: err instanceof Error ? err.message : String(err) };
  }
}
