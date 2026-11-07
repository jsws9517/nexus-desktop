/**
 * Correction Controller — the policy layer between "a signal fired" and "the
 * harness does something about it".
 *
 * The old behaviour was binary: benign monitors stay silent, degenerate ones
 * call `agent.abort()`. That stops the token burn but destroys the turn and
 * teaches the model nothing. This controller implements a five-level ladder:
 *
 *   L1  targeted steer (evidence, not encouragement)      — reversible
 *   L2  narrow the action space (tool policy / read-only)  — reversible
 *   L3  roll back to the last progress checkpoint + replan — reversible
 *   L4  abort + evidence pack + hand off to the user       — terminal
 *
 * Two invariants keep the controller from becoming the problem:
 *
 *   - Budget: a turn can only be interrupted a few times. Repeating a nudge is
 *     itself a form of context pollution.
 *   - De-escalation: after enough real progress, the controller returns to L0,
 *     so a single false positive cannot degrade the rest of the session.
 *
 * Simplicity is deliberate. First-layer detection is deterministic; this layer
 * never asks an LLM to judge another LLM.
 */

import type { CorrectionConfig } from './correction-config.js';
import type { LedgerSignal, LedgerStep, SignalKind } from './progress-ledger.js';

export type CorrectionLevel = 1 | 2 | 3 | 4;

export interface ToolPolicy {
  active: boolean;
  /** Only read-only tools survive `getToolsForContext`. */
  readOnly?: boolean;
  /** Exact tool names withheld for the rest of the turn. */
  denyTools?: string[];
  /** The next step must produce a short written plan before acting. */
  requirePlanFirst?: boolean;
}

export interface CorrectionExecutors {
  /** Queue a steer for the next safe point. Returns false when idle. */
  steer(text: string, opts?: { rollback?: boolean }): boolean | void;
  setToolPolicy?(policy: ToolPolicy | null): void;
  rollback?(): void;
  abort?(): void;
  /** Forward a structured event to the renderer. */
  emit?(event: Record<string, unknown>): void;
}

export interface CorrectionAction {
  level: CorrectionLevel;
  kind: SignalKind;
  reason: string;
  evidence: string[];
  steerText: string;
  policy?: ToolPolicy;
  rollback: boolean;
  abort: boolean;
  stepSeq: number;
  at: number;
}

export interface CorrectionEvidence {
  reason: SignalKind | 'turn_end';
  level: CorrectionLevel;
  ledgerTail: LedgerStep[];
  signals: LedgerSignal[];
  actions: CorrectionAction[];
  userMessage: string;
  usage?: { prompt: number; completion: number };
}

export interface CorrectionControllerOptions {
  config: CorrectionConfig;
  executors: CorrectionExecutors;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

export class CorrectionController {
  private readonly cfg: CorrectionConfig;
  private readonly exec: CorrectionExecutors;
  private readonly now: () => number;

  private l1Used = 0;
  private l2Used = 0;
  private l3Used = 0;
  private lastSteerStep = -999;
  private lastKind: SignalKind | null = null;
  private lastKindStep = -999;
  private readonly levelByKind = new Map<SignalKind, CorrectionLevel>();
  private progressStreak = 0;
  private readonly actions: CorrectionAction[] = [];
  private lastSignals: LedgerSignal[] = [];
  private lastStepSeq = 0;

  constructor(opts: CorrectionControllerOptions) {
    this.cfg = opts.config;
    this.exec = opts.executors;
    this.now = opts.now ?? Date.now;
  }

  /** Reset per-turn budgets. Call at the start of every runTurn(). */
  resetTurn(): void {
    this.l1Used = 0;
    this.l2Used = 0;
    this.l3Used = 0;
    this.lastSteerStep = -999;
    this.lastKind = null;
    this.lastKindStep = -999;
    this.levelByKind.clear();
    this.progressStreak = 0;
    this.actions.length = 0;
    this.lastSignals = [];
    this.lastStepSeq = 0;
    this.exec.setToolPolicy?.(null);
  }

