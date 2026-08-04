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

  onEvent?: (event: AgentEvent) => void;
  onPermission?: (req: PermissionRequest) => void;
  onLog?: (level: string, message: string) => void;

  get isReady(): boolean {
    return this.initialized && this.agent !== null;
  }

  get busy(): boolean {
    return this.agent?.isBusy?.() ?? false;
  }

  async init(cwd?: string): Promise<void> {
    if (cwd) {
      try {
        process.chdir(cwd);
      } catch (e) {
        this.onLog?.('warn', `chdir failed: ${(e as Error).message}`);
      }
    }

    const { Agent } = await import('../vendor/core/src/agent.js');
    this.agent = new Agent();

    // Route ALL permission prompts to the UI — both the MCP/tool prompt and the
    // path authorization (read_text_file etc.) use this single bridge. The CLI
    // wires the same via setPermissionPrompter; without it the path prompter
    // falls back to a dead stdin readline inside the worker and instantly denies.
    const { setPermissionPrompter } = await import('../vendor/core/src/security/path-authorizer.js');
    setPermissionPrompter((question: string) => this.askPermission(question));

    this.agent.onEvent = (event: AgentEvent) => this.onEvent?.(event);
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

    // `deferMCP`: connect MCP servers in the background so startup is not
    // blocked (config/sessions load immediately). Only MCP-dependent calls wait.
    await this.agent.init({ deferMCP: true });
    this.initialized = true;
    this.onLog?.('info', `Nexus core initialized (cwd=${process.cwd()})`);
  }

  async shutdown(): Promise<void> {
    if (this.agent) await this.agent.shutdown();
    this.initialized = false;
    this.agent = null;
  }

  async chat(input: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy()) throw new Error('Agent is busy');
    // chat() resolves pending askUser with the next user input, otherwise runs a turn
    await this.agent.chat(input);
  }

  abort(): void {
    this.agent?.abort?.();
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

  async startSession(name?: string, sessionId?: string): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');
    return this.agent.startSession(name, sessionId);
  }

  async listSessions(): Promise<Array<Record<string, unknown>>> {
    if (!this.agent) throw new Error('Agent not initialized');
    return this.agent.session.list();
  }

  async getMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
    if (!this.agent) throw new Error('Agent not initialized');
    return this.agent.session.getMessages(sessionId);
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.agent.session.delete(id);
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

  getConfig(): Record<string, unknown> {
    if (!this.agent) return {};
    const cfg = this.agent.config.get();
    return redactConfig(cfg);
  }

  saveProvider(
    name: string,
    fields: { type?: string; apiKey?: string; model?: string; baseUrl?: string },
  ): void {
    if (!this.agent) throw new Error('Agent not initialized');
    const cfg = this.agent.config.get();
    const existing = cfg.providers?.[name] ?? {};
    const next: Record<string, unknown> = {
      type: fields.type ?? existing.type ?? 'openai',
      model: fields.model ?? existing.model ?? '',
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl ?? existing.baseUrl,
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
