import { Agent } from '../agent.js';
import { TaskNode, SubTaskResult, SubAgentRole } from './types.js';
import { getSubAgentRole } from './sub-agent-roles.js';
import { preAuthorizeRoot } from '../security/path-authorizer.js';

export class SubAgentWorker {
  private authorized = false;

  constructor(
    private parentAgent: Agent,
    private onProgress?: (taskId: string, event: string) => void,
  ) {}

  /** The parent agent that spawned this worker (used to chain quality-gate sub-agents). */
  get parent(): Agent {
    return this.parentAgent;
  }

  async execute(task: TaskNode, projectDir?: string, role: SubAgentRole = 'general'): Promise<SubTaskResult> {    if (!this.authorized) {
      preAuthorizeRoot(process.cwd());
      this.authorized = true;
    }

    const roleDef = getSubAgentRole(role);

    const child = new Agent(false);
    child.detailMode = false;
    child.suppressToolOutput = true;
    child.maxTurns = roleDef.maxTurns;

    // Scope the child agent's tools to the role's allowlist (if any)
    if (roleDef.allowedTools && roleDef.allowedTools.length > 0) {
      child.toolAllowlist = new Set(roleDef.allowedTools);
    }

    const outputChunks: string[] = [];

    child.onOutput = (text: string) => {
      outputChunks.push(text);
    };

    child.onEvent = (event) => {
      this.parentAgent.onEvent?.(event);
      if (event.type === 'tool_call_start') {
        this.onProgress?.(task.id, `tool:${event.name}`);
      }
      if (event.type === 'tool_result') {
        this.onProgress?.(task.id, `result:${event.name}`);
      }
    };

    await child.init();

    let dirHint = '';
    if (projectDir) {
      // Make the child agent's exec_command default to the project directory
      child.mcp.workDir = projectDir;
      dirHint =
        `[Project Directory]\n${projectDir}\n\n` +
        `All generated code files MUST be created under the Project Directory above.\n` +
        `Shell commands (exec_command) already run inside this directory by default — ` +
        `do NOT prepend "cd <path>" or run git against the agent's own working directory.\n\n---\n\n`;
    }
    let prompt = `${dirHint}${task.description}`;
    if (roleDef.systemPrompt) {
      child.context.prependToSystem(`[Role: ${roleDef.label}]\n${roleDef.systemPrompt}`);
    }
    await child.chat(prompt);

    await child.shutdown();

    return {
      taskId: task.id,
      output: outputChunks.join(''),
    };
  }
}
