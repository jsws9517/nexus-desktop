/**
 * Core overlay bootstrap (phase 1).
 *
 * Electron-free so it can be unit-tested with plain node. Manages
 * `<overlayRoot>/state.json` and decides, before the core worker is started,
 * whether to load an overlay copy of nexus-coder instead of the copy shipped
 * inside app.asar.
 *
 * Boot protocol:
 *   decideBoot()   -> counts boots that were never confirmed healthy; after
 *                     MAX_BOOT_FAILURES consecutive ones, rolls back.
 *   markHealthy()  -> called once the worker answers; clears the counter.
 *   disableActiveCore() -> in-process fallback when the worker dies before
 *                     it became healthy (e.g. syntax error in overlay code).
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BOOT_FAILURES = 2;
const STATE_FILE = 'state.json';
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export interface OverlayState {
  /** Core version loaded from overlay on next boot, or null for base copy. */
  activeCore: string | null;
  /** Last known-good overlay version, used as rollback target. */
  previousCore: string | null;
  /** Versions that failed and must not be loaded again. */
  disabledCores: string[];
  /** True between decideBoot() and markHealthy(). */
  bootPending: boolean;
  /** Number of consecutive boots left pending. */
  consecutiveFailures: number;
}

export interface BootDecision {
  /** Absolute dir of overlay core to load, or null to use the base copy. */
  coreDir: string | null;
  version: string | null;
  /** Versions disabled as a result of this decision (for logging). */
  disabledNow: string[];
}

export function emptyState(): OverlayState {
  return {
    activeCore: null,
    previousCore: null,
    disabledCores: [],
    bootPending: false,
    consecutiveFailures: 0,
  };
}

function asVersion(v: unknown): string | null {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
}

function normalizeState(raw: unknown): OverlayState {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const disabled = Array.isArray(s.disabledCores)
    ? s.disabledCores.map(asVersion).filter((v): v is string => v !== null)
    : [];
  const failures = typeof s.consecutiveFailures === 'number' && Number.isInteger(s.consecutiveFailures)
    ? Math.max(0, s.consecutiveFailures)
    : 0;
  return {
    activeCore: asVersion(s.activeCore),
    previousCore: asVersion(s.previousCore),
    disabledCores: disabled,
    bootPending: s.bootPending === true,
    consecutiveFailures: failures,
  };
}

export function coreDirFor(root: string, version: string): string {
  return path.join(root, 'core', version);
}

export function readState(root: string): OverlayState {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')));
  } catch {
    // Missing or corrupt state: behave as if no overlay was ever activated.
    return emptyState();
  }
}

export function writeState(root: string, state: OverlayState): void {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** A version is usable when it is well-formed, not disabled, and has a package.json on disk. */
export function isUsableCore(root: string, state: OverlayState, version: string | null): version is string {
  return version !== null
    && !state.disabledCores.includes(version)
    && fs.existsSync(path.join(coreDirFor(root, version), 'package.json'));
}

function markDisabled(state: OverlayState, version: string, disabledNow: string[]): void {
  if (!state.disabledCores.includes(version)) state.disabledCores.push(version);
  disabledNow.push(version);
}

/** Decide which core to load for this boot and persist the pending marker. */
export function decideBoot(root: string): BootDecision {
  const state = readState(root);
  const disabledNow: string[] = [];

  // A pending boot that never became healthy counts as a failure.
  if (state.bootPending) state.consecutiveFailures += 1;

  if (state.activeCore && state.consecutiveFailures >= MAX_BOOT_FAILURES) {
    markDisabled(state, state.activeCore, disabledNow);
    state.activeCore = isUsableCore(root, state, state.previousCore) ? state.previousCore : null;
    state.previousCore = null;
    state.consecutiveFailures = 0;
  }

  if (state.activeCore && !isUsableCore(root, state, state.activeCore)) {
    markDisabled(state, state.activeCore, disabledNow);
    state.activeCore = null;
    state.consecutiveFailures = 0;
  }

  state.bootPending = state.activeCore !== null;
  if (!state.bootPending) state.consecutiveFailures = 0;
  writeState(root, state);

  return {
    coreDir: state.activeCore ? coreDirFor(root, state.activeCore) : null,
    version: state.activeCore,
    disabledNow,
  };
}

export interface OverlayLaunch {
  version: string | null;
  disabledNow: string[];
  /** Extra env for the worker process (empty when running the base copy). */
  env: Record<string, string>;
}

/**
 * Decide and describe how to launch the core worker.
 * The worker entry imports ./bootstrap/register.js itself (a `--import` flag is
 * ignored by Electron utilityProcess), so only env is passed here.
 * @param root    overlay root dir (e.g. <userData>/overlay)
 * @param appRoot dir that contains node_modules/nexus-coder for the base copy
 */
export function prepareLaunch(root: string, appRoot: string): OverlayLaunch {
  const decision = decideBoot(root);
  if (!decision.coreDir) {
    return { version: null, disabledNow: decision.disabledNow, env: {} };
  }
  return {
    version: decision.version,
    disabledNow: decision.disabledNow,
    env: { NEXUS_OVERLAY_CORE_DIR: decision.coreDir, NEXUS_APP_ROOT: appRoot },
  };
}

/** Clear the pending marker once the worker has answered. */
export function markHealthy(root: string): void {
  const state = readState(root);
  if (!state.bootPending && state.consecutiveFailures === 0) return;
  state.bootPending = false;
  state.consecutiveFailures = 0;
  writeState(root, state);
}

/**
 * Disable the active overlay right away (worker died before becoming healthy).
 * Falls back to the base copy; previousCore is kept for manual inspection.
 */
export function disableActiveCore(root: string): string | null {
  const state = readState(root);
  if (!state.activeCore) return null;
  const version = state.activeCore;
  const disabledNow: string[] = [];
  markDisabled(state, version, disabledNow);
  state.activeCore = null;
  state.bootPending = false;
  state.consecutiveFailures = 0;
  writeState(root, state);
  return version;
}

/** Make a staged core version the active overlay. The previous active one becomes rollback target. */
export function activateCore(root: string, version: string): void {
  if (!asVersion(version)) throw new Error(`invalid core version: ${version}`);
  const state = readState(root);
  if (!fs.existsSync(path.join(coreDirFor(root, version), 'package.json'))) {
    throw new Error(`core ${version} is not staged under ${root}`);
  }
  if (state.activeCore && state.activeCore !== version) state.previousCore = state.activeCore;
  state.activeCore = version;
  state.disabledCores = state.disabledCores.filter((v) => v !== version);
  state.bootPending = false;
  state.consecutiveFailures = 0;
  writeState(root, state);
}
