import { HookContext, HookResult } from './types.js';
import { ToolDefinition } from '../types.js';

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

/** Tools that require user-specific input params — guard against LLM guessing defaults */
const PARAM_GUARD_TOOLS = new Map<string, string>([
  // query-tickets from mcp-server-12306: must ask user for stations and date
  ['query-tickets', '查询火车票需要用户提供：出发站、到达站、日期。请先询问用户。'],
  ['query_tickets', '查询火车票需要用户提供：出发站、到达站、日期。请先询问用户。'],
  ['maps_weather', '查询天气需要用户提供：城市名称。请先询问用户具体城市。'],
  ['weather', '查询天气需要用户提供：城市名称。请先询问用户具体城市。'],
]);

function checkMissingRequiredParams(ctx: HookContext): string | null {
  if (!ctx.toolCall || !ctx.toolDefinitions) return null;

  const toolDef = ctx.toolDefinitions.find(t => t.name === ctx.toolCall!.name);
  if (!toolDef) return null;

  const schema = toolDef.inputSchema as Record<string, unknown> | undefined;
  if (!schema || typeof schema !== 'object') return null;

  const required = (schema as { required?: string[] }).required;
  if (!required || required.length === 0) return null;

  const args = ctx.toolCall.arguments || {};
  const missing = required.filter(r => {
    const val = args[r];
    return val === undefined || val === null || val === '';
  });

  if (missing.length === 0) return null;

  return `参数不完整，缺少必需参数：${missing.join('、')}。请先向用户询问这些信息，不要自行猜测。`;
}

export function createSanityCheckHook(userInput: string) {
  const isTimeSensitive = TIME_PATTERNS.some(p => p.test(userInput));

  return async function sanityCheck(ctx: HookContext): Promise<HookResult> {
    if (!ctx.toolCall) return 'allow';

    const toolName = ctx.toolCall.name;

    // 1. Time-sensitive query guard (Phase 2 feature)
    if (isTimeSensitive && LOCAL_TOOLS.has(toolName)) {
      return { verdict: 'deny', reason: `查询需要实时数据，但工具"${toolName}"只能搜索本地数据。` };
    }

    // 2. Parameter validation: check required params from tool schema
    const missingReason = checkMissingRequiredParams(ctx);
    if (missingReason) {
      return { verdict: 'deny', reason: missingReason };
    }

    // 3. Hardcoded param guards for common tools where LLM tends to guess
    const guard = PARAM_GUARD_TOOLS.get(toolName);
    if (guard) {
      return { verdict: 'deny', reason: guard };
    }

    return 'allow';
  };
}
