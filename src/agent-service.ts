/** Loose event shape forwarded from the core to the UI bridge. */
export type AgentEvent = { type: string } & Record<string, unknown>;

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

export const KEY_MASK = '••••••••••••';

/** Worker blocks (sub-agent dispatch) start with these markers. They are skipped
 *  from display AND from regenerate()'s user index, so the desktop's numbering
 *  matches the core's. */
const WORKER_MARKERS = ['[Project Directory]', '[Original Request]', '[Prior Task Results]', '[Role:'];
function isWorkerPrompt(m: { role?: string; content?: unknown }): boolean {
  if (m.role !== 'user') return false;
  const head = String(m.content ?? '').slice(0, 200);
  return WORKER_MARKERS.some((mk) => head.includes(mk));
}

function maskKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return KEY_MASK;
}

export class AgentService {
  private agent: any = null;
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
      return { verdict: answer.trim().toLowerCase() === 'y' ? 'allow' : 'deny' };
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
    const defer = !!opts?.deferMcp;
    const cfg = this.agent.config.get();
    const savedMcp = cfg.mcpServers;
    if (savedMcp) cfg.mcpServers = {};
    try {
      await this.agent.init();
    } finally {
      if (savedMcp) cfg.mcpServers = savedMcp;
    }
    const enabled = (Object.entries(savedMcp ?? {}) as Array<[string, { autoStart?: boolean } & Record<string, unknown>]>)
      .filter(([, s]) => s.autoStart !== false);
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
  private async connectMcpParallel(enabled: Array<[string, { autoStart?: boolean } & Record<string, unknown>]>): Promise<void> {
    if (enabled.length === 0) return;
    const t0 = Date.now();
    const results = await Promise.allSettled(
      enabled.map(async ([name, srv]) => {
        try {
          await this.agent.mcp.connectServer(name, srv);
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
    if (this.agent) await this.agent.shutdown();
    this.initialized = false;
    this.agent = null;
  }

  private persistUserInput(input: string): void {
    const sid = this.agent?.currentSessionId;
    if (!sid) return;
    try {
      this.agent.session.addMessage(sid, { role: 'user', content: input });
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
    const loopCfg = this.agent.config.getLoopConfig();
    const maxRounds = loopOverride ?? loopCfg.maxRounds;
    return maxRounds !== 0
      ? await this.agent.executePlanWithLoop(maxRounds)
      : await this.agent.executePlan();
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
    if (this.agent.currentSessionId !== sessionId) {
      throw new Error('Session mismatch: target session is not the active one');
    }
    const { getMessageRows, deleteMessagesFrom } = await import('./session-truncate.js');
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
    if (this.agent.currentSessionId !== sessionId) {
      throw new Error('Session mismatch: target session is not the active one');
    }
    const { getMessageRows, deleteMessagesFrom } = await import('./session-truncate.js');
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
    return Object.entries(cfg.mcpServers ?? {}).map(([name, s]: [string, any]) => ({
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

  async listSessions(options?: { limit?: number; offset?: number; excludeMock?: boolean; excludeEmpty?: boolean }): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const limit = options?.limit;
    const offset = options?.offset ?? 0;
    if (!options?.excludeMock && !options?.excludeEmpty) {
      return this.agent.session.list({ limit, offset });
    }
    // Desktop-side filtering (the core SQL is untouched): fetch the full
    // candidate set, apply the filters, then slice + recount so pagination and
    // the page numbers stay exact for the filtered list.
    const all = (this.agent.session.list({}).items ?? []) as Array<Record<string, unknown>>;
    let items = all;
    if (options?.excludeMock) {
      // Inner-test/beta sessions use mock models (model id contains "mock").
      items = items.filter((s) => !/mock/i.test(String(s.model ?? '')));
    }
    if (options?.excludeEmpty) {
      // Skip empty-context sessions (CLI scratch / AI-intermediary noise).
      const { getNonEmptySessionIds } = await import('./session-truncate.js');
      const nonEmpty = getNonEmptySessionIds();
      items = items.filter((s) => nonEmpty.has(String(s.id)));
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
  ): Promise<{ items: Array<Record<string, unknown>>; total: number; userBefore: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const all = this.agent.session.getMessages(sessionId) as Array<Record<string, unknown>>;
    let slice = all;
    let offset = 0;
    if (options?.last !== undefined) {
      offset = Math.max(0, all.length - options.last);
      slice = all.slice(offset);
    } else if (options?.limit !== undefined) {
      offset = options.offset ?? 0;
      slice = all.slice(offset, offset + options.limit);
    }
    const userBefore = all.slice(0, offset).filter((m) => m.role === 'user' && !isWorkerPrompt(m)).length;
    return { items: slice, total: all.length, userBefore };
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
    return Object.entries(cfg.providers ?? {}).map(([name, p]: [string, any]) => ({
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
      (cfg.getSpeechProviders?.() ?? {}) as Record<string, any>,
    ).map(([name, p]) => ({
      name,
      category: p.category ?? 'stt',
      model: p.model ?? '',
      baseUrl: p.baseUrl ?? '',
      voice: p.voice ?? '',
      hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    }));
    const vision: Array<Record<string, unknown>> = Object.entries(
      (cfg.getVisionProviders?.() ?? {}) as Record<string, any>,
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
    const existing = (this.agent.config.getSpeechProviders?.()?.[name] ?? {}) as Record<string, unknown>;
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
    this.agent.config.setSpeechProvider(name, next as any);
  }

  saveVisionProvider(name: string, fields: { apiKey?: string; model?: string; baseUrl?: string }): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    const existing = (this.agent.config.getVisionProviders?.()?.[name] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl !== undefined ? fields.baseUrl : existing.baseUrl ?? '',
      model: fields.model !== undefined && fields.model !== '' ? fields.model : existing.model ?? '',
    };
    if (fields.apiKey && fields.apiKey !== KEY_MASK) {
      next.apiKey = fields.apiKey;
    }
    this.agent.config.setVisionProvider(name, next as any);
  }

  /** Cumulative token estimate for a session, from persisted messages via the core's own estimator. */
  getSessionStats(sessionId: string): { tokenEstimate: number; messageCount: number } {
    if (!this.agent?.session) return { tokenEstimate: 0, messageCount: 0 };
    const messages = this.agent.session.getMessages(sessionId);
    const estimate = this.agent.session.getTokenEstimate(sessionId, this.agent.provider);
    return { tokenEstimate: estimate, messageCount: messages.length };
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
    const cfg = this.agent.config.get();
    const existing = cfg.providers?.[name] ?? {};
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
    this.agent.config.setProvider(name, next as any);
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

function redactConfig(cfg: Record<string, any>): Record<string, unknown> {
  const out: any = JSON.parse(JSON.stringify(cfg));
  const maskGroups: Array<Array<Record<string, any>>> = [
    Object.values(out.providers ?? {}),
    Object.values(out.visionProviders ?? {}),
    Object.values(out.ocrProviders ?? {}),
    Object.values(out.speechProviders ?? {}),
  ];
  for (const group of maskGroups) {
    for (const p of group) {
      if (p?.apiKey) p.apiKey = maskKey(p.apiKey);
    }
  }
  return out;
}
