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

/**
 * Optional desktop.json overrides for the unattended-coding relaxation floors
 * (see SpendPolicy.relaxedTurns / relaxedSubAgentTurns). Shape mirrors the
 * `spendMode` section already dual-written by the /billing worker, so both
 * surfaces can persist through the same mtime-cached read.
 *
 *   "spendMode": {
 *     "default": "coding",
 *     "relax": { "turns": 300, "subAgentTurns": 90 },
 *     "providers": { ... }
 *   }
 */
export interface SpendModeOverride {
  turns?: number;
  subAgentTurns?: number;
}

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
  /**
   * Consecutive same-class tool failures (RepetitionMonitor `fail_seq`) before
   * the spin guard aborts the turn. A pacing knob: generous tiers tolerate
   * longer failure storms (a model repairing bad args or probing a flaky
   * tool) before the harness calls it a spin; frugal tiers stop early.
   */
  failSeqMax: number;
  /**
   * Temporary floor applied to the main-chat `maxTurns` during unattended
   * coding runs. Only the `coding` tier relaxes: unattended coding is the one
   * mode where the user has explicitly asked for long-running work, so the
   * harness raises its turn budget. The relaxation is always restored in
   * `finally` after the turn.
   *
   * Floor, never ceiling: a user-configured value above this is preserved
   * (Math.max against the configured baseline). Default 200 matches the
   * historical RELAXED_UNATTENDED_MAX_TURNS constant.
   */
  relaxedTurns?: number;
  /**
   * Temporary floor applied to every sub-agent role's maxTurns during
   * unattended coding runs. Same floor-not-ceiling semantics as `relaxedTurns`.
   * Default 60 matches the historical RELAXED_SUBAGENT_FLOOR_TURNS constant.
   */
  relaxedSubAgentTurns?: number;
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
    // = today's RepetitionMonitor default; the safe tier must stay zero-regression.
    failSeqMax: 3,
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
    // Subscription backstop: tolerate longer same-class failure storms (a model
    // repairing bad args or probing a flaky tool) before the spin guard aborts.
    failSeqMax: 6,
    // Unattended-coding relaxation floors (see SpendPolicy.relaxedTurns docs).
    // Overridable in desktop.json; these are the safe defaults.
    relaxedTurns: 200,
    relaxedSubAgentTurns: 60,
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
    // Rate-limited tier: stop a failure storm early, same as the safe default.
    failSeqMax: 3,
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

/**
 * Resolve the relaxed-turns floor for the coding tier.
 *
 * `override` (when finite and > 0) wins; otherwise the policy's built-in
 * `relaxedTurns` (or the 200 fallback for tiers that don't declare one, e.g.
 * the `token` / `free` tiers where the relaxation itself is off anyway).
 *
 * Callers are expected to combine with Math.max(configured, floor) so that a
 * user value above the floor is never lowered — this function only returns
 * the floor component, never the final effective value.
 */
export function resolveRelaxedTurns(policy: SpendPolicy, override?: number): number {
  const base = policy.relaxedTurns ?? 200;
  return typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : base;
}

/** Resolve the relaxed sub-agent floor for the coding tier (same semantics). */
export function resolveRelaxedSubAgentTurns(policy: SpendPolicy, override?: number): number {
  const base = policy.relaxedSubAgentTurns ?? 60;
  return typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : base;
}

/** Human-readable short label per tier (renderer chip). */
export const SPEND_MODE_LABEL: Record<SpendMode, string> = {
  token: 'Token',
  coding: 'Coding',
  free: 'Free',
};

/** A one-line policy summary for the /billing status card. */
export function describeSpendPolicy(mode: SpendMode, overrides?: SpendModeOverride): string {
  const p = resolveSpendPolicy(mode);
  const lines = [
    `RPM ${p.rpm}`,
    `429 backoff ${Math.round(p.backoffBaseMs / 1000)}s–${Math.round(p.backoffCapMs / 1000)}s`,
    `loop ≥ ${p.maxRepeat}`,
    `idle ≥ ${p.idleThinkingTokens}t`,
    `fan-out ≤ ${p.fanoutCap}`,
    `retry ≤ ${p.retryBudget}`,
    `fail-seq ≥ ${p.failSeqMax}`,
  ];
  // The relaxation knobs only mean something on the coding tier; surfacing
  // them there (with the effective value incl. desktop.json overrides) is what
  // makes the previously-hardcoded 200/60 floors discoverable from /billing.
  if (mode === 'coding') {
    lines.push(
      `relax turns ≥ ${resolveRelaxedTurns(p, overrides?.turns)}`,
      `relax sub-agent turns ≥ ${resolveRelaxedSubAgentTurns(p, overrides?.subAgentTurns)}`,
    );
  }
  return lines.join(' · ');
}
