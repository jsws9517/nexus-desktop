/**
 * Deliverable Contract — turns "the model says it is done" into a set of
 * machine-checkable assertions.
 *
 * Without a contract there is no such thing as a shortcut: any output can be
 * called a success. This module has two halves:
 *
 *   1. `parseContract()` extracts acceptance items from the user request
 *      (files, test commands, builds, citations, numeric targets).
 *   2. `antiCheatChecks()` looks for the seven ways a lazy model fakes
 *      completion without producing the artifact.
 *
 * Both halves are pure and deterministic. Command execution is *opt-in* via
 * `VerifyContext.run` — when the caller does not provide a runner, command
 * items are reported as `skipped`, never guessed.
 */

import { extname } from 'node:path';
import type { ContractManifest, InvariantCheckSpec } from './contract-manifest.js';

/**
 * Extract file paths from a media tool result envelope. Media tools return
 * plain JSON strings (or objects) that may carry `files[]`, `image_path`,
 * `video_path`, or bare local paths. This is the only evidence a media turn
 * has for its deliverable, so the harness turns it into a `file_exists`
 * acceptance item.
 */
export function extractMediaArtifactPaths(content: string): string[] {
  if (!content) return [];
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return [];
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  if (obj.ok === false || obj.status === 'failed') return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (p: unknown): void => {
    if (typeof p === 'string' && p.trim()) {
      const clean = p.trim().replace(/^["']|["']$/g, '');
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        paths.push(clean);
      }
    }
  };
  for (const key of ['files', 'outputs', 'artifacts']) {
    const v = obj[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && 'path' in item) push((item as Record<string, unknown>)['path']);
        else push(item);
      }
    } else if (typeof v === 'string') {
      push(v);
    }
  }
  for (const key of ['image_path', 'video_path', 'audio_path', 'output', 'path']) {
    if (key in obj) push(obj[key]);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Acceptance items
// ---------------------------------------------------------------------------

/**
 * An `invariant` is the general form of "these things must agree". Its checks
 * are satisfied only by an OBSERVED tool run (see `ObservedRun`) — the harness
 * never executes them itself, so a declared-but-unrun check is `skipped`,
 * never `passed`.
 */
export type Acceptance =
  | { kind: 'file_exists'; path: string; nonEmpty?: boolean }
  | { kind: 'test_pass'; cmd: string }
  | { kind: 'exit_zero'; cmd: string }
  | { kind: 'diff_contains'; path: string; pattern: string }
  | { kind: 'artifact'; path: string }
  | { kind: 'citation'; min: number }
  | { kind: 'numeric'; label: string; expect: number; op: '>=' | '<=' | '==' }
  | { kind: 'invariant'; id: string; describe?: string; predicate?: string; checks: InvariantCheckSpec[] }
  /**
   * The request is in a class that NEEDS a machine-checkable invariant
   * ("align", "consistent", "sync", "match"), but the workspace declares none.
   * This is an acceptance item the model can satisfy by declaring one (writing
   * a manifest), not a domain rule invented by the harness.
   */
  | { kind: 'manifest_required'; topic: string };

export type ContractSource =
  | 'parsed_from_user'
  | 'derived_from_plan'
  | 'declared_manifest'
  | 'inferred_baseline';

export interface DeliverableContract {
  items: Acceptance[];
  source: ContractSource;
  raw: string;
  /** Set when a check manifest was loaded for this contract. */
  manifestPath?: string;
}

/** One tool run the agent actually performed, used as evidence. */
export interface ObservedRun {
  cmd: string;
  /** 0 for success; non-zero/null when the tool reported an error. */
  exitCode: number | null;
  output: string;
  at?: number;
}

export interface ContractVerdict {
  passed: boolean;
  checked: number;
  failed: Array<{ item: Acceptance; why: string }>;
  skipped: Array<{ item: Acceptance; why: string }>;
}

export interface VerifyContext {
  exists(path: string): boolean;
  size?(path: string): number;
  read?(path: string): string | null;
  run?(cmd: string): { code: number; stdout: string; stderr: string };
  diff?: GitDiff;
  citationCount?: number;
  numbers?: Record<string, number>;
  /** Tool runs observed during the turn — the only evidence source used for
   *  `invariant` items and for `test_pass`/`exit_zero` when no runner exists. */
  observations?: ObservedRun[];
  /** True when the workspace currently has a check manifest. */
  manifestPresent?: boolean;
}

// ---------------------------------------------------------------------------
// Contract parsing
// ---------------------------------------------------------------------------

const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|cpp|cc|c|h|hpp|json|jsonc|md|mdx|html|htm|css|scss|less|yml|yaml|toml|ini|cfg|sql|sh|bash|ps1|bat|vue|svelte|xml|txt|csv|pdf|docx|xlsx|pptx|png|jpg|jpeg|svg|zip';

const FILE_PATH_RE = new RegExp(
  `(?:^|[\\s\`"'(（\\[【])((?:[\\w.@-]+[\\\\/])*[\\w.@-]+\\.(?:${FILE_EXT}))(?=[\\s\`"')）\\]】，。；;,:：]|$)`,
  'gi',
);

const CREATE_VERB_RE =
  /(创建|新建|写入|生成|输出|产出|实现|添加|补充|修改|更新|修复|create|write|add|implement|generate|output|produce|update|fix|save)/i;

const TEST_CMD_RE =
  /\b(npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|node\s+--test[^\n`]*|pytest|python\s+-m\s+pytest|go\s+test[^\n`]*|cargo\s+test[^\n`]*|mvn\s+test|gradle\s+test|dotnet\s+test|jest|vitest)\b/gi;

const BUILD_CMD_RE =
  /\b(npm\s+run\s+(?:build|typecheck|lint)|pnpm\s+(?:build|typecheck|lint)|yarn\s+(?:build|typecheck|lint)|cargo\s+build[^\n`]*|go\s+build[^\n`]*|make(?:\s+[^\n`]*)?|tsc(?:\s+-p\s+\S+)?)\b/gi;

