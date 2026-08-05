import { randomUUID } from 'crypto';
import { ToolDefinition, ToolResult } from '../types.js';
import { TaskNode, TaskGraph, SubAgentRole, GraphMode } from './types.js';
import { ProgressTracker } from './progress-tracker.js';
import { SubAgentWorker } from './sub-agent-worker.js';
import { ConfigManager } from '../config/index.js';
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
          agent_type: {
            type: 'string',
            description: 'Role for the sub-agent: general | tester | committer',
            enum: ['general', 'tester', 'committer'],
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'spawn_tester',
      description:
        'Spawn a Tester sub-agent that runs the project test / lint / typecheck suite and reports PASS/FAIL. Read-only; never modifies source.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'What to validate, e.g. "run the full test suite and report results"',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'spawn_committer',
      description:
        'Spawn a Committer sub-agent that reviews the git diff, verifies build/tests, then creates an atomic Conventional Commits commit (no push).',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Commit scope/hint, e.g. "commit the implemented login feature"',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'spawn_skill_fixer',
      description:
        'Spawn a Skill Fixer sub-agent that uses LLM to intelligently fix issues in a skill directory. Fixes YAML frontmatter, adds tool references, expands instructions, converts | block scalars to inline, fixes old paths, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Path or name of the skill to fix, plus any specific instructions. E.g. "Fix all issues in local-tts"',
          },
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
      return handleSpawnSubagent(args, agentContext, normalizeRole(args.agent_type));
    case 'spawn_tester':
      return handleSpawnSubagent(args, agentContext, 'tester');
    case 'spawn_committer':
      return handleSpawnSubagent(args, agentContext, 'committer');
    case 'spawn_skill_fixer':
      return handleSpawnSubagent(args, agentContext, 'skill-fixer');
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
    let response = '';
    const stream = ctx.agent.provider.chat([{
      role: 'user',
      content: `Decompose the following request into a MINIMAL list of sub-tasks (3-5 tasks max). Provide a short English project name (project_name, used as directory name, e.g. snake-game, blog-api).

Output format (strict JSON, no extra text):
{
  "project_name": "...",
  "mode": "new | modify",
  "tasks": [
    {"id":"t1","description":"...","dependencies":[]},
    {"id":"t2","description":"...","dependencies":["t1"]}
  ]
}

Requirements:
- project_name: short English directory name generated from the request (lowercase letters, digits, hyphens only)
- mode: "new" for greenfield development (no existing files) or "modify" when the request references existing files via @path (optimization, refactoring, bugfix)
- 3-5 tasks MAX. Consolidate related work (analysis + planning into one task, refactor + optimize into one task).
- Each task has id (e.g. "t1","t2"), description, and dependencies (list of other task ids it depends on)
- dependencies must form a Directed Acyclic Graph (DAG); tasks with no dependencies use empty array
- If the request references specific file paths (via @path or [Referenced file:]), embed the absolute file path in the relevant task descriptions so sub-agents know which files to work on

Request: ${request}`,
    }]);
    let lastTick = Date.now();
    const tickStart = Date.now();
    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.text) {
        response += chunk.text;
        ctx.agent.onOutput?.(chunk.text);
      } else if (chunk.type === 'thinking' && chunk.thinking) {
        ctx.agent.onEvent?.({ type: 'thinking', thinking: chunk.thinking });
        const now = Date.now();
        if (now - lastTick >= 30_000) {
          lastTick = now;
          ctx.agent.onOutput?.(`\n⏳ Still analyzing the request (${Math.round((now - tickStart) / 1000)}s elapsed)...\n`);
        }
      }
    }

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { content: `Failed to parse decomposition result: ${response}`, isError: true };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const projectName: string | undefined = parsed.project_name || undefined;
    const mode: GraphMode | undefined = (parsed.mode === 'new' || parsed.mode === 'modify') ? parsed.mode : undefined;
    const nodes: TaskNode[] = Array.isArray(parsed) ? parsed : parsed.tasks;
    const now = Date.now();
    const taskNodes: TaskNode[] = nodes.map((n: Partial<TaskNode>, i: number) => ({
      id: n.id || `t${i + 1}`,
      description: n.description || '',
      dependencies: n.dependencies || [],
      status: 'pending' as const,
      retryCount: 0,
      maxRetries: 1,
      createdAt: now,
      updatedAt: now,
    }));

    const graph: TaskGraph = {
      id: randomUUID(),
      sessionId: ctx.sessionId || 'unknown',
      rootRequest: request,
      projectName,
      mode,
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
  role: import('./types.js').SubAgentRole = 'general',
): Promise<ToolResult> {
  const task = String(args.task || '');
  if (!task.trim()) {
    return { content: 'Error: task is required', isError: true };
  }

  const node: TaskNode = {
    id: `manual-${Date.now()}`,
    description: task,
    agentHint: role,
    dependencies: [],
    status: 'in_progress',
    retryCount: 0,
    maxRetries: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

   const worker = new SubAgentWorker(ctx.agent);
   try {
     const result = await worker.execute(node, undefined, role);

     // Validate result before marking completed: check that the
     // sub-agent actually produced meaningful output.  This
     // prevents "fake completion" where the LLM finishes its
     // turn without doing any real work.
     if (result.output.trim().length === 0) {
       node.status = 'failed';
       node.error = 'Sub-agent produced no output';
       return {
         content: 'Subagent execution failed: no output produced',
         isError: true,
       };
     }

     node.status = 'completed';
     node.result = result.output;

    // After a general implementation task, optionally run the quality gate
    // (auto tester -> auto committer) as a coding-workflow规范流.
    if (role === 'general') {
      await runQualityGate(ctx.agent, undefined);
    }

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

/**
 * Quality-gate chain invoked after a general implementation task completes:
 *   1. (if autoTest)  spawn a Tester sub-agent; stop the chain on FAIL.
 *   2. (if autoCommit) spawn a Committer sub-agent to create a local commit.
 * Runs in the given projectDir (or cwd when undefined).
 */
export async function runQualityGate(
  parentAgent: import('../agent.js').Agent,
  projectDir?: string,
): Promise<void> {
  const gate = new ConfigManager().getQualityGate();
  if (!gate.autoTest && !gate.autoCommit) return;

  const worker = new SubAgentWorker(parentAgent);

  if (gate.autoTest) {
    const testNode: TaskNode = {
      id: `qg-test-${Date.now()}`,
      description: 'Run the project test suite / lint / typecheck and report VERDICT: PASS or FAIL.',
      dependencies: [],
      status: 'in_progress',
      retryCount: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      const r = await worker.execute(testNode, projectDir, 'tester');
      const passed = /VERDICT:\s*PASS/i.test(r.output);
      if (!passed) return; // do not commit when tests fail
    } catch {
      return; // do not commit when the tester errors
    }
  }

  if (gate.autoCommit) {
    const commitNode: TaskNode = {
      id: `qg-commit-${Date.now()}`,
      description: 'Review the changes and create an atomic Conventional Commits git commit (do not push).',
      dependencies: [],
      status: 'in_progress',
      retryCount: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await worker.execute(commitNode, projectDir, 'committer');
    } catch {
      /* committer failures are non-fatal for the implementation task */
    }
  }
}

function normalizeRole(value: unknown): import('./types.js').SubAgentRole {
  const v = String(value || 'general');
  if (v === 'tester' || v === 'committer' || v === 'general' || v === 'skill-fixer') return v as import('./types.js').SubAgentRole;
  return 'general';
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
