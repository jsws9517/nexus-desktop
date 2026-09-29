/**
 * Auto-remediation policy for an active (provider, model) pair.
 *
 * Two independent failure shapes have to be distinguished, and conflating them
 * is what made the desktop keep re-applying the globally configured default:
 *
 *  1. The pair is MISSING FROM /models — the provider simply does not advertise
 *     the id. Common and often legitimate: gateway-only ids, a restricted
 *     /models endpoint, or a hand-entered model. Remediated at most once per
 *     (session, provider, model), onto that provider's OWN configured model.
 *
 *  2. The pair FAILED AT CALL TIME while /models still lists it. The id has to
 *     be retired from the list, but only when the error actually names the
 *     model as the unavailable thing.
 *
 * Kept in its own module (rather than inline in the renderer) so the matching
 * rules are directly testable — they are the part that must never regress into
 * treating an auth or quota failure as a delisted model.
 */

/**
 * Provider errors that mean a model id listed in /models is NOT servable
 * (list up, model down — e.g. Azure/OAI gateways, or a model whose region or
 * account entitlement is missing).
 *
 * Matched against the RAW provider message. `localizeError()` rewrites a bare
 * "403 Forbidden" into 访问被拒绝（403） and throws the real wording away, so
 * matching the localized display text can no longer tell a genuine "model not
 * available" apart from an ordinary auth failure.
 *
 * Every alternative must name the MODEL as the unavailable thing. Generic
 * transport/auth failures (403 / forbidden / 401 / 429 / 访问被拒绝) are
 * deliberately absent: they say nothing about the model, and counting them as a
 * delisting yanked the active model onto the provider default on every failed
 * turn and blacklisted the id permanently.
 */
const MODEL_UNAVAILABLE_RE =
  /model[\s_\-]{0,3}[^\n]{0,80}?(?:is[\s_\-]{0,3}not[\s_\-]{0,3})?(?:unavailable|not[\s_\-]{0,3}available|does[\s_\-]{0,3}not[\s_\-]{0,3}exist|not[\s_\-]{0,3}found|no[\s_\-]{0,3}longer[\s_\-]{0,3}available|deprecat|retired|unrecognized)|模型[^\n]{0,40}?(?:不可用|不存在|已下线|已下架|无此)|已下架|已下线/i;

/** True when `rawError` reports a specific model as unservable. */
export function isModelUnavailableError(rawError: string): boolean {
  if (!rawError) return false;
  return MODEL_UNAVAILABLE_RE.test(rawError);
}

/**
 * The once-only ledger for auto-remediation.
 *
 * Keyed by (session, provider, model) rather than by session alone: a mismatch
 * that is permanent by nature has to be remediated exactly once, no matter how
 * many times the tab regains focus or refetches /models. Keying on the session
 * alone made every new tab re-assert the global default, and a fallback off one
 * model used to block evaluation of a different one.
 *
 * Scope: this ledger is in-memory, so it lasts for the app session only — a
 * restart re-evaluates each pair once more. That is deliberate: the on-disk
 * blacklist (and the session's own persisted binding) are what survive.
 */
export class RemediationLedger {
  private seen = new Set<string>();

  static key(sessionId: string, provider: string, model: string): string {
    return `${sessionId || 'global'}|${provider}|${model}`;
  }

  /** Claim the pair. Returns false when it was already remediated. */
  claim(sessionId: string, provider: string, model: string): boolean {
    if (!provider || !model) return false;
    const key = RemediationLedger.key(sessionId, provider, model);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  has(sessionId: string, provider: string, model: string): boolean {
    return this.seen.has(RemediationLedger.key(sessionId, provider, model));
  }

  /**
   * Re-arm every pair of `sessionId` after an explicit user selection — a
   * deliberate choice always gets one fresh evaluation of its own.
   */
  rearmSession(sessionId: string): void {
    if (!sessionId) return;
    const prefix = `${sessionId}|`;
    for (const key of this.seen) {
      if (key.startsWith(prefix)) this.seen.delete(key);
    }
  }
}
