/**
 * Progress Ledger — the single source of truth for "did this step actually
 * move the task forward?".
 *
 * The existing guards in this folder each watch one surface in isolation:
 *   - turn-monitor.ts      watches the thinking stream (repeat / idle)
 *   - repetition-monitor.ts watches text + tool-call sequences
 *
 * Neither can answer the question the correction loop needs to answer, because
 * "the model called a different tool with different args" is not progress, and
 * "the model thought for a long time" is not progress either. This module fuses
 * both signals with a workspace-state fingerprint and classifies every model
 * step as progress / neutral / regress.
 *
 * Everything here is deterministic: no LLM calls, no heuristics that cannot be
 * explained. Every verdict carries the evidence string that produced it, so the
 * UI can show the model (and the user) exactly why a correction fired.
 */

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskKind = 'coding' | 'research' | 'ops' | 'chat';

export type Outcome = 'progress' | 'neutral' | 'regress';

export type SignalKind =
  | 'thinking_dilution'
  | 'loop_no_progress'
  | 'safety_probe'
  | 'shortcut_suspect';

export type SignalConfidence = 'low' | 'medium' | 'high';

export interface LedgerSignal {
  kind: SignalKind;
  /** 0..1 — higher means more certain / more urgent. */
  severity: number;
  confidence: SignalConfidence;
  /** Human-readable evidence lines. Empty evidence must never trigger action. */
  evidence: string[];
}

export interface ToolOutcome {
  tool: string;
  ok: boolean;
  failKey?: string;
}

export interface TouchedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Raw input the event bridge accumulates for one model step. */
export interface LedgerStepInput {
  model?: string;
  actions?: Array<{ tool: string; args?: Record<string, unknown> }>;
  toolOutcomes?: ToolOutcome[];
  /** Thinking text streamed during this step. */
  thinking?: string;
  /** Assistant text streamed during this step. */
  text?: string;
  /** Files the step touched (write/edit/delete). */
  touchedFiles?: TouchedFile[];
  /** Text bodies of tool results, used for novel-fact detection. */
  toolResultTexts?: string[];
  /** Non-empty when a write produced a diff this step. */
  diffNonEmpty?: boolean;
  /** Test state after this step, when the project exposes one. */
  testStatus?: 'pass' | 'fail' | 'unknown';
  /** Open plan / todo items visible to the harness. */
  openTodoItems?: string[];
  /** Number of deliverable-contract items satisfied this step. */
  acceptanceSatisfied?: number;
}

export interface LedgerStep {
  seq: number;
  at: number;
  model: string;
  fingerprint: string;
  actions: Array<{ tool: string; argsHash: string }>;
  outcome: Outcome;
  evidence: string[];
  thinkingTokens: number;
  textTokens: number;
  toolOutcomes: ToolOutcome[];
}

export interface FingerprintState {
  touchedFiles: TouchedFile[];
  recentToolResultHashes: string[];
  openTodoItems: string[];
  testStatus?: 'pass' | 'fail' | 'unknown';
}

export interface ProgressLedgerOptions {
  taskKind?: TaskKind;
  /** Sliding window of recent tool-result hashes folded into the fingerprint. */
  fingerprintWindowSize?: number;
  /** Consecutive unchanged fingerprints (with actions) before a loop signal. */
  frozenSteps?: number;
  /** Steps of thinking history used to compute newInfoRate. */
  thinkingHistorySize?: number;
  /** Minimum thinking tokens before a dilution signal is even considered. */
  minThinkingTokens?: number;
  /** 8-gram novelty below this is considered dilution. */
  minNewInfoRate?: number;
  /** gzip ratio above this is *supporting* evidence only (never a trigger alone). */
  lowEntropyRatio?: number;
}

const DEFAULTS: Required<ProgressLedgerOptions> = {
  taskKind: 'coding',
  fingerprintWindowSize: 8,
  frozenSteps: 4,
  thinkingHistorySize: 6,
  minThinkingTokens: 800,
  minNewInfoRate: 0.3,
  lowEntropyRatio: 0.85,
};

/** Task-kind overrides for the loop threshold only. Dilution is task-agnostic. */
const FROZEN_STEPS_BY_KIND: Record<TaskKind, number> = {
  coding: 4,
  research: 6,
  ops: 3,
  chat: 4,
};

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** Character-level 8-gram novelty. Works for CJK and Latin alike. */
const NGRAM = 8;

