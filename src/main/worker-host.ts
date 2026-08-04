import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { app, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import type { AgentEvent } from '../agent-service.js';

const DIAG = 'C:/Users/pgw/AppData/Local/Temp/opencode/worker-host.log';
const diag = (s: string): void => {
  try {
    appendFileSync(DIAG, `${Date.now()} ${s}\n`);
  } catch {}
};

interface WorkerResponse {
  type: 'result' | 'event' | 'permission' | 'log';
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
  event?: AgentEvent;
  id_p?: string;
  question?: string;
  level?: string;
  message?: string;
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
 *   JSON-RPC). Native modules are rebuilt for the Electron ABI by
 *   electron-builder; the exe ships its own Node runtime.
 */
export class WorkerHost {
  private handle: WorkerHandle | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  onEvent?: (event: AgentEvent) => void;
  onPermission?: (req: { id: string; question: string }) => void;
  onLog?: (level: string, message: string) => void;
  onExit?: (code: number | null) => void;

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

  stop(): void {
    if (app.isPackaged) {
      this.handle?.kill();
    } else {
      (this.handle as ChildLike | null)?.stdin?.end();
    }
    this.failAllPending(new Error('Worker stopped'));
  }

  private startChildProcess(): void {
    const child = spawn('node', [this.workerPath], {
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
      this.onExit?.(code);
      this.failAllPending(new Error('Worker exited'));
    });
  }

  private startUtilityProcess(): void {
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: 'nexus-core',
      stdio: 'pipe',
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
