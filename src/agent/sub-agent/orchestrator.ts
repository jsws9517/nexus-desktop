import type { AgentService } from '../service.js';
import { SubAgentExecutor, type WorkerFactory } from './executor.js';
import type { SubTask, SubTaskResult, ParallelConfig, OrchestrationResult } from './types.js';
import { logger } from '../../shared/logger.js';

/**
 * Coordinates task decomposition and result aggregation.
 * 
 * Responsibilities:
 * - Decompose user request into parallel sub-tasks
 * - Execute sub-tasks via SubAgentExecutor
 * - Aggregate results into final output
 */
export class OrchestratorAgent {
  private executor: SubAgentExecutor;
  
  constructor(
    private agentService: AgentService | null,
    config?: {
      maxConcurrent?: number;
      timeoutMs?: number;
      workerFactory?: WorkerFactory;
      workerScriptPath?: string;
    }
  ) {
    this.executor = new SubAgentExecutor(
      { maxConcurrent: config?.maxConcurrent, timeoutMs: config?.timeoutMs },
      config?.workerFactory,
      config?.workerScriptPath
    );
  }

  /**
   * Orchestrate parallel task execution.
   *
   * @param constitutionText Optional project-constitution text to pass into
   *   every sub-task prompt (adoption plan §3.7): sub-agents inherit the
   *   constitution explicitly from the Orchestrator — they never re-discover
   *   it via the filesystem inside the isolated child worker.
   */
  async orchestrate(
    userPrompt: string,
    sessionId: string,
    constitutionText?: string
  ): Promise<OrchestrationResult> {
    const subTasks = await this.decomposeTasks(userPrompt, sessionId);
    
    if (subTasks.length === 0) {
      return {
        success: true,
        output: 'No parallelizable tasks detected.',
        tasks: [],
        tokenUsage: { prompt: 0, completion: 0 },
      };
    }
    
    const results = await this.executor.executeParallel(subTasks, sessionId, constitutionText);
    
    const output = await this.aggregateResults(results, userPrompt);
    
    const totalUsage = results.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
      }),
      { prompt: 0, completion: 0 }
    );
    
    return {
      success: results.every(r => r.status === 'succeeded'),
      output,
      tasks: results,
      tokenUsage: totalUsage,
    };
  }

  /**
   * Decompose user request into parallel sub-tasks via LLM.
   */
  private async decomposeTasks(
    userPrompt: string,
    sessionId: string
  ): Promise<SubTask[]> {
    // If no agentService available, use simplified decomposition
    if (!this.agentService) {
      return this.fallbackDecomposition(userPrompt);
    }
    
    const decompositionPrompt = `
You are a task decomposition expert. Given the following user request,
break it down into independent sub-tasks that can be executed in parallel.

Rules:
1. Each sub-task should be self-contained and independent
2. Max 5 sub-tasks (more indicates poor decomposition)
3. Each sub-task should have clear description and prompt
4. Specify dependencies if tasks are not independent

User request:
${userPrompt}

Return JSON array:
[
  {
    "id": "task_1",
    "description": "What this task does",
    "prompt": "Detailed instructions for the sub-agent",
    "tools": ["read_media_file", "list_directory_with_sizes"],
    "dependsOn": []
  }
]
`;

    try {
      const response = await this.agentService.callLlm({
        messages: [
          { role: 'system', content: decompositionPrompt },
          { role: 'user', content: userPrompt },
        ],
        model: 'decomposer',
      });
      
      const subTasks = JSON.parse(response);
      
      return subTasks.map((task: any, index: number) => ({
        id: task.id || `task_${index + 1}`,
        description: task.description || `Sub-task ${index + 1}`,
        prompt: task.prompt || task.description,
        tools: task.tools || ['read_media_file', 'list_directory_with_sizes', 'query'],
        timeoutMs: task.timeoutMs || 60000,
        maxTurns: task.maxTurns || 10,
        dependsOn: task.dependsOn || [],
      }));
    } catch (error) {
      logger.warn(`Task decomposition failed: ${error}. Using fallback.`);
      return this.fallbackDecomposition(userPrompt);
    }
  }

  /**
   * Fallback decomposition when LLM is not available.
   * Only splits on multi-clause prompts; preserves single coherent tasks.
   */
  private fallbackDecomposition(userPrompt: string): SubTask[] {
    // Only split when there are multiple independent action clauses
    const actionVerbs = '分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释';
    const hasMultiClause = new RegExp(`\\b(${actionVerbs})\\b.*(?:和|与|以及|&|and).*.?\\b(${actionVerbs})\\b`, 'i').test(userPrompt);

    if (!hasMultiClause) {
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: userPrompt,
        tools: ['read_media_file', 'list_directory_with_sizes', 'query'],
        timeoutMs: 60000,
        maxTurns: 10,
        dependsOn: [],
      }];
    }

    const parts = userPrompt
      .split(/(?:[。；；\.]|(?<=\S)\s*(?:和|与|以及|&|and)\s*(?=\S))/gi)
      .map(p => p.trim())
      .filter(p => p.length > 8);

    if (parts.length <= 1) {
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: userPrompt,
        tools: ['read_media_file', 'list_directory_with_sizes', 'query'],
        timeoutMs: 60000,
        maxTurns: 10,
        dependsOn: [],
      }];
    }

    return parts.map((part, index) => ({
      id: `task_${index + 1}`,
      description: `Part ${index + 1}: ${part.substring(0, 50)}...`,
      prompt: part,
      tools: ['read_media_file', 'list_directory_with_sizes', 'query'],
      timeoutMs: 60000,
      maxTurns: 10,
      dependsOn: [],
    }));
  }

  /**
   * Aggregate sub-task results into final output.
   */
  private async aggregateResults(
    results: SubTaskResult[],
    originalPrompt: string
  ): Promise<string> {
    const succeeded = results.filter(r => r.status === 'succeeded');
    const failed = results.filter(r => r.status !== 'succeeded');
    
    if (failed.length > 0) {
      const errorReport = failed.map(r => 
        `[FAILED] ${r.taskId}: ${r.error}`
      ).join('\n');
      
      return `Completed ${succeeded.length}/${results.length} tasks.\n\nErrors:\n${errorReport}`;
    }
    
    const sections = succeeded.map(r => 
      `## ${r.taskId}\n${r.output}`
    );
    
    return sections.join('\n\n---\n\n');
  }

  /**
   * Cleanup executor resources.
   */
  async cleanup(): Promise<void> {
    await this.executor.cleanup();
  }
}
