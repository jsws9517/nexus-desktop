import { WorkerHost } from './worker-host.js';
import { mcpHub } from './mcp-hub.js';
import type { AgentEvent } from '../agent-service.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Absolute path to the agent worker script (shared with the global worker). */
export function workerScriptPath(): string {
  return join(__dirname, '..', 'agent-worker.js');
}

export interface OpenTabInfo {
  sessionId: string;
  provider: string;
  model: string;
  busy: boolean;
}

interface BoundWorker {
  sessionId: string;
  provider: string;
  model: string;
  busy: boolean;
  worker: WorkerHost;
}

/**
 * Registry of per-session agent worker processes.
 *
 * Each opened tab owns its own WorkerHost process. The process runs the SAME
 * agent-worker.js, but is bound to one concrete session via `startSession(id)`
 * right after `earlyInit` (no full MCP/skills init — that stays with the global
 * worker so opening a tab is fast). Because every session runs in its own OS
 * process, playing/streaming one tab never blocks another, each tab keeps its
 * own process.cwd(), and per-tab provider/model overrides are applied in that
 * tab's worker only — never writing the shared global config.
 */
export class SessionWorkers {
  private map = new Map<string, BoundWorker>();

  /**
   * Health gate for the pre-warmed spare. Wired by main/index.ts (needs the
   * resource monitor + tab ceiling). Absent = never warm.
   */
  canWarm?: () => boolean;
  private spare: WorkerHost | null = null;
  private warming = false;

  /** True while a pre-warmed (session-unbound) spare process exists. */
  get hasSpare(): boolean {
    return this.spare !== null;
  }

  /** Bound tabs + spare, for the resource monitor's real process count. */
  get residentCount(): number {
    return this.size + (this.spare ? 1 : 0);
  }

  onEvent?: (sessionId: string, event: AgentEvent) => void;
  onPermission?: (sessionId: string, req: { id: string; question: string }) => void;
  onLog?: (level: string, message: string) => void;
  onChange?: (tabs: OpenTabInfo[]) => void;

