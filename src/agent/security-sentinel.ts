/**
 * Security Sentinel — sits *before* the permission bridge.
 *
 * The path authorizer answers "is this argument legal?". This module answers a
 * different question: "is the model probing the boundary, or is this action
 * being steered by untrusted content?". Those are the two real-world ways an
 * agent breaks out of its sandbox:
 *
 *   1. Probe loops — the model keeps asking for the same forbidden capability
 *      until the user tires out and clicks Allow. We count denials per
 *      *capability*, not per tool name, and freeze the capability instead of
 *      showing another card.
 *
 *   2. Prompt injection — a web page / issue body / MCP result tells the model
 *      to write a file or run a command. Any privileged action in the same step
 *      as an untrusted result is treated as fatal, regardless of how the args
 *      look.
 *
 * Everything is deterministic and side-effect free except the in-memory probe
 * counters, so it is safe to call from the event bridge.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { normalizePath } from './progress-ledger.js';

export type CapabilityCategory =
  | 'policy_write'
  | 'privilege'
  | 'fs_write'
  | 'fs_read'
  | 'exec'
  | 'network'
  | 'memory_write'
  | 'unknown';

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
  /** True when this step consumed content from an untrusted source. */
  hasUntrustedSource?: boolean;
}

export interface SentinelDecision {
  ok: boolean;
  category: CapabilityCategory;
  /** Fatal decisions bypass the permission card entirely. */
  fatal: boolean;
  /** Machine key + human reason for logs and the evidence pack. */
  probe?: string;
  reason?: string;
  evidence: string[];
}

export interface SecuritySentinelOptions {
  /** Authorized project root. Writes outside it are probes. */
  root: string;
  /** Glob patterns the agent may never write (relative to root, or absolute). */
  immutablePaths?: string[];
  /** Hosts that do not count as new network egress. */
  networkAllowlist?: string[];
  /** Consecutive denials of one capability before the sentinel freezes it. */
  probeCountToFreeze?: number;
}

const DEFAULT_IMMUTABLE = [
  '.nexus/rules/**',
  '.nexus/config/**',
  'src/agent/**',
  '.git/hooks/**',
  '.github/workflows/**',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '*.audit.*',
];

const WRITE_TOOL_RE =
  /(^|_)(write|edit|patch|apply|create|delete|remove|move|rename|mkdir|copy|replace|truncate|append|save|upload|commit|stage|reset|checkout|merge|rebase|push)(_|$)/i;
const READ_TOOL_RE = /(^|_)(read|list|glob|grep|search|status|get|show|view|inspect|outline|diagnostic|hover|diff|stat)(_|$)/i;
const EXEC_TOOL_RE = /(^|_)(exec|execute|shell|bash|command|run|spawn|terminal|powershell|cmd)(_|$)/i;
const NETWORK_TOOL_RE = /(^|_)(fetch|http|https|request|download|browse|crawl|web|url|curl|wget)(_|$)/i;
const MEMORY_WRITE_TOOL_RE = /^(remember|user_info|memory_write|kg_write)$/i;

/** Binaries / verbs that constitute a privilege escalation attempt. */
const PRIVILEGE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsudo\b/i, label: 'sudo' },
  { re: /\bdoas\b/i, label: 'doas' },
  { re: /\bchmod\s+[ugoa]*\+s\b/i, label: 'setuid chmod' },
  { re: /\bchown\s+(root|0)(:|\s)/i, label: 'chown root' },
  { re: /\bsetcap\b/i, label: 'setcap' },
  { re: /\breg\s+add\b.*\bHKLM\b/i, label: 'registry HKLM write' },
  { re: /\bnetsh\s+advfirewall\b/i, label: 'firewall change' },
  { re: /\bsc\s+(create|config)\b/i, label: 'service install' },
  { re: /\bdd\s+if=.*\bof=\/dev\//i, label: 'raw device write' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/i, label: 'fork bomb' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh|powershell)\b/i, label: 'pipe-to-shell' },
  { re: /\bpowershell\b.*\s-(enc|encodedcommand)\b/i, label: 'encoded powershell' },
];

/** Tool-name heuristics that can never write to the immutable zone. */
const POLICY_GUARDED = new Set([
  '.nexus/rules',
  '.nexus/config',
]);

export class SecuritySentinel {
  private readonly root: string;
  private readonly immutable: Array<{ glob: string; re: RegExp }>;
  private readonly networkAllowlist: Set<string>;
  private readonly probeCountToFreeze: number;

