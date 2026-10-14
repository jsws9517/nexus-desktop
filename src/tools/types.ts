/**
 * Unified contract for all in-process (non-MCP) tools served by the worker.
 *
 * Before this module, each tool family (filesystem / sequential-thinking /
 * sqlite) declared its own `*Result` / `*Context` / `McpToolDef` trio with
 * slightly different shapes. Standardizing them here gives P2 (sub-agent
 * tool composition) a single registry to consume.
 */

import type { ToolRefreshQueue } from './refresh-tools.js';

/**
 * Coarse routing bucket. The relevance selector (src/tools/tool-relevance.ts)
 * scores per-tool, but reads `group` to keep a whole family alive when any
 * member looks relevant, and to honour plan mode / role allowlists.
 */
export type ToolGroup =
  | 'fs'
  | 'exec'
  | 'git'
  | 'db'
  | 'web'
  | 'media'
  | 'data'
  | 'memory'
  | 'task'
  | 'agents'
  | 'acp'
  | 'meta';

/** MCP-style behavioural hints. Only `sequentialthinking` declared these so far. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool definition surfaced to the LLM (also carries the owning server tag). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server?: string;
  /** Routing bucket for the relevance selector. Absent = treated as 'meta'. */
  group?: ToolGroup;
  /**
   * Author-supplied trigger terms, any language, matched case-insensitively as
   * substrings of the user input. This is the only language-neutral signal the
   * selector has: the core's own filter compares raw input against the English
   * description, which structurally cannot match a CJK prompt.
   */
  keywords?: string[];
  /** Pure read; never mutates project or session state. */
  readOnly?: boolean;
  annotations?: ToolAnnotations;
}

/** Result of a tool invocation; `content` is verbatim JSON or Markdown. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** Runtime context passed to a tool call (worker-side bindings). */
export interface ToolContext {
  /** Reads the live config (~/.nexus/config.json view); shape is duck-typed. */
  getConfig?: () => Record<string, unknown> | undefined;
  /** Ask approval for a write operation. Returns true when allowed. */
  requestWriteApproval?: (label: string) => Promise<boolean>;
  /**
   * Bridge to the core's skill registry, for the progressive-disclosure tools.
   * Supplied by AgentService, which owns the live Agent — the registry is
   * per-agent so it cannot live in a module-level singleton.
   */
  skills?: SkillHost;
  /** Queue backing `refresh_tools`, so the selector can widen the next round. */
  toolRefresh?: ToolRefreshQueue;
  /**
   * Read the CURRENT session's one-time RAG attachment store. Supplied by
   * AgentService (which owns the live session). `search` returns ranked
   * passages, `outline` the file's chunk map, `chunk` whole chunks verbatim.
   */
  attachmentsSearch?: (req: AttachmentSearchRequest) => ToolResult;
}

/** Request shape accepted by the `attachments_search` tool callable. */
export type AttachmentSearchRequest =
  | { kind: 'search'; query: string; topK: number }
  | { kind: 'outline'; file?: string }
  | { kind: 'chunk'; chunk: number; count: number; file?: string };

/**
 * The slice of the core's SkillRegistry that the disclosure tools need. Kept
 * structural so this module does not depend on the core's skill types.
 */
export interface SkillHost {
  listSkills(): Array<{
    name: string;
    description?: string;
    rootDir?: string;
    source?: 'skills' | 'plugins' | 'claude';
    steps?: Array<{ name: string; done: string }>;
  }>;
  invokeSkill(name: string, task: string): Promise<ToolResult>;
}

/** A self-contained tool family: its defs, its callable entry, and name set. */
export interface ToolRegistry {
  /** e.g. 'filesystem' | 'sequential-thinking' | 'sqlite' */
  id: string;
  defs: ToolDef[];
  call: (name: string, args: unknown, ctx?: ToolContext) => Promise<ToolResult> | ToolResult;
}

/** Flattened name set across every registry (used to shadow same-named MCP tools). */
export function registryNames(registries: ToolRegistry[]): Set<string> {
  return new Set(registries.flatMap((r) => r.defs.map((d) => d.name)));
}

/** Flattened defs across every registry (appended to the worker tool list). */
export function registryDefs(registries: ToolRegistry[]): ToolDef[] {
  return registries.flatMap((r) => r.defs);
}