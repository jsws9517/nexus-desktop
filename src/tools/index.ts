/**
 * Unified in-process tool registry.
 *
 * Every worker-side (non-MCP) tool family — filesystem, sequential-thinking,
 * sqlite — registers here with a common contract (ToolDef / ToolResult /
 * ToolContext). Consumers (agent-service proxy, and later P2 sub-agents)
 * iterate `TOOL_REGISTRIES` instead of hand-maintaining parallel sets.
 */

import type { ToolDef, ToolResult, ToolContext, ToolRegistry } from './types.js';
import { registryNames, registryDefs } from './types.js';
import { FILESYSTEM_TOOLS, FILESYSTEM_TOOL_DEFS, callFsTool } from './filesystem.js';
import { SEQUENTIAL_THINK_TOOLS, SEQUENTIAL_THINK_TOOL_DEFS, callSequentialThinkTool } from './sequential-think.js';
import { SQLITE_TOOLS, SQLITE_TOOL_DEFS, callSqliteTool, closeSqliteDbs } from './sqlite.js';

export type { ToolDef, ToolResult, ToolContext, ToolRegistry };
export { registryNames, registryDefs };
export { FILESYSTEM_TOOLS, FILESYSTEM_TOOL_DEFS, callFsTool } from './filesystem.js';
export { SEQUENTIAL_THINK_TOOLS, SEQUENTIAL_THINK_TOOL_DEFS, callSequentialThinkTool } from './sequential-think.js';
export { SQLITE_TOOLS, SQLITE_TOOL_DEFS, callSqliteTool, closeSqliteDbs } from './sqlite.js';

/** Every in-process tool family served by the worker. */
export const TOOL_REGISTRIES: ToolRegistry[] = [
  { id: 'filesystem', defs: FILESYSTEM_TOOL_DEFS, call: callFsTool },
  { id: 'sequential-thinking', defs: SEQUENTIAL_THINK_TOOL_DEFS, call: callSequentialThinkTool },
  { id: 'sqlite', defs: SQLITE_TOOL_DEFS, call: callSqliteTool },
];

/** Flat name set across all registries — used to shadow same-named MCP tools. */
export const INTERNAL_TOOLS: Set<string> = registryNames(TOOL_REGISTRIES);

/** Flat def list across all registries — appended to the worker tool list. */
export const ALL_TOOL_DEFS: ToolDef[] = registryDefs(TOOL_REGISTRIES);

/** Route a name to the owning registry, or a not-found error when unknown. */
export async function callBuiltinTool(name: string, args: unknown, ctx?: ToolContext): Promise<ToolResult> {
  for (const r of TOOL_REGISTRIES) {
    if (r.defs.some((d) => d.name === name)) {
      return await r.call(name, args, ctx);
    }
  }
  return { content: `Tool "${name}" not found`, isError: true };
}