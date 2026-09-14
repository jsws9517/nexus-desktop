/**
 * Per-turn monitoring for the desktop agent bridge: real (estimated) token
 * accounting + empty / stalled thinking detection.
 *
 * The nexus-coder core never surfaces API `usage` objects (every downstream
 * tokenUsage field was previously hardcoded to `{ prompt: 0, completion: 0 }`).
 * This module produces a real estimate from what the desktop CAN observe:
 *
 *  - prompt side: the live context token count sampled at turn start
 *    (`context.getTokenCount()`), which already absorbs the full message list
 *    including the five prompt-decoration markers.
 *  - completion side: the characters actually streamed as text + thinking,
 *    converted via the same char/4 heuristic the rest of the app already uses.
 *
 * It also watches the thinking stream for three degenerate patterns that burn
 * tokens without producing work:
 *
 *  - noise deltas: pure whitespace / U+FFFD garbage. Dropped — never counted,
 *    never forwarded to the renderer.
 *  - thinking loops: the exact same thinking delta repeated consecutively (a
 *    model "hallucination spin"). Flagged with reason 'loop' so the caller can
 *    abort the turn instead of letting it burn tokens forever.
 *  - idle thinking: a large budget of thinking tokens accumulated with zero
 *    text / tool-call progress. Flagged with reason 'idle' — DETECTION ONLY by
 *    default, because genuinely long chain-of-thought is legitimate and must
 *    not be aborted blindly.
 */

export interface TurnUsage {
  /** Estimated prompt tokens (context token count at turn start). */
  prompt: number;
  /** Estimated completion tokens (streamed text + thinking, char/4). */
  completion: number;
  /** Raw streamed thinking characters (noise excluded). */
  thinkingChars: number;
  /** Raw streamed text characters. */
  textChars: number;
  /** Number of informative thinking deltas received. */
  thinkingDeltas: number;
  /** Estimated thinking-only tokens (char/4). */
  thinkingEstimate: number;
}

export const EMPTY_USAGE: TurnUsage = {
  prompt: 0,
  completion: 0,
  thinkingChars: 0,
  textChars: 0,
  thinkingDeltas: 0,
  thinkingEstimate: 0,
};

export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil((chars || 0) / 4));
}

export type StallReason = 'none' | 'loop' | 'idle';

export interface ThinkingStall {
  stalled: boolean;
  reason: StallReason;
  /** Estimated thinking tokens accumulated since the last text/tool-call progress. */
  thinkingTokens: number;
  /** Current consecutive-identical-delta count. */
  repeatCount: number;
}

export interface TurnMonitorOptions {
  /** Consecutive identical thinking deltas before a `loop` is flagged. */
  maxRepeat?: number;
  /** Estimated thinking tokens since the last text/tool-call progress before
   *  an `idle` is flagged. */
  idleThinkingTokens?: number;
  /** Minimum non-whitespace ratio a thinking delta must carry to be considered
   *  informative (lower allows more noise through). */
  minInfoRatio?: number;
}

const DEFAULTS: Required<TurnMonitorOptions> = {
  maxRepeat: 6,
  idleThinkingTokens: 2500,
  minInfoRatio: 0.5,
};

export class TurnMonitor {
  private opts: Required<TurnMonitorOptions>;
  private thinkingChars = 0;
  private textChars = 0;
  private thinkingDeltas = 0;
  private promptBaseline = 0;
  private lastNorm = '';
  private repeatCount = 1;
  private sinceProgressChars = 0;
  private stallFired = false;

  constructor(opts: TurnMonitorOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  setPromptBaseline(tokens: number): void {
    this.promptBaseline = Math.max(0, Math.round(tokens || 0));
  }

  /**
   * True when a thinking delta carries no usable information and should be
   * dropped entirely (never counted, never forwarded to the renderer).
   */
  isNoise(delta: string): boolean {
    const clean = typeof delta === 'string' ? delta.replace(/\uFFFD/g, '') : '';
    if (!clean || clean.trim().length === 0) return true;
    const nonWs = (clean.match(/\S/g) ?? []).length;
    return nonWs / clean.length < this.opts.minInfoRatio;
  }

  /** Record a thinking delta (must be pre-filtered via isNoise). */
  noteThinking(delta: string): void {
    const clean = typeof delta === 'string' ? delta.replace(/\uFFFD/g, '') : '';
    const info = clean.trim();
    if (!info) return;
    this.thinkingChars += clean.length;
    this.sinceProgressChars += clean.length;
    this.thinkingDeltas += 1;
    const norm = info.replace(/[\s\r\n]+/g, '').slice(0, 64);
    if (norm === this.lastNorm) {
      this.repeatCount += 1;
    } else {
      this.lastNorm = norm;
      this.repeatCount = 1;
    }
  }

  /** Record a streamed text delta; any text is real progress. */
  noteText(delta: string): void {
    if (typeof delta !== 'string' || !delta) return;
    this.textChars += delta.length;
    this.noteProgress();
  }

  /** Reset the idle accumulator (called on text output and tool calls). */
  noteProgress(): void {
    this.sinceProgressChars = 0;
    this.repeatCount = 1;
    this.lastNorm = '';
  }

  /**
   * Latest stall verdict. Idempotent: the first stall of a turn is reported
   * with `stalled: true`; later calls report `stalled: false` until the next
   * turn (markStallHandled internal bookkeeping).
   */
  checkStall(): ThinkingStall {
    const thinkingTokens = estimateTokens(this.sinceProgressChars);
    const loop = this.repeatCount >= this.opts.maxRepeat;
    const idle =
      !loop && this.sinceProgressChars > 0 && thinkingTokens >= this.opts.idleThinkingTokens;
    return {
      stalled: (loop || idle) && !this.stallFired,
      reason: loop ? 'loop' : idle ? 'idle' : 'none',
      thinkingTokens,
      repeatCount: this.repeatCount,
    };
  }

  /** Mark this turn's stall as handled (so it fires exactly once). */
  markStallHandled(): void {
    this.stallFired = true;
  }

  get thinkingEstimate(): number {
    return estimateTokens(this.thinkingChars);
  }

  finish(): TurnUsage {
    return {
      prompt: this.promptBaseline,
      completion: estimateTokens(this.thinkingChars + this.textChars),
      thinkingChars: this.thinkingChars,
      textChars: this.textChars,
      thinkingDeltas: this.thinkingDeltas,
      thinkingEstimate: this.thinkingEstimate,
    };
  }
}