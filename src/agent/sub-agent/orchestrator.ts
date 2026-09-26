import type { AgentService } from '../service.js';
import { SubAgentExecutor, type WorkerFactory } from './executor.js';
import type { SubTask, SubTaskResult, ParallelConfig, OrchestrationResult } from './types.js';
import type { BgJobManager } from '../../main/bg-job-manager.js';
import { detectLanguage, type PromptLang } from '../../shared/lang-detect.js';
import { logger } from '../../shared/logger.js';

/**
 * Coordinates task decomposition and result aggregation.
 *
 * Responsibilities:
 * - Decompose user request into parallel sub-tasks
 * - Execute sub-tasks via SubAgentExecutor
 * - Aggregate results into final output
 *
 * DEAD PATH — unreachable as of 2026-09-26. Its only caller is
 * `handleParallelRequest` (src/main/index.ts), which nothing invokes: no code
 * emits `parallel_request` (the type exists only in src/agent/types.ts), so no
 * `bj_` job is ever registered and `executeParallel` never runs. The live
 * "parallel" path is `AgentService.shouldUseParallel` → `chatParallel`, a
 * serial in-process loop. See docs/module-map-panels-and-runs.md §2/§3.
 */
export class OrchestratorAgent {
  private executor: SubAgentExecutor;
  private _bgJobs: BgJobManager | null = null;

  constructor(
    private agentService: AgentService | null,
    config?: {
      maxConcurrent?: number;
      timeoutMs?: number;
      workerFactory?: WorkerFactory;
      workerScriptPath?: string;
      /** Optional persistent job tracker — when provided, each sub-task is
       *  registered as a bg_job so progress survives worker crashes. */
      bgJobManager?: BgJobManager;
    }
  ) {
    this.executor = new SubAgentExecutor(
      { maxConcurrent: config?.maxConcurrent, timeoutMs: config?.timeoutMs },
      config?.workerFactory,
      config?.workerScriptPath,
    );
    this._bgJobs = config?.bgJobManager ?? null;
  }

  /** Expose bgJobManager for external status queries. */
  get bgJobManager(): BgJobManager | null {
    return this._bgJobs;
  }

  /**
    * Orchestrate parallel task execution.
    *
    * @param constitutionText Optional project-constitution text to pass into
    *   every sub-task prompt (adoption plan §3.7): sub-agents inherit the
    *   constitution explicitly from the Orchestrator — they never re-discover
    *   it via the filesystem inside the isolated child worker.
    *
    * When a BgJobManager is wired in, each sub-task is registered as a
    * persistent bg_job so progress survives worker crashes and can be polled
     * via `nexus:bgJobQuery` even after the owning tab is closed.
     */
    async orchestrate(
      userPrompt: string,
      sessionId: string,
      constitutionText?: string,
    ): Promise<OrchestrationResult & { jobIds?: string[]; lang?: PromptLang }> {
      const subTasks = await this.decomposeTasks(userPrompt, sessionId);
      const lang = detectLanguage(userPrompt);

    if (subTasks.length === 0) {
      return {
        success: true,
        output: lang === 'zh-CN'
          ? '未检测到可并行的子任务 — 按单一连续任务处理。'
          : 'No parallelizable tasks detected — treat as a single declarative prompt.',
        tasks: [],
        tokenUsage: { prompt: 0, completion: 0 },
        lang,
      };
    }

     // Register each sub-task as a persistent bg_job when a manager is available.
     const jobIds: string[] = [];
     if (this._bgJobs) {
       for (const task of subTasks) {
          const job = this._bgJobs.create({
            title: task.description,
            prompt: task.prompt,
            sessionId,
            toolAllowlist: task.tools,
            maxDurationMs: task.timeoutMs ?? 60_000,
            maxTurns: task.maxTurns ?? 10,
            constitution: constitutionText,
            _lang: lang,
          });
         jobIds.push(job.id);
       }
     }

     // Wire progress callbacks into the executor when bg_jobs exist.
     let originalProgress = this.executor['onProgress'];
     if (this._bgJobs && jobIds.length > 0) {
       this.executor['onProgress'] = (taskId: string, status: string) => {
         const idx = subTasks.findIndex((t) => t.id === taskId);
         if (idx === -1 || !jobIds[idx]) return;
         const bgStatus: import('./types.js').BgJobStatus =
           status === 'running' ? 'running'
           : status === 'succeeded' ? 'succeeded'
           : status === 'failed' ? 'failed'
           : status === 'timeout' ? 'timeout'
           : status === 'cancelled' ? 'cancelled'
           : 'queued';
          this._bgJobs!.notify(jobIds[idx], { status: bgStatus });
          originalProgress?.(taskId, status as import('./types.js').SubTaskStatus);
       };
     }

     const results = await this.executor.executeParallel(subTasks, sessionId, constitutionText);

     // Update bg_jobs with final statuses.
     if (this._bgJobs) {
       for (let i = 0; i < results.length; i++) {
         const jobId = jobIds[i];
         if (!jobId) continue;
         const r = results[i];
         if (r.status === 'succeeded') {
           this._bgJobs.onComplete(jobId, r.output, r.tokenUsage);
         } else if (r.status === 'failed' || r.status === 'timeout') {
           this._bgJobs.onFailure(jobId, r.error ?? `task ${r.taskId} ${r.status}`);
         } else if (r.status === 'cancelled') {
           this._bgJobs.advanceProgress(jobId, { status: 'cancelled' });
         }
       }
     }

     const output = await this.aggregateResults(results, userPrompt);

     const totalUsage = results.reduce(
       (acc, r) => ({
         prompt: acc.prompt + r.tokenUsage.prompt,
         completion: acc.completion + r.tokenUsage.completion,
       }),
       { prompt: 0, completion: 0 },
     );

      return {
        success: results.every((r) => r.status === 'succeeded'),
        output,
        tasks: results,
        tokenUsage: totalUsage,
        lang,
        ...(jobIds.length > 0 ? { jobIds } : {}),
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

## DECLINE TO DECOMPOSE DECLARATIVE STATEMENTS
If the user request is a purely declarative statement — a description of concepts or a question about related terms that contains no action verb (e.g. "分析/读取/生成/查找/处理/解释/解决") — return an empty array [].
Examples:
  - "基站ID 和 栅格ID傻傻分不清" → []
  - "A和B的区别是什么" → []
  - "介绍X和Y的应用场景" → []
These should be handled by a single reasoning pass (sequentialthinking), NOT split into parallel tasks.

## SPLIT ONLY WHEN TWO INDEPENDENT ACTIONS ARE REQUIRED
Only return sub-tasks when the request contains at least two independent action verbs connected by a conjunction — e.g. "读取A和生成B" or "分析X并对比Y".
A single action with paired objects ("分析A和B") is one task, not two.

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
    // Purely declarative: has conjunctions but no action verb → no decomposition needed
    const actionVerbs = '分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释|解决|修复|实现|开发|写|画|设计';
    const hasConjunction = /(?:和|与|以及|、|&|and)/i.test(userPrompt);
    const hasVerb = new RegExp(`\\b(${actionVerbs})\\b`, 'i').test(userPrompt);
    if (hasConjunction && !hasVerb) {
      return [];
    }
    // Only split when there are multiple independent action clauses
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
