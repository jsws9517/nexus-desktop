/**
 * Unified contract for all in-process (non-MCP) tools served by the worker.
 *
 * Before this module, each tool family (filesystem / sequential-thinking /
 * sqlite) declared its own `*Result` / `*Context` / `McpToolDef` trio with
 * slightly different shapes. Standardizing them here gives P2 (sub-agent
 * tool composition) a single registry to consume.
 */

/** A tool definition surfaced to the LLM (also carries the owning server tag). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server?: string;
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