import type { AgentEvent } from '../types.js';

/** Unique identifier for the sub-task */
export interface SubTask {
  /** Stable ID for tracking */
  id: string;

  /** Human-readable description */
  description: string;

  /** Prompt given to the sub-agent */
  prompt: string;

  /** Tool allowlist (optional = all tools) */
  tools?: string[];

  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;

  /** Maximum conversation turns (default: 10) */
  maxTurns?: number;

  /** IDs of dependent sub-tasks */
  dependsOn?: string[];
}

/** Execution status of a sub-task */
export type SubTaskStatus =
  | 'pending'     /** Waiting in queue */
  | 'queued'      /** Ready for execution */
  | 'running'     /** Currently executing */
  | 'succeeded'   /** Completed successfully */
  | 'failed'      /** Execution failed */
  | 'timeout'     /** Exceeded timeout */
  | 'cancelled';  /** Explicitly cancelled */

/** Result from a sub-task execution */
export interface SubTaskResult {
  taskId: string;
  status: SubTaskStatus;
  output: string;
  tokenUsage: { prompt: number; completion: number };
  durationMs: number;
  error?: string;
  events?: AgentEvent[];
}

/** Parallel execution configuration */
export interface ParallelConfig {
  /** Maximum concurrent sub-agents (default: 4) */
  maxConcurrent?: number;

  /** Total timeout in milliseconds (default: 300000) */
  timeoutMs?: number;

  /** Fallback to serial on partial failure (default: true) */
  fallbackToSerial?: boolean;
}

/** Token usage tracking */
export interface TokenUsage {
  prompt: number;
  completion: number;
}

/** Orchestration result */
export interface OrchestrationResult {
  success: boolean;
  output: string;
  tasks: SubTaskResult[];
  tokenUsage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Background Job types (bg_job integration)
// ---------------------------------------------------------------------------

export type BgJobStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'stale';

export interface BgJob {
  id: string;
  title: string;
  prompt: string;
  sessionId: string;
  toolAllowlist?: string[];
  maxDurationMs: number;
  maxTurns: number;
  constitution?: string;
  status: BgJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  progress?: number;
  progressNote?: string;
  output?: string;
  error?: string;
}

export interface BgJobCreateInput {
  title: string;
  prompt: string;
  sessionId: string;
  toolAllowlist?: string[];
  maxDurationMs?: number;
  maxTurns?: number;
  constitution?: string;
}

export interface BgJobQueryResult {
  job: BgJob | null;
  error?: string;
}

export interface BgJobListFilter {
  sessionId?: string;
  status?: BgJobStatus;
}