  get currentLevel(): CorrectionLevel | 0 {
    let max: CorrectionLevel | 0 = 0;
    for (const level of this.levelByKind.values()) {
      if (level > max) max = level;
    }
    return max;
  }

  get history(): readonly CorrectionAction[] {
    return this.actions;
  }

  /**
   * Feed one model step plus any externally produced signals (safety probe,
   * contract failure). Applies the winning action and returns it.
   */
  onStep(step: LedgerStep, extraSignals: LedgerSignal[] = []): CorrectionAction | null {
    this.lastStepSeq = step.seq;
    this.lastSignals = extraSignals;

    if (extraSignals.length === 0) {
      if (step.outcome === 'progress') {
        this.progressStreak += 1;
        if (this.progressStreak >= this.cfg.deescalation.progressRequired) {
          this.levelByKind.clear();
          this.progressStreak = 0;
          // Lift any L2 narrowing: the model is making progress again.
          this.exec.setToolPolicy?.(null);
        }
      } else {
        this.progressStreak = 0;
      }
      return null;
    }

    const signal = pickSignal(extraSignals);
    if (!signal || signal.evidence.length === 0) return null;

    const level = this.decideLevel(signal, step);
    if (level === 0) return null;

    const action = this.buildAction(level, signal, step);
    this.apply(action);
    return action;
  }

  /**
   * Terminal path used by the Security Sentinel: no ladder, no budget.
   * A boundary probe is not something to negotiate with.
   */
  forceTerminate(kind: SignalKind, reason: string, evidence: string[], stepSeq = this.lastStepSeq): CorrectionAction {
    const action: CorrectionAction = {
      level: 4,
      kind,
      reason,
      evidence,
      steerText: '',
      abort: true,
      rollback: false,
      stepSeq,
      at: this.now(),
    };
    this.apply(action);
    return action;
  }

  apply(action: CorrectionAction): void {
    this.actions.push(action);
    this.lastKind = action.kind;
    this.lastKindStep = action.stepSeq;
    this.levelByKind.set(action.kind, action.level);

    if (action.level === 1) {
      this.l1Used += 1;
      this.lastSteerStep = action.stepSeq;
    } else if (action.level === 2) {
      this.l2Used += 1;
      this.lastSteerStep = action.stepSeq;
    } else if (action.level === 3) {
      this.l3Used += 1;
    }

    if (action.policy) this.exec.setToolPolicy?.(action.policy);
    if (action.steerText) this.exec.steer(action.steerText, { rollback: action.rollback });
    if (action.abort) this.exec.abort?.();

    this.exec.emit?.({
      type: 'correction',
      level: action.level,
      kind: action.kind,
      reason: action.reason,
      evidence: action.evidence,
      steer: action.steerText,
      policy: action.policy,
      aborted: action.abort,
      step: action.stepSeq,
    });
  }

  evidencePack(reason: SignalKind | 'turn_end', ledgerTail: LedgerStep[], userMessage: string): CorrectionEvidence {
    return {
      reason,
      level: this.currentLevel || 1,
      ledgerTail,
      signals: this.lastSignals,
      actions: [...this.actions],
      userMessage,
    };
  }

  // -------------------------------------------------------------------------
  // decision
  // -------------------------------------------------------------------------

  private decideLevel(signal: LedgerSignal, step: LedgerStep): CorrectionLevel | 0 {
    // A boundary probe is always terminal.
    if (signal.kind === 'safety_probe') return 4;

    let level: CorrectionLevel =
      signal.severity >= 0.85 ? 3 : signal.severity >= 0.55 ? 2 : 1;

    // A shortcut is never a "gentle nudge" case: the model already believes it
    // is finished, so only constraining the next step changes the outcome.
    if (signal.kind === 'shortcut_suspect') level = Math.max(level, 2) as CorrectionLevel;

    // Same problem within three steps: refuse to repeat the same level.
    if (this.lastKind === signal.kind && step.seq - this.lastKindStep <= 3) {
      level = Math.min(4, level + 1) as CorrectionLevel;
    }

    // Never walk a level back down inside one turn (de-escalation is per-progress).
    const previous = this.levelByKind.get(signal.kind);
    if (previous && previous > level) level = previous;

    // Budget gates. Low-confidence signals are suppressed instead of escalating
    // into a hard abort; high-confidence ones climb the ladder.
    if (level === 1 && this.l1Used >= this.cfg.budget.l1PerTurn) {
      if (signal.severity < 0.7) return 0;
      level = 2;
    }
    if (level === 2 && this.l2Used >= this.cfg.budget.l2PerTurn) {
      if (signal.severity < 0.7) return 0;
      level = 3;
    }
    if (level === 3 && this.l3Used >= this.cfg.budget.l3PerTurn) {
      if (signal.severity < 0.7) return 0;
      level = 4;
    }

    // Cooldown: do not inject two nudges back to back.
    if (level === 1 && step.seq - this.lastSteerStep < this.cfg.budget.coolDownStepsAfterL1) {
      return 0;
    }

    return level;
  }

