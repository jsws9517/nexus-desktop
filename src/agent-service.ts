import type { AgentEvent } from '../vendor/core/src/types.js';

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

    // Route permission prompts to the UI (CLI sets this same global).
    (globalThis as Record<string, unknown>).__nexusPermissionPrompter = (question: string) =>
      this.askPermission(question);

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
      this.onPermission?.({ id, question });
    });
  }
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
