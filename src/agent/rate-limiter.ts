/**
 * Per-process rate limiter using a sliding-window counter.
 *
 * Each provider family (zhipu / agnes / unknown) tracks requests made in the
 * last 60 seconds. When acquire() is called and the window is full, it awaits
 * until the oldest request expires — no dropped requests, no lost turns.
 *
 * On a 429 from the upstream API, markRateLimited() sets a mandatory backoff
 * that supersedes the normal sliding window for one retry cycle.
 */

/** Infer provider family from baseUrl — used by AgentService to key the limiter. */
export function inferProviderFamily(baseUrl?: string): 'zhipu' | 'agnes' | 'unknown' {
  if (!baseUrl) return 'unknown';
  const u = baseUrl.toLowerCase();
  if (/open\.bigmodel/.test(u)) return 'zhipu';
  if (/apihub\.agnes-ai/.test(u)) return 'agnes';
  return 'unknown';
}

const WINDOW_MS = 60_000;
const DEFAULT_RPM: Record<string, number> = {
  zhipu: 20,
  agnes: 20,
  unknown: 5,
};

interface Bucket {
  timestamps: number[];
  rpm: number;
  backoffUntil: number; // epoch ms; 0 = no backoff
  consecutive429: number;
}

export interface RateLimitStatus {
  providerName: string;
  baseUrl: string;
  family: string;
  rpm: number;
  recentRequests: number;
  backoffMs: number;
  status: 'normal' | 'warning' | 'throttled';
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly customRpm = new Map<string, number>();

  getEffectiveRpm(family: string): number {
    return this.customRpm.get(family) ?? DEFAULT_RPM[family] ?? DEFAULT_RPM.unknown;
  }

  setCustomRpm(family: string, rpm: number): void {
    this.customRpm.set(family, rpm);
  }

  async acquire(family: string, rpm?: number): Promise<void> {
    const limit = rpm ?? this.getEffectiveRpm(family);
    const now = Date.now();
    let bucket = this.buckets.get(family);
    if (!bucket) {
      bucket = { timestamps: [], rpm: limit, backoffUntil: 0, consecutive429: 0 };
      this.buckets.set(family, bucket);
    }
    bucket.rpm = limit;

    // Enforce any active backoff first.
    if (bucket.backoffUntil > now) {
      const waitMs = bucket.backoffUntil - now;
      await this.sleep(waitMs);
      // Re-check after waking — backoff may have expired.
      if (bucket.backoffUntil <= Date.now()) {
        bucket.backoffUntil = 0;
      } else {
        await this.acquire(family, limit);
        return;
      }
    }

    // Prune timestamps outside the window.
    const cutoff = now - WINDOW_MS;
    bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

    if (bucket.timestamps.length >= limit) {
      // Wait until the oldest request in the window slides out.
      const oldest = bucket.timestamps[0];
      const waitMs = oldest + WINDOW_MS - Date.now();
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
      // Re-prune and re-check after waking.
      const now2 = Date.now();
      const cutoff2 = now2 - WINDOW_MS;
      bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff2);
      if (bucket.timestamps.length >= limit) {
        // Spinning wait (rare): keep pruning until a slot opens.
        while (bucket.timestamps.length >= limit) {
          const w = bucket.timestamps[0] + WINDOW_MS - Date.now();
          if (w > 0) await this.sleep(w);
          const now3 = Date.now();
          const c3 = now3 - WINDOW_MS;
          bucket.timestamps = bucket.timestamps.filter((t) => t > c3);
        }
      }
    }

    bucket.timestamps.push(Date.now());
  }

  markRateLimited(family: string): void {
    const bucket = this.getOrCreate(family);
    bucket.consecutive429 += 1;
    const baseMs = 15_000;
    const capMs = 60_000;
    const backoffMs = Math.min(baseMs * Math.pow(2, bucket.consecutive429 - 1), capMs);
    bucket.backoffUntil = Date.now() + backoffMs;
  }

  getBackoffMs(family: string): number {
    const bucket = this.buckets.get(family);
    if (!bucket) return 0;
    return Math.max(0, bucket.backoffUntil - Date.now());
  }

  resetBackoff(family: string): void {
    const bucket = this.buckets.get(family);
    if (bucket) {
      bucket.backoffUntil = 0;
      bucket.consecutive429 = 0;
    }
  }

  getStatus(family: string, baseUrl?: string): RateLimitStatus | null {
    const bucket = this.buckets.get(family);
    if (!bucket) {
      return {
        providerName: family,
        baseUrl: baseUrl || '',
        family,
        rpm: this.getEffectiveRpm(family),
        recentRequests: 0,
        backoffMs: 0,
        status: 'normal',
      };
    }
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const recent = bucket.timestamps.filter((t) => t > cutoff).length;
    const rpm = bucket.rpm;
    const backoffMs = Math.max(0, bucket.backoffUntil - now);
    let status: RateLimitStatus['status'];
    if (backoffMs > 0) {
      status = 'throttled';
    } else if (recent >= rpm) {
      status = 'throttled';
    } else if (recent >= rpm * 0.7) {
      status = 'warning';
    } else {
      status = 'normal';
    }
    return {
      providerName: family,
      baseUrl: baseUrl || '',
      family,
      rpm,
      recentRequests: recent,
      backoffMs,
      status,
    };
  }

  private getOrCreate(family: string): Bucket {
    let b = this.buckets.get(family);
    if (!b) {
      b = { timestamps: [], rpm: this.getEffectiveRpm(family), backoffUntil: 0, consecutive429: 0 };
      this.buckets.set(family, b);
    }
    return b;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