  private buildAction(level: CorrectionLevel, signal: LedgerSignal, step: LedgerStep): CorrectionAction {
    const evidence = [...signal.evidence];
    const steerText = level === 4 ? '' : buildSteerText(level, signal, step);
    const policy = level === 2 ? buildPolicy(signal, step) : undefined;

    return {
      level,
      kind: signal.kind,
      reason: reasonFor(signal.kind),
      evidence,
      steerText,
      policy,
      rollback: level === 3,
      abort: level === 4,
      stepSeq: step.seq,
      at: this.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const KIND_PRIORITY: Record<SignalKind, number> = {
  safety_probe: 100,
  shortcut_suspect: 80,
  loop_no_progress: 60,
  thinking_dilution: 40,
};

function pickSignal(signals: LedgerSignal[]): LedgerSignal | null {
  if (signals.length === 0) return null;
  return [...signals].sort((a, b) => {
    const p = KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
    if (p !== 0) return p;
    return b.severity - a.severity;
  })[0];
}

function reasonFor(kind: SignalKind): string {
  switch (kind) {
    case 'thinking_dilution':
      return 'reasoning is repeating prior content without producing actions or state change';
    case 'loop_no_progress':
      return 'the workspace state has not changed across repeated tool calls';
    case 'safety_probe':
      return 'the model attempted to cross a security boundary';
    case 'shortcut_suspect':
      return 'completion was claimed without the required deliverable';
  }
}

function buildPolicy(signal: LedgerSignal, step: LedgerStep): ToolPolicy {
  if (signal.kind === 'loop_no_progress') {
    const failedTools = [
      ...new Set(step.toolOutcomes.filter((o) => !o.ok).map((o) => o.tool)),
    ];
    return { active: true, denyTools: failedTools, requirePlanFirst: true };
  }
  if (signal.kind === 'thinking_dilution') {
    return {
      active: true,
      denyTools: ['sequential_thinking', 'sequential_think', 'think'],
      requirePlanFirst: true,
    };
  }
  return { active: true, requirePlanFirst: true };
}

function buildSteerText(level: CorrectionLevel, signal: LedgerSignal, step: LedgerStep): string {
  const evidence = signal.evidence.slice(0, 4).map((e) => `- ${e}`).join('\n');
  const head =
    `<harness_correction kind="${signal.kind}" level="L${level}" step="${step.seq}">\n` +
    `The harness detected a problem:\n${evidence}\n`;

  if (level <= 2) {
    return (
      head +
      `\nBefore acting again:\n` +
      `1) state your current hypothesis in one sentence;\n` +
      `2) name the missing fact or evidence;\n` +
      `3) take one NEW path that is not a repeat of the last ${Math.max(3, step.actions.length + 2)} actions.\n` +
      (level === 2
        ? `Tool access is narrowed for this attempt. Produce a short plan first, then execute it.\n`
        : '') +
      `</harness_correction>`
    );
  }

  // L3: the attempt is being rolled back; force a different plan.
  return (
    head +
    `\nThis attempt is being rolled back to the last checkpoint that produced progress.\n` +
    `Discard the current plan. Write a new plan (≤ 5 bullets) that starts from the last known-good state,\n` +
    `then execute the first bullet immediately.\n` +
    `</harness_correction>`
  );
}
