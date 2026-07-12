import { join } from 'path';
import { TaskGraph, TaskNode, TaskStatus } from './types.js';
import { SubAgentWorker } from './sub-agent-worker.js';
import { ProgressTracker } from './progress-tracker.js';
import { preAuthorizeRoot } from '../security/path-authorizer.js';

export class DAGScheduler {
  constructor(
    private worker: SubAgentWorker,
    private tracker: ProgressTracker,
  ) {}

  async execute(graph: TaskGraph): Promise<void> {
    const projectDir = graph.projectName
      ? join(process.cwd(), graph.projectName)
      : process.cwd();
    preAuthorizeRoot(process.cwd());
    if (projectDir !== process.cwd()) preAuthorizeRoot(projectDir);
    const levels = this.topologicalSort(graph);

    for (const level of levels) {
      await Promise.all(level.map(async (node) => {
        if (node.status === 'cancelled') return;
        if (node.status === 'completed') return;

        await this.markInProgress(graph, node);

        // Reset state for previously failed nodes
        if (node.status === 'failed') {
          node.retryCount = 0;
          node.error = undefined;
        }
        for (let attempt = 0; attempt <= node.maxRetries; attempt++) {
          try {
            const result = await this.worker.execute(node, projectDir);
            node.result = result.output;
            node.status = 'completed';
            node.error = undefined;
            node.retryCount = 0;
            node.updatedAt = Date.now();
            this.tracker.updateGraph(graph);
            this.tracker.appendEvent({
              graphId: graph.id,
              taskId: node.id,
              eventType: 'task_completed',
              timestamp: Date.now(),
            });
            break;
          } catch (err) {
            node.retryCount = attempt + 1;
            node.error = String(err);
            if (attempt < node.maxRetries) {
              this.tracker.appendEvent({
                graphId: graph.id,
                taskId: node.id,
                eventType: 'task_retry',
                payload: String(err),
                timestamp: Date.now(),
              });
            } else {
              node.status = 'failed';
              node.updatedAt = Date.now();
              this.tracker.updateGraph(graph);
              this.tracker.appendEvent({
                graphId: graph.id,
                taskId: node.id,
                eventType: 'task_failed',
                payload: String(err),
                timestamp: Date.now(),
              });
              this.cancelDownstream(graph, node.id);
            }
          }
        }
      }));
    }
  }

  private async markInProgress(graph: TaskGraph, node: TaskNode): Promise<void> {
    node.status = 'in_progress';
    node.updatedAt = Date.now();
    this.tracker.updateGraph(graph);
    this.tracker.appendEvent({
      graphId: graph.id,
      taskId: node.id,
      eventType: 'task_started',
      timestamp: Date.now(),
    });
  }

  private cancelDownstream(graph: TaskGraph, failedId: string): void {
    const downstream = this.findDownstream(graph, failedId);
    for (const nodeId of downstream) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node && node.status === 'pending') {
        node.status = 'cancelled';
        node.updatedAt = Date.now();
      }
    }
    this.tracker.updateGraph(graph);
  }

  private findDownstream(graph: TaskGraph, nodeId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const node of graph.nodes) {
        if (node.dependencies.includes(current) && !visited.has(node.id)) {
          visited.add(node.id);
          queue.push(node.id);
        }
      }
    }
    return visited;
  }

  topologicalSort(graph: TaskGraph): TaskNode[][] {
    const nodes = graph.nodes;
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjList.set(node.id, []);
    }

    for (const node of nodes) {
      for (const depId of node.dependencies) {
        const list = adjList.get(depId);
        if (list) list.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    const levels: TaskNode[][] = [];
    let queue = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id);

    while (queue.length > 0) {
      const level: TaskNode[] = [];
      const nextQueue: string[] = [];

      for (const nodeId of queue) {
        const node = nodes.find((n) => n.id === nodeId);
        if (node) level.push(node);

        for (const neighbor of adjList.get(nodeId) || []) {
          const deg = (inDegree.get(neighbor) || 1) - 1;
          inDegree.set(neighbor, deg);
          if (deg === 0) nextQueue.push(neighbor);
        }
      }

      if (level.length > 0) levels.push(level);
      queue = nextQueue;
    }

    return levels;
  }
}
