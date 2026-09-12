import type { AgentService } from '../service.js';
import type { SubTask } from './types.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from './tool-categories.js';
import { logger } from '../../shared/logger.js';

/**
 * Context-aware task decomposition using LLM.
 */
export class TaskDecomposer {
  constructor(private agentService: AgentService) {}

  /**
   * Decompose user request into parallel sub-tasks.
   */
  async decompose(
    userPrompt: string,
    context?: {
      previousResults?: Map<string, string>;
      availableTools?: string[];
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
   * Build the system prompt for decomposition.
   */
  private buildDecompositionPrompt(context?: {
    previousResults?: Map<string, string>;
    availableTools?: string[];
  }): string {
    const toolsList = context?.availableTools?.join(', ') || 'read_media_file, list_directory_with_sizes, query';
    
    return `
You are an expert task decomposition agent. Your job is to break down complex user requests 
into independent sub-tasks that can be executed in parallel.

## Rules for Decomposition

1. **Independence**: Each sub-task must be self-contained and not depend on results from other sub-tasks
2. **Completeness**: The combined results of all sub-tasks must fully address the user's request
3. **Efficiency**: Maximize parallelism - only create dependencies when absolutely necessary
4. **Tool Assignment**: Assign appropriate tools to each sub-task based on what it needs to do

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
    "priority": "high|medium|low"
  }
]

## Example
User: "Analyze the sales data in report.xlsx, compare it with last quarter's data, and generate a summary"

Decomposition:
[
  {
    "id": "task_1",
    "description": "Read and analyze current quarter sales data",
    "prompt": "Read the file report.xlsx using sheet.read and analyze the sales data using sheet.analyze. Return key metrics and trends.",
    "tools": ["sheet.read", "sheet.analyze"],
    "dependsOn": [],
    "priority": "high"
  },
  {
    "id": "task_2", 
    "description": "Read and analyze last quarter's data",
    "prompt": "Find and read last quarter's sales data file. If not found, use the most recent available data. Analyze and return key metrics.",
    "tools": ["sheet.read", "sheet.analyze"],
    "dependsOn": [],
    "priority": "high"
  },
  {
    "id": "task_3",
    "description": "Compare and generate summary",
    "prompt": "Compare the results from task_1 and task_2. Generate a comprehensive summary highlighting differences, trends, and recommendations.",
    "tools": ["sequentialthinking"],
    "dependsOn": ["task_1", "task_2"],
    "priority": "medium"
  }
]
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
   * Splits by obvious conjunctions or returns single task.
   */
  private fallbackDecomposition(userPrompt: string): SubTask[] {
    // Try to split by common conjunctions
    const parts = userPrompt.split(/(?:和|与|以及|,|\band\b)/i)
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    if (parts.length <= 1) {
      // Single task
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
      description: `Part ${index + 1}: ${part.substring(0, 50)}...`,
      prompt: part,
      tools: Array.from(READ_ONLY_TOOLS).slice(0, 5),
      timeoutMs: 60000,
      maxTurns: 10,
      dependsOn: [],
    }));
  }
}