const CITATION_RE = /(参考文献|引用|来源|出处|参考链接|references?|citations?|sources?)/i;

const NUMERIC_RE =
  /(?:至少|不少于|不少于|at\s+least|>=|≥)\s*(\d+)\s*(个|条|项|篇|张|tests?|items?|files?|citations?|references?)/gi;

/**
 * Request classes whose completion CANNOT be judged from file existence or a
 * numeric target: "these two things must agree". Kept as a class (not a list of
 * symptoms) so any new domain — audio drift, schema parity, ledger balance —
 * lands here without a new rule.
 */
const INVARIANT_CLASS_RE =
  /(对齐|对齐|一致|同步|匹配|对得上|对应|覆盖|相等|吻合|align|consistent|consistency|sync(?:hron)|match(?:es|ing)?|parity|correlat)/i;

/** Action forms of the invariant class ("把 A 和 B 对齐" has no other verb). */
const INVARIANT_ACTION_RE =
  /(对齐|一致化|同步|匹配|校对|校准|align|reconcile|sync(?:hronize)?|match)/i;

/** A question about consistency is not a request to implement it. */
const QUESTION_RE = /(为什么|为何|怎么|如何|是否|能不能|可不可以|吗[？?]?$|[？?]\s*$|\bwhy\b|\bhow\b|\bwhether\b)/i;

export function isFileDeliverablePath(p: string): boolean {
  const ext = extname(p).replace(/^\./, '').toLowerCase();
  return FILE_EXT.split('|').includes(ext);
}

/**
 * Extract acceptance items from a user request. Conservative by design: a path
 * only becomes an item when a creation/modification verb appears near it, so
 * "look at package.json" does not turn into "produce package.json".
 *
 * `manifest` (loaded by the caller from the workspace) is the declarative
 * source: it supplies invariants the sentence cannot express. Passing `null`
 * keeps the previous behaviour except for the one general rule below.
 */
