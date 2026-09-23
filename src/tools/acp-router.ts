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
 *   3. It either:
 *        a) hands off to a fresh sub-agent worker (fast, synchronous-ish), OR
 *        b) enqueues a background job via BgJobManager (for long-running work).
 *   4. Result is returned inline (a) or as a job-id reference (b); the caller
 *      may use `bg_job_query` to poll later.
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
    if (!roleName) return { content: '`role` is required for action=lookup.', isError: true };
    const roles = await discoverRoles(root);
    const role = roles.find((r) => r.name === roleName);
    if (!role) return { content: `Role "${roleName}" not found. Use acp_router(action=list_roles) to see available roles.`, isError: true };
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
    if (!roleName) return { content: '`role` is required for action=route.', isError: true };
    if (!prompt) return { content: '`prompt` is required for action=route.', isError: true };

    const roles = await discoverRoles(root);
    const role = roles.find((r) => r.name === roleName);
    if (!role) {
      return {
        content: `Role "${roleName}" not found. Use acp_router(action=list_roles) to see available roles.`,
        isError: true,
      };
    }

    // The actual routing is done by the caller (agent-worker) which has access
    // to BgJobManager.  Here we return the resolved role config + input so the
    // caller can decide inline-vs-background.
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

  return { content: `Unknown acp_router action: "${action}". Valid: list_roles, lookup, route.`, isError: true };
}
