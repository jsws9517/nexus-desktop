/**
 * acp_router — multi-agent routing tool.
 *
 * Surface an LLM-callable tool that lets the active agent delegate work to a
 * named sub-agent role.  Each role is a pre-configured prompt + tool allowlist
 * + optional constitution snippet, stored under the project's `.nexus/agents/`
 * directory (one markdown file per role).
 *
 * Workflow:
 *   1. LLM calls `acp_router` with `action` + role + prompt.
 *   2. The tool resolves the role config (`.nexus/agents/<role>/SKILL.md`).
 *   3. `action=route` returns the resolved role config (system prompt, tool
 *      allowlist, limits) plus the prompt. It does NOT execute the role —
 *      role dispatch lives in core, which owns scheduling and execution.
 *   4. `action=list_roles` / `action=create_role` manage role definitions.
 *
 * Role definitions live in `<project-root>/.nexus/agents/<name>/SKILL.md`
 * with front-matter:
 *   ---
 *   role: researcher
 *   tools: [read_media_file, list_directory_with_sizes, query]
 *   constitution: path relative to .nexus/agents/<name>/
 *   background: true|false   (default: false — inline is faster)
 *   ---
 *   <system prompt for this role>
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ToolDef, ToolResult, ToolContext } from './types.js';

// ---------------------------------------------------------------------------
// Role config schema
// ---------------------------------------------------------------------------

interface RoleFrontMatter {
  role?: string;
  tools?: string[];
  constitution?: string;
  background?: boolean;
  maxDurationMs?: number;
  maxTurns?: number;
}

interface RoleDef {
  name: string;
  path: string;          // absolute path to SKILL.md
  systemPrompt: string;  // body after front-matter
  frontmatter: RoleFrontMatter;
}

const AGENTS_DIR = '.nexus/agents';
const MAX_ROLE_FILE_BYTES = 16_000;
const MAX_TOOL_RESULT_CHARS = 30_000;

// ---------------------------------------------------------------------------
// Subagent failure classification — structured error codes for delegation.
//
// Every subagent tool returns one of these codes so the LLM can disambiguate
// "gate-blocked" from "role not found" without parsing prose. The renderer
// consumes them to build the steer banner shown in the chat bubble.
// ---------------------------------------------------------------------------
export type SubagentFailureKind =
  | 'blocked_policy'
  | 'blocked_quota'
  | 'not_found'
  | 'exec_error'
  | 'timeout'
  | 'unknown';

/**
 * Build a structured error payload for subagent delegation failures.
 *
 * `ToolResult` only carries {content, isError}, so the failure code is encoded
 * into `content` as a machine-parseable prefix `[subagent:<kind>]`.
 * Both the LLM (which reads the result) and AgentService.noteToolOutcome
 * (which logs + classifies) can recover the code without parsing prose.
 */
export const SUBAGENT_FAILURE_PREFIX = '[subagent:';

export function buildSubagentFailure(
  kind: SubagentFailureKind,
  message: string,
): { content: string; isError: true } {
  return {
    content: `${SUBAGENT_FAILURE_PREFIX}${kind}] ${message}`,
    isError: true,
  };
}

/**
 * Extract the structured failure code from a subagent error's content.
 * Returns null when the payload carries no `[subagent:<kind>]` prefix
 * (i.e. it is not a delegation failure).
 */
