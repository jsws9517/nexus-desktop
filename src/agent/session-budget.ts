/**
 * Session-scoped budget — the counter that survives `turn_end`.
 *
 * Every existing guard is per turn: the ledger, the correction controller and
 * the repetition monitor are all rebuilt in `beginCorrectionTurn()`, and the
 * core's own `maxTurns` is per chat cycle. A session with 18 user messages and
 * 8 hours of work therefore received 18 fresh budgets and never accumulated
 * anything — which is exactly how "one more attempt" ran all night.
 *
 * This module counts across the whole session (steps, wall clock, consecutive
 * non-progress, identical probes) and reports a breach exactly once per
 * severity. It knows nothing about domains: a repeated `ffprobe` and a repeated
 * `npm test` are the same signal.
 */

import type { Outcome } from './progress-ledger.js';

export interface SessionBudgetOptions {
  /** 0 disables. */
  maxSteps?: number;
  /** 0 disables. Wall clock starts at the first recorded step. */
  maxWallClockMs?: number;
  /** Consecutive non-progress steps (across turns). */
  maxNoProgressSteps?: number;
  /** Identical probe (same tool + args) repetitions across the session. */
  maxRepeatProbes?: number;
  now?: () => number;
}

export type BudgetBreachKind = 'steps' | 'wall_clock' | 'no_progress' | 'repeat_probe';

export interface BudgetBreach {
  kind: BudgetBreachKind;
  severity: 'soft' | 'hard';
  /** Human-readable facts; a breach without evidence must never be acted on. */
  evidence: string[];
}

export interface SessionBudgetSnapshot {
  steps: number;
  progressSteps: number;
  noProgressStreak: number;
  elapsedMs: number;
  topProbe?: { key: string; count: number };
}

/** Model-facing steer for a soft breach. Evidence first, no encouragement. */
export function formatBudgetSteer(breach: BudgetBreach): string {
  const lines = breach.evidence.slice(0, 4).map((e) => `- ${e}`).join('\n');
  return [
    `<harness_correction kind="session_budget" dimension="${breach.kind}">`,
    'The session has spent its allowance on this task without moving the deliverable:',
    lines,
    '',
    'Stop probing. In your next message:',
    '1) list what has actually been verified, with the command that verified it;',
    '2) list the hypotheses already disproved;',
    '3) state the single missing fact/decision you need — or take one NEW action that produces acceptance evidence.',
    'Do not repeat a probe that has already run in this session.',
    '</harness_correction>',
  ].join('\n');
}

const DEFAULTS: Required<Omit<SessionBudgetOptions, 'now'>> = {
  maxSteps: 0,
  maxWallClockMs: 6 * 60 * 60 * 1000,
  maxNoProgressSteps: 15,
  maxRepeatProbes: 6,
};

export class SessionBudget {
  private readonly opts: Required<Omit<SessionBudgetOptions, 'now'>>;
  private readonly now: () => number;
  private startedAt: number | null = null;
  private steps = 0;
  private progressSteps = 0;
  private noProgressStreak = 0;
  private readonly probes = new Map<string, number>();
  private readonly softFired = new Set<BudgetBreachKind>();
  private readonly hardFired = new Set<BudgetBreachKind>();

  constructor(opts: SessionBudgetOptions = {}) {
    this.opts = {
      maxSteps: opts.maxSteps ?? DEFAULTS.maxSteps,
      maxWallClockMs: opts.maxWallClockMs ?? DEFAULTS.maxWallClockMs,
      maxNoProgressSteps: opts.maxNoProgressSteps ?? DEFAULTS.maxNoProgressSteps,
      maxRepeatProbes: opts.maxRepeatProbes ?? DEFAULTS.maxRepeatProbes,
    };
    this.now = opts.now ?? Date.now;
  }

  get stepCount(): number {
    return this.steps;
  }

  get progressStepCount(): number {
    return this.progressSteps;
  }

  get currentNoProgressStreak(): number {
    return this.noProgressStreak;
  }

  reset(): void {
    this.startedAt = null;
    this.steps = 0;
    this.progressSteps = 0;
    this.noProgressStreak = 0;
    this.probes.clear();
    this.softFired.clear();
    this.hardFired.clear();
  }

