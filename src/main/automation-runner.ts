/**
 * T6 automation runner host (main-process wiring).
 *
 * Owns the in-process `AutomationRunner` + `AutomationStore` (both from the
 * core's dist) and supplies the `AutomationAgentFactory` that spawns a
 * headless `automation-worker.js` per run. The spawned worker is NOT
 * registered in `SessionWorkers`, so it never appears in the tab table,
 * never counts toward `getMaxTabs`, and never affects the resource monitor.
 *
 * Zero-resident invariant: when idle (no automation run in flight) no extra
 * process exists; the runner's tick timer is `unref()`'d, so it never keeps
 * the main process alive either.
 *
 * The store + runner are loaded lazily: better-sqlite3 is native, and the
 * main process must keep booting even when that binding is unusable.
 */

import { WorkerHost } from './worker-host.js';
import { mcpHub } from './mcp-hub.js';
import { logger } from '../shared/logger.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Automation, AutomationRun, MissPolicy } from 'nexus-coder/dist/src/automation/types.js';
import type { AutomationRunner, RunnerEvent } from 'nexus-coder/dist/src/automation/runner.js';
import type { AutomationStore } from 'nexus-coder/dist/src/automation/store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Path to the headless automation worker entry (same dir as agent-worker.js). */
export function automationWorkerPath(): string {
  return join(__dirname, '..', 'automation-worker.js');
}

interface AutomationHost {
  store: AutomationStore;
  runner: AutomationRunner;
  started: boolean;
}

let hostPromise: Promise<AutomationHost | null> | null = null;

/**
 * Create a brand-new host bundle. Factored out of `loadHost()` so a cache
 * invalidation (after `close()`) or a better-sqlite3 retry gets a fresh DB
 * connection instead of the poisoned cache entry.
 */
