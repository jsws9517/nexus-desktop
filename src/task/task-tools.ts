import { randomUUID } from 'crypto';
import { ToolDefinition, ToolResult } from '../types.js';
import { TaskNode, TaskGraph } from './types.js';
import { ProgressTracker } from './progress-tracker.js';
import { SubAgentWorker } from './sub-agent-worker.js';
import { t, tf } from '../i18n/index.js';

export function getTaskToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'decompose_task',
      description: t('plan_tool_desc'),
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: t('plan_request_desc') },
        },
        required: ['request'],
      },
    },
    {
      name: 'spawn_subagent',
      description: t('exec_tool_desc'),
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: t('exec_task_desc') },
          agent_hint: { type: 'string', description: t('exec_hint_desc') },
        },
        required: ['task'],
      },
    },
    {
      name: 'query_tasks',
      description: t('status_tool_desc'),
      inputSchema: {
        type: 'object',
        properties: {
          graph_id: { type: 'string', description: t('status_graph_desc') },
        },
      },
    },
  ];
}

export async function executeTaskTool(
  name: string,
  args: Record<string, unknown>,
  agentContext: {
    agent: import('../agent.js').Agent;
    tracker: ProgressTracker;
    sessionId?: string;
  },
): Promise<ToolResult | undefined> {
  switch (name) {
    case 'decompose_task':
      return handleDecompose(args, agentContext);
    case 'spawn_subagent':
      return handleSpawnSubagent(args, agentContext);
    case 'query_tasks':
      return handleQueryTasks(args, agentContext);
    default:
      return undefined;
  }
}

async function handleDecompose(
  args: Record<string, unknown>,
  ctx: { agent: import('../agent.js').Agent; tracker: ProgressTracker; sessionId?: string },
): Promise<ToolResult> {
  const request = String(args.request || '');
  if (!request.trim()) {
    return { content: 'Error: request is required', isError: true };
  }

  try {
    const response = await ctx.agent.provider.complete([{
      role: 'user',
      content: `Decompose the following request into a list of sub-tasks, and provide a short English project name (project_name, used as directory name, e.g. snake-game, blog-api).

Output format (strict JSON, no extra text):
{
  "project_name": "...",
  "tasks": [
    {"id":"t1","description":"...","dependencies":[]},
    {"id":"t2","description":"...","dependencies":["t1"]}
  ]
}

Requirements:
- project_name: short English directory name generated from the request (lowercase letters, digits, hyphens only)
- Each task has id (e.g. "t1","t2"), description, and dependencies (list of other task ids it depends on)
- dependencies must form a Directed Acyclic Graph (DAG); tasks with no dependencies use empty array
- Each task should be small enough to execute independently (~5-15 minutes work)
- Do not miss critical steps, do not repeat

Request: ${request}`,
    }]);

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { content: `Failed to parse decomposition result: ${response}`, isError: true };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const projectName: string | undefined = parsed.project_name || undefined;
    const nodes: TaskNode[] = Array.isArray(parsed) ? parsed : parsed.tasks;
    const now = Date.now();
    const taskNodes: TaskNode[] = nodes.map((n: Partial<TaskNode>, i: number) => ({
      id: n.id || `t${i + 1}`,
      description: n.description || '',
      dependencies: n.dependencies || [],
      status: 'pending' as const,
      retryCount: 0,
      maxRetries: 2,
      createdAt: now,
      updatedAt: now,
    }));

    const graph: TaskGraph = {
      id: randomUUID(),
      sessionId: ctx.sessionId || 'unknown',
      rootRequest: request,
      projectName,
      nodes: taskNodes,
      createdAt: now,
      updatedAt: now,
    };

    ctx.tracker.initGraph(graph);

    return {
      content: JSON.stringify({ graphId: graph.id, nodes: taskNodes }, null, 2),
    };
  } catch (err) {
    return {
      content: `Decomposition failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function handleSpawnSubagent(
  args: Record<string, unknown>,
  ctx: { agent: import('../agent.js').Agent; tracker: ProgressTracker },
): Promise<ToolResult> {
  const task = String(args.task || '');
  if (!task.trim()) {
    return { content: 'Error: task is required', isError: true };
  }

  const node: TaskNode = {
    id: `manual-${Date.now()}`,
    description: task,
    dependencies: [],
    status: 'in_progress',
    retryCount: 0,
    maxRetries: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const worker = new SubAgentWorker(ctx.agent);
  try {
    const result = await worker.execute(node);
    node.status = 'completed';
    node.result = result.output;
    return { content: result.output };
  } catch (err) {
    node.status = 'failed';
    node.error = String(err);
    return {
      content: `Subagent execution failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

async function handleQueryTasks(
  args: Record<string, unknown>,
  ctx: { agent: import('../agent.js').Agent; tracker: ProgressTracker; sessionId?: string },
): Promise<ToolResult> {
  const graphId = String(args.graph_id || '');
  let graph: TaskGraph | undefined;

  if (graphId) {
    graph = ctx.tracker.getGraph(graphId);
  } else if (ctx.sessionId) {
    graph = ctx.tracker.getGraphBySession(ctx.sessionId);
  }

  if (!graph) {
    return { content: 'No task graph found.', isError: true };
  }

  const summary = graph.nodes.map((n) => {
    const depInfo = n.dependencies.length > 0 ? ` [depends on: ${n.dependencies.join(', ')}]` : '';
    const resultInfo = n.result ? `\n      result: ${n.result.slice(0, 100)}${n.result.length > 100 ? '...' : ''}` : '';
    const errorInfo = n.error ? `\n      error: ${n.error}` : '';
    return `  ${statusIcon(n.status)} ${n.id}: ${n.description} (${n.status})${depInfo}${resultInfo}${errorInfo}`;
  }).join('\n');

  return {
    content: `Task Graph: ${graph.rootRequest}\n${summary}\n\nGraph ID: ${graph.id}`,
  };
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✓';
    case 'in_progress': return '▶';
    case 'failed': return '✗';
    case 'cancelled': return '−';
    case 'assigned': return '●';
    default: return '○';
  }
}
