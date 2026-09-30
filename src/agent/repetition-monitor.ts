/**
 * Per-turn repetition guard: detects when the model enters a degenerate loop
 * by repeating the same text or the same tool-call sequence consecutively.
 *
 * The core's own loop guard (turn-monitor.ts) only watches thinking deltas.
 * A model can also get stuck by:
 *   - emitting identical text over and over (e.g. "让我直接定位根因…")
 *   - issuing the exact same tool_call sequence each turn with no progress
 *
 * This module monitors both signals and reports a RepetitionVerdict so the
 * service can abort the turn.
 */

export interface RepetitionVerdict {
  /** True when the repetition threshold has been reached and the turn should be aborted. */
  stalled: boolean;
  /** Which repetition pattern was detected. */
  kind: 'text' | 'tool_seq';
  /** How many consecutive identical samples have been observed. */
  repeatCount: number;
  /** Normalised representative of the repeated content (text snippet or tool-seq hash). */
  repr: string;
}

export interface RepetitionMonitorOptions {
  /** Consecutive identical normalised text chunks before a `text` stall is flagged. */
  maxTextRepeat?: number;
  /** Consecutive identical tool-call sequences before a `tool_seq` stall is flagged. */
  maxToolSeqRepeat?: number;
  /** Max length (chars) to consider for text normalisation — longer chunks are truncated. */
  textTruncChars?: number;
}

const DEFAULTS: Required<RepetitionMonitorOptions> = {
  maxTextRepeat: 6,
  maxToolSeqRepeat: 3,
  textTruncChars: 120,
};

function normText(s: string): string {
  return s.replace(/[\s\r\n]+/g, ' ').trim().slice(0, DEFAULTS.textTruncChars);
}

/**
 * Serialise a tool-call sequence into a stable string for comparison.
 * Uses only name + first 80 chars of JSON args to keep the hash cheap while
 * still distinguishing e.g. two read_text_file calls on different paths.
 */
function seqHash(entries: Array<{ name: string; args: Record<string, unknown> }>): string {
  if (entries.length === 0) return '[]';
  const parts = entries.map((tc) => {
    const a = typeof tc.args === 'object' && tc.args !== null ? tc.args : {};
    return `${tc.name}:${JSON.stringify(a).slice(0, 80)}`;
  });
  return `[${parts.join(',')}]`;
}

export class RepetitionMonitor {
  private opts: Required<RepetitionMonitorOptions>;
  private lastTextNorm = '';
  private textRepeatCount = 0;
  private lastToolSeq = '';
  private toolSeqRepeatCount = 0;

  constructor(opts: RepetitionMonitorOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Reset state at the start of each new turn (called from the event bridge). */
  reset(): void {
    this.lastTextNorm = '';
    this.textRepeatCount = 0;
    this.lastToolSeq = '';
    this.toolSeqRepeatCount = 0;
  }

  /**
   * Feed a streamed text chunk. Returns a verdict immediately when the
   * consecutive-text repetition threshold is hit.
   */
  noteText(delta: string): RepetitionVerdict | null {
    const norm = normText(delta);
    if (!norm) return null;
    if (norm === this.lastTextNorm) {
      this.textRepeatCount += 1;
      if (this.textRepeatCount >= this.opts.maxTextRepeat) {
        return {
          stalled: true,
          kind: 'text',
          repeatCount: this.textRepeatCount,
          repr: norm,
        };
      }
    } else {
      this.lastTextNorm = norm;
      this.textRepeatCount = 1;
    }
    return null;
  }

  /**
   * Feed a tool-call sequence (the set of tool_calls emitted in one LLM turn).
   * Returns a verdict immediately when the same sequence repeats consecutively.
   */
  noteToolSeq(entries: Array<{ name: string; args: Record<string, unknown> }>): RepetitionVerdict | null {
    const h = seqHash(entries);
    if (h === this.lastToolSeq) {
      this.toolSeqRepeatCount += 1;
      if (this.toolSeqRepeatCount >= this.opts.maxToolSeqRepeat) {
        return {
          stalled: true,
          kind: 'tool_seq',
          repeatCount: this.toolSeqRepeatCount,
          repr: h,
        };
      }
    } else {
      this.lastToolSeq = h;
      this.toolSeqRepeatCount = 1;
    }
    return null;
  }
}
