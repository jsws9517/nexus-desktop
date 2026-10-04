/**
 * `refresh_tools` — the escape hatch for the relevance selector.
 *
 * The selector (src/tools/tool-relevance.ts) can only guess what a round needs,
 * and a wrong guess hides a tool the model has no other way to ask for. That is
 * the exact failure mode that made `spawn_subagent` unusable, so the model gets
 * an explicit way to widen its own toolset rather than being at the mercy of the
 * scorer.
 *
 * Effect: the core re-enters `runLlmTurn` after every batch of tool results and
 * rebuilds the tool list each time (nexus-coder/src/agent.ts). So a request
 * recorded here lands on the very next round — no turn is wasted, and the caller
 * gets the widened list back immediately so it can act without guessing.
 */

import type { ToolDef, ToolRegistry, ToolResult } from './types.js';

const REFRESH_TOOLS_TOOL: ToolDef = {
  name: 'refresh_tools',
  server: 'meta-internal',
  group: 'meta',
  readOnly: true,
  keywords: ['tool', 'tools', '工具', '工具列表', 'refresh tools', 'switch tool'],
  description:
    'Re-select the available tools for this task and return the widened list. Call this when you need a ' +
    'capability that is not in your current tool list — the current list is chosen automatically and may ' +
    'have omitted something you need. Pass the capability you need in natural language.',
  inputSchema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'The capability you need, in plain language (e.g. "read a spreadsheet", "查天气").',
      },
    },
    required: ['intent'],
  },
};

export const REFRESH_TOOLS_DEF: ToolDef = REFRESH_TOOLS_TOOL;
export const REFRESH_TOOLS: Set<string> = new Set([REFRESH_TOOLS_TOOL.name]);

/** A pending widening request, consumed by the selector on the next round. */
export interface PendingRefresh {
  intent: string;
  /** Tools the last refresh surfaced, so the caller can be told what appeared. */
  surfaced: string[];
}

/**
 * Bounded so a model cannot grow the force-set without limit across a long turn.
 */
const MAX_PENDING_INTENTS = 4;

export class ToolRefreshQueue {
  private intents: string[] = [];

  /** Record a widening request. Returns the queue depth, for the tool result. */
  push(intent: string): number {
    const trimmed = intent.trim();
    if (!trimmed) return this.intents.length;
    if (this.intents.length >= MAX_PENDING_INTENTS) this.intents.shift();
    this.intents.push(trimmed);
    return this.intents.length;
  }

  /** Snapshot for the selector; does not clear. */
  peek(): string[] {
    return this.intents.slice();
  }

  /** Clear after the selector has consumed them for a round. */
  clear(): void {
    this.intents = [];
  }
}

/** Build the tool result for a `refresh_tools` call. */
export function refreshToolsResult(queue: ToolRefreshQueue, intent: string): ToolResult {
  const trimmed = intent.trim();
  if (!trimmed) {
    return { content: 'refresh_tools needs a non-empty intent.', isError: true };
  }
  const depth = queue.push(trimmed);
  return {
    content:
      `Recorded: "${trimmed}". Your tool list will be re-selected for this on the next step ` +
      `(${depth} pending request${depth === 1 ? '' : 's'}). If the capability you need still is not ` +
      `present after the next tool list arrives, call refresh_tools again with more specific wording.`,
  };
}

/**
 * Registry entry. The queue is per-agent and arrives on the ToolContext the
 * service builds, so this stays a module-level constant like every other family.
 */
export function createRefreshToolsRegistry(): ToolRegistry {
  return {
    id: 'refresh-tools',
    defs: [REFRESH_TOOLS_DEF],
    call: (name, args, ctx): ToolResult => {
      const queue = ctx?.toolRefresh;
      if (!queue) {
        return {
          content: 'refresh_tools is unavailable in this session (no tool-refresh queue attached).',
          isError: true,
        };
      }
      const intent = String((args as Record<string, unknown> | undefined)?.intent ?? '');
      return refreshToolsResult(queue, intent);
    },
  };
}