async function createHost(): Promise<AutomationHost | null> {
  try {
    const storeMod = await import('nexus-coder/dist/src/automation/store.js') as {
      AutomationStore: new (dbPath?: string) => AutomationStore;
    };
    const runnerMod = await import('nexus-coder/dist/src/automation/runner.js') as {
      AutomationRunner: new (
        store: AutomationStore,
        factory: {
          run(
            aut: Automation,
            opts: { sessionId?: string; maxCostUsd?: number },
          ): Promise<{ sessionId: string; costUsd?: number }>;
        },
        opts?: { tickMs?: number; serialisePerAutomation?: boolean; catchupGraceMs?: number; maxCostUsd?: number },
      ) => AutomationRunner;
    };
    const store = new storeMod.AutomationStore();
    const runner = new runnerMod.AutomationRunner(store, createAgentFactory(), { tickMs: 1000 });
    return { store, runner, started: false };
  } catch (err) {
    logger.warn(
      `automation host unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Lazy singleton (cached promise). A `null` result (better-sqlite3 unusable
 * etc.) is not cached: the next call retries, so a binding that appears later
 * in the same process lifecycle still works.
 */
async function getHost(): Promise<AutomationHost | null> {
  if (!hostPromise) hostPromise = createHost();
  const host = await hostPromise;
  if (!host) hostPromise = null;
  return host;
}

/**
 * In-flight headless workers, keyed by the run's session id. Interrupted
 * (killed) by `interruptRunningRuns()` on quit so no orphan process outlives
 * the app.
 */
const inFlightWorkers = new Map<string, WorkerHost>();

/**
 * The factory the runner consults to execute each automation run: spawn a
 * headless automation-worker, run the prompt, stop it. Isolated from the
 * user's open tabs by design.
 */
function createAgentFactory() {
  return {
    async run(
      aut: Automation,
      _opts: { sessionId?: string; maxCostUsd?: number },
    ): Promise<{ sessionId: string; costUsd?: number }> {
      const worker = new WorkerHost(automationWorkerPath(), { env: {} });
      worker.onLog = (level, message) => {
        if (level === 'error' || level === 'stderr') logger.error(`[automation ${aut.id}] ${message}`);
        else logger.debug(`[automation ${aut.id}] ${message}`);
      };
      worker.onMcpRequest = (op, params) => mcpHub.handle(op, params);

      let sessionId = '';
      try {
        worker.start();

        // Phase 1: fast Agent construction (no MCP connect).
        await worker.request('earlyInit', aut.cwd ? { cwd: aut.cwd } : undefined);

        // Phase 2: full init.
        await worker.request('init', aut.cwd ? { cwd: aut.cwd } : undefined);

        // Open a fresh session for this run so the prompt lands in an isolated
        // context (never the user's open tabs).
        const res = (await worker.request('startSession', {
          name: `automation:${aut.name}`,
        })) as { sessionId?: string } | undefined;
        sessionId = res?.sessionId ?? '';
        if (sessionId) inFlightWorkers.set(sessionId, worker);

        // Run the prompt through the agent.
        await worker.request('chat', { input: aut.prompt });

        return { sessionId };
      } finally {
        if (sessionId) inFlightWorkers.delete(sessionId);
        try {
          worker.stop();
        } catch {}
      }
    },
  };
}

/**
 * Start the automation runner's tick loop. Idempotent; resolves to the host
 * bundle or null when the core automation module is unavailable.
 *
 * The tick timer is `unref()`'d inside the runner, so this NEVER keeps the
 * main process alive — the zero-resident invariant.
 */
export async function startAutomationRunner(): Promise<AutomationHost | null> {
  const host = await getHost();
  if (!host) return null;
  if (!host.started) {
    host.started = true;
    host.runner.start();
    // Forward runner events to the on-disk log (the tray notification wiring
    // lives in main/index.ts via `onAutomationRunCompleted`).
    host.runner.on((ev: RunnerEvent) => {
      if (ev.type === 'run-started') {
        logger.info(`[automation] run started: ${ev.run.id} (${ev.automation.id})`);
      } else if (ev.type === 'run-completed') {
        logger.info(`[automation] run completed: ${ev.run.id} status=${ev.run.status}`);
      } else if (ev.type === 'run-missed') {
        logger.warn(`[automation] run missed: ${ev.run.id} (${ev.automation.id})`);
      } else if (ev.type === 'error') {
        logger.warn(`[automation] ${ev.message}`);
      }
    });
  }
  return host;
}

/**
 * Stop the runner, interrupt any live runs, and close the store. Called on
 * `before-quit`; the DB is released so the process can exit cleanly.
 */
export async function stopAutomationRunner(): Promise<void> {
  const host = await getHost();
  if (!host) {
    hostPromise = null;
    return;
  }
  await doInterruptRunningRuns(host);
  host.runner.stop();
  try {
    host.store.close();
  } catch {}
  // Drop the cache so the next start (if the app is relaunched within the
  // same process, e.g. a core hot-restart) gets a fresh connection.
  hostPromise = null;
}

/**
 * Interrupt every run in the 'running' state, mark it `interrupted` (NOT
 * 'failed' — the roadmap acceptance criterion), and kill its headless worker.
 *
 * @returns the number of runs marked interrupted.
 */
export async function interruptRunningRuns(): Promise<number> {
  const host = await getHost();
  if (!host) return 0;
  return doInterruptRunningRuns(host);
}

async function doInterruptRunningRuns(host: AutomationHost): Promise<number> {
  let count = 0;
  // Mark DB rows first (synchronous better-sqlite3), then kill the workers,
  // so a kill that races the mark still leaves a clean record.
  for (const aut of host.store.listEnabled()) {
    for (const run of host.store.getRunningRuns(aut.id)) {
      host.store.finishRun(run.id, 'interrupted', {
        error: 'app quit while run in progress',
        sessionId: run.sessionId,
      });
      count++;
    }
  }
  for (const worker of inFlightWorkers.values()) {
    try {
      worker.stop();
    } catch {}
  }
  inFlightWorkers.clear();
  return count;
}

/**
 * Run a specific automation immediately (manual trigger). Delegates to the
 * runner's `runNow()`.
 */
export async function automationRunNow(
  automationId: string,
): Promise<{ ok: boolean; runId?: string; reason?: string }> {
  const host = await startAutomationRunner();
  if (!host) return { ok: false, reason: 'automation host unavailable' };
  return host.runner.runNow(automationId);
}

/**
 * Query the store for all automations.
 */
export async function automationList(): Promise<Automation[]> {
  const host = await getHost();
  if (!host) return [];
  return host.store.listAll();
}

/**
 * Insert or update an automation in the store.
 * - No `id`: create new (id generated here).
 * - `id` present: update the matching row.
 *
 * @returns the id of the stored automation.
 */
export async function automationUpsert(params: {
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
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const host = await getHost();
  if (!host) return { ok: false, error: 'automation host unavailable' };
  const { store } = host;
  try {
    const now = Date.now();
    const name = (params.name ?? '').trim();
    const prompt = (params.prompt ?? '').trim();
    if (!name || !prompt) {
      return { ok: false, error: 'name and prompt are required' };
    }

    const schedule = normalizeSchedule(params.schedule);
    if (!schedule) {
      return {
        ok: false,
        error: 'invalid schedule: expected { type: "cron", expr } or { type: "interval", everyMs }',
      };
    }

    if (params.id) {
      const existing = store.get(params.id);
      if (!existing) {
        return { ok: false, error: `automation not found: ${params.id}` };
      }
      const updated: Automation = {
        ...existing,
        name,
        enabled: params.enabled ?? existing.enabled,
        schedule,
        prompt,
        cwd: params.cwd !== undefined ? (params.cwd || undefined) : existing.cwd,
        profile: params.profile ?? existing.profile,
        provider: params.provider !== undefined ? (params.provider || undefined) : existing.provider,
        model: params.model !== undefined ? (params.model || undefined) : existing.model,
        missPolicy: (params.missPolicy as MissPolicy | undefined) ?? existing.missPolicy,
        updatedAt: now,
      };
      store.update(updated);
      return { ok: true, id: params.id };
    }

    const id = 'aut_' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    const aut: Automation = {
      id,
      name,
      enabled: params.enabled ?? true,
      schedule,
      prompt,
      cwd: params.cwd || undefined,
      profile: params.profile ?? 'default',
      provider: params.provider || undefined,
      model: params.model || undefined,
      missPolicy: (params.missPolicy as MissPolicy | undefined) ?? 'skip',
      createdAt: now,
      updatedAt: now,
    };
    store.insert(aut);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete an automation and its run history.
 */
export async function automationDelete(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const host = await getHost();
  if (!host) return { ok: false, error: 'automation host unavailable' };
  try {
    const deleted = host.store.delete(id);
    if (!deleted) return { ok: false, error: `automation not found: ${id}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List run history for an automation (or all runs when no id is given).
 */
export async function automationRuns(params?: {
  id?: string;
  limit?: number;
}): Promise<{ ok: boolean; runs?: AutomationRun[]; error?: string }> {
  const host = await getHost();
  if (!host) return { ok: false, error: 'automation host unavailable' };
  try {
    const limit = Math.max(1, Math.min(200, params?.limit ?? 50));
    const runs = host.store.listRuns(params?.id, limit);
    return { ok: true, runs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Normalize the schedule param coming from IPC. Accepts:
 *   { type: 'cron', expr: '...', tz?: '...' }
 *   { type: 'interval', everyMs: N }
 * Returns undefined when the shape is invalid.
 */
function normalizeSchedule(raw: unknown):
  | { type: 'cron'; expr: string; tz?: string }
  | { type: 'interval'; everyMs: number }
  | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.type === 'cron') {
    const expr = typeof obj.expr === 'string' ? obj.expr.trim() : '';
    if (!expr) return undefined;
    const tz = typeof obj.tz === 'string' && obj.tz ? obj.tz : undefined;
    return { type: 'cron', expr, tz };
  }
  if (obj.type === 'interval') {
    const everyMs = typeof obj.everyMs === 'number' ? obj.everyMs : NaN;
    if (!Number.isFinite(everyMs) || everyMs <= 0) return undefined;
    return { type: 'interval', everyMs: Math.floor(everyMs) };
  }
  return undefined;
}

/**
 * Register a `run-completed` listener on the runner (used by main/index.ts
 * to fire the tray notification with click-to-jump). Resolves the host
 * lazily so it can be wired right after `startAutomationRunner()`.
 *
 * @returns an unsubscribe function.
 */
export function onAutomationRunCompleted(
  cb: (run: AutomationRun, automation: Automation) => void,
): () => void {
  let unsub: (() => void) | undefined;
  void startAutomationRunner().then((host) => {
    if (!host) return;
    unsub = host.runner.on((ev: RunnerEvent) => {
      if (ev.type === 'run-completed') cb(ev.run, ev.automation);
    });
  });
  return () => {
    unsub?.();
  };
}

/**
 * True when at least one enabled automation exists (used by the tray
 * contract: close-to-tray by default + one-time notice).
 */
export async function hasEnabledAutomations(): Promise<boolean> {
  const host = await getHost();
  if (!host) return false;
  try {
    return host.store.listEnabled().length > 0;
  } catch {
    return false;
  }
}
