/**
 * Declarative check manifest — where "what counts as done" comes from when the
 * user's sentence cannot say it.
 *
 * `parseContract()` can only see the request text. A request like "fix the
 * image/audio alignment" contains no file name, no test command and no numeric
 * target, so the parsed contract is empty and the completion gate is a no-op.
 * This module lets a workspace declare its own machine-checkable invariants
 * once, in a file, instead of asking the harness to grow a rule per domain.
 *
 *   .nexus/checks.json
 *   {
 *     "version": 1,
 *     "invariants": [
 *       {
 *         "id": "timeline-ssot",
 *         "describe": "video / audio / subtitle timelines are one timeline",
 *         "predicate": "abs(video_s - audio_s) <= 0.05 and subtitle_end >= audio_s - 0.05",
 *         "checks": [{ "cmd": "python tools/check_timeline.py", "expect": { "exitCode": 0, "stdoutMatch": "^OK" } }]
 *       }
 *     ]
 *   }
 *
 * The harness never invents an invariant. It *loads* them, and it never runs a
 * command on its own — an invariant is satisfied only by an observed tool run
 * carrying the declared command (see `VerifyContext.observations`). That keeps
 * the "no evidence, no success" rule honest: a declared but unrun check is
 * reported as skipped, and a skipped item can never produce a `passed` verdict.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Acceptance } from './deliverable-contract.js';

export interface InvariantExpectation {
  /** Required exit code. Defaults to 0. */
  exitCode?: number;
  /** Regex the combined stdout/stderr must match. */
  stdoutMatch?: string;
  /** Regex it must NOT match. */
  stdoutNotMatch?: string;
}

export type InvariantEvidence =
  | 'content_check'
  | 'duration_check'
  | 'exit_code'
  | 'numeric'
  | 'custom';

export interface InvariantCheckSpec {
  /** Exact command line the agent is expected to run. */
  cmd: string;
  expect?: InvariantExpectation;
  /**
   * What KIND of fact this check produces. `duration_check` alone is a proxy
   * metric and never proves "aligned"; the manifest must name the stronger
   * evidence it expects so a reviewer can see the difference.
   */
  evidence?: InvariantEvidence;
}

export interface InvariantSpec {
  id: string;
  describe?: string;
  /** Human-readable invariant (documentation only — never executed). */
  predicate?: string;
  checks: InvariantCheckSpec[];
  /** Optional tolerance carried through for reporting. */
  tolerance?: number;
}

export interface ContractManifest {
  version?: number;
  invariants?: InvariantSpec[];
  /** Extra acceptance items, same shape the parser produces. */
  acceptance?: Acceptance[];
}

export interface LoadedManifest {
  manifest: ContractManifest;
  /** Absolute path of the file that produced it. */
  path: string;
}

/** Convention paths, first hit wins. A project opts in by creating one. */
export const MANIFEST_CANDIDATES = [
  '.nexus/checks.json',
  'nexus.checks.json',
  'checks.manifest.json',
] as const;

const MAX_INVARIANTS = 20;
const MAX_CHECKS_PER_INVARIANT = 8;

/** True when any manifest file exists in the workspace. */
export function manifestExists(root: string): boolean {
  return !!findManifestPath(root);
}

