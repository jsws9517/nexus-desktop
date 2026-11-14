/**
 * Spend-mode policy: how aggressively the harness paces a provider depending
 * on how it bills. Pure data + selectors only — importable from the worker,
 * the main process and the renderer (all bundled as plain ESM, no Node APIs).
 *
 * The billing way a provider works is a property of the ACCOUNT / ENDPOINT, not
 * of the model, so the mode is remembered per provider (keyed by host) in
 * `~/.nexus/desktop.json` — never in the core's config.json (its zod schema
 * strips unknown keys, see src/main/desktop-state.ts).
 *
 * Three tiers:
 *   token  — pay-per-call. Frugality is the constraint: tight RPM, short
 *            idle budget, conservative retry / fan-out / correction budgets.
 *   coding — subscription / bundled-credit plan (coding plan, monthly pack).
 *            The quota is the backstop, so pacing can be generous.
 *   free   — free tier / local. Money is NOT the constraint but the rate limit
 *            usually is: most patient thinking, tightest RPM, longer backoff.
 *
 * Every tier treats `idle` thinking as WARN-ONLY (never aborts): that matches
 * `handleThinkingStall()` in service.ts and is what keeps deep reasoning from
 * being killed to save tokens. The tiers only change pace, never correctness.
 */

export type SpendMode = 'token' | 'coding' | 'free';

/** Per-tier strategy. Single source of truth for every injection point. */
export interface SpendPolicy {
  /** Sliding-window RPM the rate limiter paces to. */
  rpm: number;
  /** Base backoff after a 429 (ms); doubles per consecutive 429, capped at cap. */
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Consecutive identical thinking deltas before a `loop` is flagged. */
  maxRepeat: number;
  /** Thinking tokens since last progress before an `idle` stall is flagged. */
  idleThinkingTokens: number;
  /** Max parallel sub-tasks a fan-out turn may spawn. */
  fanoutCap: number;
  /** Max 429 retries callLlm() attempts before surfacing the error. */
  retryBudget: number;
  /** Multiplier applied to the correction-loop budgets (L1–L4) per turn. */
  correctionScale: number;
}

export const SPEND_MODES: readonly SpendMode[] = ['token', 'coding', 'free'] as const;

export const SPEND_POLICIES: Record<SpendMode, SpendPolicy> = {
  // `token` MUST equal today's unknown-family behaviour (TurnMonitor DEFAULTS:
  // maxRepeat 6 / idle 2500, rate limiter rpm 5) — it is the SAFE default for
  // every provider with no explicit override, so it must be zero-regression.
  token: {
    rpm: 5,
    backoffBaseMs: 20_000,
    backoffCapMs: 120_000,
    maxRepeat: 6,
    idleThinkingTokens: 2_500,
    fanoutCap: 2,
    retryBudget: 1,
    correctionScale: 0.6,
  },
  coding: {
    rpm: 30,
    backoffBaseMs: 10_000,
    backoffCapMs: 60_000,
    maxRepeat: 8,
    idleThinkingTokens: 4_000,
    fanoutCap: 6,
    retryBudget: 3,
    correctionScale: 1.0,
  },
  free: {
    rpm: 3,
    backoffBaseMs: 30_000,
    backoffCapMs: 180_000,
    maxRepeat: 8,
    idleThinkingTokens: 4_000,
    fanoutCap: 3,
    retryBudget: 2,
    correctionScale: 0.9,
  },
};

/** The safe default when a provider has no explicit override. */
export const DEFAULT_SPEND_MODE: SpendMode = 'token';

export function isSpendMode(v: unknown): v is SpendMode {
  return v === 'token' || v === 'coding' || v === 'free';
}

export function resolveSpendPolicy(mode: SpendMode): SpendPolicy {
  return SPEND_POLICIES[mode] ?? SPEND_POLICIES[DEFAULT_SPEND_MODE];
}

/** Human-readable short label per tier (renderer chip). */
export const SPEND_MODE_LABEL: Record<SpendMode, string> = {
  token: 'Token',
  coding: 'Coding',
  free: 'Free',
};

/** A one-line policy summary for the /billing status card. */
export function describeSpendPolicy(mode: SpendMode): string {
  const p = resolveSpendPolicy(mode);
  return [
    `RPM ${p.rpm}`,
    `429 backoff ${Math.round(p.backoffBaseMs / 1000)}s–${Math.round(p.backoffCapMs / 1000)}s`,
    `loop ≥ ${p.maxRepeat}`,
    `idle ≥ ${p.idleThinkingTokens}t`,
    `fan-out ≤ ${p.fanoutCap}`,
    `retry ≤ ${p.retryBudget}`,
  ].join(' · ');
}
