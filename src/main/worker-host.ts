import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createInterface } from 'node:readline';
import { app, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import type { AgentEvent } from '../agent-service.js';
import { logger } from '../shared/logger.js';

const diag = (s: string): void => {
  logger.debug(s);
};

/** Cap the agent worker's V8 heap (~2GB default is far above what one session needs). */
const WORKER_V8_FLAG = '--max-old-space-size=1024';
/** Grace period between sending 'shutdown' RPC and force-killing the worker. */
const SHUTDOWN_TIMEOUT_MS = 3000;

interface WorkerResponse {
  type: 'result' | 'event' | 'permission' | 'log' | 'mcpRequest';
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
  event?: AgentEvent;
  id_p?: string;
  question?: string;
  level?: string;
  message?: string;
  op?: string;
}

type WorkerHandle = ChildLike | UtilityProcess;

interface ChildLike {
  stdin?: { write(chunk: string): boolean; end(): void };
  stdout?: { on(event: 'data', cb: (chunk: string) => void): void };
  stderr?: { on(event: 'data', cb: (chunk: string) => void): void };
  on(event: string, cb: (...args: unknown[]) => void): void;
  kill(): void;
}

/**
 * Manages the process that hosts the nexus core (AgentService).
 *
 * - Dev / npm install: spawns system `node` (worker = stdio JSON-RPC). Native
 *   modules keep their system-Node ABI.
 * - Packaged exe: uses Electron `utilityProcess` (worker = parentPort
 *   JSON-RPC). Native modules ship as an Electron-ABI build compiled under
 *   .native/electron (prepare-electron-native.mjs) and swapped into the output
 *   by the afterPack hook; the exe ships its own Node runtime.
 */
export class WorkerHost {
  private handle: WorkerHandle | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private stopping = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  onEvent?: (event: AgentEvent) => void;
  onPermission?: (req: { id: string; question: string }) => void;
  onLog?: (level: string, message: string) => void;
  onExit?: (code: number | null) => void;
  /** Worker -> main request handler (currently the shared MCP hub proxy). */
  onMcpRequest?: (op: string, params?: Record<string, unknown>) => Promise<unknown>;

  constructor(private workerPath: string) {}

  start(): void {
    diag(`start() path=${this.workerPath}`);
    if (app.isPackaged) {
      this.startUtilityProcess();
    } else {
      this.startChildProcess();
    }
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const payload = { id, method, ...(params ? { params } : {}) };
    diag(`request id=${id} method=${method}`);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      if (app.isPackaged) {
        (this.handle as UtilityProcess).postMessage(payload);
      } else {
        const child = this.handle as ChildLike;
        if (!child.stdin?.write) {
          this.pending.delete(id);
          reject(new Error('Worker is not running'));
          return;
        }
        child.stdin.write(JSON.stringify(payload) + '\n');
      }
    });
  }

  /** Send a raw message to the worker (used to reply to a worker->main request). */
  post(msg: Record<string, unknown>): void {
    if (app.isPackaged) {
      (this.handle as UtilityProcess)?.postMessage(msg);
    } else {
      (this.handle as ChildLike | null)?.stdin?.write(JSON.stringify(msg) + '\n');
    }
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    const h = this.handle;
    if (!h) return;
    // Graceful shutdown: send the 'shutdown' RPC so the worker can flush the
    // session DB/WAL before exiting. Fall back to a hard kill after a timeout.
    try {
      if (app.isPackaged) {
        (h as UtilityProcess).postMessage({ id: this.nextId++, method: 'shutdown' });
      } else {
        (h as ChildLike).stdin?.write(JSON.stringify({ id: this.nextId++, method: 'shutdown' }) + '\n');
      }
    } catch {}
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.failAllPending(new Error('Worker stopped'));
      try {
        if (app.isPackaged) {
          (h as UtilityProcess).kill();
        } else {
          (h as ChildLike)?.stdin?.end();
        }
      } catch {}
    }, SHUTDOWN_TIMEOUT_MS);
  }

  private clearStopTimer(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private startChildProcess(): void {
    const child = spawn('node', [WORKER_V8_FLAG, this.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.handle = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.onLog?.('stderr', line);
      }
    });

    this.rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let msg: WorkerResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    child.on('error', (err) => {
      this.onLog?.('error', `Worker spawn failed: ${err.message}`);
    });
    child.on('exit', (code) => {
      this.onLog?.('warn', `Worker exited (code=${code})`);
      this.clearStopTimer();
      this.onExit?.(code);
      this.failAllPending(new Error('Worker exited'));
    });
  }

  private startUtilityProcess(): void {
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: 'nexus-core',
      stdio: 'pipe',
      execArgv: [WORKER_V8_FLAG],
    });
    this.handle = child;
    diag(`utilityProcess forked pid=${(child as unknown as { pid?: number }).pid}`);

    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) {
          diag(`stderr: ${line}`);
          this.onLog?.('stderr', line);
        }
      }
    });

    child.on('message', (msg) => {
      diag(`message: ${(msg as WorkerResponse)?.type}:${(msg as WorkerResponse)?.id ?? ''}`);
      this.dispatch(msg as WorkerResponse);
    });
    child.on('error', (err) => {
      diag(`error: ${(err as unknown as Error).message ?? String(err)}`);
      this.onLog?.('error', `Utility worker failed: ${(err as unknown as Error).message ?? String(err)}`);
    });
    child.on('exit', (code) => {
      diag(`exit code=${code}`);
      this.onLog?.('warn', `Utility worker exited (code=${code})`);
      this.clearStopTimer();
      this.onExit?.(code);
      this.failAllPending(new Error('Worker exited'));
    });
  }

  private dispatch(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'result':
        this.resolveResult(msg.id!, msg.ok!, msg.data, msg.error);
        break;
      case 'event':
        this.onEvent?.(msg.event!);
        break;
      case 'permission':
        this.onPermission?.({ id: String(msg.id ?? ''), question: msg.question! });
        break;
      case 'log':
        this.onLog?.(msg.level!, msg.message!);
        break;
      case 'mcpRequest': {
        const id = msg.id ?? 0;
        const op = msg.op ?? '';
        const params = msg.data as Record<string, unknown> | undefined;
        // Forward to the shared MCP hub (single owner, one process per server),
        // then reply to this worker with the result. Await so MCP calls are
        // serialized through the hub without blocking the main thread.
        void (async () => {
          try {
            const res = this.onMcpRequest ? await this.onMcpRequest(op, params) : undefined;
            this.post({ type: 'mcpResult', id, ok: true, data: res });
          } catch (e) {
            this.post({ type: 'mcpResult', id, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        })();
        break;
      }
    }
  }

  private resolveResult(id: number, ok: boolean, data: unknown, error: string | undefined): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (ok) p.resolve(data);
    else p.reject(new Error(error || 'Worker error'));
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
