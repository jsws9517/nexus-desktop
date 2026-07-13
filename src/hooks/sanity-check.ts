import { HookContext, HookResult } from './types.js';
import { t, tf } from '../i18n/index.js';

const TIME_PATTERNS = [
  /history/i, /today in history/i, /historical event/i,
  /news/i, /current event/i,
  /weather/i, /time/i, /date/i,
  /历史/i, /历史上的今天/i, /今年/i, /去年/i, /新闻/i, /天气/i, /时间/i, /日期/i,
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
      return { verdict: 'deny', reason: tf('sanity_check')(toolName) };
    }

    return 'allow';
  };
}