  private readonly denials = new Map<CapabilityCategory, number>();
  private readonly frozen = new Set<CapabilityCategory>();
  private readonly frozenAt = new Map<CapabilityCategory, number>();

  constructor(opts: SecuritySentinelOptions) {
    this.root = resolve(opts.root || process.cwd());
    const patterns = opts.immutablePaths?.length ? opts.immutablePaths : DEFAULT_IMMUTABLE;
    this.immutable = patterns.map((glob) => ({ glob, re: globToRegExp(glob) }));
    this.networkAllowlist = new Set((opts.networkAllowlist ?? []).map((h) => h.toLowerCase()));
    this.probeCountToFreeze = Math.max(1, opts.probeCountToFreeze ?? 2);
  }

  get rootDir(): string {
    return this.root;
  }

  reset(): void {
    this.denials.clear();
    this.frozen.clear();
    this.frozenAt.clear();
  }

  isFrozen(category?: CapabilityCategory): boolean {
    if (!category) return this.frozen.size > 0;
    return this.frozen.has(category);
  }

  frozenCategories(): CapabilityCategory[] {
    return [...this.frozen];
  }

  /** Public classification, useful for tests and for the UI. */
  classify(tool: string, args: Record<string, unknown> = {}): CapabilityCategory {
    const name = tool.toLowerCase();
    if (MEMORY_WRITE_TOOL_RE.test(name)) return 'memory_write';
    if (EXEC_TOOL_RE.test(name)) return 'exec';
    if (NETWORK_TOOL_RE.test(name)) return 'network';
    if (WRITE_TOOL_RE.test(name)) return 'fs_write';
    if (READ_TOOL_RE.test(name)) return 'fs_read';
    // Unknown MCP tools are treated by their args: a path means fs, a command
    // means exec, a URL means network.
    if (typeof firstString(args, ['command', 'cmd', 'shell', 'script']) === 'string') return 'exec';
    if (urlsIn(args).length > 0) return 'network';
    if (pathsIn(args).length > 0) return 'fs_write';
    return 'unknown';
  }

  /**
   * Evaluate one tool request. Called from the event bridge on
   * `tool_call_start`, before the permission bridge.
   */
  evaluate(req: ToolRequest): SentinelDecision {
    const category = this.classify(req.tool, req.args);
    const evidence: string[] = [`tool=${req.tool}`, `category=${category}`];

    // --- immutable policy zone -------------------------------------------
    // Only *writes* are checked here: reading the constitution/rules is
    // something the agent is explicitly allowed to do.
    const writeTargets = pathsIn(req.args);
    if (category === 'fs_write') {
      for (const p of writeTargets) {
        if (this.isImmutable(p)) {
          evidence.push(`target in immutable zone: ${p}`);
          return this.fatal('policy_write', 'policy_write', 'write to harness/policy zone is forbidden', evidence);
        }
      }
    }

    // --- privilege escalation --------------------------------------------
    const commandText = commandsIn(req.args).join('\n');
    if (commandText) {
      for (const { re, label } of PRIVILEGE_PATTERNS) {
        if (re.test(commandText)) {
          evidence.push(`privilege pattern: ${label}`);
          return this.fatal('privilege', 'privilege', `privilege escalation attempt (${label})`, evidence);
        }
      }
    }

    // --- taint: untrusted content in this step + privileged action -------
    const privileged =
      category === 'fs_write' ||
      category === 'exec' ||
      category === 'network' ||
      category === 'memory_write' ||
      category === 'privilege';
    if (req.hasUntrustedSource && privileged) {
      evidence.push('step consumed untrusted content and now wants a privileged action');
      return this.fatal(category, 'tainted_action', 'privileged action driven by untrusted content', evidence);
    }

    // --- path containment -------------------------------------------------
    if (category === 'fs_write') {
      for (const p of writeTargets) {
        if (!this.isInsideRoot(p)) {
          evidence.push(`write outside authorized root: ${p}`);
          return this.probeDecision(category, 'write_outside_root', 'write outside authorized project root', evidence);
        }
      }
    }

    // --- network egress ---------------------------------------------------
    if (category === 'network') {
      for (const url of urlsIn(req.args)) {
        const host = hostOf(url);
        if (host && this.networkAllowlist.size > 0 && !this.networkAllowlist.has(host)) {
          evidence.push(`egress to host outside allowlist: ${host}`);
          return this.probeDecision(category, 'network_egress', `network egress to ${host}`, evidence);
        }
      }
    }

    // --- frozen capability ------------------------------------------------
    if (this.frozen.has(category)) {
      evidence.push(`capability ${category} is frozen after repeated denials`);
      return {
        ok: false,
        category,
        fatal: true,
        probe: 'frozen_capability',
        reason: `capability "${category}" was frozen after repeated boundary probes`,
        evidence,
      };
    }

    return { ok: true, category, fatal: false, evidence };
  }

