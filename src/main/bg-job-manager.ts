/**
 * Background Job Manager — persistent task scheduler for the desktop app.
 *
 * Solves three problems that arise when a long-running sub-agent task is
 * interrupted by gate timeouts or wall-clock kills:
 *
 * 1. **No unified progress tracking** — each worker process dies on its own,
 *    leaving no trace.  Jobs are now persisted to ~/.nexus/jobs.json so the
 *    main process (which survives tab closes) can drive polling and recovery.
 *
 * 2. **No automatic reporting** — when a job finishes (or fails) outside the
 *    owning session, nobody tells the user.  The manager emits
 *    `bg_job_complete` / `bg_job_progress` IPC events that the renderer
 *    surfaces as in-chat notifications.
 *
 * 3. **No async progress query** — callers cannot ask "how's task X going?"
 *    after the owning tab is gone.  `bgJobQuery` resolves from the in-memory
 *    store; when the job is still running it also fans out a `pollWorker`
 *    request to the original worker (if alive) to pull live progress.
 *
 * Job lifecycle:
 *   created → queued → running → succeeded | failed | cancelled | timeout
 *
 * Recovery on main-process restart:
 *   On init, any job whose status is `queued` or `running` is re-queued so
 *   the orchestrator picks it up again.  Stuck jobs older than STUCK_THRESHOLD
 *   are auto-failed with a note so the UI never shows a permanent spinner.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BgJobStatus =
  | 'created'   // registered but not yet picked up
  | 'queued'    // in the scheduling queue
  | 'running'   // actively being executed by a worker
  | 'succeeded' // completed successfully
  | 'failed'    // execution errored out
  | 'timeout'   // exceeded maxDurationMs
  | 'cancelled' // explicitly cancelled by the user
  | 'stale';    // abandoned after main-process restart (auto-failed on recovery)

export interface BgJobDef {
  /** Stable UUID assigned at creation time. */
  id: string;
  /** Human-readable title (shown in the job list UI). */
  title: string;
  /** The LLM prompt given to the worker that will execute this job. */
  prompt: string;
  /** Owning session id — the event target when the job completes. */
  sessionId: string;
  /** Tool allowlist (empty = all tools). */
  toolAllowlist?: string[];
  /** Max wall-clock time before auto-timeout (ms).  Default 10 min. */
  maxDurationMs: number;
  /** Max turns before auto-fail (default 50). */
  maxTurns: number;
  /** Constitution text inherited by the sub-agent (optional). */
  constitution?: string;
  status: BgJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  /** Progress hint — set by the worker during execution (0–100). */
  progress?: number;
  progressNote?: string;
  output?: string;
  error?: string;
  workerPid?: number;
  /** Internal: language detected from the originating prompt (zh-CN | en). */
  _lang?: 'zh-CN' | 'en';
}

export interface BgJobCreateOpts {
  title: string;
  prompt: string;
  sessionId: string;
  toolAllowlist?: string[];
  maxDurationMs?: number;
  maxTurns?: number;
  constitution?: string;
}

export interface BgJobListFilter {
  sessionId?: string;
  status?: BgJobStatus;
}

// ---------------------------------------------------------------------------
// Persistence path
// ---------------------------------------------------------------------------

function jobsFilePath(): string {
  return join(homedir(), '.nexus', 'jobs.json');
}

