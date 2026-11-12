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
import { AGENTS_TOOLS, AGENTS_TOOL_DEFS, callAgentsTool } from './agents.js';
import { ACP_ROUTER_TOOLS, ACP_ROUTER_TOOL_DEFS, callAcpRouterTool } from './acp-router.js';
import { createSkillsDisclosureRegistry, SKILLS_DISCLOSURE_TOOLS } from './skills-disclosure.js';
import { createRefreshToolsRegistry, REFRESH_TOOLS } from './refresh-tools.js';
import { ATTACHMENT_RAG_TOOL_DEFS, ATTACHMENT_RAG_TOOLS, callAttachmentRagTool } from './attachment-rag.js';
import { applyRouting } from './routing.js';
import { SKILL_REGISTRIES } from '../skills/index.js';

export type { ToolDef, ToolResult, ToolContext, ToolRegistry, SkillHost } from './types.js';
export { registryNames, registryDefs } from './types.js';
export { FILESYSTEM_TOOLS, FILESYSTEM_TOOL_DEFS, callFsTool } from './filesystem.js';
export { SEQUENTIAL_THINK_TOOLS, SEQUENTIAL_THINK_TOOL_DEFS, callSequentialThinkTool } from './sequential-think.js';
export { SQLITE_TOOLS, SQLITE_TOOL_DEFS, callSqliteTool, closeSqliteDbs } from './sqlite.js';
export { AGENTS_TOOLS, AGENTS_TOOL_DEFS, callAgentsTool } from './agents.js';
export { ACP_ROUTER_TOOLS, ACP_ROUTER_TOOL_DEFS, callAcpRouterTool } from './acp-router.js';
export { SKILL_REGISTRIES } from '../skills/index.js';
export { SHEET_TOOLS, SHEET_TOOL_DEFS, callSheetTool } from '../skills/sheet.js';
export { CHART_TOOLS, CHART_TOOL_DEFS, callChartTool } from '../skills/chart.js';
export { ATTACHMENT_RAG_TOOLS, ATTACHMENT_RAG_TOOL_DEFS, callAttachmentRagTool } from './attachment-rag.js';
export { skillHostFromAgent, skillToolNames } from './skills-disclosure.js';
export { ToolRefreshQueue, refreshToolsResult } from './refresh-tools.js';
export { selectTools, ESSENTIAL_TOOLS, mergeCoreAgentTools } from './tool-relevance.js';
export { TOOL_ROUTING, applyRouting } from './routing.js';

/**
 * Every in-process tool family served by the worker — utility tools first, then
 * the artifact-producing office skills, then the two self-management families
 * that let the model widen its own toolset.
 */
export const TOOL_REGISTRIES: ToolRegistry[] = [
  { id: 'filesystem', defs: FILESYSTEM_TOOL_DEFS, call: callFsTool },
  { id: 'sequential-thinking', defs: SEQUENTIAL_THINK_TOOL_DEFS, call: callSequentialThinkTool },
  { id: 'sqlite', defs: SQLITE_TOOL_DEFS, call: callSqliteTool },
  { id: 'agents', defs: AGENTS_TOOL_DEFS, call: callAgentsTool },
  { id: 'acp-router', defs: ACP_ROUTER_TOOL_DEFS, call: callAcpRouterTool },
  { id: 'attachment-rag', defs: ATTACHMENT_RAG_TOOL_DEFS, call: callAttachmentRagTool },
  ...SKILL_REGISTRIES,
  createSkillsDisclosureRegistry(),
  createRefreshToolsRegistry(),
];

/** Flat name set across all registries — used to shadow same-named MCP tools. */
export const INTERNAL_TOOLS: Set<string> = registryNames(TOOL_REGISTRIES);

/**
 * Flat def list across all registries — appended to the worker tool list.
 * Routing metadata is filled in here so every consumer (and the relevance
 * selector) sees one uniform shape.
 */
export const ALL_TOOL_DEFS: ToolDef[] = applyRouting(registryDefs(TOOL_REGISTRIES));

/** Names of the progressive-disclosure + self-management families. */
export const DISCLOSURE_TOOLS: ReadonlySet<string> = new Set([
  ...SKILLS_DISCLOSURE_TOOLS,
  ...REFRESH_TOOLS,
]);

/**
 * Alias table for tool names LLMs habitually "normalize" wrongly: dotted tool
 * names get written with underscores (`docx_write` instead of `docx.write`,
 * `sheet_read` instead of `sheet.read`). Both dispatch entry points
 * (`callBuiltinTool` and the service MCP proxy) resolve these so a near-miss
 * call keeps working instead of falling through to "tool not found" and
 * escalating into a heavyweight sub-agent spawn. Derived from the registry
 * itself, so a new dotted tool family is covered automatically.
 */
export const BUILTIN_TOOL_ALIASES: Record<string, string> = (() => {
  const aliases: Record<string, string> = {};
  for (const def of ALL_TOOL_DEFS) {
    if (def.name.includes('.')) aliases[def.name.replace(/\./g, '_')] = def.name;
  }
  return aliases;
})();

/** Route a name to the owning registry, or a not-found error when unknown. */
export async function callBuiltinTool(name: string, args: unknown, ctx?: ToolContext): Promise<ToolResult> {
  // Near-miss name recovery: `docx_write` → `docx.write`.
  const target = BUILTIN_TOOL_ALIASES[name] ?? name;
  for (const r of TOOL_REGISTRIES) {
    if (r.defs.some((d) => d.name === target)) {
      return await r.call(target, args, ctx);
    }
  }
  if (target !== name) {
    return { content: `Tool "${name}" not found (its alias "${target}" is not registered).`, isError: true };
  }
  return { content: `Tool "${name}" not found`, isError: true };
}