export function normalizeForNgram(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function ngramSet(s: string, n = NGRAM): Set<string> {
  const out = new Set<string>();
  const norm = normalizeForNgram(s);
  if (!norm) return out;
  if (norm.length <= n) {
    out.add(norm);
    return out;
  }
  for (let i = 0; i + n <= norm.length; i += 1) out.add(norm.slice(i, i + n));
  return out;
}

/**
 * Fraction of the current text's 8-grams that never appeared in history.
 * 1 = entirely new, 0 = verbatim repeat.
 */
export function newInfoRate(text: string, history: string[]): number {
  const cur = ngramSet(text);
  if (cur.size === 0) return 1;
  const hist = ngramSet(history.join('\n'));
  if (hist.size === 0) return 1;
  let overlap = 0;
  for (const gram of cur) {
    if (hist.has(gram)) overlap += 1;
  }
  return 1 - overlap / cur.size;
}

/**
 * gzip compression ratio — a cheap deterministic low-entropy probe.
 * Returns 0 for short text (gzip container overhead makes the ratio
 * meaningless below ~200 chars) and clamps to [0, 1].
 */
export function zlibRatio(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes < 200) return 0;
  try {
    const compressed = gzipSync(Buffer.from(text, 'utf8')).length;
    return Math.max(0, Math.min(1, compressed / bytes));
  } catch {
    return 0;
  }
}

