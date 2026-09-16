/** Shared types of the desktop agent bridge. */
import type { SubTaskResult, TokenUsage } from './sub-agent/types.js';

/** Loose event shape forwarded from the core to the UI bridge. */
export type AgentEvent = { type: string } & Record<string, unknown>;

/** Parallel execution events */
export interface ParallelStartEvent {
  type: 'parallel_start';
  sessionId: string;
  prompt: string;
}

export interface ParallelEndEvent {
  type: 'parallel_end';
  sessionId: string;
  tasks: SubTaskResult[];
  tokenUsage: TokenUsage;
}

export interface ParallelRequestEvent {
  type: 'parallel_request';
  sessionId: string;
  prompt: string;
}

export interface TaskProgressEvent {
  type: 'task_progress';
  taskId: string;
  status: string;
}

export interface ParallelErrorEvent {
  type: 'parallel_error';
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
