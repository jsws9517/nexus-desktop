import type { AgentService } from '../service.js';
import type { SubTask } from './types.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from './tool-categories.js';
import { logger } from '../../shared/logger.js';
import { detectLanguage, type PromptLang } from '../../shared/lang-detect.js';

/**
 * Context-aware task decomposition using LLM with semantic analysis.
 */
export class TaskDecomposer {
  constructor(private agentService: AgentService) {}

  /**
   * Decompose user request into parallel sub-tasks with semantic analysis.
   */
  async decompose(
    userPrompt: string,
    context?: {
      previousResults?: Map<string, string>;
      availableTools?: string[];
      language?: PromptLang;
    }
  ): Promise<SubTask[]> {
    const lang = context?.language ?? detectLanguage(userPrompt);
    const systemPrompt = this.buildDecompositionPrompt(context, lang);
    
    try {
      const response = await this.agentService.callLlm({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: 'decomposer',
      });
      
      const parsed = this.parseDecompositionResponse(response);
      return this.validateAndFilterTasks(parsed);
    } catch (error) {
      logger.warn(`LLM decomposition failed: ${error}. Using fallback.`);
      return this.fallbackDecomposition(userPrompt);
    }
  }

  /**
   * Build the system prompt for decomposition with semantic analysis.
   */
  private buildDecompositionPrompt(context?: {
    previousResults?: Map<string, string>;
    availableTools?: string[];
    language?: PromptLang;
  }, lang: PromptLang = 'en'): string {
    const toolsList = context?.availableTools?.join(', ') || 'read_media_file, list_directory_with_sizes, query';

    const isZh = lang === 'zh-CN';

    const languageHeader = isZh
      ? `你是一个精通语义分析的中文任务拆解专家。用户输入语言为：**中文**。`
      : `You are an expert task decomposition agent with deep semantic understanding. User input language: **English**.`;

    const descRules = isZh
      ? `## 描述撰写规则（重要！）
- **语言匹配**：description 必须与用户输入语言一致（中文输入→中文 description，英文输入→英文 description）
- **禁止复读机**：description 不能照抄用户原话，必须用自己的话提炼
- **通俗易懂**：用普通人能理解的语言，避免技术术语
- **简洁明了**：控制在 10–20 个字/词，一句话说清楚任务目标
- **突出动作**：以动词开头`
      : `## Description Writing Rules
- **Language match**: description must match the user's input language
- **No copy-paste**: rewrite in your own words, never mirror the user's exact phrasing
- **Plain language**: avoid jargon; anyone should understand it
- **Concise**: 10–20 words max, one clear sentence per task
- **Action-first**: start with a verb`;

    return `${languageHeader}
Your job is to break down complex user requests into independent sub-tasks that can be executed in parallel.

## Semantic Analysis Rules

1. **Identify Action Verbs**: Find all action verbs (analyze/分析, compare/对比, read/读取, generate/生成, etc.) and group related actions
2. **Detect Object Relationships**: Identify what each action operates on (files, data, concepts)
3. **Find Conjunction Chains**: Parse "A and B and C" / "A和B和C" patterns to extract individual tasks
4. **Understand Implicit Tasks**: Infer unstated but necessary sub-tasks
5. **Detect Dependency Patterns**: Recognize when one task's output is another's input

## Decomposition Rules

1. **Independence**: Each sub-task must be self-contained and not depend on results from other sub-tasks (unless explicitly sequential)
2. **Completeness**: The combined results of all sub-tasks must fully address the user's request
3. **Efficiency**: Maximize parallelism — only create dependencies when absolutely necessary
4. **Tool Assignment**: Assign appropriate tools to each sub-task based on what it needs to do
5. **Semantic Grouping**: Group semantically related actions into single tasks when they share context

## Available Tools
${toolsList}

## Output Format
Return a JSON array of sub-tasks:
[
  {
    "id": "task_1",
    "description": "Brief task summary (10-20 words, rewritten in your own words, NOT copied from user)",
    "prompt": "Detailed instructions for the sub-agent to complete this task",
    "tools": ["tool1", "tool2"],
    "dependsOn": [],
    "priority": "high|medium|low",
    "semanticGroup": "group_name"
  }
]

${descRules}

## Semantic Grouping
Tasks that share the same semantic context should be in the same group if they can share intermediate results.

## Important Notes
- If the request is simple or has only one action, return a single task
- When in doubt about dependencies, create sequential dependencies to be safe
- Always validate that the decomposition covers the entire user request
`;
  }

  /**
   * Parse the LLM response into structured tasks.
   */
  private parseDecompositionResponse(response: string): SubTask[] {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    if (!Array.isArray(parsed)) {
      throw new Error('Response is not an array');
    }
    
    return parsed;
  }

