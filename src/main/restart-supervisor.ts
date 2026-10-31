/**
 * Crash-loop breaker + backoff scheduler for the core worker.
 *
 * Extracted from main/index.ts so the "expected exit vs. crash" state machine
 * is unit-testable (test/restart-supervisor.test.mjs).
 *
 * The bug this guards against (hot-restart failure after a core overlay
 * activation): `restartWorker()` stops the running host and immediately
 * starts a replacement. The old host's exit event arrives SECONDS later (the
 * graceful shutdown has a 3 s grace period). Without the intentional-stop
 * tag, that expected exit looks like a crash: it schedules another restart,
 * which stops the healthy replacement, which schedules another, until the
 * breaker trips and no worker runs at all. Only a full app restart recovered.
 */

export interface TimerHandle {
  clear(): void;
}

export interface Scheduler {
  schedule(fn: () => void, ms: number): TimerHandle;
}

const defaultScheduler: Scheduler = {
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return { clear: () => clearTimeout(t) };
  },
};

export interface RestartSupervisorOptions {
  /** Maximum crash-restart attempts before the breaker gives up. Default 3. */
  maxAttempts?: number;
  /** Delay base for exponential backoff (2^n * baseDelayMs). Default 1000. */
  baseDelayMs?: number;
  /** Backoff cap. Default 30000. */
  maxDelayMs?: number;
  /**
   * A worker that lived at least this long before exiting has proven the
   * setup (overlay or base) works, so its exit earns a fresh retry budget.
   * A worker that dies sooner is crash-looping: the attempt counter must
   * PERSIST across restarts, otherwise every fast init (deferMcp makes init
   * resolve in ~100ms) resets it and the breaker can never trip.
   */
  stableLifetimeMs?: number;
  /** Injectable timers for tests. */
  scheduler?: Scheduler;
  /** Log sink (keeps main's logger + renderer log channel in sync). */
  onLog?: (level: 'warn' | 'error', message: string) => void;
  /** Fires when a scheduled backoff restart comes due. */
  onRestart: () => void;
}

export class RestartSupervisor {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly stableLifetimeMs: number;
  private readonly scheduler: Scheduler;
  private readonly onLog?: (level: 'warn' | 'error', message: string) => void;
  private readonly onRestart: () => void;

  private stoppedHosts = new Set<unknown>();
  private appExiting = false;
  private attempts = 0;
  private pending: TimerHandle | null = null;

  constructor(opts: RestartSupervisorOptions) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.stableLifetimeMs = opts.stableLifetimeMs ?? 5 * 60_000;
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.onLog = opts.onLog;
    this.onRestart = opts.onRestart;
  }

  /** True once the app is quitting; all restart scheduling is suppressed. */
  get isAppExiting(): boolean {
    return this.appExiting;
  }

  markAppExiting(): void {
    this.appExiting = true;
    this.pending?.clear();
    this.pending = null;
  }

  /**
   * Tag a host that is being stopped on purpose (hot restart, overlay
   * rollback, app quit). Its later exit event is EXPECTED and must not be
   * treated as a crash.
   */
  markStopped(host: unknown): void {
    this.stoppedHosts.add(host);
  }

  /**
   * Handle a host's exit. Returns true when the exit was expected (the host
   * had been intentionally stopped) — the caller must skip ALL crash
   * handling, or a dying old host would stop its healthy replacement and
   * escalate into the breaker. For unexpected exits: refresh the retry
   * budget based on lifetime, then schedule the backoff restart.
   */
  recordExit(host: unknown, lifetimeMs: number): boolean {
    if (this.stoppedHosts.delete(host)) return true;
    if (lifetimeMs >= this.stableLifetimeMs) this.attempts = 0;
    this.requestCrashRestart();
    return false;
  }

  /**
   * Schedule one backoff crash-restart (or trip the breaker). Called from
   * `recordExit` for unexpected exits and from `restartWorker` when the new
   * worker's init fails. Returns 'exhausted' when no restart will run
   * (breaker tripped, or the app is quitting) — quietly, since the caller
   * already knows no worker will come back.
   */
  requestCrashRestart(): 'scheduled' | 'exhausted' {
    if (this.appExiting) return 'exhausted';
    if (this.attempts >= this.maxAttempts) {
      this.onLog?.('error', 'Core worker crashed repeatedly; please restart the app.');
      return 'exhausted';
    }
    // Only one pending restart at a time: a crash before the previous timer
    // fired must not stack a second restart on top of it.
    this.pending?.clear();
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempts);
    this.attempts += 1;
    this.onLog?.('warn', `Restarting core worker in ${delay}ms (attempt ${this.attempts}/${this.maxAttempts})`);
    this.pending = this.scheduler.schedule(() => {
      this.pending = null;
      this.onRestart();
    }, delay);
    return 'scheduled';
  }
}