  get size(): number {
    return this.map.size;
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  tabs(): OpenTabInfo[] {
    const out: OpenTabInfo[] = [];
    for (const b of this.map.values()) {
      out.push({ sessionId: b.sessionId, provider: b.provider, model: b.model, busy: b.busy });
    }
    return out;
  }

  get (sessionId: string): OpenTabInfo | undefined {
    const b = this.map.get(sessionId);
    return b ? { sessionId: b.sessionId, provider: b.provider, model: b.model, busy: b.busy } : undefined;
  }

  private wire(bound: BoundWorker): void {
    const w = bound.worker;
    w.onEvent = (event: AgentEvent) => {
      // Streaming/turn events from the core don't carry a sessionId; stamp the
      // bound session so the renderer can route them to the correct tab.
      if (event.type === 'session_start') {
        bound.sessionId = String(event.sessionId ?? bound.sessionId);
      }
      if (event.type === 'turn_start') bound.busy = true;
      if (event.type === 'session_end') bound.busy = false;
      this.onEvent?.(bound.sessionId, { ...event, sessionId: bound.sessionId });
    };
    w.onPermission = (req: { id: string; question: string }) => {
      this.onPermission?.(bound.sessionId, req);
    };
    w.onLog = (level: string, message: string) => this.onLog?.(level, message);
    w.onExit = (code: number | null) => {
      this.onLog?.('warn', `Session worker exited (sessionId=${bound.sessionId}, code=${code})`);
      if (this.map.get(bound.sessionId) === bound) {
        this.map.delete(bound.sessionId);
        this.onChange?.(this.tabs());
      }
    };
  }

  /**
   * Pre-warm a spare, SESSION-UNBOUND worker so the next openSession can bind it
   * instead of paying a cold spawn + earlyInit. Because the spare is never
   * attached to a user session until it is handed to an open()/openNew(), it can
   * never be misidentified as an idle, recyclable process carrying an in-flight
   * turn — the failure mode a bound-worker pool would have to guard against.
   * Gated by `canWarm` (resource health + tab headroom) and single-flight.
   */
  async warmSpare(): Promise<void> {
    if (this.spare || this.warming) return;
    if (!this.canWarm || !this.canWarm()) return;
    this.warming = true;
    const worker = new WorkerHost(workerScriptPath());
    worker.onLog = (level, message) => this.onLog?.(level, message);
    worker.onExit = (code) => {
      this.onLog?.('warn', `Spare worker exited (code=${code})`);
      if (this.spare === worker) this.spare = null;
    };
    worker.onMcpRequest = (op, params) => mcpHub.handle(op, params);
    try {
      worker.start();
      // earlyInit only — the MCP/skills connect stays with the global worker,
      // matching how open() warms a fresh tab (fast path). cwd is applied at
      // bind time via setCwd (earlyInit without a cwd leaves the process cwd).
      await worker.request('earlyInit');
      if (worker.alive) {
        this.spare = worker;
        this.onLog?.('info', 'Spare worker warmed');
      } else {
        // Died mid warm-up — discard.
        try {
          worker.stop();
        } catch {}
      }
    } catch (err) {
      this.onLog?.(
        'warn',
        `Spare worker warm-up failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        worker.stop();
      } catch {}
    } finally {
      this.warming = false;
    }
  }

  /** Hand a warmed spare to the caller, or null to spawn fresh. Synchronous lease. */
  private async takeSpare(): Promise<WorkerHost | null> {
    const worker = this.spare;
    if (!worker) return null;
    this.spare = null; // single-threaded main: no other open() can grab it now
    if (!worker.alive) {
      try {
        worker.stop();
      } catch {}
      return null;
    }
    return worker;
  }

  /** Spawn + bind a worker to `sessionId`. Resolves once the session is loaded. */
  async open(sessionId: string, opts?: { cwd?: string }): Promise<OpenTabInfo> {
    const existing = this.map.get(sessionId);
    if (existing) {
      return { sessionId, provider: existing.provider, model: existing.model, busy: existing.busy };
    }
    // Take the pre-warmed spare when available (skips spawn + Agent construction);
    // a fresh spawn otherwise.
    let worker: WorkerHost | null = await this.takeSpare();
    const fromSpare = worker !== null;
    if (!worker) {
      worker = new WorkerHost(workerScriptPath());
      worker.start();
      // Every tab proxies MCP through the single main-process hub (one OS process
      // per MCP server, shared by all tabs — no per-tab shadow processes).
      worker.onMcpRequest = (op, params) => mcpHub.handle(op, params);
    }
    const bound: BoundWorker = {
      sessionId,
      provider: '',
      model: '',
      busy: false,
      worker,
    };
    this.wire(bound);
    try {
      if (fromSpare) {
        // Spare already ran earlyInit (no cwd) — apply this tab's working directory.
        if (opts?.cwd) await worker.request('setCwd', { cwd: opts.cwd });
      } else {
        await worker.request('earlyInit', opts?.cwd ? { cwd: opts.cwd } : undefined);
      }
      const sid = (await worker.request('startSession', { sessionId })) as string;
      bound.sessionId = sid || sessionId;
      const status = (await worker.request('getStatus')) as {
        provider?: string;
        model?: string;
        busy?: boolean;
      };
      bound.provider = typeof status.provider === 'string' ? status.provider : '';
      bound.model = typeof status.model === 'string' ? status.model : '';
      bound.busy = !!status.busy;
      this.map.set(bound.sessionId, bound);
      this.onChange?.(this.tabs());
      // Keep one spare warm for the next open (gated on resource health).
      void this.warmSpare();
      return {
        sessionId: bound.sessionId,
        provider: bound.provider,
        model: bound.model,
        busy: bound.busy,
      };
    } catch (err) {
      try {
        worker.stop();
      } catch {}
      this.map.delete(sessionId);
      throw err;
    }
  }

  /**
   * Spawn a FRESH session inside a new worker via the core's create-new path
   * (no sessionId argument to startSession), optionally carrying the parent
   * session's project memory forward (Desktop /new). The brand-new session id
   * is created inside this worker's process, so its derived baseline lives in
   * the same process that will serve the tab — matching CLI /new exactly.
   *
   * Honors the same override map keyed by the NEW session id on success.
   */
  async openNew(opts?: { cwd?: string; prevSessionId?: string }): Promise<OpenTabInfo> {
    // The parent's memory must be finalized in its OWN process (which holds the
    // real in-memory conversation): compress + persist a structured summary so
    // the derived session inherits substance instead of a blank baseline. Best
    // effort — a failure here must not block the new session (the core's
    // injectDerivedContext falls back to the stored transcript).
    const parentId = opts?.prevSessionId;
    if (parentId) {
      const parent = this.map.get(parentId);
      if (parent && !parent.busy) {
        try {
          await parent.worker.request('prepareParentMemory', {});
        } catch (err) {
          this.onLog?.('warn', `prepareParentMemory failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    let worker: WorkerHost | null = await this.takeSpare();
    const fromSpare = worker !== null;
    if (!worker) {
      worker = new WorkerHost(workerScriptPath());
      worker.start();
      worker.onMcpRequest = (op, params) => mcpHub.handle(op, params);
    }
    const bound: BoundWorker = {
      sessionId: '',
      provider: '',
      model: '',
      busy: false,
      worker,
    };
    this.wire(bound);
    try {
      if (fromSpare) {
        if (opts?.cwd) await worker.request('setCwd', { cwd: opts.cwd });
      } else {
        await worker.request('earlyInit', opts?.cwd ? { cwd: opts.cwd } : undefined);
      }
      const sid = (await worker.request('startSession', {
        prevSessionId: opts?.prevSessionId,
      })) as string;
      if (!sid || typeof sid !== 'string' || sid.length === 0) {
        throw new Error('worker startSession returned no session id');
      }
      bound.sessionId = sid;
      const status = (await worker.request('getStatus')) as {
        provider?: string;
        model?: string;
      };
      bound.provider = typeof status.provider === 'string' ? status.provider : '';
      bound.model = typeof status.model === 'string' ? status.model : '';
      this.map.set(sid, bound);
      this.onChange?.(this.tabs());
      // Keep one spare warm for the next open (gated on resource health).
      void this.warmSpare();
      return {
        sessionId: sid,
        provider: bound.provider,
        model: bound.model,
        busy: bound.busy,
      };
    } catch (err) {
      try {
        worker.stop();
      } catch {}
      this.map.delete(bound.sessionId);
      throw err;
    }
  }

  /**
   * Re-read config.json into every open session worker's in-memory ConfigManager.
   *
   * After the config Web UI rewrites ~/.nexus/config.json (e.g. a provider was
   * added/removed), each session worker otherwise keeps a STALE in-memory copy;
   * its next save() would then silently write the old provider list back to
   * disk and re-surface deleted providers in the UI. Reloading them all here
   * prevents that lost-update overwrite.
   */
  async reloadAll(): Promise<void> {
    for (const b of this.map.values()) {
      try {
        await b.worker.request('reloadConfig');
      } catch {
        /* best-effort — a worker may be mid-turn or already gone */
      }
    }
  }

  /** Route a worker method call to the session's own process. */
  request<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>): Promise<T> {
    const b = this.map.get(sessionId);
    if (!b) throw new Error(`No open session worker for ${sessionId}`);
    return b.worker.request<T>(method, params);
  }

  /** Best-effort async state refresh after a provider/model switch. */
  async refreshState(sessionId: string): Promise<void> {
    const b = this.map.get(sessionId);
    if (!b) return;
    try {
      const status = (await b.worker.request('getStatus')) as {
        provider?: string;
        model?: string;
        busy?: boolean;
      };
      b.provider = typeof status.provider === 'string' ? status.provider : b.provider;
      b.model = typeof status.model === 'string' ? status.model : b.model;
      b.busy = !!status.busy;
    } catch {}
  }

  close(sessionId: string): void {
    const b = this.map.get(sessionId);
    if (!b) return;
    this.map.delete(sessionId);
    try {
      b.worker.stop();
    } catch {}
    this.onChange?.(this.tabs());
    // Closing a tab is idle time — refill the spare so the next open is warm.
    void this.warmSpare();
  }

  closeAll(): void {
    for (const sessionId of [...this.map.keys()]) this.close(sessionId);
    if (this.spare) {
      const w = this.spare;
      this.spare = null;
      try {
        w.stop();
      } catch {}
    }
  }
}