export function findManifestPath(root: string): string | null {
  const env = process.env.NEXUS_CHECKS_MANIFEST;
  const candidates = env?.trim()
    ? [env.trim(), ...MANIFEST_CANDIDATES]
    : [...MANIFEST_CANDIDATES];
  for (const rel of candidates) {
    const abs = isAbsolute(rel) ? rel : resolve(root, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Load and normalise the manifest. Never throws: a malformed file yields
 * `null` plus a reason, so the caller can surface "your checks file is
 * unreadable" instead of silently treating the task as uncontracted.
 */
export function loadManifest(root: string): { loaded: LoadedManifest | null; error?: string } {
  const path = findManifestPath(root);
  if (!path) return { loaded: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { loaded: null, error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const manifest = normalizeManifest(raw);
  if (!manifest) return { loaded: null, error: `${path}: not a check manifest object` };
  return { loaded: { manifest, path } };
}

/** Normalise untrusted JSON into a manifest; unknown/malformed entries drop. */
export function normalizeManifest(raw: unknown): ContractManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const out: ContractManifest = {};
  if (typeof obj.version === 'number' && Number.isFinite(obj.version)) out.version = obj.version;

  if (Array.isArray(obj.invariants)) {
    const invariants: InvariantSpec[] = [];
    for (const item of obj.invariants.slice(0, MAX_INVARIANTS)) {
      const inv = normalizeInvariant(item);
      if (inv) invariants.push(inv);
    }
    if (invariants.length) out.invariants = invariants;
  }

  if (Array.isArray(obj.acceptance)) {
    const items: Acceptance[] = [];
    for (const item of obj.acceptance) {
      const acc = normalizeAcceptance(item);
      if (acc) items.push(acc);
    }
    if (items.length) out.acceptance = items;
  }

  return out;
}

function normalizeInvariant(raw: unknown): InvariantSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  if (!id) return null;
  const checks: InvariantCheckSpec[] = [];
  if (Array.isArray(obj.checks)) {
    for (const c of obj.checks.slice(0, MAX_CHECKS_PER_INVARIANT)) {
      const spec = normalizeCheck(c);
      if (spec) checks.push(spec);
    }
  }
  if (checks.length === 0) return null;
  const inv: InvariantSpec = { id, checks };
  if (typeof obj.describe === 'string' && obj.describe.trim()) inv.describe = obj.describe.trim();
  if (typeof obj.predicate === 'string' && obj.predicate.trim()) inv.predicate = obj.predicate.trim();
  if (typeof obj.tolerance === 'number' && Number.isFinite(obj.tolerance)) {
    inv.tolerance = obj.tolerance;
  }
  return inv;
}

function normalizeCheck(raw: unknown): InvariantCheckSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const cmd = typeof obj.cmd === 'string' ? obj.cmd.trim() : '';
  if (!cmd) return null;
  const spec: InvariantCheckSpec = { cmd };
  const expectRaw = obj.expect;
  if (expectRaw && typeof expectRaw === 'object') {
    const e = expectRaw as Record<string, unknown>;
    const expect: InvariantExpectation = {};
    if (typeof e.exitCode === 'number' && Number.isFinite(e.exitCode)) {
      expect.exitCode = Math.round(e.exitCode);
    }
    if (typeof e.stdoutMatch === 'string' && e.stdoutMatch.trim()) {
      expect.stdoutMatch = e.stdoutMatch;
    }
    if (typeof e.stdoutNotMatch === 'string' && e.stdoutNotMatch.trim()) {
      expect.stdoutNotMatch = e.stdoutNotMatch;
    }
    if (Object.keys(expect).length) spec.expect = expect;
  }
  const evidence = obj.evidence;
  if (
    evidence === 'content_check' ||
    evidence === 'duration_check' ||
    evidence === 'exit_code' ||
    evidence === 'numeric' ||
    evidence === 'custom'
  ) {
    spec.evidence = evidence;
  }
  return spec;
}

const ACCEPTANCE_KINDS = new Set([
  'file_exists',
  'test_pass',
  'exit_zero',
  'diff_contains',
  'artifact',
  'citation',
  'numeric',
]);

/**
 * Accept only the plain acceptance shapes. `invariant` / `manifest_required`
 * are produced by the harness itself and stay out of user JSON so a project
 * cannot fabricate "this is verified" items.
 */
function normalizeAcceptance(raw: unknown): Acceptance | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind : '';
  if (!ACCEPTANCE_KINDS.has(kind)) return null;
  switch (kind) {
    case 'file_exists':
      return typeof obj.path === 'string' && obj.path.trim()
        ? { kind: 'file_exists', path: obj.path.trim(), nonEmpty: obj.nonEmpty === true }
        : null;
    case 'test_pass':
    case 'exit_zero':
      return typeof obj.cmd === 'string' && obj.cmd.trim()
        ? { kind: kind as 'test_pass' | 'exit_zero', cmd: obj.cmd.trim() }
        : null;
    case 'diff_contains':
      return typeof obj.path === 'string' && typeof obj.pattern === 'string'
        ? { kind: 'diff_contains', path: obj.path, pattern: obj.pattern }
        : null;
    case 'artifact':
      return typeof obj.path === 'string' && obj.path.trim()
        ? { kind: 'artifact', path: obj.path.trim() }
        : null;
    case 'citation':
      return { kind: 'citation', min: typeof obj.min === 'number' ? obj.min : 1 };
    case 'numeric':
      return typeof obj.label === 'string' &&
        typeof obj.expect === 'number' &&
        (obj.op === '>=' || obj.op === '<=' || obj.op === '==')
        ? { kind: 'numeric', label: obj.label, expect: obj.expect, op: obj.op }
        : null;
    default:
      return null;
  }
}

/** Absolute path for a manifest-relative command cwd. */
export function manifestRootFor(manifestPath: string): string {
  return join(manifestPath, '..');
}
