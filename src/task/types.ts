export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

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

export interface TaskGraph {
  id: string;
  sessionId: string;
  rootRequest: string;
  projectName?: string;
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
