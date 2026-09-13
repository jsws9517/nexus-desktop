import type { SubTask, SubTaskResult, SubTaskStatus, ParallelConfig } from './types.js';
import { logger } from '../../shared/logger.js';

/** Minimal worker interface — decoupled from WorkerHost to avoid Electron imports in worker process */
export interface SubAgentWorker {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
}

/** Factory function to create workers — injected by the main process */
export type WorkerFactory = (scriptPath: string) => SubAgentWorker;

/**
 * Manages the lifecycle of parallel sub-agent execution.
 * 
 * Key responsibilities:
 * - Dependency resolution via topological sort
 * - Concurrency control with batching
 * - Worker process lifecycle management
 * - Result aggregation
 * 
 * Note: Uses dependency injection for worker creation to avoid
 * circular imports with Electron main-process modules.
 */
export class SubAgentExecutor {
  private workers = new Map<string, SubAgentWorker>();
  private results = new Map<string, SubTaskResult>();
  
  constructor(
    private config: ParallelConfig = {},
    private workerFactory?: WorkerFactory,
    private workerScriptPath?: string,
    private onProgress?: (taskId: string, status: SubTaskStatus) => void
  ) {}

  /**
   * Execute multiple sub-tasks in parallel with dependency resolution.
   */
  async executeParallel(
    tasks: SubTask[],
    baseSessionId: string,
    constitutionText?: string
  ): Promise<SubTaskResult[]> {
    const sorted = this.topologicalSort(tasks);
    const batches = this.chunkByConcurrency(sorted);
    
    const allResults: SubTaskResult[] = [];
    
    for (const batch of batches) {
      const batchPromises = batch.map(task => 
        this.executeWithRetry(task, baseSessionId, constitutionText)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push(this.toFailedResult(result.reason));
        }
      }
    }
    
    return allResults;
  }

  /**
   * Execute with retry logic and exponential backoff.
   */
  private async executeWithRetry(
    task: SubTask, 
    baseSessionId: string,
    maxRetries: number = 2,
    constitutionText?: string
  ): Promise<SubTaskResult> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeSingle(task, baseSessionId, constitutionText);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff
          logger.warn(`Task ${task.id} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms...`);
          await this.delay(delayMs);
        }
      }
    }
    
    return this.toFailedResult(lastError!);
  }

  /**
   * Utility: delay for specified milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a single sub-task in an isolated worker.
   */
  private async executeSingle(
    task: SubTask,
    baseSessionId: string,
    constitutionText?: string
  ): Promise<SubTaskResult> {
    const startTime = Date.now();
    
    this.onProgress?.(task.id, 'queued');
    
    const worker = await this.spawnWorker(task, baseSessionId);
    
    this.onProgress?.(task.id, 'running');
    
    try {
      const result = await worker.request('runSubAgent', {
        taskId: task.id,
        prompt: task.prompt,
        tools: task.tools,
        maxTurns: task.maxTurns ?? 10,
        timeoutMs: task.timeoutMs ?? 60000,
        ...(constitutionText != null ? { constitution: constitutionText } : {}),
      });
      
      this.onProgress?.(task.id, 'succeeded');
      
      const output = typeof result === 'string' ? result : JSON.stringify(result);
      const tokenUsage = (result && typeof result === 'object' && 'tokenUsage' in result) 
        ? (result as { tokenUsage: { prompt: number; completion: number } }).tokenUsage 
        : { prompt: 0, completion: 0 };
      
      return {
        taskId: task.id,
        status: 'succeeded',
        output,
        tokenUsage,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      this.onProgress?.(task.id, 'failed');
      
      return {
        taskId: task.id,
        status: 'failed',
        output: '',
        tokenUsage: { prompt: 0, completion: 0 },
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      worker.stop();
      this.workers.delete(task.id);
    }
  }

  /**
   * Topological sort for dependency resolution.
   * Detects circular dependencies and throws.
   */
  topologicalSort(tasks: SubTask[]): SubTask[] {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const sorted: SubTask[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();
    
    const visit = (id: string) => {
      if (temp.has(id)) {
        throw new Error(`Circular dependency detected: ${id}`);
      }
      if (visited.has(id)) return;
      
      temp.add(id);
      
      const task = taskMap.get(id);
      if (task?.dependsOn) {
        for (const depId of task.dependsOn) {
          visit(depId);
        }
      }
      
      temp.delete(id);
      visited.add(id);
      sorted.push(task!);
    };
    
    for (const task of tasks) {
      visit(task.id);
    }
    
    return sorted;
  }

  /**
   * Chunk tasks by concurrency limit.
   */
  chunkByConcurrency(tasks: SubTask[], size?: number): SubTask[][] {
    const chunkSize = size ?? this.config.maxConcurrent ?? 4;
    const chunks: SubTask[][] = [];
    
    for (let i = 0; i < tasks.length; i += chunkSize) {
      chunks.push(tasks.slice(i, i + chunkSize));
    }
    
    return chunks;
  }

  /**
   * Spawn an isolated worker for a sub-task.
   */
  private async spawnWorker(
    task: SubTask,
    baseSessionId: string
  ): Promise<SubAgentWorker> {
    if (!this.workerFactory || !this.workerScriptPath) {
      throw new Error('WorkerFactory not provided — cannot spawn workers');
    }
    
    const worker = this.workerFactory(this.workerScriptPath);
    
    await worker.request('earlyInit');
    
    await worker.request('startSession', {
      prevSessionId: baseSessionId,
      isolate: true,
    });
    
    this.workers.set(task.id, worker);
    
    return worker;
  }

  /**
   * Convert an error to a failed SubTaskResult.
   */
  private toFailedResult(error: unknown): SubTaskResult {
    return {
      taskId: 'unknown',
      status: 'failed',
      output: '',
      tokenUsage: { prompt: 0, completion: 0 },
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * Cleanup all workers.
   */
  async cleanup(): Promise<void> {
    for (const [taskId, worker] of this.workers) {
      try {
        worker.stop();
      } catch (e) {
        logger.warn(`Failed to stop worker for task ${taskId}: ${e}`);
      }
    }
    this.workers.clear();
    this.results.clear();
  }
}