export function parseContract(
  userRequest: string,
  planText = '',
  manifest: ContractManifest | null = null,
): DeliverableContract {
  const text = `${userRequest}\n${planText}`;
  const items: Acceptance[] = [];
  const seen = new Set<string>();

  const push = (item: Acceptance): void => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  // --- manifest invariants (declarative, highest authority) --------------
  let manifestItems = 0;
  if (manifest) {
    for (const inv of manifest.invariants ?? []) {
      push({
        kind: 'invariant',
        id: inv.id,
        describe: inv.describe,
        predicate: inv.predicate,
        checks: inv.checks,
      });
      manifestItems += 1;
    }
    for (const item of manifest.acceptance ?? []) {
      push(item);
      manifestItems += 1;
    }
  }

  // --- files -------------------------------------------------------------
  const pathMatches = [...text.matchAll(FILE_PATH_RE)];
  for (const m of pathMatches) {
    const p = m[1]?.trim();
    if (!p || !isFileDeliverablePath(p)) continue;
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 48), at);
    const backticked = /[`"']$/.test(before.trimEnd());
    if (!backticked && !CREATE_VERB_RE.test(before)) continue;
    push({ kind: 'file_exists', path: p, nonEmpty: true });
  }

  // --- test / build commands --------------------------------------------
  for (const m of text.matchAll(TEST_CMD_RE)) {
    const cmd = m[0].trim().replace(/[`"'，。；;,]+$/, '');
    if (cmd) push({ kind: 'test_pass', cmd });
  }
  for (const m of text.matchAll(BUILD_CMD_RE)) {
    const cmd = m[0].trim().replace(/[`"'，。；;,]+$/, '');
    if (cmd) push({ kind: 'exit_zero', cmd });
  }

  // --- citations ---------------------------------------------------------
  if (CITATION_RE.test(text)) push({ kind: 'citation', min: 1 });

  // --- numeric targets ---------------------------------------------------
  for (const m of text.matchAll(NUMERIC_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 0) {
      push({ kind: 'numeric', label: m[0].trim(), expect: n, op: '>=' });
    }
  }

  // --- invariant class without a declared invariant ----------------------
  // "Make A and B agree" cannot be verified from a filename or a count. If
  // the workspace declares no invariant, the honest contract item is "declare
  // one" — not a guessed domain check, and not an empty contract that makes
  // the completion gate a no-op.
  const asksForConsistency =
    INVARIANT_CLASS_RE.test(text) &&
    !QUESTION_RE.test(text) &&
    (CREATE_VERB_RE.test(text) || INVARIANT_ACTION_RE.test(text));
  const hasInvariant = items.some((i) => i.kind === 'invariant');
  if (asksForConsistency && !hasInvariant) {
    push({ kind: 'manifest_required', topic: firstInvariantTopic(text) });
  }

  const source: ContractSource = manifestItems
    ? 'declared_manifest'
    : items.length
      ? planText.trim()
        ? 'derived_from_plan'
        : 'parsed_from_user'
      : 'inferred_baseline';

  const contract: DeliverableContract = { items, source, raw: userRequest };
  return contract;
}

/** Short topic tag for a `manifest_required` item (reporting only). */
function firstInvariantTopic(text: string): string {
  const m = text.match(INVARIANT_CLASS_RE);
  return m ? m[0] : 'consistency';
}

/** True when the request asks for real implementation work (not just a read). */
export function requestImpliesImplementation(userRequest: string): boolean {
  return /(实现|开发|编写|新增|添加功能|修复|重构|改造|implement|develop|build|feature|refactor|fix|bug)/i.test(
    userRequest,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verifyContract(contract: DeliverableContract, ctx: VerifyContext): ContractVerdict {
  const failed: ContractVerdict['failed'] = [];
  const skipped: ContractVerdict['skipped'] = [];
  let checked = 0;

  for (const item of contract.items) {
    try {
      switch (item.kind) {
        case 'file_exists': {
          checked += 1;
          if (!ctx.exists(item.path)) {
            failed.push({ item, why: `file does not exist: ${item.path}` });
          } else if (item.nonEmpty && ctx.size && ctx.size(item.path) <= 0) {
            failed.push({ item, why: `file is empty: ${item.path}` });
          }
          break;
        }
        case 'artifact': {
          checked += 1;
          if (!ctx.exists(item.path)) {
            failed.push({ item, why: `artifact missing: ${item.path}` });
          }
          break;
        }
        case 'diff_contains': {
          checked += 1;
          const file = ctx.diff?.files.find((f) => f.path.replace(/\\/g, '/').endsWith(item.path));
          if (!file) failed.push({ item, why: `no diff for ${item.path}` });
          else if (!(file.patch ?? '').includes(item.pattern)) {
            failed.push({ item, why: `diff for ${item.path} does not contain "${item.pattern}"` });
          }
          break;
        }
        case 'test_pass':
        case 'exit_zero': {
          if (ctx.run) {
            checked += 1;
            const res = ctx.run(item.cmd);
            if (res.code !== 0) {
              failed.push({
                item,
                why: `"${item.cmd}" exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 160)}`,
              });
            }
            break;
          }
          // No runner: the agent's own tool run is the evidence. A command that
          // was never observed is skipped, never assumed to have passed.
          const observed = findObservation(ctx.observations, item.cmd);
          if (!observed) {
            skipped.push({ item, why: `no observed run of \`${item.cmd}\`` });
            break;
          }
          checked += 1;
          if (observed.exitCode !== 0) {
            failed.push({
              item,
              why: `"${item.cmd}" exited ${observed.exitCode ?? 'error'}: ${observed.output.slice(0, 160)}`,
            });
          }
          break;
        }
        case 'invariant': {
          checked += 1;
          const missing: string[] = [];
          const mismatched: string[] = [];
          for (const check of item.checks) {
            const observed = findObservation(ctx.observations, check.cmd);
            if (!observed) {
              missing.push(check.cmd);
              continue;
            }
            const why = invariantCheckFailure(check, observed);
            if (why) mismatched.push(why);
          }
          if (mismatched.length) {
            failed.push({
              item,
              why: `invariant "${item.id}" violated: ${mismatched.join('; ')}`,
            });
          } else if (missing.length) {
            skipped.push({
              item,
              why: `invariant "${item.id}" not observed — run: ${missing.join(' ; ')}`,
            });
          }
          break;
        }
        case 'manifest_required': {
          checked += 1;
          if (ctx.manifestPresent !== true) {
            failed.push({
              item,
              why:
                `"${item.topic}" cannot be verified without a declared invariant. ` +
                `Write .nexus/checks.json with the checks that prove it, then run them.`,
            });
          }
          break;
        }
        case 'citation': {
          checked += 1;
          const n = ctx.citationCount ?? 0;
          if (n < item.min) failed.push({ item, why: `citations ${n} < ${item.min}` });
          break;
        }
        case 'numeric': {
          checked += 1;
          const value = ctx.numbers?.[item.label];
          if (value === undefined) {
            skipped.push({ item, why: `no measurement for "${item.label}"` });
          } else if (!compare(value, item.op, item.expect)) {
            failed.push({ item, why: `${item.label}: ${value} ${item.op} ${item.expect} is false` });
          }
          break;
        }
      }
    } catch (err) {
      failed.push({ item, why: `verification error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return { passed: failed.length === 0, checked, failed, skipped };
}

function compare(value: number, op: '>=' | '<=' | '==', expect: number): boolean {
  if (op === '>=') return value >= expect;
  if (op === '<=') return value <= expect;
  return value === expect;
}

/** Command comparison: whitespace-insensitive, and tolerant of a `cd X &&` prefix. */
export function normalizeCommand(cmd: string): string {
  return cmd.replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findObservation(
  observations: ObservedRun[] | undefined,
  cmd: string,
): ObservedRun | undefined {
  if (!observations?.length) return undefined;
  const want = normalizeCommand(cmd);
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const got = normalizeCommand(observations[i]!.cmd);
    // Exact, chained (`cd x && …`), or the declared command with extra flags
    // (`pytest` declared, `pytest -q` observed).
    if (
      got === want ||
      got.endsWith(`&& ${want}`) ||
      got.endsWith(`; ${want}`) ||
      got.startsWith(`${want} `)
    ) {
      return observations[i];
    }
  }
  return undefined;
}

/** null = check passed; string = human reason it failed. */
function invariantCheckFailure(
  check: InvariantCheckSpec,
  observed: ObservedRun,
): string | null {
  const expect = check.expect ?? {};
  const wantExit = expect.exitCode ?? 0;
  if (observed.exitCode !== wantExit) {
    return `\`${check.cmd}\` exited ${observed.exitCode ?? 'error'} (expected ${wantExit})`;
  }
  if (expect.stdoutMatch) {
    try {
      if (!new RegExp(expect.stdoutMatch, 'm').test(observed.output)) {
        return `\`${check.cmd}\` output did not match /${expect.stdoutMatch}/`;
      }
    } catch {
      return `\`${check.cmd}\` has an invalid stdoutMatch pattern`;
    }
  }
  if (expect.stdoutNotMatch) {
    try {
      if (new RegExp(expect.stdoutNotMatch, 'm').test(observed.output)) {
        return `\`${check.cmd}\` output matched forbidden /${expect.stdoutNotMatch}/`;
      }
    } catch {
      return `\`${check.cmd}\` has an invalid stdoutNotMatch pattern`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anti-cheat checks
// ---------------------------------------------------------------------------

export type CheatId =
  | 'tests_only_change'
  | 'assertion_deleted'
  | 'stub_as_impl'
  | 'narration_without_action'
  | 'pushback_to_user'
  | 'empty_diff_claims'
  | 'report_without_artifact'
  | 'claimed_action_blocked'
  | 'unverified_success';

export interface GitDiffFile {
  path: string;
  status?: string;
  added: number;
  removed: number;
  patch?: string;
}

export interface GitDiff {
  files: GitDiffFile[];
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** Number of tool calls emitted alongside this assistant message. */
  toolCalls?: number;
}

export interface CheatFinding {
  id: CheatId;
  severity: 'high' | 'medium';
  evidence: string;
}

export interface AntiCheatInput {
  userRequest: string;
  diff: GitDiff;
  /**
   * False when the caller has no trustworthy workspace diff (e.g. a chat-only
   * step). Diff-derived checks are skipped rather than guessed.
   */
  diffKnown?: boolean;
  transcript: TranscriptEntry[];
}

const TEST_PATH_RE = /(^|[\\/])(test|tests|__tests__|spec|e2e)([\\/]|$)|\.(test|spec)\.[a-z0-9]+$/i;

const ASSERT_ADD_RE = /^\+\s*(assert|expect\s*\(|self\.assert|@Test|t\.(?:assert|error|fatal))/;
const ASSERT_DEL_RE = /^-\s*(assert|expect\s*\(|self\.assert|@Test|t\.(?:assert|error|fatal))/;
const SKIP_ADD_RE = /^\+\s*.*\b(skip|xit|xdescribe|todo|@Ignore|@Disabled|pytest\.mark\.skip)\b/i;
const STUB_ADD_RE =
  /^\+\s*.*(\bTODO\b|\bFIXME\b|not implemented|NotImplemented|throw new Error\(['"`]todo|pass\s*#\s*todo)/i;

export function antiCheatChecks(input: AntiCheatInput): CheatFinding[] {
  const findings: CheatFinding[] = [];
  const { diff, transcript, userRequest } = input;
  const diffKnown = input.diffKnown !== false;
  const lastAssistant = [...transcript].reverse().find((t) => t.role === 'assistant');
  const claims = lastAssistant ? claimsCompletion(lastAssistant.text) : false;

  // 1. tests_only_change
  if (diffKnown && diff.files.length > 0 && requestImpliesImplementation(userRequest)) {
    const nonTest = diff.files.filter((f) => !TEST_PATH_RE.test(f.path.replace(/\\/g, '/')));
    if (nonTest.length === 0) {
      findings.push({
        id: 'tests_only_change',
        severity: 'high',
        evidence: `only test files changed: ${diff.files.map((f) => f.path).join(', ')}`,
      });
    }
  }

  // 2. assertion_deleted
  let assertAdded = 0;
  let assertRemoved = 0;
  let skipAdded = 0;
  for (const f of diff.files) {
    for (const line of (f.patch ?? '').split('\n')) {
      if (ASSERT_ADD_RE.test(line)) assertAdded += 1;
      else if (ASSERT_DEL_RE.test(line)) assertRemoved += 1;
      if (SKIP_ADD_RE.test(line)) skipAdded += 1;
    }
  }
  if (diffKnown && assertRemoved > 0 && assertAdded === 0) {
    findings.push({
      id: 'assertion_deleted',
      severity: 'high',
      evidence: `removed ${assertRemoved} assertion(s) and added none`,
    });
  }
  if (diffKnown && skipAdded > 0 && assertAdded === 0) {
    findings.push({
      id: 'assertion_deleted',
      severity: 'high',
      evidence: `added ${skipAdded} skipped/disabled marker(s) with no new assertion`,
    });
  }

  // 3. stub_as_impl
  const stubs: string[] = [];
  for (const f of diff.files) {
    if (TEST_PATH_RE.test(f.path.replace(/\\/g, '/'))) continue;
    for (const line of (f.patch ?? '').split('\n')) {
      if (STUB_ADD_RE.test(line)) stubs.push(`${f.path}: ${line.trim().slice(0, 100)}`);
    }
  }
  if (diffKnown && stubs.length > 0 && claims) {
    findings.push({
      id: 'stub_as_impl',
      severity: 'high',
      evidence: `completion claimed with ${stubs.length} stub/TODO line(s): ${stubs[0]}`,
    });
  }

  // 4. narration_without_action
  // The final answer is normally tool-call-free (the tools ran in earlier
  // rounds), so "0 tool calls in the last message" proves nothing. The real
  // shortcut is a turn that claims completion without ANY tool ever running.
  if (lastAssistant && claims) {
    const totalToolCalls = transcript.reduce((n, t) => n + (t.toolCalls ?? 0), 0);
    const anyToolEntry = transcript.some((t) => t.role === 'tool');
    if (totalToolCalls === 0 && !anyToolEntry) {
      findings.push({
        id: 'narration_without_action',
        severity: 'high',
        evidence: `completion claimed with 0 tool calls: "${lastAssistant.text.slice(0, 120)}"`,
      });
    }
  }

  // 5. pushback_to_user
  if (lastAssistant) {
    const m = lastAssistant.text.match(
      /(请|你需要|你可以|please)[^。\n]{0,40}(手动|自行|运行|执行|run|execute|manually)/i,
    );
    if (m && (lastAssistant.toolCalls ?? 0) === 0) {
      findings.push({
        id: 'pushback_to_user',
        severity: 'medium',
        evidence: `asks the user to act instead of doing it: "${m[0].slice(0, 120)}"`,
      });
    }
  }

  // 6. empty_diff_claims
  if (diffKnown && claims && diff.files.length === 0) {
    findings.push({
      id: 'empty_diff_claims',
      severity: 'high',
      evidence: 'completion claimed but the workspace diff is empty',
    });
  }

  // 7. report_without_artifact
  if (diffKnown && lastAssistant && claims) {
    const saysProduced = /(已生成|已创建|已写入|已保存|报告已|generated|created|saved|written)/i.test(
      lastAssistant.text,
    );
    const namesFile = new RegExp(`[\\w./-]+\\.(?:${FILE_EXT})\\b`, 'i').test(lastAssistant.text);
    const artifactInDiff = diff.files.some((f) =>
      /\.(md|mdx|html|pdf|docx|xlsx|pptx|png|jpe?g|svg|csv|txt)$/i.test(f.path),
    );
    if (saysProduced && !namesFile && !artifactInDiff) {
      findings.push({
        id: 'report_without_artifact',
        severity: 'medium',
        evidence: 'claims a generated artifact but names no file and produced no diff',
      });
    }
  }

  return findings;
}

/** Completion claim detection with a negation guard ("未完成" is not a claim). */
export function claimsCompletion(text: string): boolean {
  if (!text) return false;
  const zh =
    /(?:^|[^未没无])[^。\n]{0,8}(已完成|完成了|搞定了|做好了|已实现|已修复|修复成功|修复完成|修复确认|已生成|已创建|已写入|已保存|已删除|已清理|已解决|问题已解决|彻底解决|完全正确|完全匹配|完全对齐|对齐正确|字幕.{0,4}正确|验证成功|验证通过|测试通过|生效了)/;
  const en =
    /\b(done|completed|implemented|fixed|created|generated|finished|verified|all tests pass|tests pass|fully aligned|perfectly aligned)\b/i;
  const negated =
    /(未完成|没完成|尚未|无法完成|没有完成|不能完成|not\s+(?:yet\s+)?(?:done|completed|finished|fixed)|cannot\s+complete|not\s+verified|unverified)/i;
  if (negated.test(text) && !/(已完成|completed successfully|fully verified)/i.test(text)) return false;
  return zh.test(text) || en.test(text);
}

/**
 * Build the L1 steer body for a failed contract / anti-cheat verdict.
 * Caller passes the machine reasons; this function only formats.
 */
export function formatContractCorrection(
  verdict: ContractVerdict | null,
  findings: CheatFinding[],
): string {
  const lines: string[] = [];
  if (verdict) {
    for (const f of verdict.failed) {
      lines.push(`- acceptance not met: ${describeAcceptance(f.item)} — ${f.why}`);
    }
    for (const s of verdict.skipped) {
      lines.push(
        `- declared but not observed: ${describeAcceptance(s.item)} — ${s.why}. ` +
          'Run the check and quote its output; absence of evidence is not completion.',
      );
    }
  }
  for (const f of findings) {
    lines.push(`- anti-cheat "${f.id}": ${f.evidence}`);
  }
  if (lines.length === 0) return '';
  return [
    '<harness_correction kind="shortcut_suspect">',
    'The task is not complete yet. The harness found:',
    ...lines,
    'Do not restate the plan. Fix the failing item(s) with real tool calls, then verify.',
    '</harness_correction>',
  ].join('\n');
}

export function describeAcceptance(item: Acceptance): string {
  switch (item.kind) {
    case 'file_exists':
      return `file ${item.path}`;
    case 'artifact':
      return `artifact ${item.path}`;
    case 'test_pass':
      return `test \`${item.cmd}\``;
    case 'exit_zero':
      return `command \`${item.cmd}\``;
    case 'diff_contains':
      return `diff of ${item.path} contains "${item.pattern}"`;
    case 'citation':
      return `at least ${item.min} citation(s)`;
    case 'numeric':
      return `${item.label} ${item.op} ${item.expect}`;
    case 'invariant':
      return `invariant "${item.id}"${item.describe ? ` (${item.describe})` : ''}`;
    case 'manifest_required':
      return `a declared invariant for "${item.topic}"`;
  }
}
