import { Agent } from '../agent.js';
import { TaskNode, SubTaskResult } from './types.js';
import { preAuthorizeRoot } from '../security/path-authorizer.js';

export class SubAgentWorker {
  private authorized = false;

  constructor(
    private parentAgent: Agent,
    private onProgress?: (taskId: string, event: string) => void,
  ) {}

  async execute(task: TaskNode, projectDir?: string): Promise<SubTaskResult> {
    if (!this.authorized) {
      preAuthorizeRoot(process.cwd());
      this.authorized = true;
    }

    const child = new Agent();
    child.detailMode = false;
    child.suppressToolOutput = true;
    child.maxTurns = 10;

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
    await child.chat(`${dirHint}${task.description}`);

    await child.shutdown();

    return {
      taskId: task.id,
      output: outputChunks.join(''),
    };
  }
}
