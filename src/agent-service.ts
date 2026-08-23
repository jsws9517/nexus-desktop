/** Loose event shape forwarded from the core to the UI bridge. */
export type AgentEvent = { type: string } & Record<string, unknown>;

import { isWorkerPrompt, KEY_MASK } from './shared/constants.js';
import type { StoredRow } from './session-db.js';
import type { Agent } from 'nexus-coder/dist/src/agent.js';
import type { Config, ProviderConfig } from 'nexus-coder/dist/src/config/types.js';
import type { Session } from 'nexus-coder/dist/src/session/types.js';

/**
 * Headless bridge around the nexus CLI Agent.
 *
 * Reuses the compiled CLI core (dist/src) exactly as the CLI does:
 *  - Agent: streaming turns, tools, MCP, skills, sessions, permissions
 *  - ConfigManager: provider/session/vision/mcp config
 *  - SessionManager: SQLite-backed sessions
 *
 * The only thing this replaces is the TTY UI layer (src/cli/chat.ts).
 * The Agent runs in a plain Node process so native modules
 * (better-sqlite3) keep their system-Node ABI.
 */
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

function maskKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return KEY_MASK;
}

/**
 * Extract a short topic from user input for auto-session-naming.
 * Supports both Chinese and English input.
 * Examples:
 *   "帮我写一个排序算法" → "排序算法"
 *   "Help me write a sorting algorithm" → "Sorting Algorithm"
 */
function extractTopic(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';

  // Detect if input contains Chinese characters
  const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed);

  if (hasChinese) {
    return extractChineseTopic(trimmed);
  } else {
    return extractEnglishTopic(trimmed);
  }
}

function extractChineseTopic(input: string): string {
  // Step 1: Remove common prefix verbs/particles
  const cleaned = input
    .replace(/^(帮我|请帮我|我需要|我想要|我要|需要|给|为|把|让|和|与|来|写|做一个|搞一个|弄一个)/g, '')
    .replace(/^(如何|怎么|怎样|怎么样)/g, '')
    .trim();

  // Step 2: Extract core topic - look for the main noun phrase
  const patterns = [
    // "写个傅里叶变换的python实现代码" → "傅里叶变换"
    /(?:写|做|实现|创建|开发|设计|编写|制作|完成|搞|弄)(?:个|一个|一下|简单的)?\s*(.+?)(?:的python|的java|的js|的typescript|的代码|的功能|的算法|的实现|的程序|的模块|的组件|的接口|的方法|的函数|的脚本|的工具|的系统|的应用|的服务)/,
    // "写个傅里叶变换" → "傅里叶变换"
    /(?:写|做|实现|创建|开发|设计|编写|制作|完成|搞|弄)(?:个|一个|一下|简单的)?\s*(.+?)(?:\s*(?:来|去|要|能)?\s*(?:显示|处理|统计|计算|分析|管理|实现|创建|开发))/,
    /(?:写|做|实现|创建|开发|设计|编写|制作|完成|搞|弄)(?:个|一个|一下|简单的)?\s*(.+)/,
    // "傅里叶变换的python实现" → "傅里叶变换"
    /(.+?)(?:的python|的java|的js|的typescript|的实现|的代码|的功能|的算法|的程序|的模块|的组件|的接口|的方法|的函数|的脚本|的工具|的系统|的应用|的服务)/,
    // "如何实现傅里叶变换" → "傅里叶变换"
    /(?:如何|怎么|怎样)(?:实现|做|写|创建|开发)?\s*(.+)/,
    // "用Python读取Excel" → "Python读取Excel" or "读取Excel"
    /(?:用|使用)\s*(\w[\w\s]*(?:读取|处理|分析|计算|统计|显示|管理)\s*\w+)/,
    // Fallback: extract between 2-15 characters
    /(.{2,15})/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      let topic = match[1].trim();
      // Remove leading particles
      topic = topic.replace(/^(的|个|一个|了|着|地|得|简单的)/, '');
      topic = topic.replace(/(的|了|着|地|得)$/, '');
      // Truncate at action verbs
      topic = topic.replace(/\s*(来|去|要|能)?\s*(显示|处理|统计|计算|分析|管理|实现|创建|开发).*$/, '');
      topic = topic.trim();
      if (topic.length >= 2 && topic.length <= 20) {
        return topic;
      }
    }
  }

  // Final fallback
  return cleaned.slice(0, 20) || input.slice(0, 20);
}