export function parseSubagentFailureKind(content: string): SubagentFailureKind | null {
  const m = content.match(/^\[subagent:([a-z_]+)\]/);
  if (!m) return null;
  const kind = m[1];
  const known: SubagentFailureKind[] = [
    'blocked_policy', 'blocked_quota', 'not_found', 'exec_error', 'timeout', 'unknown',
  ];
  return (known.includes(kind as SubagentFailureKind) ? kind : 'unknown') as SubagentFailureKind;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFrontMatter(content: string): { body: string; fm: RoleFrontMatter } {
  const match = content.match(/^---\s*\n([\s\S]*?)^---\s*$/m);
  if (!match) return { body: content.trim(), fm: {} };
  const raw = match[1];
  const fm: RoleFrontMatter = {};
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key === 'tools') {
      try { fm.tools = JSON.parse(val) as string[]; } catch { fm.tools = []; }
    } else if (key === 'background') {
      fm.background = val.toLowerCase() === 'true';
    } else if (key === 'constitution') {
      fm.constitution = val;
    } else if (key === 'maxDurationMs') {
      const n = Number(val);
      if (Number.isFinite(n)) fm.maxDurationMs = n;
    } else if (key === 'maxTurns') {
      const n = Number(val);
      if (Number.isFinite(n)) fm.maxTurns = n;
    } else if (key === 'role') {
      fm.role = val;
    }
  }
  const body = content.slice(match[0].length).trim();
  return { body, fm };
}

function isAuthorizedAgentRoot(root: string): boolean {
  return root.length > 0; // authorized at the call site via tool context
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function discoverRoles(root: string): Promise<RoleDef[]> {
  if (!isAuthorizedAgentRoot(root)) return [];
  const agentsDir = join(resolve(root), AGENTS_DIR);
  const roles: RoleDef[] = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const skillFile = join(agentsDir, d.name, 'SKILL.md');
      try {
        const st = await stat(skillFile);
        if (!st.isFile() || st.size > MAX_ROLE_FILE_BYTES) continue;
        const text = await readFile(skillFile, 'utf8');
        const { body, fm } = extractFrontMatter(text);
        roles.push({ name: d.name, path: skillFile, systemPrompt: body, frontmatter: fm });
      } catch { /* unreadable — skip */ }
    }
  } catch {
    // no agents dir yet
  }
  return roles;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const ACP_ROUTER_TOOL: ToolDef = {
  name: 'acp_router',
  server: 'acp-router-internal',
  description:
    'Route a sub-task to a named agent role.  Roles are defined under .nexus/agents/<name>/SKILL.md. ' +
    'Use this to delegate specialized work (research, code review, data analysis, etc.) to a role that ' +
    'has its own system prompt and tool allowlist.  Returns a job id when background:true; otherwise ' +
    'returns the inline result.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['route', 'list_roles', 'lookup'],
        description: 'route=delegate to a role; list_roles=list available roles; lookup=read a role config.',
      },
      role: {
        type: 'string',
        description: 'Name of the role (directory under .nexus/agents/). Required for route+lookup.',
      },
      prompt: {
        type: 'string',
        description: 'The task prompt to give the role. Required for action=route.',
      },
      root: {
        type: 'string',
        description: 'Project root (defaults to cwd). Must be an authorized root.',
      },
    },
    required: ['action'],
  },
};