  /**
   * Record one model step. Returns the breaches that JUST crossed a threshold
   * (each severity fires once), so callers can act without re-firing forever.
   */
  noteStep(input: { outcome: Outcome; probeKeys?: string[] }): BudgetBreach[] {
    if (this.startedAt === null) this.startedAt = this.now();
    this.steps += 1;
    if (input.outcome === 'progress') {
      this.progressSteps += 1;
      this.noProgressStreak = 0;
    } else {
      this.noProgressStreak += 1;
    }
    for (const key of input.probeKeys ?? []) {
      this.probes.set(key, (this.probes.get(key) ?? 0) + 1);
    }
    return this.evaluate();
  }

  snapshot(): SessionBudgetSnapshot {
    let topProbe: { key: string; count: number } | undefined;
    for (const [key, count] of this.probes) {
      if (!topProbe || count > topProbe.count) topProbe = { key, count };
    }
    return {
      steps: this.steps,
      progressSteps: this.progressSteps,
      noProgressStreak: this.noProgressStreak,
      elapsedMs: this.startedAt === null ? 0 : this.now() - this.startedAt,
      topProbe,
    };
  }

  private evaluate(): BudgetBreach[] {
    const out: BudgetBreach[] = [];
    const push = (breach: BudgetBreach): void => {
      const set = breach.severity === 'hard' ? this.hardFired : this.softFired;
      if (set.has(breach.kind)) return;
      set.add(breach.kind);
      out.push(breach);
    };

    if (this.opts.maxSteps > 0) {
      if (this.steps >= this.opts.maxSteps * 1.5) {
        push({
          kind: 'steps',
          severity: 'hard',
          evidence: [`session steps ${this.steps} >= 1.5 × ${this.opts.maxSteps}`],
        });
      } else if (this.steps >= this.opts.maxSteps) {
        push({
          kind: 'steps',
          severity: 'soft',
          evidence: [`session steps ${this.steps} >= ${this.opts.maxSteps}`],
        });
      }
    }

    if (this.opts.maxWallClockMs > 0 && this.startedAt !== null) {
      const elapsed = this.now() - this.startedAt;
      if (elapsed >= this.opts.maxWallClockMs * 1.5) {
        push({
          kind: 'wall_clock',
          severity: 'hard',
          evidence: [
            `session wall clock ${Math.round(elapsed / 60000)} min >= 1.5 × ${Math.round(
              this.opts.maxWallClockMs / 60000,
            )} min`,
          ],
        });
      } else if (elapsed >= this.opts.maxWallClockMs) {
        push({
          kind: 'wall_clock',
          severity: 'soft',
          evidence: [
            `session wall clock ${Math.round(elapsed / 60000)} min >= ${Math.round(
              this.opts.maxWallClockMs / 60000,
            )} min`,
          ],
        });
      }
    }

    if (this.opts.maxNoProgressSteps > 0) {
      if (this.noProgressStreak >= this.opts.maxNoProgressSteps * 2) {
        push({
          kind: 'no_progress',
          severity: 'hard',
          evidence: [
            `${this.noProgressStreak} consecutive steps without an acceptance/diff/test delta`,
          ],
        });
      } else if (this.noProgressStreak >= this.opts.maxNoProgressSteps) {
        push({
          kind: 'no_progress',
          severity: 'soft',
          evidence: [
            `${this.noProgressStreak} consecutive steps without an acceptance/diff/test delta`,
          ],
        });
      }
    }

    if (this.opts.maxRepeatProbes > 0) {
      for (const [key, count] of this.probes) {
        if (count >= this.opts.maxRepeatProbes * 2) {
          push({
            kind: 'repeat_probe',
            severity: 'hard',
            evidence: [`probe repeated ${count}× across the session: ${key}`],
          });
          break;
        }
        if (count >= this.opts.maxRepeatProbes) {
          push({
            kind: 'repeat_probe',
            severity: 'soft',
            evidence: [`probe repeated ${count}× across the session: ${key}`],
          });
          break;
        }
      }
    }

    return out;
  }
}
