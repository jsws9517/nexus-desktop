import type { SubTaskResult, TokenUsage } from './types.js';
import { logger } from '../../shared/logger.js';

/**
 * Performance metrics for parallel execution.
 */
export interface ParallelMetrics {
  totalDurationMs: number;
  taskCount: number;
  succeededCount: number;
  failedCount: number;
  timeoutCount: number;
  totalTokenUsage: TokenUsage;
  averageTaskDurationMs: number;
  maxTaskDurationMs: number;
  minTaskDurationMs: number;
}

/**
 * Collector for parallel execution metrics.
 */
export class MetricsCollector {
  private startTime: number = 0;
  private taskResults: SubTaskResult[] = [];

  /**
   * Start metrics collection.
   */
  start(): void {
    this.startTime = Date.now();
    this.taskResults = [];
  }

  /**
   * Record a task result.
   */
  recordTask(result: SubTaskResult): void {
    this.taskResults.push(result);
  }

  /**
   * Get collected metrics.
   */
  getMetrics(): ParallelMetrics {
    const totalDurationMs = Date.now() - this.startTime;
    const taskCount = this.taskResults.length;
    const succeededCount = this.taskResults.filter(r => r.status === 'succeeded').length;
    const failedCount = this.taskResults.filter(r => r.status === 'failed').length;
    const timeoutCount = this.taskResults.filter(r => r.status === 'timeout').length;
    
    const totalTokenUsage = this.taskResults.reduce(
      (acc, r) => ({
        prompt: acc.prompt + r.tokenUsage.prompt,
        completion: acc.completion + r.tokenUsage.completion,
      }),
      { prompt: 0, completion: 0 }
    );
    
    const durations = this.taskResults.map(r => r.durationMs);
    const averageTaskDurationMs = durations.length > 0 
      ? durations.reduce((a, b) => a + b, 0) / durations.length 
      : 0;
    const maxTaskDurationMs = durations.length > 0 ? Math.max(...durations) : 0;
    const minTaskDurationMs = durations.length > 0 ? Math.min(...durations) : 0;

    return {
      totalDurationMs,
      taskCount,
      succeededCount,
      failedCount,
      timeoutCount,
      totalTokenUsage,
      averageTaskDurationMs,
      maxTaskDurationMs,
      minTaskDurationMs,
    };
  }

  /**
   * Log metrics summary.
   */
  logSummary(): void {
    const metrics = this.getMetrics();
    
    logger.info('=== Parallel Execution Metrics ===');
    logger.info(`Total Duration: ${metrics.totalDurationMs}ms`);
    logger.info(`Tasks: ${metrics.taskCount} (Succeeded: ${metrics.succeededCount}, Failed: ${metrics.failedCount}, Timeout: ${metrics.timeoutCount})`);
    logger.info(`Token Usage: ${metrics.totalTokenUsage.prompt} prompt, ${metrics.totalTokenUsage.completion} completion`);
    logger.info(`Task Duration: avg=${metrics.averageTaskDurationMs.toFixed(0)}ms, min=${metrics.minTaskDurationMs}ms, max=${metrics.maxTaskDurationMs}ms`);
    logger.info('==================================');
  }

  /**
   * Reset metrics.
   */
  reset(): void {
    this.startTime = 0;
    this.taskResults = [];
  }
}

/**
 * Compare serial vs parallel performance.
 */
export function comparePerformance(
  serialMetrics: { durationMs: number; tokenUsage: TokenUsage },
  parallelMetrics: ParallelMetrics
): {
  durationImprovement: number;  // percentage
  tokenOverhead: number;        // percentage
} {
  const durationImprovement = serialMetrics.durationMs > 0
    ? ((serialMetrics.durationMs - parallelMetrics.totalDurationMs) / serialMetrics.durationMs) * 100
    : 0;
  
  const serialTokens = serialMetrics.tokenUsage.prompt + serialMetrics.tokenUsage.completion;
  const parallelTokens = parallelMetrics.totalTokenUsage.prompt + parallelMetrics.totalTokenUsage.completion;
  const tokenOverhead = serialTokens > 0
    ? ((parallelTokens - serialTokens) / serialTokens) * 100
    : 0;

  return {
    durationImprovement,
    tokenOverhead,
  };
}
