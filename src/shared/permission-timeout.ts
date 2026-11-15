/**
 * H2: permission-card timeout policy.
 *
 * An unanswered permission card must not hold a turn (or the whole worker)
 * forever: after the configured timeout the card auto-denies WITH THE REASON
 * (the UI closes the card and toasts why; the model sees a deny verdict). The
 * value lives in `~/.nexus/desktop.json` (`permissionTimeoutMs`) — never in
 * the core's config.json (its zod schema strips unknown keys).
 *
 * Pure constants + clamp: importable from the worker (the owner of the
 * pending card), the main process (settings accessor) and the renderer.
 */

/** Default: auto-deny an unanswered permission card after 10 minutes. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 600_000;
/** Loose floor: below this a card would be unusable for anything non-trivial. */
export const MIN_PERMISSION_TIMEOUT_MS = 10_000;
/** Loose ceiling: 1 hour is the outer bound (never "wait forever"). */
export const MAX_PERMISSION_TIMEOUT_MS = 3_600_000;

/**
 * Clamp a hand-edited desktop.json value into the loose range. Invalid
 * shapes (NaN, 0, negative, out of range, non-number) fall back to the
 * 10-minute default — a broken value must not disable the timeout.
 */
export function clampPermissionTimeoutMs(v: unknown): number {
  if (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= MIN_PERMISSION_TIMEOUT_MS &&
    v <= MAX_PERMISSION_TIMEOUT_MS
  ) {
    return Math.round(v);
  }
  return DEFAULT_PERMISSION_TIMEOUT_MS;
}