  /**
   * Validate and filter tasks to ensure they use valid tools.
   */
  private validateAndFilterTasks(tasks: any[]): SubTask[] {
    return tasks
      .filter(task => task.id && task.prompt)
      .map((task, index) => ({
        id: task.id || `task_${index + 1}`,
        description: task.description || `Sub-task ${index + 1}`,
        prompt: task.prompt,
        tools: this.filterValidTools(task.tools),
        timeoutMs: task.timeoutMs || 60000,
        maxTurns: task.maxTurns || 10,
        dependsOn: task.dependsOn || [],
      }));
  }

  /**
   * Filter tools to only include valid, available tools.
   */
  private filterValidTools(tools?: string[]): string[] {
    if (!tools || !Array.isArray(tools)) {
      return Array.from(READ_ONLY_TOOLS).slice(0, 5); // Default to first 5 read-only tools
    }
    
    return tools.filter(t => READ_ONLY_TOOLS.has(t) || WRITE_TOOLS.has(t));
  }

  /**
   * Fallback decomposition when LLM fails.
   * Uses heuristic-based splitting with semantic awareness to avoid
   * splitting on conjunctions that connect related nouns in a single task.
   */
  private fallbackDecomposition(userPrompt: string): SubTask[] {
    // Purely declarative: has conjunctions but no action verb → no decomposition needed
    const actionVerbs = '分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释|解决|修复|实现|开发|写|画|设计';
    const hasConjunction = /(?:和|与|以及|、|&|and)/i.test(userPrompt);
    const hasVerb = new RegExp(`\\b(${actionVerbs})\\b`, 'i').test(userPrompt);
    if (hasConjunction && !hasVerb) {
      return [];
    }
    // Only split on conjunctions that separate full clauses/commands,
    // not those connecting paired nouns within a single action.
    // Pattern: look for verb + object ... CONJ ... verb + object structure.
    const conjunctions = '和|与|以及|、|，|,|＆|&| and | et | y | и | أو';

    // Heuristic: detect if prompt has multiple independent clause patterns
    // e.g. "分析A和B" -> single task; "读取A和生成B" -> two tasks
    const hasMultiClause = /\b(分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释)\b.*${conjunctions}.*\b(分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释)\b/i.test(userPrompt);

    if (!hasMultiClause) {
      // Single coherent task — do NOT split
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: userPrompt,
        tools: Array.from(READ_ONLY_TOOLS).slice(0, 5),
        timeoutMs: 60000,
        maxTurns: 10,
        dependsOn: [],
      }];
    }

    // Split on sentence-level separators: period, semicolon, or conjunction
    // that follows a complete clause boundary
    const sentenceBoundary = /(?:[。；；\.]|(?<=\S)\s*(?:和|与|以及|&|and)\s*(?=\S))/gu;
    const parts = userPrompt
      .split(sentenceBoundary)
      .map(p => p.trim())
      .filter(p => p.length > 8); // Require meaningful length

    if (parts.length <= 1) {
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: userPrompt,
        tools: Array.from(READ_ONLY_TOOLS).slice(0, 5),
        timeoutMs: 60000,
        maxTurns: 10,
        dependsOn: [],
      }];
    }

    return parts.map((part, index) => ({
      id: `task_${index + 1}`,
      description: this.generateTaskDescription(part, index + 1),
      prompt: part,
      tools: Array.from(READ_ONLY_TOOLS).slice(0, 5),
      timeoutMs: 60000,
      maxTurns: 10,
      dependsOn: [],
    }));
  }

  /**
   * Generate a meaningful description for a sub-task.
   */
  private generateTaskDescription(part: string, index: number): string {
    const lowerPart = part.toLowerCase();
    
    // Common action patterns
    if (lowerPart.includes('分析') || lowerPart.includes('analyze')) {
      return `Analyze: ${part.substring(0, 40)}...`;
    }
    if (lowerPart.includes('比较') || lowerPart.includes('compare')) {
      return `Compare: ${part.substring(0, 40)}...`;
    }
    if (lowerPart.includes('读取') || lowerPart.includes('read')) {
      return `Read: ${part.substring(0, 40)}...`;
    }
    if (lowerPart.includes('生成') || lowerPart.includes('generate')) {
      return `Generate: ${part.substring(0, 40)}...`;
    }
    if (lowerPart.includes('处理') || lowerPart.includes('process')) {
      return `Process: ${part.substring(0, 40)}...`;
    }
    
    // Default: use the first 50 chars as description
    const truncated = part.length > 50 ? part.substring(0, 50) + '...' : part;
    return `Task ${index}: ${truncated}`;
  }
}
