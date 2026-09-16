import type { AgentService } from '../service.js';
import type { SubTask } from './types.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from './tool-categories.js';
import { logger } from '../../shared/logger.js';

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
      language?: string;
    }
  ): Promise<SubTask[]> {
    const systemPrompt = this.buildDecompositionPrompt(context);
    
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
    language?: string;
  }): string {
    const toolsList = context?.availableTools?.join(', ') || 'read_media_file, list_directory_with_sizes, query';
    const lang = context?.language || 'auto';
    
    return `You are an expert task decomposition agent with deep semantic understanding.
Your job is to break down complex user requests into independent sub-tasks that can be executed in parallel.

## Semantic Analysis Rules

1. **Identify Action Verbs**: Find all action verbs (analyze, compare, read, generate, etc.) and group related actions
2. **Detect Object Relationships**: Identify what each action operates on (files, data, concepts)
3. **Find Conjunction Chains**: Parse "A and B and C" patterns to extract individual tasks
4. **Understand Implicit Tasks**: Infer unstated but necessary sub-tasks (e.g., "compare A and B" implies reading both A and B first)
5. **Detect Dependency Patterns**: Recognize when one task's output is another's input

## Decomposition Rules

1. **Independence**: Each sub-task must be self-contained and not depend on results from other sub-tasks (unless explicitly sequential)
2. **Completeness**: The combined results of all sub-tasks must fully address the user's request
3. **Efficiency**: Maximize parallelism - only create dependencies when absolutely necessary
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

## Description Writing Rules (重要！)
- **语言匹配**：description语言必须与用户输入语言一致
  - 用户用中文提问 → description用中文
  - 用户用英文提问 → description用英文
  - 混合语言 → 主要内容用哪种语言，description就用哪种
- **禁止复读机**：description不能照抄用户原话，必须用自己的话提炼
- **通俗易懂**：用普通人能理解的语言，避免技术术语
- **简洁明了**：控制在10-20个字/词，一句话说清楚任务目标
- **突出动作**：以动词开头

**中文示例**：
- 用户："分析report.xlsx的销售数据" → ✅ "提取表格中的销售指标"
- 用户："对比A和B两个文件" → ✅ "对比两份文件的差异"

**英文示例**：
- User: "Analyze report.xlsx sales data" → ✅ "Extract key metrics from spreadsheet"
- User: "Compare files A and B" → ✅ "Compare differences between two files"

## Semantic Grouping
Tasks that share the same semantic context (e.g., "analyze sales data" and "compare with last quarter") should be in the same group if they can share intermediate results.

## Examples

### Example 1: Chinese Input → Chinese Description
User: "分析report.xlsx、report2.xlsx和report3.xlsx"
分析: 3个独立文件分析任务 → 并行执行
Decomposition:
[
  {"id": "task_1", "description": "提取第一个表格的指标", "prompt": "Read and analyze report.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_2", "description": "提取第二个表格的指标", "prompt": "Read and analyze report2.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_3", "description": "提取第三个表格的指标", "prompt": "Read and analyze report3.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"}
]

### Example 2: English Input → English Description
User: "Analyze report.xlsx, report2.xlsx and report3.xlsx"
Analysis: 3 independent file analysis tasks → parallel execution
Decomposition:
[
  {"id": "task_1", "description": "Extract metrics from first spreadsheet", "prompt": "Read and analyze report.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_2", "description": "Extract metrics from second spreadsheet", "prompt": "Read and analyze report2.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_3", "description": "Extract metrics from third spreadsheet", "prompt": "Read and analyze report3.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"}
]

### Example 3: Chinese Input with Sequential Dependencies
User: "对比report.xlsx的销售数据和上季度的数据"
分析: 读取当前 → 读取上季度 → 对比（顺序依赖）
Decomposition:
[
  {"id": "task_1", "description": "读取本季度销售数据", "prompt": "Read report.xlsx and extract sales data. Return structured data.", "tools": ["sheet.read"], "dependsOn": [], "priority": "high", "semanticGroup": "data_collection"},
  {"id": "task_2", "description": "读取上季度销售数据", "prompt": "Find and read last quarter's sales data file. Return structured data.", "tools": ["sheet.read"], "dependsOn": [], "priority": "high", "semanticGroup": "data_collection"},
  {"id": "task_3", "description": "对比两季度数据差异", "prompt": "Compare the two datasets and generate a summary highlighting differences.", "tools": ["sequentialthinking"], "dependsOn": ["task_1", "task_2"], "priority": "medium", "semanticGroup": "analysis"}
]

### Example 4: English Input with Sequential Dependencies
User: "Compare sales data in report.xlsx with last quarter's data"
Analysis: Read current → Read previous → Compare (sequential dependency)
Decomposition:
[
  {"id": "task_1", "description": "Read current quarter sales data", "prompt": "Read report.xlsx and extract sales data. Return structured data.", "tools": ["sheet.read"], "dependsOn": [], "priority": "high", "semanticGroup": "data_collection"},
  {"id": "task_2", "description": "Read last quarter sales data", "prompt": "Find and read last quarter's sales data file. Return structured data.", "tools": ["sheet.read"], "dependsOn": [], "priority": "high", "semanticGroup": "data_collection"},
  {"id": "task_3", "description": "Compare data between two quarters", "prompt": "Compare the two datasets and generate a summary highlighting differences.", "tools": ["sequentialthinking"], "dependsOn": ["task_1", "task_2"], "priority": "medium", "semanticGroup": "analysis"}
]

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