  /**
   * Feed a denial (from the permission bridge or a failed containment check).
   * Returns a fatal decision once the capability crosses the probe threshold.
   */
  notifyDenied(category: CapabilityCategory, reason = 'denied'): SentinelDecision | null {
    const count = (this.denials.get(category) ?? 0) + 1;
    this.denials.set(category, count);
    if (count >= this.probeCountToFreeze && !this.frozen.has(category)) {
      this.freeze(category);
      return {
        ok: false,
        category,
        fatal: true,
        probe: 'probe_threshold',
        reason:
          `capability "${category}" denied ${count} times — ` +
          `treating this as boundary probing and freezing it`,
        evidence: [`denials=${count}`, `last_reason=${reason}`],
      };
    }
    return null;
  }

  /** Called when a capability succeeds, so a one-off denial does not accumulate. */
  notifyAllowed(category: CapabilityCategory): void {
    this.denials.delete(category);
  }

  freeze(category: CapabilityCategory): void {
    this.frozen.add(category);
    this.frozenAt.set(category, Date.now());
  }

  frozenSince(category: CapabilityCategory): number | undefined {
    return this.frozenAt.get(category);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private fatal(
    category: CapabilityCategory,
    probe: string,
    reason: string,
    evidence: string[],
  ): SentinelDecision {
    this.freeze(category);
    return { ok: false, category, fatal: true, probe, reason, evidence };
  }

  private probeDecision(
    category: CapabilityCategory,
    probe: string,
    reason: string,
    evidence: string[],
  ): SentinelDecision {
    const fatal = this.notifyDenied(category, reason);
    if (fatal) return fatal;
    return { ok: false, category, fatal: false, probe, reason, evidence };
  }

  private isImmutable(p: string): boolean {
    const abs = normalizePath(resolve(this.root, p));
    const rel = normalizePath(relative(this.root, abs));
    for (const { glob, re } of this.immutable) {
      const g = normalizePath(glob);
      // Match the relative form (normal case) and the absolute form (config
      // may list an absolute path).
      if (re.test(rel) || re.test(abs) || re.test(normalizePath(p))) return true;
      // A bare directory prefix (e.g. ".nexus/rules") protects everything below.
      if (!g.includes('*') && (rel === g || rel.startsWith(`${g}/`))) return true;
      if (POLICY_GUARDED.has(g) && (rel === g || rel.startsWith(`${g}/`))) return true;
    }
    return false;
  }

  private isInsideRoot(p: string): boolean {
    const abs = normalizePath(resolve(this.root, p));
    const root = normalizePath(this.root);
    return abs === root || abs.startsWith(`${root}/`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'target',
  'dest',
  'destination',
  'dir',
  'directory',
  'cwd',
  'root',
  'output',
  'filename',
];

export function pathsIn(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && PATH_KEYS.includes(k)) {
        out.push(v);
      } else if (typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };
  if (args && typeof args === 'object') visit(args, 0);
  // De-duplicate while preserving order.
  return [...new Set(out)];
}

const COMMAND_KEYS = ['command', 'cmd', 'shell', 'script', 'args', 'argv'];

export function commandsIn(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of COMMAND_KEYS) {
    const v = args?.[key];
    if (typeof v === 'string' && v.trim()) out.push(v);
    else if (Array.isArray(v)) {
      const parts = v.filter((x): x is string => typeof x === 'string');
      if (parts.length) out.push(parts.join(' '));
    }
  }
  return out;
}

export function urlsIn(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const matches = value.match(/https?:\/\/[^\s"'<>]+/gi);
      if (matches) for (const m of matches) out.add(m);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(args, 0);
  return [...out];
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args?.[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/**
 * Minimal glob → RegExp. Supports `**` (any depth), `*` (one segment) and `?`.
 * Case-insensitive because the fingerprint/immutable checks are on Windows too.
 */
export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (g[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Convenience: true when `p` is absolute. Exposed for wiring/tests. */
export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}