const STUCK_THRESHOLD_MS = 5 * 60_000; // jobs older than 5 min without update → stale
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;
const DEFAULT_MAX_TURNS = 50;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class BgJobManager {
  private jobs = new Map<string, BgJobDef>();
  private subscribers = new Set<(job: BgJobDef) => void>();

  constructor() {
    this._load();
    this._recoveryScan();
  }

  // -- public API ----------------------------------------------------------

  create(opts: BgJobCreateOpts & { _lang?: 'zh-CN' | 'en' }): BgJobDef {
    const now = Date.now();
    const job: BgJobDef = {
      id: `bj_${uuidv4().slice(0, 8)}`,
      title: opts.title,
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      toolAllowlist: opts.toolAllowlist,
      maxDurationMs: opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
      constitution: opts.constitution,
      status: 'queued',
      createdAtMs: now,
      updatedAtMs: now,
      _lang: opts._lang,
    };
    this.jobs.set(job.id, job);
    this._save();
    this._emit(job);
    return job;
  }

  query(id: string): BgJobDef | null {
    return this.jobs.get(id) ?? null;
  }

  list(filter?: { sessionId?: string; status?: BgJobStatus }): BgJobDef[] {
    return [...this.jobs.values()].filter((j) => {
      if (filter?.sessionId && j.sessionId !== filter.sessionId) return false;
      if (filter?.status && j.status !== filter.status) return false;
      return true;
    });
  }

  cancel(id: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: 'job not found' };
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'timeout' || job.status === 'cancelled') {
      return { ok: false, error: `job already terminal (${job.status})` };
    }
    job.status = 'cancelled';
    job.finishedAtMs = Date.now();
    job.updatedAtMs = Date.now();
    this._save();
    this._emit(job);
    return { ok: true };
  }

  advanceProgress(
    id: string,
    opts: { progress?: number; note?: string; status?: BgJobStatus; output?: string; error?: string },
  ): BgJobDef | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (opts.progress !== undefined) job.progress = opts.progress;
    if (opts.note !== undefined) job.progressNote = opts.note;
    if (opts.status) {
      job.status = opts.status;
      job.finishedAtMs = Date.now();
    }
    if (opts.output !== undefined) job.output = opts.output;
    if (opts.error !== undefined) job.error = opts.error;
    job.updatedAtMs = Date.now();
    this._save();
    this._emit(job);
    return job;
  }

  onComplete(id: string, output: string, tokenUsage?: { prompt: number; completion: number }): BgJobDef | null {
    return this.advanceProgress(id, { status: 'succeeded', output });
  }

  onFailure(id: string, error: string): BgJobDef | null {
    return this.advanceProgress(id, { status: 'failed', error });
  }

  /** Called from the main process loop to push updates into running jobs. */
  notify(id: string, partial: Partial<BgJobDef>): BgJobDef | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (partial.status) job.status = partial.status;
    if (partial.progress !== undefined) job.progress = partial.progress;
    if (partial.progressNote !== undefined) job.progressNote = partial.progressNote;
    if (partial.output !== undefined) job.output = partial.output;
    if (partial.error !== undefined) job.error = partial.error;
    job.updatedAtMs = Date.now();
    this._save();
    this._emit(job);
    return job;
  }

  // -- subscriber / event --------------------------------------------------

  subscribe(fn: (job: BgJobDef) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  /** Return all subscriber callbacks (for IPC event fan-out in main/index.ts). */
  _getSubscribers(): Set<(job: BgJobDef) => void> {
    return this.subscribers;
  }

  /**
   * Called by WorkerHost when a worker posts a 'bgJobRequest'.
   * Routes the op to the appropriate manager method and returns the result
   * so the worker's pending promise can resolve.
   */
  handleWorkerRequest(op: string, params?: Record<string, unknown>): unknown {
    switch (op) {
      case 'create': {
        const job = this.create({
          title: String(params?.title ?? ''),
          prompt: String(params?.prompt ?? ''),
          sessionId: String(params?.sessionId ?? ''),
          toolAllowlist: Array.isArray(params?.toolAllowlist) ? (params.toolAllowlist as string[]) : undefined,
          maxDurationMs: typeof params?.maxDurationMs === 'number' ? params.maxDurationMs : undefined,
          maxTurns: typeof params?.maxTurns === 'number' ? params.maxTurns : undefined,
          constitution: typeof params?.constitution === 'string' ? params.constitution : undefined,
        });
        return { ok: true, jobId: job.id };
      }
      case 'query': {
        const jobId = String(params?.jobId ?? '');
        const job = this.jobs.get(jobId) ?? null;
        return { ok: true, job };
      }
      case 'list': {
        const filter: import('./bg-job-manager.js').BgJobListFilter | undefined = params
          ? {
              sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
              status: (params.status as BgJobStatus | undefined),
            }
          : undefined;
        return { ok: true, jobs: this.list(filter) };
      }
      case 'cancel': {
        const jobId = String(params?.jobId ?? '');
        const res = this.cancel(jobId);
        return res;
      }
      case 'progress': {
        const jobId = String(params?.jobId ?? '');
        const job = this.advanceProgress(jobId, {
          progress: typeof params?.progress === 'number' ? params.progress : undefined,
          note: typeof params?.note === 'string' ? params.note : undefined,
        });
        return { ok: true, job };
      }
      default:
        return { ok: false, error: `unknown bg_job op: ${op}` };
    }
  }

  // -- recovery ------------------------------------------------------------

  /**
   * Called once at startup.  Any job still in `queued` / `running` gets a
   * second chance; anything older than STUCK_THRESHOLD_MS is marked `stale`.
   */
  _recoveryScan(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'timeout' || job.status === 'cancelled') continue;
      const age = now - (job.updatedAtMs ?? job.createdAtMs);
      if (age > STUCK_THRESHOLD_MS) {
        job.status = 'stale';
        job.error = `abandoned after ${Math.round(age / 60_000)} min (main process restart)`;
        job.finishedAtMs = now;
        job.updatedAtMs = now;
        this._save();
        this._emit(job);
      } else if (job.status === 'queued' || job.status === 'running') {
        // Give it one more chance — the orchestrator will pick it up.
        job.status = 'queued';
        job.updatedAtMs = now;
      }
    }
    this._save();
  }

  // -- internals -----------------------------------------------------------

  private _load(): void {
    try {
      const raw = readFileSync(jobsFilePath(), 'utf8');
      const arr = JSON.parse(raw) as BgJobDef[];
      for (const j of arr) this.jobs.set(j.id, j);
    } catch {
      // fresh install — nothing to load
    }
  }

  private _save(): void {
    try {
      const dir = join(homedir(), '.nexus');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(jobsFilePath(), JSON.stringify([...this.jobs.values()], null, 2), 'utf8');
    } catch {
      // best-effort persistence
    }
  }

  private _emit(job: BgJobDef): void {
    for (const fn of this.subscribers) {
      try { fn(job); } catch {}
    }
  }
}