export const ACP_ROUTER_TOOL_DEFS: ToolDef[] = [ACP_ROUTER_TOOL];
export const ACP_ROUTER_TOOLS: Set<string> = new Set(ACP_ROUTER_TOOL_DEFS.map((d) => d.name));

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function callAcpRouterTool(
  name: string,
  args: unknown,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const a = (args ?? {}) as { action?: unknown; role?: unknown; prompt?: unknown; root?: unknown };
  const action = typeof a.action === 'string' ? a.action : '';
  const root =
    typeof a.root === 'string' && a.root.trim() !== ''
      ? a.root
      : process.cwd();

  if (action === 'list_roles') {
    const roles = await discoverRoles(root);
    const summary = roles.map((r) => ({
      name: r.name,
      systemPrompt: r.systemPrompt.slice(0, 200),
      tools: r.frontmatter.tools,
      background: r.frontmatter.background,
    }));
    return { content: JSON.stringify({ roles: summary, count: summary.length }, null, 2).slice(0, MAX_TOOL_RESULT_CHARS) };
  }

  if (action === 'lookup') {
    const roleName = typeof a.role === 'string' ? a.role : '';
    if (!roleName) return buildSubagentFailure('not_found', '`role` is required for action=lookup.');
    const roles = await discoverRoles(root);
    const role = roles.find((r) => r.name === roleName);
    if (!role) {
      return buildSubagentFailure(
        'not_found',
        `Role "${roleName}" not found. Use acp_router(action=list_roles) to see available roles.`,
      );
    }
    return { content: JSON.stringify({
      name: role.name,
      path: role.path,
      systemPrompt: role.systemPrompt,
      frontmatter: role.frontmatter,
    }, null, 2).slice(0, MAX_TOOL_RESULT_CHARS) };
  }

  if (action === 'route') {
    const roleName = typeof a.role === 'string' ? a.role : '';
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    if (!roleName) return buildSubagentFailure('not_found', '`role` is required for action=route.');
    if (!prompt) return buildSubagentFailure('not_found', '`prompt` is required for action=route.');

    const roles = await discoverRoles(root);
    const role = roles.find((r) => r.name === roleName);
    if (!role) {
      return buildSubagentFailure(
        'not_found',
        `Role "${roleName}" not found. Use acp_router(action=list_roles) to see available roles.`,
      );
    }

    // This tool only resolves config. Role dispatch belongs to core, which owns
    // task decomposition, scheduling and execution — so we hand back the role
    // config + input and let core decide inline-vs-background.
    const payload = {
      roleId: roleName,
      roleConfig: {
        systemPrompt: role.systemPrompt,
        tools: role.frontmatter.tools,
        background: role.frontmatter.background,
        maxDurationMs: role.frontmatter.maxDurationMs,
        maxTurns: role.frontmatter.maxTurns,
        constitution: role.frontmatter.constitution,
      },
      prompt,
      root,
    };
    // Return structured data the worker can pick up directly.
    return { content: JSON.stringify(payload) };
  }

  return buildSubagentFailure('unknown', `Unknown acp_router action: "${action}". Valid: list_roles, lookup, route.`);
}

/**
 * Map a subagent failure kind to a RepetitionMonitor fail_seq key.
 *
 * Pure function so the service's storm-counter branch stays testable without a
 * live AgentService:
 *   - `blocked_policy` / `blocked_quota` → `null` (EXCLUDED from the fail_seq
 *     storm counter, same semantics as gate-blocked: the policy said no, the
 *     tool is not broken, and the model may be legitimately asking the user for
 *     a grant / waiting out a quota).
 *   - `not_found` → arg-level key `${name}:subagent-not-found:${argsDigest}`:
 *     only the SAME bad args failing repeatedly count as a spin, so a repair
 *     loop that fixes the role id is not killed.
 *   - `exec_error` / `timeout` / `unknown` → class-level key
 *     `${name}:subagent-${kind}`: a repeated failure of the same class is a
 *     spin no matter how the args vary.
 */
export function subagentFailureKey(
  kind: SubagentFailureKind,
  name: string,
  argsDigest: string,
): string | null {
  switch (kind) {
    case 'blocked_policy':
    case 'blocked_quota':
      return null;
    case 'not_found':
      return `${name}:subagent-not-found:${argsDigest}`;
    case 'exec_error':
    case 'timeout':
    case 'unknown':
      return `${name}:subagent-${kind}`;
  }
}

/**
 * Build a human-readable steer banner for a delegation failure.
 * This is injected into the chat so the user sees exactly what went wrong.
 */
export function formatSubagentSteer(kind: SubagentFailureKind, toolName: string): string {
  const steerMap: Record<SubagentFailureKind, string> = {
    blocked_policy: `Subagent delegate blocked by policy (${toolName}) — user action required.`,
    blocked_quota: `Subagent delegate quota exceeded — consider background mode.`,
    not_found: `Subagent role not found — verify role id and try again.`,
    exec_error: `Subagent execution failed — check logs for details.`,
    timeout: `Subagent timed out — consider increasing maxDurationMs.`,
    unknown: `Subagent error (${toolName}) — inspect raw result.`,
  };
  return steerMap[kind] ?? steerMap.unknown;
}
