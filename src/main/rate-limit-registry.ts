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

  /** Aggregate: for each family, take the max backoffMs and max recentRequests. */
  getAggregated(): RateLimitStatus[] {
    const merged = new Map<string, RateLimitStatus>();
    for (const familyMap of this.snapshots.values()) {
      for (const status of familyMap.values()) {
        const existing = merged.get(status.family);
        if (!existing) {
          merged.set(status.family, { ...status });
          continue;
        }
        // Merge: keep the most restrictive signal.
        merged.set(status.family, {
          ...existing,
          recentRequests: Math.max(existing.recentRequests, status.recentRequests),
          backoffMs: Math.max(existing.backoffMs, status.backoffMs),
          status: this.mergeStatus(existing.status, status.status),
        });
      }
    }
    return [...merged.values()];
  }

  private buildSnapshot(): RateLimitSnapshot {
    return { providers: this.getAggregated() };
  }

  private mergeStatus(a: RateLimitStatus['status'], b: RateLimitStatus['status']): RateLimitStatus['status'] {
    const order: RateLimitStatus['status'][] = ['normal', 'warning', 'throttled'];
    return order[Math.max(order.indexOf(a), order.indexOf(b))] ?? 'normal';
  }
}
