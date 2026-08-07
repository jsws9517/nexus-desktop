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

    const { Agent } = await import('@jsws9517/nexus-core/dist/src/agent.js');
    this.agent = new Agent();

    // Route ALL permission prompts to the UI — both the MCP/tool prompt and the
    // path authorization (read_text_file etc.) use this single bridge. The CLI
    // wires the same via setPermissionPrompter; without it the path prompter
    // falls back to a dead stdin readline inside the worker and instantly denies.
    const { setPermissionPrompter } = await import('@jsws9517/nexus-core/dist/src/security/path-authorizer.js');
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
   * Phase 2 of startup: full init (MCP connect + skills load). Only chat and
   * mutation methods gate on this — see EARLY_METHODS in main/index.ts.
   */
  async init(cwd?: string): Promise<void> {
    await this.earlyInit(cwd);
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

  /**
   * Slash commands (e.g. /plan /go /tasks) are intercepted by the core's chat()
   * and return BEFORE the user message is persisted to the session DB, so the
   * transcript would otherwise miss them. Persist the raw input ourselves so
   * history/resume matches what the user actually typed. Persisted BEFORE the
   * turn so the row lands ahead of any sub-agent worker blocks that /go spawns.
   */
  private persistSlashInput(input: string): void {
    if (!input.trim().startsWith('/')) return;
    const sid = this.agent?.currentSessionId;
    if (!sid) return;
    try {
      this.agent.session.addMessage(sid, { role: 'user', content: input });
    } catch (e) {
      this.onLog?.('warn', `Persist slash input failed: ${(e as Error).message}`);
    }
  }

  async chat(input: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy()) throw new Error('Agent is busy');
    // chat() resolves pending askUser with the next user input, otherwise runs a turn
    this.persistSlashInput(input);
    await this.agent.chat(input);
  }

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
    return this.agent.startSession(name, sessionId, metadata);
  }

  async listSessions(options?: { limit?: number; offset?: number }): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    return this.agent.session.list(options);
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
      const { decryptApiKey } = await import('@jsws9517/nexus-core/dist/src/security/env-key-encrypt.js');
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
