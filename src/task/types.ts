export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/** Role a sub-agent runs as. `general` is the default open-ended executor. */
export type SubAgentRole = 'general' | 'tester' | 'committer';

export interface TaskNode {
  id: string;
  description: string;
  agentHint?: string;
  dependencies: string[];
  status: TaskStatus;
  result?: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
}

export type GraphMode = 'new' | 'modify';

export interface TaskGraph {
  id: string;
  sessionId: string;
  rootRequest: string;
  projectName?: string;
  mode?: GraphMode;
  nodes: TaskNode[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  id?: number;
  graphId: string;
  taskId?: string;
  eventType: string;
  payload?: string;
  timestamp: number;
}

export interface SubTaskResult {
  taskId: string;
  output: string;
}
