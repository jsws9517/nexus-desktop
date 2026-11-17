/**
 * Turn verdict — the one place that decides whether a finished turn may be
 * presented as a success.
 *
 * Before this module, `finalizeCorrectionTurn()` computed a contract verdict,
 * emitted an event, and then threw the result away: a failed contract could
 * still end with the model's "修复成功！" as the last thing the user saw. The
 * verdict below is derived from evidence, not from prose:
 *
 *   claimed && all declared items checked && none failed  -> passed
 *   claimed && a check ran and failed                     -> failed
 *   claimed && a capability action was blocked            -> blocked
 *   claimed && nothing checkable was observed             -> unverified
 *   no claim                                              -> unclaimed
 *
 * `unverified` is the important one: it is the legitimate outcome of "the
 * model says it is done and no evidence exists", and it exists so that the
 * harness never has to pick between lying and staying silent.
 */

import { claimsCompletion, describeAcceptance } from './deliverable-contract.js';
import type { CheatFinding, ContractVerdict, DeliverableContract } from './deliverable-contract.js';

export type VerdictStatus = 'passed' | 'failed' | 'blocked' | 'unverified' | 'unclaimed';

export interface ClaimRecord {
  kind: 'completion' | 'action';
  text: string;
  evidence: string[];
  status: 'supported' | 'refuted' | 'unverified';
}

export interface TurnVerdict {
  status: VerdictStatus;
  /** Whether the model asserted completion in this turn. */
  claimed: boolean;
  reason: string;
  /** Machine reasons, one per unmet item. */
  failed: string[];
  /** Items that were declared but never observed. */
  skipped: string[];
  evidence: string[];
  claims: ClaimRecord[];
  blockedActions: string[];
  at: number;
}

export interface VerdictInput {
  contract: DeliverableContract | null;
  verdict: ContractVerdict | null;
  findings: CheatFinding[];
  lastAssistantText: string;
  blockedActions?: string[];
  sawToolActivity?: boolean;
}

export function deriveTurnVerdict(input: VerdictInput): TurnVerdict {
  const findings = input.findings ?? [];
  const blocking = findings.filter((f) => f.severity === 'high');
  const blockedActions = input.blockedActions ?? [];
  const claimed = claimsCompletion(input.lastAssistantText ?? '');
  const at = Date.now();

  const failed = (input.verdict?.failed ?? []).map(
    (f) => `${describeAcceptance(f.item)} — ${f.why}`,
  );
  const skipped = (input.verdict?.skipped ?? []).map(
    (s) => `${describeAcceptance(s.item)} — ${s.why}`,
  );
  const checked = input.verdict?.checked ?? 0;
  const evidence: string[] = [];
  if (input.contract) {
    evidence.push(`contract source: ${input.contract.source}, items: ${input.contract.items.length}`);
  }
  evidence.push(`acceptance checked: ${checked}, failed: ${failed.length}, skipped: ${skipped.length}`);
  if (blockedActions.length) evidence.push(`blocked actions: ${blockedActions.join(' | ')}`);
  if (input.sawToolActivity) evidence.push('tool activity observed');

  const claims: ClaimRecord[] = [];
  let status: VerdictStatus;

  if (!claimed) {
    status = blockedActions.length ? 'blocked' : 'unclaimed';
  } else if (blockedActions.length) {
    // A turn that asserts success after a capability denial has no basis for
    // the assertion: whatever the blocked action would have produced does not
    // exist. This is the "said deleted, command was blocked" class.
    status = 'blocked';
  } else if (failed.length > 0 || blocking.length > 0) {
    status = 'failed';
  } else if (!input.verdict || checked === 0 || skipped.length > 0) {
    // Claim with nothing observed. Not a failure — an absence of evidence.
    status = 'unverified';
  } else {
    status = 'passed';
  }

  if (claimed) {
    claims.push({
      kind: 'completion',
      text: (input.lastAssistantText ?? '').slice(0, 240),
      evidence: [...evidence, ...failed, ...skipped],
      status: status === 'passed' ? 'supported' : status === 'failed' ? 'refuted' : 'unverified',
    });
  }
  for (const finding of blocking) {
    claims.push({
      kind: 'action',
      text: finding.id,
      evidence: [finding.evidence],
      status: 'refuted',
    });
  }

  return {
    status,
    claimed,
    reason: reasonFor(status, {
      failed: failed.length,
      skipped: skipped.length,
      checked,
      blocking: blocking.length,
      blocked: blockedActions.length,
    }),
    failed,
    skipped,
    evidence,
    claims,
    blockedActions,
    at,
  };
}

function reasonFor(
  status: VerdictStatus,
  n: { failed: number; skipped: number; checked: number; blocking: number; blocked: number },
): string {
  switch (status) {
    case 'passed':
      return `completion supported by ${n.checked} checked acceptance item(s)`;
    case 'failed':
      return `${n.failed} acceptance item(s) failed, ${n.blocking} anti-cheat finding(s)`;
    case 'blocked':
      return `${n.blocked} capability action(s) were blocked; the successful outcome was never produced`;
    case 'unverified':
      return n.checked === 0
        ? 'completion claimed with no machine-checkable evidence'
        : `completion claimed but ${n.skipped} declared check(s) were never observed`;
    case 'unclaimed':
      return 'no completion claim in this turn';
  }
}

/** Compact one-line summary for logs and the session stats surface. */
export function summarizeVerdict(v: TurnVerdict): string {
  return `${v.status} (${v.reason})`;
}