function extractEnglishTopic(input: string): string {
  // Remove common prefix verbs
  const cleaned = input
    .replace(/^(help me |please |can you |I want to |I need to |could you )/i, '')
    .replace(/^(write|create|implement|design|build|make|develop|fix|debug|optimize|refactor|test)/i, '')
    .replace(/\s*(a|an|the|for|to|in|of|with|that|which|and|or)\s*/gi, ' ')
    .trim();

  // Extract core noun phrases
  const patterns = [
    /(?:a|an|the)\s+([\w\s]+?)(?:\s+for\s+.+)?$/i,
    /how to\s+([\w\s]+?)(?:\s+in\s+.+)?$/i,
    /([\w\s]+?)(?:\s+function|algorithm|module|component|feature|code|implementation)/i,
    /([\w]+(?:\s+[\w]+){0,2})/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      // Remove stopwords, keep meaningful words
      const meaningful = match[1]
        .replace(/\b(a|an|the|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|must|shall|can|need|dare|ought|used)\b/gi, '')
        .trim();
      if (meaningful.length > 0) {
        return capitalizeFirst(meaningful.slice(0, 40));
      }
    }
  }

  // Fallback: take first 3 meaningful words
  const words = cleaned.split(/\s+/).filter(w => w.length > 2);
  return capitalizeFirst(words.slice(0, 3).join(' '));
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export class AgentService {
  private agent: Agent | null = null;
  private initialized = false;
  private mcpEnabled = true;
  private pendingPermissions = new Map<string, (answer: string) => void>();
  private nextPermissionId = 1;
  /** Set by a bare `/revise`; the next plain (non-slash) message is the fix
   *  for the revise dialogue instead of a normal chat turn. */
  private pendingRevise = false;

  onEvent?: (event: AgentEvent) => void;
  onPermission?: (req: PermissionRequest) => void;
  onLog?: (level: string, message: string) => void;

  get isReady(): boolean {
    return this.initialized && this.agent !== null;
  }

  get busy(): boolean {
    return this.agent?.isBusy?.() ?? false;
  }

  /**
   * Phase 1 of startup: construct the Agent and wire the event/callback bridges.
   * Config/session/provider are ready the moment the constructor returns, so the
   * session list and message reads can be served while MCP/skills are still
   * connecting in the background. Read-only methods work after this resolves.
   */
  async earlyInit(cwd?: string): Promise<void> {
    if (this.agent) return;
    if (cwd) {
      try {
        process.chdir(cwd);
      } catch (e) {
        this.onLog?.('warn', `chdir failed: ${(e as Error).message}`);
      }
    }

    const { Agent } = await import('nexus-coder/dist/src/agent.js');
    this.agent = new Agent();

    // Route ALL permission prompts to the UI — both the MCP/tool prompt and the
    // path authorization (read_text_file etc.) use this single bridge. The CLI
    // wires the same via setPermissionPrompter; without it the path prompter
    // falls back to a dead stdin readline inside the worker and instantly denies.
    const { setPermissionPrompter } = await import('nexus-coder/dist/src/security/path-authorizer.js');
    setPermissionPrompter((question: string) => this.askPermission(question));

    this.agent.onEvent = (event: AgentEvent) => this.onEvent?.(event);
    // onOutput is used by slash-command and non-streaming paths (e.g. runRemoteSlashCommand's
    // /plan /go /tasks). Surface it as a text event so the renderer displays it.
    this.agent.onOutput = (text: string) => this.onEvent?.({ type: 'text', text });
    this.agent.onPermissionRequest = async (
      toolName: string,
      _toolCallId: string,
      toolArgs: unknown,
    ) => {
      const summary =
        toolArgs && typeof toolArgs === 'object'
          ? JSON.stringify(toolArgs).slice(0, 200)
          : '';
      const answer = await this.askPermission(
        `Tool "${toolName}" requested permission.\nArgs: ${summary}`,
      );
      // 'y' (once) and 'a' (always) both allow; the core has no per-tool
      // persistence so 'a' behaves like a one-time allow here (path prompts
      // still persist 'a' via the path-authorizer's GLOBAL_SCOPE).
      return { verdict: ['y', 'a'].includes(answer.trim().toLowerCase()) ? 'allow' : 'deny' };
    };
    this.onLog?.('info', `Nexus core ready for reads (cwd=${process.cwd()})`);
  }

  /**
   * Phase 2 of startup: full init (skills load + MCP connect). Only chat and
   * mutation methods gate on this — see EARLY_METHODS in main/index.ts.
   *
   * The core's agent.init() bundles MCP connect (sequential) with skills load
   * and ignores the `deferMCP` option. We bypass its sequential connectAll by
   * temporarily clearing cfg.mcpServers (ConfigManager.get() returns the live
   * in-memory object), then connect MCP servers ourselves IN PARALLEL. `defer`
   * chooses whether init waits for MCP (default, false) or returns immediately
   * while MCP connects in the background (true) — see the desktop settings
   * toggle, persisted to ~/.nexus/desktop.json and passed via the worker.
   */
  async init(cwd?: string, opts?: { deferMcp?: boolean }): Promise<void> {
    await this.earlyInit(cwd);
    const agent = this.agent;
    if (!agent) throw new Error('Agent not initialized');
    const defer = !!opts?.deferMcp;
    const cfg = agent.config.get();
    const savedMcp = cfg.mcpServers;
    if (savedMcp) cfg.mcpServers = {};
    try {
      await agent.init();
    } finally {
      if (savedMcp) cfg.mcpServers = savedMcp;
    }
    const enabled = Object.entries(savedMcp ?? {}).filter(([, s]) => s.autoStart !== false);
    if (defer) {
      // Background connect: init resolves immediately, MCP tools appear as
      // each server lands. Failures are logged, never fatal.
      void this.connectMcpParallel(enabled);
    } else {
      await this.connectMcpParallel(enabled);
    }
    this.initialized = true;
    this.onLog?.('info', `Nexus core initialized (cwd=${process.cwd()}, deferMcp=${defer})`);
  }

  /**
   * Connect all auto-start MCP servers concurrently. Each server's own latency
   * is no longer summed — the phase completes when the slowest server is done.
   * connectServer is idempotent per name and catches per-server failures.
   */
  private async connectMcpParallel(
    enabled: Array<[string, NonNullable<Config['mcpServers']>[string]]>,
  ): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    if (enabled.length === 0) return;
    const t0 = Date.now();
    const results = await Promise.allSettled(
      enabled.map(async ([name, srv]) => {
        try {
          await agent.mcp.connectServer(name, srv);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.onLog?.('warn', `MCP "${name}" connect failed: ${msg}`);
        }
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    this.onLog?.('info', `MCP connect done: ${enabled.length - failed}/${enabled.length} servers in ${Date.now() - t0}ms`);
  }

  async shutdown(): Promise<void> {
    const agent = this.agent;
    if (agent) await agent.shutdown();
    this.initialized = false;
    this.agent = null;
  }

  private persistUserInput(input: string): void {
    const agent = this.agent;
    if (!agent) return;
    const sid = agent.getCurrentSessionId?.();
    if (!sid) return;
    try {
      agent.session.addMessage(sid, { role: 'user', content: input });
    } catch (e) {
      this.onLog?.('warn', `Persist user input failed: ${(e as Error).message}`);
    }
  }

  /**
   * Slash commands (e.g. /plan /go /tasks) are intercepted by the core's chat()
   * and return BEFORE the user message is persisted to the session DB, so the
   * transcript would otherwise miss them. Persist the raw input ourselves so
   * history/resume matches what the user actually typed. Persisted BEFORE the
   * turn so the row lands ahead of any sub-agent worker blocks that /go spawns.
   */
  private persistSlashInput(input: string): void {
    if (!input.trim().startsWith('/')) return;
    this.persistUserInput(input);
  }

  async chat(input: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy()) throw new Error('Agent is busy');
    // chat() resolves pending askUser with the next user input, otherwise runs a turn
    this.persistSlashInput(input);
    const bridged = await this.handleDagCommand(input);
    if (bridged) return;

    // Auto-name session on first user message
    const sid = this.agent.getCurrentSessionId?.();
    if (sid) {
      try {
        const session = this.agent.session.get(sid);
        if (session && input.trim().length > 0) {
          // Check if session has default name (time-based format) or no name
          const hasDefaultName = !session.name || 
            session.name.trim() === '' ||
            /^Session \d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/.test(session.name);
          
          if (hasDefaultName) {
            const autoName = extractTopic(input.trim());
            if (autoName) {
              this.agent.session.rename(sid, autoName);
              this.onEvent?.({ type: 'sessionRenamed', sessionId: sid, name: autoName });
            }
          }
        }
      } catch (err) {
        // Log error for debugging but don't throw (non-critical feature)
        this.onLog?.('debug', `Auto-rename failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.agent.chat(input);
  }

  // ---------------------------------------------------------------- DAG bridge
  // /commit, /revise and /go --loop are implemented on the interactive CLI path
  // only (src/cli/chat.ts); the core's runRemoteSlashCommand allowlist rejects
  // them over a remote channel. This desktop-side bridge routes them straight
  // onto the core's public plan methods so the desktop gets the same behaviour
  // with zero core changes.

  /** Parse a `/cmd args` line. Returns null for non-slash / malformed input. */
  private parseSlash(input: string): { cmd: string; args: string[] } | null {
    if (!input.startsWith('/')) return null;
    const parts = input.split(/\s+/);
    const raw = parts[0] ?? '';
    if (raw.length <= 1) return null;
    return { cmd: raw.slice(1).toLowerCase(), args: parts.slice(1) };
  }

  private emitText(text: string): void {
    this.onEvent?.({ type: 'text', text });
  }

  /** Returns true when the input was consumed by the DAG bridge. */
  private async handleDagCommand(input: string): Promise<boolean> {
    if (!this.agent) return false;
    const trimmed = input.trim();
    const parsed = this.parseSlash(trimmed);
    if (!parsed) {
      // Bare /revise armed revise mode — the next plain message is the fix.
      if (this.pendingRevise) {
        this.pendingRevise = false;
        this.persistUserInput(trimmed);
        await this.runRevise(trimmed);
        return true;
      }
      return false;
    }
    // Any slash command cancels a pending bare-/revise prompt.
    this.pendingRevise = false;
    const { cmd, args } = parsed;
    if (cmd === 'revise') {
      await this.runRevise(args.join(' ').trim());
      return true;
    }
    if (cmd === 'commit') {
      await this.runPlanExecution(args, true);
      return true;
    }
    if (cmd === 'go' && args.some((a) => a.startsWith('--loop'))) {
      await this.runPlanExecution(args, false);
      return true;
    }
    if (cmd === 'rename') {
      const newName = args.join(' ').trim();
      if (newName) {
        const sid = this.agent.getCurrentSessionId?.();
        if (sid) {
          this.agent.session.rename(sid, newName);
          this.emitText(`Session renamed to: ${newName}\n`);
          this.onEvent?.({ type: 'sessionRenamed', sessionId: sid, name: newName });
        }
      } else {
        this.emitText('Usage: /rename <new name>\n');
      }
      return true;
    }
    return false;
  }

  private async runRevise(instruction: string): Promise<void> {
    if (!this.agent) return;
    if (!this.agent.currentPlan) {
      this.emitText('No plan to revise. Use /plan <request>, then /go, then /revise.\n');
      return;
    }
    this.agent.enterReviseMode?.();
    if (instruction) {
      try {
        await this.agent.revisePlan(instruction);
      } catch (err) {
        this.emitText(`Revision failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } else {
      this.pendingRevise = true;
      this.emitText(
        'Entering revise mode. Describe how to fix the failed breakpoint; the failed subgraph will be re-planned. /go to re-run, or /revise <fix> to revise inline.\n',
      );
    }
  }

  /** Shared /commit + /go --loop execution path (plan resolution incl. redo). */
  private async runPlanExecution(args: string[], commit: boolean): Promise<void> {
    if (!this.agent) return;
    const redo = args.includes('redo');
    let plan = this.agent.currentPlan;
    const sid = this.agent.getCurrentSessionId?.();
    if (!plan) {
      if (sid) {
        plan = this.agent.tracker.getGraphBySession(sid);
        if (plan) this.agent.currentPlan = plan;
      }
    } else if (!redo) {
      const hasWork = plan.nodes.some(
        (n: { status: string }) => n.status !== 'completed' && n.status !== 'cancelled',
      );
      if (!hasWork && sid) {
        const sessionGraph = this.agent.tracker.getGraphBySession(sid);
        if (sessionGraph && sessionGraph.id !== plan.id) {
          plan = sessionGraph;
          this.agent.currentPlan = sessionGraph;
        }
      }
    }
    if (!plan) {
      this.emitText('? No plan found. Use /plan <request> first.\n');
      return;
    }
    if (commit) this.agent.exitPlanMode?.();
    if (redo) {
      for (const n of plan.nodes) {
        n.status = 'pending';
        n.result = undefined;
        n.error = undefined;
        n.retryCount = 0;
        n.updatedAt = Date.now();
      }
      this.agent.tracker.updateGraph(plan);
      this.emitText(`? Reset ${plan.nodes.length} tasks to pending for redo.\n`);
    }
    const completed = plan.nodes.filter((n: { status: string }) => n.status === 'completed').length;
    const failed = plan.nodes.filter((n: { status: string }) => n.status === 'failed').length;
    const pending = plan.nodes.filter(
      (n: { status: string }) => n.status === 'pending' || n.status === 'in_progress',
    ).length;
    if (completed > 0) {
      this.emitText(`Resuming ? ${completed} done, ${failed} failed, ${pending} remaining.\n`);
    }
    this.emitText('Executing plan...\n');
    try {
      const result = await this.runPlanWithLoop(args);
      this.emitText(`? ${result}\n`);
    } catch (err) {
      this.emitText(`? Execution failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  /**
   * Run the current plan, honoring `/go --loop[=N|∞|config]` (mirrors the CLI
   * parse in src/cli/chat.ts). `--loop=0` → single run; `--loop`/`--loop=config`
   * → config loop.maxRounds; `--loop=∞/-1` → unlimited.
   */
  private async runPlanWithLoop(args: string[]): Promise<string> {
    const loopArg = args.find((a) => a.startsWith('--loop'));
    let loopOverride: number | null = null;
    if (loopArg) {
      let raw = loopArg.includes('=') ? loopArg.slice('--loop'.length + 1) : '';
      if (!raw) {
        const i = args.indexOf(loopArg);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) raw = next;
      }
      if (raw === '' || raw === 'config') {
        loopOverride = null;
      } else if (raw === '∞' || raw === 'inf' || raw === 'infinity' || raw === '-1') {
        loopOverride = -1;
      } else {
        const n = Number.parseInt(raw, 10);
        loopOverride = Number.isInteger(n) ? n : null;
      }
    }
    const agent = this.agent;
    if (!agent) return 'Execution failed: agent not initialized';
    const loopCfg = agent.config.getLoopConfig();
    const maxRounds = loopOverride ?? loopCfg.maxRounds;
    return maxRounds !== 0
      ? await agent.executePlanWithLoop(maxRounds)
      : await agent.executePlan();
  }
  // ---------------------------------------------------------------------- end

  abort(): void {
    this.agent?.abort?.();
  }

  /**
   * Regenerate the assistant turn that follows the user message at `userIndex`
   * (0-based over persisted user messages, skipping sub-agent worker blocks).
   *
   * Desktop-only implementation — the core branch is untouched:
   *   1. read message rows directly from ~/.nexus/sessions.db,
   *   2. delete the target user message and everything after it,
   *   3. reload the agent's LLM context from the (now truncated) DB via
   *      startSession(sessionId),
   *   4. re-run the target prompt through chat() — which re-inserts the user
   *      message once, so the DB never accumulates a duplicate.
   */
  async regenerate(sessionId: string, userIndex: number): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy())
      throw new Error('Agent is busy; wait for the current turn to finish');
    if (this.agent.getCurrentSessionId() !== sessionId) {
      throw new Error('Session mismatch: target session is not the active one');
    }
    const { getMessageRows, deleteMessagesFrom } = await import('./session-db.js');
    const userRows = getMessageRows(sessionId).filter((r) => r.role === 'user' && !isWorkerPrompt(r));
    const target = userRows[userIndex];
    if (!target) throw new Error(`Regenerate: no user message at index ${userIndex}`);
    deleteMessagesFrom(sessionId, target.id);
    // NOTE: core signature is startSession(name?, sessionId?) — passing the id
    // in the first slot would CREATE a new session named after the id instead
    // of reloading the truncated one from the DB.
    await this.agent.startSession(undefined, sessionId);
    await this.chat(target.content);
  }

  /**
   * Withdraw a past user message: delete it and everything after it from the
   * session, then reload the agent's LLM context from the truncated DB — WITHOUT
   * re-running. Returns the withdrawn prompt text so the UI can paste it back
   * into the input box for the user to fix and resubmit. Mirrors regenerate()
   * minus the chat() re-run.
   */
  async withdraw(sessionId: string, userIndex: number): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy())
      throw new Error('Agent is busy; wait for the current turn to finish');
    if (this.agent.getCurrentSessionId() !== sessionId) {
      throw new Error('Session mismatch: target session is not the active one');
    }
    const { getMessageRows, deleteMessagesFrom } = await import('./session-db.js');
    const userRows = getMessageRows(sessionId).filter((r) => r.role === 'user' && !isWorkerPrompt(r));
    const target = userRows[userIndex];
    if (!target) throw new Error(`Withdraw: no user message at index ${userIndex}`);
    deleteMessagesFrom(sessionId, target.id);
    await this.agent.startSession(undefined, sessionId);
    return target.content;
  }

  /**
   * Per-session MCP switch. Disabling disconnects the MCP servers so their
   * tools leave the toolset for subsequent turns; enabling reconnects them.
   */
  async setMcpEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.agent) return { ok: false, error: 'Agent not initialized' };
    if (enabled === this.mcpEnabled) return { ok: true };
    try {
      if (enabled) {
        const cfg = this.agent.config.get();
        await this.agent.mcp.connectAll(cfg.mcpServers ?? {});
      } else {
        await this.agent.mcp.disconnect();
      }
      this.mcpEnabled = enabled;
      this.onLog?.('info', `MCP ${enabled ? 'enabled' : 'disabled'}`);
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.onLog?.('warn', `MCP toggle failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  getMcpStatus(): { enabled: boolean; servers: Array<Record<string, unknown>> } {
    const servers = (this.agent?.mcp?.listConnections?.() ?? []).map((c: Record<string, unknown>) => ({
      name: c.name,
      toolCount: c.toolCount,
      status: c.status,
    }));
    return {
      enabled: servers.length > 0,
      servers,
    };
  }

  /**
   * Registered MCP servers from config, with live connection state.
   */
  getMcpServers(): Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string; stderr?: string }> {
    if (!this.agent) return [];
    const cfg = this.agent.config.get();
    const connectedMap = new Map<string, Record<string, unknown>>(
      (this.agent.mcp.listConnections?.() ?? []).map((c: Record<string, unknown>) => [
        c.name as string,
        c,
      ]),
    );
    const errors = new Map<string, Record<string, unknown>>(
      (this.agent.mcp.getServerErrors?.() ?? []).map((c: Record<string, unknown>) => [
        c.name as string,
        c,
      ]),
    );
    return Object.entries(cfg.mcpServers ?? {}).map(([name, s]: [string, Record<string, unknown>]) => ({
      name,
      autoStart: s.autoStart !== false,
      connected: connectedMap.has(name),
      toolCount: Number(connectedMap.get(name)?.toolCount ?? 0),
      error: errors.get(name)?.error as string | undefined,
      stderr: errors.get(name)?.stderr as string | undefined,
    }));
  }

  /**
   * Toggle a single MCP server. Idempotent: connects only when disconnected,
   * disconnects only when connected.
   */
  async setMcpServer(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.agent) return { ok: false, error: 'Agent not initialized' };
    try {
      const connected = (this.agent.mcp.listConnections?.() ?? []).some(
        (c: Record<string, unknown>) => c.name === name,
      );
      if (enabled && !connected) {
        const cfg = this.agent.config.get();
        const srv = cfg.mcpServers?.[name];
        if (!srv) return { ok: false, error: `MCP server "${name}" not configured` };
        await this.agent.mcp.connectServer(name, srv);
        this.onLog?.('info', `MCP server "${name}" connected (${srv.command})`);
      } else if (!enabled && connected) {
        await this.agent.mcp.disconnect(name);
        this.onLog?.('info', `MCP server "${name}" disconnected`);
      }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.onLog?.('warn', `MCP server "${name}" toggle failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  async startSession(name?: string, sessionId?: string, metadata?: Record<string, unknown>): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.pendingRevise = false;
    return this.agent.startSession(name, sessionId, metadata);
  }

  async listSessions(options?: { limit?: number; offset?: number; excludeMock?: boolean; excludeEmpty?: boolean; search?: string }): Promise<{ items: Session[]; total: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const limit = options?.limit;
    const offset = options?.offset ?? 0;
    const q = options?.search?.trim().toLowerCase();
    if (!options?.excludeMock && !options?.excludeEmpty && !q) {
      return this.agent.session.list({ limit, offset });
    }
    // Desktop-side filtering (the core SQL is untouched): fetch the full
    // candidate set, apply the filters, then slice + recount so pagination and
    // the page numbers stay exact for the filtered list.
    const all = this.agent.session.list({}).items ?? [];
    let items = all;
    if (options?.excludeMock) {
      // Inner-test/beta sessions use mock models (model id contains "mock").
      items = items.filter((s) => !/mock/i.test(String(s.model ?? '')));
    }
    if (options?.excludeEmpty) {
      // Skip empty-context sessions (CLI scratch / AI-intermediary noise).
      const { getNonEmptySessionIds } = await import('./session-db.js');
      const nonEmpty = getNonEmptySessionIds();
      items = items.filter((s) => nonEmpty.has(String(s.id)));
    }
    if (q) {
      items = items.filter((s) => {
        const name = String(s.name ?? '').toLowerCase();
        const id = String(s.id ?? '').toLowerCase();
        return name.includes(q) || id.includes(q);
      });
    }
    const total = items.length;
    const sliced = limit !== undefined && limit >= 0 ? items.slice(offset, offset + limit) : items.slice(offset);
    return { items: sliced, total };
  }

  /**
   * Windowed message reads for a session. Returns `{ items, total, userBefore }`
   * so the renderer can paginate history (bounded DOM + IPC) while keeping
   * regenerate()'s user index stable: `userBefore` is the count of user-role
   * rows before the returned slice, which the renderer adds to its local
   * counter to reconstruct global user indices.
   *
   * - `{ last: N }` — the N newest rows.
   * - `{ limit, offset }` — an arbitrary window (offset is 0-based over the
   *   full, oldest→newest row list).
   */
  async getMessages(
    sessionId: string,
    options?: { last?: number; limit?: number; offset?: number },
  ): Promise<{ items: StoredRow[]; total: number; userBefore: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    // SQL-windowed reads (src/session-db.ts) so a long session never loads
    // every row into memory just to paginate.
    const { getMessageWindow, getMessageLast } = await import('./session-db.js');
    if (options?.last !== undefined) {
      const w = getMessageLast(sessionId, options.last);
      return { items: w.items, total: w.total, userBefore: w.userBefore };
    }
    const limit = options?.limit ?? 500;
    const offset = options?.offset ?? 0;
    const w = getMessageWindow(sessionId, offset, limit);
    return { items: w.items, total: w.total, userBefore: w.userBefore };
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.agent.deleteSession(id);
  }

  async renameSession(id: string, name: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.agent.session.rename(id, name);
  }

  async switchProvider(name: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    await this.agent.switchProvider(name);
  }

  async switchModel(modelId: string): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');
    return this.agent.switchModel(modelId);
  }

  async setCwd(cwd: string): Promise<void> {
    if (!cwd) return;
    process.chdir(cwd);
    this.onLog?.('info', `Project directory set to ${cwd}`);
  }

  getCwd(): string {
    return process.cwd();
  }

  getProviders(): ProviderInfo[] {
    if (!this.agent) return [];
    const cfg = this.agent.config.get();
    const active = cfg.activeProvider;
    return Object.entries(cfg.providers ?? {}).map(([name, p]: [string, ProviderConfig]) => ({
      name,
      type: p.type,
      model: p.model,
      baseUrl: p.baseUrl,
      hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    }));
  }

  getActiveProvider(): string {
    return this.agent?.config?.getActiveProvider?.() ?? '';
  }

  getActiveModel(): string {
    return this.agent?.provider?.model ?? '';
  }

  /**
   * Fetch the model list for a provider from its API (OpenAI-compatible
   * GET /models, Anthropic GET /v1/models). Falls back to the configured
   * model alone when the API is unreachable or the key is missing.
   */
  async getModels(providerName?: string): Promise<string[]> {
    if (!this.agent) return [];
    let provider: { type: string; apiKey?: string; baseUrl?: string; model?: string } | undefined;
    try {
      provider = this.agent.config.getProvider(providerName);
    } catch {
      provider = undefined;
    }
    const fallback = (): string[] => {
      const m = this.agent?.provider?.model;
      return m ? [String(m)] : [];
    };
    if (!provider || typeof provider.apiKey !== 'string' || provider.apiKey.length === 0) {
      return fallback();
    }
    // getProvider() returns an in-memory encrypted blob (mem:/enc:). Decrypt it
    // to the real key — sending the blob as the Bearer token yields 401 even
    // though the stored key is valid (createProvider does the same).
    let apiKey: string;
    try {
      const { decryptApiKey } = await import('nexus-coder/dist/src/security/env-key-encrypt.js');
      apiKey = decryptApiKey(provider.apiKey);
    } catch {
      apiKey = provider.apiKey;
    }
    if (!apiKey) return fallback();
    const type = provider.type || 'openai';
    const base = (provider.baseUrl || (type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
    try {
      let json: { data?: Array<{ id: string }> } | null = null;
      if (type === 'anthropic') {
        const res = await fetch(`${base}/v1/models`, {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = (await res.json()) as { data?: Array<{ id: string }> };
      } else {
        const res = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = (await res.json()) as { data?: Array<{ id: string }> };
      }
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean);
      return ids.length > 0 ? ids : fallback();
    } catch {
      return fallback();
    }
  }

  getPermissions(): { mode: string; allowlist: string[]; safePaths: string[]; mcpAllowlist: string[] } {
    if (!this.agent?.config?.getPermissions) {
      return { mode: 'prompt', allowlist: [], safePaths: [], mcpAllowlist: [] };
    }
    return this.agent.config.getPermissions();
  }

  getLanguage(): string {
    return this.agent?.config?.getLanguage?.() ?? 'en';
  }

  /**
   * Re-read config.json into the agent's in-memory ConfigManager. Called after
   * the config Web UI writes to disk so the long-lived copy (used by every
   * config getter/setter) does not go stale or clobber disk on the next save.
   */
  reloadConfig(): { ok: boolean } {
    if (!this.agent?.config) return { ok: false };
    this.agent.config.reload?.();
    return { ok: true };
  }

  /** Speech (STT/TTS) + vision provider config with masked keys and active selection. */
  getSpeechVisionConfig(): Record<string, unknown> {
    if (!this.agent?.config) return {};
    const cfg = this.agent.config;
    const speech: Array<Record<string, unknown>> = Object.entries(
      (cfg.getSpeechProviders?.() ?? {}) as Record<string, Record<string, unknown>>,
    ).map(([name, p]) => ({
      name,
      category: p.category ?? 'stt',
      model: p.model ?? '',
      baseUrl: p.baseUrl ?? '',
      voice: p.voice ?? '',
      hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    }));
    const vision: Array<Record<string, unknown>> = Object.entries(
      (cfg.getVisionProviders?.() ?? {}) as Record<string, Record<string, unknown>>,
    ).map(([name, p]) => ({
      name,
      model: p.model ?? '',
      baseUrl: p.baseUrl ?? '',
      hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    }));
    return {
      activeSpeech: cfg.getActiveSpeechProvider?.() ?? '',
      activeTts: cfg.getActiveTtsProvider?.() ?? '',
      activeVision: cfg.getActiveVisionProvider?.() ?? 'glm-4v',
      speechProviders: speech,
      visionProviders: vision,
    };
  }

  setActiveSpeechProvider(name: string): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    this.agent.config.setActiveSpeechProvider(name);
  }

  setActiveTtsProvider(name: string): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    this.agent.config.setActiveTtsProvider(name);
  }

  setActiveVisionProvider(name: string): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    this.agent.config.setActiveVisionProvider(name);
  }

  saveSpeechProvider(name: string, fields: { apiKey?: string; model?: string; baseUrl?: string; category?: string; voice?: string }): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    const cfg = this.agent.config;
    const existing = (cfg.getSpeechProviders?.()?.[name] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl !== undefined ? fields.baseUrl : existing.baseUrl ?? '',
      model: fields.model !== undefined && fields.model !== '' ? fields.model : existing.model ?? '',
      category: fields.category ?? existing.category ?? 'stt',
      voice: fields.voice ?? existing.voice ?? '',
    };
    if (fields.apiKey && fields.apiKey !== KEY_MASK) {
      next.apiKey = fields.apiKey;
    }
    cfg.setSpeechProvider(name, next as Parameters<typeof cfg.setSpeechProvider>[1]);
  }

  saveVisionProvider(name: string, fields: { apiKey?: string; model?: string; baseUrl?: string }): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    const cfg = this.agent.config;
    const existing = (cfg.getVisionProviders?.()?.[name] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl !== undefined ? fields.baseUrl : existing.baseUrl ?? '',
      model: fields.model !== undefined && fields.model !== '' ? fields.model : existing.model ?? '',
    };
    if (fields.apiKey && fields.apiKey !== KEY_MASK) {
      next.apiKey = fields.apiKey;
    }
    cfg.setVisionProvider(name, next as Parameters<typeof cfg.setVisionProvider>[1]);
  }

  /** Cumulative token estimate for a session. Windowed batches over the SQL DB
   *  keep memory bounded for very long sessions; tokenizer falls back to the
   *  core's char/4 heuristic when the active provider has no countTokens. */
  async getSessionStats(sessionId: string): Promise<{ tokenEstimate: number; messageCount: number }> {
    if (!this.agent?.session) return { tokenEstimate: 0, messageCount: 0 };
    const { getMessageCount, estimateSessionTokens } = await import('./session-db.js');
    const provider = this.agent.provider;
    const estimate = estimateSessionTokens(
      sessionId,
      (content, thinking) => {
        const count = (s: string): number => (provider?.countTokens ? provider.countTokens(s) : Math.ceil(s.length / 4)) || 0;
        return count(content ?? '') + (thinking ? count(thinking) : 0);
      },
      500,
    );
    return { tokenEstimate: estimate, messageCount: getMessageCount(sessionId) };
  }

  getConfig(): Record<string, unknown> {
    if (!this.agent) return {};
    const cfg = this.agent.config.get();
    return redactConfig(cfg);
  }

  saveProvider(
    name: string,
    fields: { type?: string; apiKey?: string; model?: string; baseUrl?: string; options?: Record<string, unknown> },
  ): void {
    if (!this.agent) throw new Error('Agent not initialized');
    const cfg = this.agent.config;
    const cur = cfg.get();
    const existing = cur.providers?.[name] ?? {};
    const next: Record<string, unknown> = {
      type: fields.type ?? existing.type ?? 'openai',
      model: fields.model ?? existing.model ?? '',
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl ?? existing.baseUrl,
      options: fields.options ?? existing.options ?? {},
    };
    if (fields.apiKey && fields.apiKey !== KEY_MASK) {
      next.apiKey = fields.apiKey;
    }
    cfg.setProvider(name, next as Parameters<typeof cfg.setProvider>[1]);
  }

  async resolvePermission(id: string, answer: string): Promise<void> {
    const resolve = this.pendingPermissions.get(id);
    if (resolve) {
      this.pendingPermissions.delete(id);
      resolve(answer);
    } else {
      this.onLog?.('warn', `resolvePermission: no pending prompt for id=${id}`);
    }
  }

  /** Bridge for __nexusPermissionPrompter / onPermissionRequest. Returns 'y'|''. */
  private askPermission(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = String(this.nextPermissionId++);
      this.pendingPermissions.set(id, resolve);
      this.onPermission?.({ id, question: cleanQuestion(question) });
    });
  }
}

/** Strip ANSI color codes + trailing CLI option hint ("[y] once [a] always [n] deny") from core prompt text. */
function cleanQuestion(raw: string): string {
  const noAnsi = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const trimmed = noAnsi.replace(/\s+/g, ' ').trim();
  return trimmed
    .replace(/\s*\[\s*y\s*\]\s*once\s*\[\s*a\s*\]\s*always\s*\[\s*n\s*\]\s*deny\s*$/i, '')
    .trim();
}

type ProviderGroup = Record<string, { apiKey?: string; [k: string]: unknown }>;

function redactConfig(cfg: Config): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(cfg)) as {
    providers?: ProviderGroup;
    visionProviders?: ProviderGroup;
    ocrProviders?: ProviderGroup;
    speechProviders?: ProviderGroup;
  };
  const maskGroups: Array<ProviderGroup | undefined> = [
    out.providers,
    out.visionProviders,
    out.ocrProviders,
    out.speechProviders,
  ];
  for (const group of maskGroups) {
    if (!group) continue;
    for (const p of Object.values(group)) {
      if (p.apiKey) p.apiKey = maskKey(p.apiKey);
    }
  }
  return out as unknown as Record<string, unknown>;
}
