import { randomUUID } from 'crypto';
import { ToolDefinition, ToolResult } from '../types.js';
import { TaskNode, TaskGraph } from './types.js';
import { ProgressTracker } from './progress-tracker.js';
import { SubAgentWorker } from './sub-agent-worker.js';

const TASK_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'decompose_task',
    description: '将复杂请求拆解为有依赖关系的子任务列表，返回 TaskGraph（不执行）',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: '需要拆解的原始请求' },
      },
      required: ['request'],
    },
  },
  {
    name: 'spawn_subagent',
    description: '创建子 agent 执行单个任务并返回结果',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述' },
        agent_hint: { type: 'string', description: '可选的能力提示（如 code, search, test）' },
      },
      required: ['task'],
    },
  },
  {
    name: 'query_tasks',
    description: '查询当前 TaskGraph 中所有子任务的执行进度',
    inputSchema: {
      type: 'object',
      properties: {
        graph_id: { type: 'string', description: '可选，指定 TaskGraph ID，不传则查当前 session 的最新 graph' },
      },
    },
  },
];

export function getTaskToolDefinitions(): ToolDefinition[] {
  return TASK_TOOL_DEFINITIONS;
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
      content: `将以下请求拆解为子任务列表，并给出一个简短的英文项目名（project_name，用作目录名，如 snake-game、blog-api）。

输出格式（严格 JSON，不要多余文本）：
{
  "project_name": "...",
  "tasks": [
    {"id":"t1","description":"...","dependencies":[]},
    {"id":"t2","description":"...","dependencies":["t1"]}
  ]
}

要求：
- project_name: 根据请求内容生成的简短英文目录名（仅含小写字母、数字、连字符）
- 每个任务有 id（如 "t1","t2"）、description（任务描述）、dependencies（依赖的其他任务id列表）
- dependencies 形成有向无环图（DAG），无依赖的任务用空数组
- 每个任务应当足够小以便独立执行（约 5-15 分钟工作量）
- 不要遗漏关键步骤，不要重复

请求: ${request}`,
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
