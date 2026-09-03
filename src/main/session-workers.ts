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

  /** Spawn + bind a worker to `sessionId`. Resolves once the session is loaded. */
  async open(sessionId: string, opts?: { cwd?: string }): Promise<OpenTabInfo> {
    const existing = this.map.get(sessionId);
    if (existing) {
      return { sessionId, provider: existing.provider, model: existing.model, busy: existing.busy };
    }
    const worker = new WorkerHost(workerScriptPath());
    const bound: BoundWorker = {
      sessionId,
      provider: '',
      model: '',
      busy: false,
      worker,
    };
    this.wire(bound);
    worker.start();
    // Every tab proxies MCP through the single main-process hub (one OS process
    // per MCP server, shared by all tabs — no per-tab shadow processes).
    worker.onMcpRequest = (op, params) => mcpHub.handle(op, params);
    try {
      await worker.request('earlyInit', opts?.cwd ? { cwd: opts.cwd } : undefined);
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
  }

  closeAll(): void {
    for (const sessionId of [...this.map.keys()]) this.close(sessionId);
  }
}
