/**
 * Global cross-session rate-limit aggregator.
 *
 * Each session worker reports its per-family RateLimitStatus after every LLM
 * call. This registry merges them and emits a single aggregated snapshot to the
 * renderer via the nexus:rateLimitUpdate event so the sidebar always shows the
 * effective limit across all open tabs.
 */

import type { RateLimitStatus } from '../agent/types.js';

export interface RateLimitSnapshot {
  providers: RateLimitStatus[];
}

export class RateLimitRegistry {
  // sessionId → family → last-reported status
  private snapshots = new Map<string, Map<string, RateLimitStatus>>();
  private onChange?: (snapshot: RateLimitSnapshot) => void;

  setOnChange(fn: (snapshot: RateLimitSnapshot) => void): void {
    this.onChange = fn;
  }

  /** Called by each worker after callLlm() completes. */
  report(sessionId: string, status: RateLimitStatus): void {
    if (!this.snapshots.has(sessionId)) {
      this.snapshots.set(sessionId, new Map());
    }
    const familyMap = this.snapshots.get(sessionId)!;
    familyMap.set(status.family, status);
    this.onChange?.(this.buildSnapshot());
  }

  /** Remove a session's entries when its worker exits. */
  forget(sessionId: string): void {
    this.snapshots.delete(sessionId);
    this.onChange?.(this.buildSnapshot());
  }

  /**
   * Aggregate across open tabs.
   *
   * M9 — shared-quota merge: a provider's RPM budget is ONE pool for the whole
   * account, not a per-tab budget. Two tabs on the same provider draw from the
   * same pool, so the pool's recent usage is the SUM of every tab's requests
   * (taking the max, as before, would under-report a busy account). Backoff
   * stays the max (the most restrictive signal wins) and the tightest rpm the
   * minimum. Status is recomputed against the summed usage, not merged.
   */
  getAggregated(): RateLimitStatus[] {
    // Pool key = family + baseUrl: same provider account ⇒ shared pool.
    const pools = new Map<string, RateLimitStatus[]>();
    for (const familyMap of this.snapshots.values()) {
      for (const status of familyMap.values()) {
        const key = `${status.family}|${status.baseUrl || ''}`;
        let list = pools.get(key);
        if (!list) {
          list = [];
          pools.set(key, list);
        }
        list.push(status);
      }
    }
    const out: RateLimitStatus[] = [];
    for (const list of pools.values()) {
      if (list.length === 1) {
        out.push({ ...list[0] });
        continue;
      }
      const base = list[0];
      const recentRequests = list.reduce((n, s) => n + s.recentRequests, 0);
      const backoffMs = Math.max(...list.map((s) => s.backoffMs));
      const queuedMs = Math.max(...list.map((s) => s.queuedMs ?? 0));
      const rpm = Math.min(...list.map((s) => s.rpm));
      out.push({
        ...base,
        rpm,
        recentRequests,
        backoffMs,
        queuedMs,
        status: statusFromUsage(recentRequests, rpm, backoffMs),
      });
    }
    return out;
  }

  private buildSnapshot(): RateLimitSnapshot {
    return { providers: this.getAggregated() };
  }
}

/** Recompute a pool status from summed usage (mirrors RateLimiter.getStatus). */
function statusFromUsage(recent: number, rpm: number, backoffMs: number): RateLimitStatus['status'] {
  if (backoffMs > 0) return 'throttled';
  if (rpm > 0 && recent >= rpm) return 'throttled';
  if (rpm > 0 && recent >= rpm * 0.7) return 'warning';
  return 'normal';
}
