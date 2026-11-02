import { logger } from './logger.js';

/**
 * Terminal-noise filter for the main process.
 *
 * On Linux, Chromium/Electron emit a handful of NON-fatal C++ log lines
 * straight to the main process stderr:
 *
 *   - `ContextResult::kTransientFailure: Failed to send
 *     GpuControl.CreateCommandBuffer` — a transient GPU IPC failure (common in
 *     VMs / headless / software-GL desktops; Chromium falls back and keeps
 *     running).
 *   - `GLib-GObject: gobject/gsignal.c ... instance '0x…' has no handler with
 *     id 'NNNN'` — a GLib/Chromium main-loop notice from dynamically
 *     registered/unregistered signal handlers.
 *
 * Neither passes through any `src/**` module, neither is written to
 * `~/.nexus/logs`, and neither crashes the app — they just pollute the user's
 * terminal. This filter swallows those specific lines from the *interactive*
 * terminal and records ONE dedup'd trace in the app log (the "留痕"), so the
 * event is still discoverable without the screen full of red noise.
 *
 * Piped stderr (CI, `| tee`, `script`, redirection) is left completely
 * untouched, so diagnostics still flow to whatever tooling the user wired up.
 *
 * Call {@link installStderrNoiseFilter} as early as possible in the main
 * process (before `app.whenReady()`), so even the first transient notice is
 * already filtered. Idempotent.
 */

interface NoiseClass {
  /** Stable key used for dedup bookkeeping + the log trace. */
  key: string;
  /** Cheap per-line test; true only when the line is a known non-fatal notice. */
  test: (line: string) => boolean;
}

const NOISE_CLASSES: NoiseClass[] = [
  {
    key: 'gpu-cmdbuffer',
    test: (l) =>
      l.includes('ContextResult::kTransientFailure') ||
      l.includes('GpuControl.CreateCommandBuffer'),
  },
  // A bare 'GLib-GObject' substring is too broad; require the gobject signal
  // context so we never swallow an unrelated, genuinely useful GLib error.
  {
    key: 'glib-gsignal',
    test: (l) =>
      l.includes('GLib-GObject') &&
      (l.includes('gobject/gsignal.c') || l.includes('has no handler with id')),
  },
];

// Dedup cadence: log the first sighting, then one cumulative line every +STEP
// occurrences — enough to prove the event happened (and its frequency) without
// the log file filling up while the notices keep firing.
const STEP = 50;

const seen = new Map<string, number>();
const lastLogged = new Map<string, number>();
let installed = false;

function isNoisy(line: string): string | null {
  for (const c of NOISE_CLASSES) if (c.test(line)) return c.key;
  return null;
}

function record(key: string): void {
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  const threshold = lastLogged.get(key) ?? 0;
  if (n === 1 || n - threshold >= STEP) {
    lastLogged.set(key, n);
    logger.warn(
      n === 1
        ? `suppressed non-fatal Chromium runtime notice "${key}" from the terminal (first occurrence; cumulative logged every ${STEP} more)`
        : `suppressed non-fatal Chromium runtime notice "${key}" x${n} so far (repeats not echoed to the terminal)`,
    );
  }
}

function toText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Buffer) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

/**
 * Wrap `process.stderr.write` to swallow known non-fatal Chromium runtime
 * notices on an interactive TTY (recording a dedup'd log trace), and to pass
 * every other byte through unchanged. No-op when stderr is not a TTY, or when
 * already installed.
 */
export function installStderrNoiseFilter(): void {
  if (installed) return;

  // Piped / redirected / CI: keep the full stream on stderr so the user's
  // tooling still captures it. We do NOT log-trace here either, to avoid
  // double-recording what the pipe already has.
  //
  // NB: `installed` is only latched AFTER we actually wrap stderr. A
  // no-op return (piped stderr) must NOT latch, so a later re-check in a
  // TTY context (tests, late attach of a terminal) can still install the
  // filter. The idempotence guarantee is "we never double-wrap", not
  // "we never re-evaluate".
  if (!process.stderr.isTTY) return;

  const originalWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk: unknown, enc?: BufferEncoding | number | null, cb?: unknown) => {
    try {
      const text = toText(chunk);
      if (text.length === 0) return true;
      const endsNewline = text.endsWith('\n');
      const lines = text.split('\n');
      const kept: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const isLast = i === lines.length - 1;
        const complete = !isLast || endsNewline;
        // A trailing segment with no newline is an in-progress line: keep it
        // whole (we can't judge a partial line yet) to avoid data loss.
        if (complete) {
          const noisy = isNoisy(lines[i]);
          if (noisy) {
            record(noisy);
            continue; // swallow this line
          }
        }
        kept.push(lines[i]);
      }
      const out = kept.join('\n');
      if (out.length === 0) {
        // Every line was swallowed; satisfy the stream contract.
        if (typeof cb === 'function') (cb as () => void)();
        return true;
      }
      return originalWrite(out, enc as BufferEncoding | undefined, cb as any);
    } catch {
      // A filter bug must never break stderr — fall back to the raw write.
      if (typeof cb === 'function') (cb as () => void)();
      return originalWrite(chunk as string, enc as BufferEncoding | undefined, cb as any);
    }
  }) as typeof process.stderr.write;

  // Only latch after the wrap is actually in place, so a no-op return above
  // (piped stderr) can't prevent a later, TTY-attached call from installing.
  installed = true;

  logger.debug('stderr noise filter installed (interactive terminal): gpu-cmdbuffer + glib-gsignal lines suppressed, deduped to ~/.nexus/logs');
}
