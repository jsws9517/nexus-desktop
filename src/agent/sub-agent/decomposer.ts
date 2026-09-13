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
    "description": "Brief description of what this task does",
    "prompt": "Detailed instructions for the sub-agent to complete this task",
    "tools": ["tool1", "tool2"],
    "dependsOn": [],
    "priority": "high|medium|low",
    "semanticGroup": "group_name"
  }
]

## Semantic Grouping
Tasks that share the same semantic context (e.g., "analyze sales data" and "compare with last quarter") should be in the same group if they can share intermediate results.

## Examples

### Example 1: Simple Conjunction Chain
User: "Analyze report.xlsx and report2.xlsx and report3.xlsx"
Analysis: 3 independent file analysis tasks → parallel execution
Decomposition:
[
  {"id": "task_1", "description": "Analyze report.xlsx", "prompt": "Read and analyze report.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_2", "description": "Analyze report2.xlsx", "prompt": "Read and analyze report2.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_3", "description": "Analyze report3.xlsx", "prompt": "Read and analyze report3.xlsx. Return key metrics.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"}
]

### Example 2: Compare with Implicit Read Tasks
User: "Compare sales data in report.xlsx with last quarter's data"
Analysis: Read current → Read previous → Compare (sequential dependency)
Decomposition:
[
  {"id": "task_1", "description": "Read current quarter sales data", "prompt": "Read report.xlsx and extract sales data. Return structured data.", "tools": ["sheet.read"], "dependsOn": [], "priority": "high", "semanticGroup": "data_collection"},
  {"id": "task_2", "description": "Read last quarter sales data", "prompt": "Find and read last quarter's sales data file. Return structured data.", "tools": ["sheet.read"], "dependsOn": [], "priority": "high", "semanticGroup": "data_collection"},
  {"id": "task_3", "description": "Compare and generate summary", "prompt": "Compare the two datasets and generate a summary highlighting differences.", "tools": ["sequentialthinking"], "dependsOn": ["task_1", "task_2"], "priority": "medium", "semanticGroup": "analysis"}
]

### Example 3: Multi-Action Single Object
User: "Read, analyze, and summarize the sales report"
Analysis: All actions on same object → sequential chain, not parallel
Decomposition:
[
  {"id": "task_1", "description": "Process sales report", "prompt": "Read the sales report, analyze key metrics, and generate a comprehensive summary.", "tools": ["sheet.read", "sheet.analyze"], "dependsOn": [], "priority": "high", "semanticGroup": "report_analysis"}
]

### Example 4: Mixed Parallel and Sequential
User: "Analyze files A, B, C, then compare results and generate report"
Analysis: A, B, C parallel → compare (depends on all) → report (depends on compare)
Decomposition:
[
  {"id": "task_1", "description": "Analyze file A", "prompt": "Read and analyze file A. Return key findings.", "tools": ["read_media_file"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_2", "description": "Analyze file B", "prompt": "Read and analyze file B. Return key findings.", "tools": ["read_media_file"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_3", "description": "Analyze file C", "prompt": "Read and analyze file C. Return key findings.", "tools": ["read_media_file"], "dependsOn": [], "priority": "high", "semanticGroup": "analysis"},
  {"id": "task_4", "description": "Compare all results", "prompt": "Compare findings from tasks 1, 2, and 3. Identify patterns and differences.", "tools": ["sequentialthinking"], "dependsOn": ["task_1", "task_2", "task_3"], "priority": "medium", "semanticGroup": "comparison"},
  {"id": "task_5", "description": "Generate final report", "prompt": "Create a comprehensive report based on the comparison.", "tools": [], "dependsOn": ["task_4"], "priority": "low", "semanticGroup": "reporting"}
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
   * Uses heuristic-based splitting with semantic awareness.
   */
  private fallbackDecomposition(userPrompt: string): SubTask[] {
    // Try to split by common conjunctions
    const parts = userPrompt.split(/(?:和|与|以及|，|,|、|＆|&|and|et|y|и|أو)/i)
      .map(p => p.trim())
      .filter(p => p.length > 5); // Ignore very short fragments
    
    if (parts.length <= 1) {
      // No conjunctions found, return single task
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
    
    // Multiple tasks from conjunctions
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
