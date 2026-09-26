/** Shared types of the desktop agent bridge. */

/** Loose event shape forwarded from the core to the UI bridge. */
export type AgentEvent = { type: string } & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Task / sub-agent view types.
//
// These used to live in `src/agent/sub-agent/types.ts` next to a dead
// orchestrator. They are NOT dead: the whole renderer normalizes every core
// status vocabulary (task_graph nodes, subagent_status runs, core bg_ jobs)
// into `SubTaskStatus` so one card renderer can display all of them.
// ---------------------------------------------------------------------------

/** Execution status of a sub-task */
export type SubTaskStatus =
  | 'pending'     /** Waiting in queue */
  | 'queued'      /** Ready for execution */
  | 'running'     /** Currently executing */
  | 'succeeded'   /** Completed successfully */
  | 'failed'      /** Execution failed */
  | 'timeout'     /** Exceeded timeout */
  | 'cancelled';  /** Explicitly cancelled */

/** Token usage tracking */
export interface TokenUsage {
  prompt: number;
  completion: number;
}

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

/**
 * Fan-out execution events.
 *
 * One user prompt is decomposed into N sub-tasks and each is run to
 * completion. The sub-tasks are NOT run concurrently — they are executed
 * one after another in the owning worker — so these are named fanout_*,
 * not parallel_*, to keep the event stream honest about what happened.
 */
export interface FanoutStartEvent {
  type: 'fanout_start';
  sessionId: string;
  prompt: string;
}

export interface FanoutEndEvent {
  type: 'fanout_end';
  sessionId: string;
  tasks: SubTaskResult[];
  tokenUsage: TokenUsage;
}

export interface FanoutTaskProgressEvent {
  type: 'fanout_task_progress';
  taskId: string;
  status: string;
}

export interface FanoutErrorEvent {
  type: 'fanout_error';
  sessionId: string;
  error: string;
}

export interface PermissionRequest {
  id: string;
  question: string;
}

export interface ProviderInfo {
  name: string;
  type: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
}

export interface RateLimitStatus {
  providerName: string;
  baseUrl: string;
  family: string;
  rpm: number;
  recentRequests: number;
  backoffMs: number;
  status: 'normal' | 'warning' | 'throttled';
}
