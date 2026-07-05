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
 * Known tool parameter patterns (fallback when MCP schema lacks `required`).
 * key = tool name, value = { paramCandidates[], message }
 * `paramCandidates` = alternative param names any of which counts as "provided"
 */
const KNOWN_TOOL_PARAMS: Record<string, { candidates: string[][]; message: string }> = {
  'query-tickets': {
    candidates: [
      ['from', 'from_station'],
      ['to', 'to_station'],
      ['date', 'train_date'],
    ],
    message: '查询火车票缺少必要信息，请提供：出发站、到达站和日期（格式 YYYY-MM-DD）。不要自行猜测。',
  },
  'maps_weather': {
    candidates: [
      ['city', 'location', 'city_name'],
    ],
    message: '查询天气需要城市名称，请询问用户具体城市。',
  },
};

/** Check args against schema-declared required fields */
function checkSchemaRequired(ctx: HookContext): string | null {
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

  return `参数不完整，缺少必需参数：${missing.join('、')}。请先向用户询问，不要自行猜测。`;
}

/** Check args against known tool param patterns (when schema has no `required`) */
function checkKnownToolParams(ctx: HookContext): string | null {
  if (!ctx.toolCall) return null;
  const toolName = ctx.toolCall.name;

  // Skip if this tool already has schema-declared required fields that are all present
  const schemaMissing = checkSchemaRequired(ctx);
  if (schemaMissing === null) return null; // all schema-required params are present → allow

  const known = KNOWN_TOOL_PARAMS[toolName];
  if (!known) return null;

  const args = ctx.toolCall.arguments || {};

  // For each param group, ensure at least one candidate is present
  const missingGroups: string[] = [];
  for (const group of known.candidates) {
    const anyPresent = group.some(p => {
      const val = args[p];
      return val !== undefined && val !== null && val !== '';
    });
    if (!anyPresent) {
      missingGroups.push(group.join('/'));
    }
  }

  if (missingGroups.length === 0) return null; // all groups have at least one value

  return `缺少必要参数（${missingGroups.join('、')}）。${known.message}`;
}

export function createSanityCheckHook(userInput: string) {
  const isTimeSensitive = TIME_PATTERNS.some(p => p.test(userInput));

  return async function sanityCheck(ctx: HookContext): Promise<HookResult> {
    if (!ctx.toolCall) return 'allow';

    const toolName = ctx.toolCall.name;

    // 1. Time-sensitive query guard
    if (isTimeSensitive && LOCAL_TOOLS.has(toolName)) {
      return { verdict: 'deny', reason: `查询需要实时数据，但工具"${toolName}"只能搜索本地数据。` };
    }

    // 2. Check schema-declared required params (if schema has `required` and any are missing)
    const schemaReason = checkSchemaRequired(ctx);
    if (schemaReason) {
      return { verdict: 'deny', reason: schemaReason };
    }

    // 3. Fallback: known-tool param validation (when schema lacks `required`)
    const knownReason = checkKnownToolParams(ctx);
    if (knownReason) {
      return { verdict: 'deny', reason: knownReason };
    }

    return 'allow';
  };
}