export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil((chars || 0) / 4));
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function hashArgs(args: Record<string, unknown> | undefined): string {
  try {
    return hashText(JSON.stringify(args ?? {})).slice(0, 10);
  } catch {
    return 'unserialisable';
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class ProgressLedger {
  private readonly opts: Required<ProgressLedgerOptions>;
  private readonly steps: LedgerStep[] = [];
  private recentThinking: string[] = [];
  private recentResultHashes: string[] = [];
  private seenResultHashes = new Set<string>();
  private lastFingerprint = '';
  private frozenSteps = 0;
  private lastTestStatus: 'pass' | 'fail' | 'unknown' = 'unknown';
  private seq = 0;

  constructor(opts: ProgressLedgerOptions = {}) {
    const taskKind = opts.taskKind ?? DEFAULTS.taskKind;
    this.opts = {
      ...DEFAULTS,
      ...opts,
      taskKind,
      frozenSteps: opts.frozenSteps ?? FROZEN_STEPS_BY_KIND[taskKind],
    };
  }

  get taskKind(): TaskKind {
    return this.opts.taskKind;
  }

  get currentFrozenSteps(): number {
    return this.frozenSteps;
  }

  get lastStep(): LedgerStep | undefined {
    return this.steps[this.steps.length - 1];
  }

  tail(n = 10): LedgerStep[] {
    return this.steps.slice(Math.max(0, this.steps.length - n));
  }

  reset(): void {
    this.steps.length = 0;
    this.recentThinking = [];
    this.recentResultHashes = [];
    this.seenResultHashes.clear();
    this.lastFingerprint = '';
    this.frozenSteps = 0;
    this.lastTestStatus = 'unknown';
    this.seq = 0;
  }

  /**
   * Stable workspace fingerprint. Two consecutive steps with the same
   * fingerprint made no observable change, regardless of which tools ran.
   */
  buildFingerprint(state: FingerprintState): string {
    const files = [...state.touchedFiles]
      .map((f) => `${normalizePath(f.path)}:${Math.round(f.mtimeMs)}:${f.size}`)
      .sort();
    // De-duplicate: the same result seen twice is not a state change. Without
    // this, a repeated read would mutate the fingerprint on every step and the
    // loop detector could never fire.
    const hashes = [...new Set(state.recentToolResultHashes.slice(-this.opts.fingerprintWindowSize))].sort();
    const todos = [...state.openTodoItems].map((t) => normalizeForNgram(t)).sort();
    const test = state.testStatus ?? 'unknown';
    return createHash('sha1')
      .update([...files, ...hashes, ...todos, `test:${test}`].join('|'))
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Classify a step. Progress is deliberately narrow: new information,
   * a state transition, or a satisfied acceptance item. Reading the same
   * content again is neutral no matter how many tokens it burns.
   */
  classifyOutcome(input: LedgerStepInput): Outcome {
    const actions = input.actions ?? [];
    const outcomes = input.toolOutcomes ?? [];

    if (
      input.diffNonEmpty === true ||
      input.acceptanceSatisfied !== undefined && input.acceptanceSatisfied > 0 ||
      (input.testStatus === 'pass' && this.lastTestStatus !== 'pass')
    ) {
      return 'progress';
    }

    // A tool result that has never been seen before is new information.
    const texts = input.toolResultTexts ?? [];
    for (const text of texts) {
      const h = hashText(text);
      if (text.trim() && !this.seenResultHashes.has(h)) return 'progress';
    }

    // Every action in this step failed and nothing changed: regression.
    if (actions.length > 0 && outcomes.length === actions.length && outcomes.every((o) => !o.ok)) {
      return 'regress';
    }

    return 'neutral';
  }

  recordStep(input: LedgerStepInput): LedgerStep {
    const actions = input.actions ?? [];
    const outcomes = input.toolOutcomes ?? [];
    const thinking = input.thinking ?? '';
    const text = input.text ?? '';
    const resultTexts = input.toolResultTexts ?? [];

    const resultHashes = resultTexts.map(hashText);
    const fingerprint = this.buildFingerprint({
      touchedFiles: input.touchedFiles ?? [],
      recentToolResultHashes: [...this.recentResultHashes, ...resultHashes],
      openTodoItems: input.openTodoItems ?? [],
      testStatus: input.testStatus,
    });

    const outcome = this.classifyOutcome(input);
    const evidence: string[] = [];

    // Process tool-result novelty *after* classification so the current step's
    // own results cannot count as "new information" twice.
    for (const [i, h] of resultHashes.entries()) {
      if (resultTexts[i]?.trim() && !this.seenResultHashes.has(h)) {
        this.seenResultHashes.add(h);
        evidence.push(`new tool result (${h})`);
      }
    }
    this.recentResultHashes = [...this.recentResultHashes, ...resultHashes].slice(
      -this.opts.fingerprintWindowSize * 2,
    );

    if (actions.length === 0) {
      evidence.push('no tool calls');
    }
    if (thinking) {
      evidence.push(`thinking ${estimateTokensFromChars(thinking.length)} tok`);
    }
    if (outcome === 'progress') evidence.push('state advanced');
    if (outcome === 'regress') evidence.push('all tool calls failed');
    if (outcome === 'neutral') evidence.push('no state change');

    // Freeze counter: unchanged fingerprint with real actions.
    if (actions.length > 0 && fingerprint === this.lastFingerprint) {
      this.frozenSteps += 1;
    } else if (outcome === 'progress') {
      this.frozenSteps = 0;
    }
    if (actions.length === 0) this.frozenSteps = 0;

    if (this.frozenSteps >= this.opts.frozenSteps) {
      evidence.push(`fingerprint unchanged ${this.frozenSteps} steps (${fingerprint})`);
    }

    this.lastFingerprint = fingerprint;
    if (input.testStatus) this.lastTestStatus = input.testStatus;

    const step: LedgerStep = {
      seq: ++this.seq,
      at: Date.now(),
      model: input.model ?? '',
      fingerprint,
      actions: actions.map((a) => ({ tool: a.tool, argsHash: hashArgs(a.args) })),
      outcome,
      evidence,
      thinkingTokens: estimateTokensFromChars(thinking.length),
      textTokens: estimateTokensFromChars(text.length),
      toolOutcomes: outcomes,
    };

    this.steps.push(step);
    if (thinking.trim()) {
      this.recentThinking.push(thinking);
      if (this.recentThinking.length > this.opts.thinkingHistorySize) this.recentThinking.shift();
    }
    return step;
  }

  /**
   * Signals derived from this step. Returns an empty array for a healthy step.
   * Shortcut signals come from DeliverableContract and are injected by the
   * caller, not computed here.
   */
  signals(step: LedgerStep, thinkingText = ''): LedgerSignal[] {
    const signals: LedgerSignal[] = [];

    // --- thinking dilution ------------------------------------------------
    if (
      step.thinkingTokens >= this.opts.minThinkingTokens &&
      step.outcome !== 'progress' &&
      thinkingText.trim()
    ) {
      const history = this.recentThinking.slice(0, -1); // exclude current step
      const rate = newInfoRate(thinkingText, history);
      const ratio = zlibRatio(thinkingText);
      if (rate < this.opts.minNewInfoRate) {
        const deficit = this.opts.minNewInfoRate - rate;
        const severity = clamp01(0.45 + deficit * 1.4 + (ratio > this.opts.lowEntropyRatio ? 0.15 : 0));
        signals.push({
          kind: 'thinking_dilution',
          severity,
          confidence: severity >= 0.7 ? 'high' : 'medium',
          evidence: [
            `thinking ${step.thinkingTokens} tok with newInfoRate ${rate.toFixed(2)} (< ${this.opts.minNewInfoRate})`,
            `8-gram overlap ${((1 - rate) * 100).toFixed(0)}% with prior thinking/results`,
            ...(ratio > this.opts.lowEntropyRatio
              ? [`gzip ratio ${ratio.toFixed(2)} (> ${this.opts.lowEntropyRatio}) — low entropy`]
              : []),
            `no state change this step`,
          ],
        });
      }
    }

    // --- loop / no progress ----------------------------------------------
    if (this.frozenSteps >= this.opts.frozenSteps) {
      const overrun = this.frozenSteps - this.opts.frozenSteps;
      const severity = clamp01(0.5 + overrun * 0.12);
      signals.push({
        kind: 'loop_no_progress',
        severity,
        confidence: this.frozenSteps >= this.opts.frozenSteps + 3 ? 'high' : 'medium',
        evidence: [
          `workspace fingerprint unchanged for ${this.frozenSteps} steps (${step.fingerprint})`,
          `tool calls executed: ${step.actions.map((a) => a.tool).join(', ') || 'none'}`,
          `outcome: ${step.outcome}`,
        ],
      });
    }

    return signals;
  }
}

/** Normalise a path for fingerprint comparison (cross-platform, case-folded). */
export function normalizePath(p: string): string {
  const slash = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? slash.toLowerCase() : slash;
}
