import { cpus } from 'node:os';

/**
 * System resource monitor for the Nexus Desktop multi-session protection.
 *
 * Every open session tab runs its own agent worker process, so unlimited tabs
 * can exhaust memory/CPU. This monitor samples SYSTEM-WIDE usage (not just this
 * app) and, with a debounced state machine, tells the caller whether new tabs
 * should be paused to avoid overload.
 *
 * Metrics:
 *   - Memory: (total - available) / total via Electron's
 *     process.getSystemMemoryInfo() (available includes reclaimable caches, so
 *     it matches the OS "available" intuition better than raw free).
 *   - CPU: two snapshots of os.cpus() taken ~pollMs apart; the delta of
 *     idle/total across all cores yields a system load estimate.
 *
 * Debounce: a usage spike is only treated as overload AFTER `debounce` (3)
 * consecutive samples both exceed the thresholds. Once overloaded, a single
 * sample dropping back below BOTH thresholds recovers it to normal (so new
 * tabs become allowed again).
 *
 * Uses only Node built-ins + Electron's process.getSystemMemoryInfo() — no
 * third-party dependency (avoids a native/systeminformation weight).
 */

export type ResourceStatus = 'normal' | 'warning' | 'overloaded';

export interface ResourceState {
  status: ResourceStatus;
  running: boolean;
  /** 0..1 system memory in use. NaN when unavailable. */
  memoryPct: number;
  /** 0..1 estimated system CPU load. NaN when unavailable / still sampling. */
  cpuPct: number;
  atMax?: boolean;
  updatedAt: number;
}

export interface ResourceThresholds {
  maxTabs: number;
  memThresholdPct: number;
  cpuThresholdPct: number;
  monitorEnabled: boolean;
}

interface CpuSnapshot {
  idle: number;
  total: number;
}

function sampleCpu(): CpuSnapshot | null {
  const list = cpus();
  if (!list || list.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const c of list) {
    idle += c.times.idle;
    total +=
      c.times.user +
      c.times.nice +
      c.times.sys +
      c.times.idle +
      c.times.irq;
  }
  return { idle, total };
}

export class ResourceMonitor {
  private intervalMs: number;
  private memThreshold = 0.8;
  private cpuThreshold = 0.7;
  private enabled = true;
  private loadCount = 0;
  private overloaded = false;
  private lastCpu: CpuSnapshot | null = null;
  private lastCpuPct = 0;
  private lastMemPct = 0;
  private lastAtMax = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private log: (msg: string) => void = () => {};

  onState?: (state: ResourceState) => void;

  constructor(opts?: { intervalMs?: number; log?: (msg: string) => void }) {
    this.intervalMs = opts?.intervalMs ?? 5000;
    if (opts?.log) this.log = opts.log;
  }
  /** Apply persisted thresholds/toggle. Idempotent; safe to call before start(). */
  apply(opts: Partial<ResourceThresholds>): void {
    if (typeof opts.memThresholdPct === 'number' && opts.memThresholdPct > 0) {
      this.memThreshold = opts.memThresholdPct / 100;
    }
    if (typeof opts.cpuThresholdPct === 'number' && opts.cpuThresholdPct > 0) {
      this.cpuThreshold = opts.cpuThresholdPct / 100;
    }
    if (typeof opts.monitorEnabled === 'boolean') this.enabled = opts.monitorEnabled;
  }

  /** Set the "current tabs == max tabs" flag surfaced in state (renderer hint). */
  setAtMax(atMax: boolean): void {
    this.lastAtMax = atMax;
  }

  start(): void {
    // Prime the CPU baseline immediately so the first delta isn't skewed.
    this.lastCpu = sampleCpu();
    if (!this.enabled) return;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get currentMemoryPct(): number {
    return this.lastMemPct;
  }

  get currentCpuPct(): number {
    return this.lastCpuPct;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether new-tab creation should be paused. False when monitoring is off. */
  isOverloaded(): boolean {
    return this.enabled && this.overloaded;
  }

  getState(): ResourceState {
    return {
      status: this.classify(),
      running: this.enabled,
      memoryPct: this.lastMemPct,
      cpuPct: this.lastCpuPct,
      atMax: this.lastAtMax || undefined,
      updatedAt: Date.now(),
    };
  }

  private classify(): ResourceStatus {
    if (!this.enabled) return 'normal';
    if (this.overloaded) return 'overloaded';
    // A single recent sample over threshold but not yet debounced → warning.
    if (
      this.lastMemPct >= this.memThreshold ||
      this.lastCpuPct >= this.cpuThreshold
    ) {
      return 'warning';
    }
    return 'normal';
  }

  private sample(): void {
    let mem: number | undefined;
    try {
      const info = process.getSystemMemoryInfo?.() as
        | { total: number; free: number; available?: number }
        | undefined;
      if (info && info.total > 0) {
        const avail = typeof info.available === 'number' ? info.available : info.free;
        mem = Math.max(0, (info.total - avail) / info.total);
      }
    } catch {
      mem = undefined;
    }

    let cpu: number | undefined;
    const cur = sampleCpu();
    if (cur && this.lastCpu) {
      const idled = Math.max(0, cur.idle - this.lastCpu.idle);
      const totald = Math.max(0, cur.total - this.lastCpu.total);
      if (totald > 0) {
        cpu = Math.min(1, Math.max(0, 1 - idled / totald));
      }
    }
    this.lastCpu = cur;

    if (mem !== undefined) this.lastMemPct = mem;
    if (cpu !== undefined) this.lastCpuPct = cpu;

    const memOver = this.lastMemPct >= this.memThreshold;
    const cpuOver = this.lastCpuPct >= this.cpuThreshold;

    if (memOver || cpuOver) {
      this.loadCount++;
      // Debounce: only after consecutive samples both-cross threshold.
      if (this.loadCount >= 3) {
        if (!this.overloaded) {
          this.overloaded = true;
          this.log(
            `Resource overloaded (mem=${(this.lastMemPct * 100).toFixed(0)}%, ` +
              `cpu=${(this.lastCpuPct * 100).toFixed(0)}%) — pausing new tabs`,
          );
        }
      }
    } else {
      this.loadCount = 0;
      if (this.overloaded) {
        this.overloaded = false;
        this.log('Resource back to normal — new tabs allowed');
      }
    }

    this.onState?.(this.getState());
  }
}
