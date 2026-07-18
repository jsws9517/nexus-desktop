import { Agent } from '../agent.js';
import { TaskNode, SubTaskResult, SubAgentRole, GraphMode } from './types.js';
import { getSubAgentRole } from './sub-agent-roles.js';

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

  async execute(
    task: TaskNode,
    projectDir?: string,
    role: SubAgentRole = 'general',
    priorResults?: Record<string, string>,
    rootRequest?: string,
    mode?: GraphMode,
  ): Promise<SubTaskResult> {
    if (!this.authorized) {
      // NOTE: the project's cwd is already an implicit authorized root in
      // checkPathAllowed(), so no explicit pre-authorization is needed here.
      // We deliberately do NOT pre-authorize anything globally, to avoid the
      // process-wide grant accumulation that previously let sub-agent scopes
      // leak to unrelated tools (M5). Per-sub-agent grants, if any, should use
      // a dedicated scope released on completion.
      this.authorized = true;
    }

    const roleDef = getSubAgentRole(role);

    const child = new Agent(false);
    child.detailMode = false;
    child.suppressToolOutput = true;
    child.maxTurns = roleDef.maxTurns;

    // Inherit the parent's live permission configuration (mode / allowlist /
    // safePaths / mcpAllowlist) so that autonomous runs (e.g. /go, which
    // temporarily switches the parent to auto-whitelist) flow into sub-agents
    // without re-prompting for every tool. This mirrors the parent's in-memory
    // state and is never persisted by the child.
    const parentPerms = this.parentAgent.config.getPermissions();
    if (parentPerms.mode === 'auto') {
      child.config.setPermissionsInMemory({
        mode: parentPerms.mode,
        allowlist: [...parentPerms.allowlist],
        safePaths: [...parentPerms.safePaths],
        mcpAllowlist: [...parentPerms.mcpAllowlist],
      });
    }
    // Sub-agents need a generous context window to read files and iterate
    child.context.setMaxContextTokens(128000);

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

    const sections: string[] = [];

    if (projectDir) {
      // workDir = parent CWD so relative paths (e.g. @../../foo/bar.py) resolve
      // correctly against the same working directory the user sees.
      child.mcp.workDir = process.cwd();
      const isNew = mode === 'new' || !mode;
      sections.push(
        `[Project Directory]\n${projectDir}\n\n` +
        `[Mode: ${mode || 'new'}]\n\n` +
        (isNew
          ? `This is a GREENFIELD project. ALL generated code files MUST be placed ` +
            `under the Project Directory above. Do NOT modify files outside the sandbox.\n`
          : `This is a MODIFY-EXISTING task. Edit source files IN-PLACE using their ` +
            `absolute or relative-to-CWD paths. NEW supporting files can go to the ` +
            `Project Directory above. A git snapshot will be created automatically ` +
            `for rollback safety.\n`) +
        `Shell commands (exec_command) run inside the parent working directory ` +
        `(${process.cwd()}) by default — do NOT prepend "cd <path>" or run git against ` +
        `the agent's own working directory.\n\n---\n`);
    }

    if (rootRequest) {
      sections.push(
        `[Original Request]\n${rootRequest}\n\n---\n`);
    }

    if (priorResults) {
      const keys = Object.keys(priorResults);
      if (keys.length > 0) {
        const parts: string[] = ['[Prior Task Results]'];
        for (const taskId of keys) {
          const result = priorResults[taskId];
          const snippet = result.length > 1200
            ? result.slice(0, 600) + '\n...(中间截断, 共' + result.length + '字符)...\n' + result.slice(-500)
            : result;
          parts.push(`\n--- ${taskId} ---\n${snippet}`);
        }
        parts.push('\n---\n');
        sections.push(parts.join(''));
      }
    }

    const rolePrefix = roleDef.systemPrompt
      ? `[Role: ${roleDef.label}]\n${roleDef.systemPrompt}\n\n---\n\n`
      : '';
    let prompt = sections.join('\n\n') + '\n\n' + rolePrefix + task.description;

    await child.chat(prompt);

    await child.shutdown();

    return {
      taskId: task.id,
      output: outputChunks.join(''),
    };
  }
}
