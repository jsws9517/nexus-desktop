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

const REMOTE_TOOLS = new Set([
  'web_search', 'web_fetch', 'search_web', 'fetch_url', 'get_current_time',
]);

export function createSanityCheckHook(userInput: string) {
  const isTimeSensitive = TIME_PATTERNS.some(p => p.test(userInput));

  return async function sanityCheck(ctx: HookContext): Promise<HookResult> {
    if (!isTimeSensitive || !ctx.toolCall) return 'allow';

    const toolName = ctx.toolCall.name;

    if (LOCAL_TOOLS.has(toolName)) {
      console.error(`\n[Guard] Tool "${toolName}" blocked: query appears time-sensitive but tool only searches local data.\n`);
      return 'deny';
    }

    return 'allow';
  };
}
