import { HookContext, HookResult } from './types.js';

const TIME_PATTERNS = [
  /历史/i, /历史上的今天/i, /today in history/i, /historical event/i,
  /今年/i, /去年/i, /新闻/i, /news/i, /current event/i,
  /天气/i, /weather/i, /时间/i, /time/i, /日期/i, /date/i,
];

const LOCAL_TOOLS = new Set([
  'search_nodes', 'search_files', 'search_entities', 'search_relations',
  'knowledge_search', 'local_search',
]);

/**
 * Sanity check guard — ONLY blocks when a tool is fundamentally incapable of answering the query.
 * Does NOT validate parameters; LLM handles parameter negotiation with the user naturally.
 */
export function createSanityCheckHook(userInput: string) {
  const isTimeSensitive = TIME_PATTERNS.some(p => p.test(userInput));

  return async function sanityCheck(ctx: HookContext): Promise<HookResult> {
    if (!ctx.toolCall) return 'allow';
    if (!isTimeSensitive) return 'allow';

    const toolName = ctx.toolCall.name;

    // Only block local-search tools when the query clearly needs real-time data
    if (LOCAL_TOOLS.has(toolName)) {
      return { verdict: 'deny', reason: `当前查询需要实时数据，但工具"${toolName}"只能搜索本地数据。` };
    }

    return 'allow';
  };
}
