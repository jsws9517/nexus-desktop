/**
 * Capability gate — turns "that action was refused" into a state the rest of
 * the harness can reason about.
 *
 * A blocked tool result is not a failed tool. The tool works; the policy said
 * no. Treating the two the same produced both halves of the video-plus
 * failure: the model re-spelled the blocked command as a one-off script (the
 * core's gate text literally suggested it), and the resulting narration said
 * the action had succeeded. Both are fixed here:
 *
 *   - `classifyToolResult()` separates `blocked` from `failed`;
 *   - the decision request gives the user the only legitimate exits
 *     (grant, switch mode, or drop the step) — never "try another spelling";
 *   - a blocked action is sticky for the turn, so a completion claim made
 *     afterwards is `blocked`, not `passed`.
 */

import { parseSubagentFailureKind } from '../tools/acp-router.js';

export type ResultClass = 'ok' | 'blocked' | 'failed';

/**
 * Subagent delegation failures carry a machine-readable prefix
 * ([subagent:<kind>]) that is authoritative when present: structured codes
 * win over prose patterns so a policy/quota denial cannot hide in wording the
 * regex set below fails to catch.
 */
const SUBAGENT_BLOCKED_KINDS = new Set(['blocked_policy', 'blocked_quota']);

const BLOCKED_PATTERNS: RegExp[] = [
  /unattended mode blocked/i,
  /\bblocked (?:by|in) (?:the )?(?:policy|gate|guard|mode|safety|sandbox|permission)\b/i,
  /\bgate (?:blocked|refused|denied)\b/i,
  /\bblocked file mutation\b/i,
  /\bpermission denied\b/i,
  /\baccess denied\b/i,
  /\boperation not permitted\b/i,
  /\bEACCES\b|\bEPERM\b/,
  /\brequires? (?:a )?(?:git )?checkpoint\b/i,
  /\brequires? (?:manual |user )?(?:approval|authorization)\b/i,
  /\bnot (?:allowed|permitted) (?:in|by|without) (?:unattended|policy|approval|permission)\b/i,
  /(?:操作|命令|动作)被(?:拦截|阻止|拒绝)/,
  /(?:权限|授权)不足/,
  /已被(?:安全|策略|门禁)(?:拦截|阻断)/,
  // Defence in depth for subagent policy denials: even if the structured
  // short-circuit above is bypassed (a hand-built prose result), the raw code
  // text still matches here.
  /\[subagent:blocked_policy\]/,
];

/**
 * Classify a tool result. `isError` is required for `blocked`: policy denials
 * arrive as errors, and matching these phrases in ordinary successful output
 * (a log line about a blocked request, say) would be a false positive.
 */
export function classifyToolResult(isError: boolean, content: string): ResultClass {
  if (!isError) return 'ok';
  if (!content) return 'failed';
  // Structured subagent codes are authoritative: a policy or quota denial is a
  // "the gate said no", not a broken tool, even when its prose matches no
  // BLOCKED_PATTERNS regex.
  const subagentKind = parseSubagentFailureKind(content);
  if (subagentKind !== null && SUBAGENT_BLOCKED_KINDS.has(subagentKind)) return 'blocked';
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(content)) return 'blocked';
  }
  return 'failed';
}

export interface DecisionOption {
  id: 'grant' | 'switch_mode' | 'skip';
  label: string;
}

/**
 * A grant_hint tells the model the LEGITIMATE path to get the capability it
 * was denied — which config key to edit, which mode to switch to, or how to
 * one-tap grant. It is NEVER a syntax workaround: the hint points at the
 * policy surface, not at a different spelling of the same command.
 */
export interface GrantHint {
  /** How the user / model can acquire the capability. */
  kind: 'config' | 'switch_mode' | 'one_tap';
  /** Human-readable instruction, e.g. "Add {\"command\": \"rm -rf *\"} to permissions.allow in config.json". */
  instruction: string;
  /** The config key to modify (kind='config'), e.g. "permissions.allow". */
  configKey?: string;
  /** Suggested value to set (kind='config'). */
  suggestedValue?: string;
  /** Target permission mode to switch to (kind='switch_mode'), e.g. "auto". */
  targetMode?: string;
}

export interface DecisionRequest {
  type: 'decision_request';
  tool: string;
  command?: string;
  reason: string;
  options: DecisionOption[];
  /** Never a suggestion to work around the gate — see buildBlockedSteer. */
  note: string;
  /** When present, tells the model the legitimate way to acquire this capability. */
  grant_hint?: GrantHint;
}

export function buildDecisionRequest(
  tool: string,
  command: string,
  rawReason: string,
  grantHint?: GrantHint,
): DecisionRequest {
  return {
    type: 'decision_request',
    tool,
    command: command || undefined,
    reason: rawReason.replace(/\s+/g, ' ').slice(0, 400),
    options: [
      { id: 'grant', label: 'Grant this action once' },
      { id: 'switch_mode', label: 'Switch to a mode that allows it' },
      { id: 'skip', label: 'Skip this step and report what is missing' },
    ],
    note: grantHint
      ? 'Re-spelling the blocked action as a script or another tool is not an option: the policy is about the action, not its syntax. ' +
        'The legitimate path is documented in grant_hint — follow it instead of retrying the same args.'
      : 'Re-spelling the blocked action as a script or another tool is not an option: the policy is about the action, not its syntax.',
    grant_hint: grantHint,
  };
}

/**
 * One steer per turn when a capability denial happens. It deliberately does
 * NOT offer a syntax workaround (the old core hint said "write the logic to a
 * script file and run it", which is how 46 one-off probe scripts were born).
 */
export function buildBlockedSteer(blocked: string[], grantHints?: GrantHint[]): string {
  const shown = blocked.slice(0, 3).map((b) => `- ${b}`).join('\n');
  const lines: string[] = [
    '<harness_correction kind="capability_blocked">',
    'A required action was refused by policy:',
    shown,
    '',
    'Rules for the rest of this turn:',
    '1) Do NOT describe the blocked action as done/deleted/cleaned/completed. It did not happen.',
    '2) Do NOT rewrite it as a script, a different tool, or a different shell spelling to route around the gate.',
    '3) Ask the user for a decision (grant / switch mode / skip) and state exactly what remains undone.',
  ];
  if (grantHints && grantHints.length > 0) {
    lines.push('', 'Legitimate paths to acquire the blocked capability:');
    for (const h of grantHints.slice(0, 3)) {
      lines.push(`   - ${h.instruction}`);
    }
    lines.push('   If you already followed the path above and it still fails, STOP retrying and report the gap to the user.');
  }
  lines.push('</harness_correction>');
  return lines.join('\n');
}

/** One-line user-facing summary for the decision event. */
export function describeBlocked(command: string): string {
  return command.replace(/\s+/g, ' ').slice(0, 160);
}
