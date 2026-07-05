import { createInterface } from 'readline';
import { randomBytes } from 'crypto';
import { Agent } from '../agent.js';

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface AcpSession {
  id: string;
  mode?: string;
}

export class AcpServer {
  private agent: Agent;
  private sessions = new Map<string, AcpSession>();
  private currentSessionId?: string;
  private rl: ReturnType<typeof createInterface>;
  private alive = false;

  constructor(agent: Agent) {
    this.agent = agent;
    this.rl = createInterface({ input: process.stdin });
  }

  async start(): Promise<void> {
    this.alive = true;

    this.rl.on('line', (line) => {
      if (!this.alive) return;
      this.handleLine(line).catch((err) => {
        this.logError('handleLine', err);
      });
    });

    // Wait for stdin to close
    return new Promise((resolve) => {
      this.rl.on('close', () => {
        this.alive = false;
        resolve();
      });
    });
  }

  stop(): void {
    this.alive = false;
    this.rl.close();
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      this.sendError(null, -32700, 'Parse error');
      return;
    }

    if (req.jsonrpc !== '2.0') {
      this.sendError(req.id, -32600, 'Invalid Request');
      return;
    }

    try {
      const result = await this.handleMethod(req.method, req.params);
      if (req.id !== undefined && req.id !== null) {
        this.sendResponse(req.id, result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (req.id !== undefined && req.id !== null) {
        this.sendError(req.id, -32603, message);
      }
    }
  }

  private async handleMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.handleInitialize(params as Record<string, unknown>);

      case 'session/new':
        return this.handleSessionNew(params as Record<string, unknown>);

      case 'session/load':
        return this.handleSessionLoad(params as Record<string, unknown>);

      case 'session/set_mode':
        return this.handleSessionSetMode(params as Record<string, unknown>);

      case 'session/prompt': {
        const p = params as Record<string, unknown>;
        return this.handleSessionPrompt(String(p.sessionId ?? ''), p.prompt);
      }

      case 'session/cancel':
        return {};

      case 'tool/call': {
        const p = params as Record<string, unknown>;
        return this.handleToolCall(String(p.name ?? ''), p.arguments);
      }

      case 'tools/list':
        return this.handleToolsList();

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  private handleToolsList(): unknown {
    const mcpTools = this.agent.mcp.getAllTools();
    const skillTools = this.agent.skills.getTools();
    const acpTools = this.agent.getAcpTools();

    const allTools = [
      ...mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        source: 'mcp',
        inputSchema: t.inputSchema,
      })),
      ...skillTools.map((t) => ({
        name: t.name,
        description: t.description,
        source: 'skill',
        inputSchema: t.inputSchema,
      })),
      ...acpTools.map((t) => ({
        name: t.name,
        description: t.description,
        source: 'acp',
        inputSchema: t.inputSchema,
      })),
    ];

    return { tools: allTools };
  }

  private handleInitialize(_params: Record<string, unknown>): unknown {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        tools: { list: true, call: true },
        sessionCapabilities: {
          list: false,
        },
      },
      agentInfo: {
        name: 'nexus',
        version: '1.0.1',
      },
    };
  }

  private handleSessionNew(_params: Record<string, unknown>): unknown {
    const sessionId = `nexus-${Date.now()}-${randomBytes(8).toString('hex')}`;
    this.sessions.set(sessionId, { id: sessionId });
    this.currentSessionId = sessionId;

    // Start agent session
    this.agent.startSession('ACP Session', sessionId).catch(() => {});

    return {
      sessionId,
      modes: {
        currentModeId: '',
        availableModes: [],
      },
    };
  }

  private handleSessionLoad(params: Record<string, unknown>): unknown {
    const sessionId = String(params.sessionId ?? '');
    if (!sessionId) {
      throw new Error('sessionId is required');
    }

    this.sessions.set(sessionId, { id: sessionId });
    this.currentSessionId = sessionId;

    // Try to load existing session
    this.agent.startSession('ACP Session', sessionId).catch(() => {});

    return {
      sessionId,
      modes: {
        currentModeId: '',
        availableModes: [],
      },
    };
  }

  private handleSessionSetMode(params: Record<string, unknown>): unknown {
    const sessionId = String(params.sessionId ?? '');
    const modeId = String(params.modeId ?? '');
    const session = this.sessions.get(sessionId);
    if (session) {
      session.mode = modeId;
    }
    return {};
  }

  private async handleSessionPrompt(sessionId: string, prompt: unknown): Promise<unknown> {
    if (!sessionId || !this.sessions.has(sessionId)) {
      throw new Error('Invalid session');
    }

    // Extract text from prompt blocks
    let userInput = '';
    if (Array.isArray(prompt)) {
      for (const block of prompt) {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            userInput += b.text;
          }
        }
      }
    } else if (typeof prompt === 'string') {
      userInput = prompt;
    }

    if (!userInput.trim()) {
      return {};
    }

    // Ensure session is started
    if (!this.agent.getCurrentSessionId()) {
      await this.agent.startSession('ACP Session', sessionId);
    }

    // Set up output callback for streaming
    this.agent.onOutput = (text: string) => {
      this.sendNotification('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    };
    this.agent.onEvent = (event) => {
      this.sendNotification('session/event', {
        sessionId,
        event,
      });
    };
    this.agent.suppressToolOutput = true;

    try {
      await this.agent.chat(userInput);
    } finally {
      this.agent.onOutput = undefined;
      this.agent.onEvent = undefined;
      this.agent.suppressToolOutput = false;
    }

    // Send done update
    this.sendNotification('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        done: true,
      },
    });

    return {};
  }

  private async handleToolCall(name: string, args: unknown): Promise<unknown> {
    // 1. Try local execution first
    try {
      const result = await this.agent.executeTool({
        id: `tool-${Date.now()}`,
        name,
        arguments: args as Record<string, unknown>,
      });
      return { content: result.content };
    } catch {
      // Local tool not found, try ACP forwarding
    }

    // 2. Forward to configured ACP agents
    const acpCfg = this.agent.config.getAcpConfig();
    if (!acpCfg?.agents || acpCfg.agents.length === 0) {
      throw new Error(`Tool '${name}' not found locally and no ACP agents configured`);
    }

    const errors: string[] = [];
    for (const agent of acpCfg.agents) {
      const hasTool = agent.tools?.some((t) => t.name === name);
      const hasCapability = agent.capabilities.includes(name) || agent.capabilities.includes('*');

      if (!hasTool && !hasCapability) continue;

      try {
        this.agent.acp.registerAgent(agent);
        const msg = await this.agent.acp.sendTask(
          agent.id,
          { tool: name, args },
          'nexus',
        );
        return {
          content: typeof msg.payload === 'string'
            ? msg.payload
            : JSON.stringify(msg.payload, null, 2),
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`${agent.name}: ${errMsg}`);
      }
    }

    const errorDetail = errors.length > 0
      ? `ACP forwarding failed: ${errors.join('; ')}`
      : 'No ACP agent provides this tool';
    throw new Error(`Tool '${name}' not found. ${errorDetail}`);
  }

  private sendResponse(id: number | string | null | undefined, result: unknown): void {
    const res: JsonRpcResponse = { jsonrpc: '2.0', id: id ?? null, result };
    this.writeLine(JSON.stringify(res));
  }

  private sendError(id: number | string | null | undefined, code: number, message: string): void {
    const res: JsonRpcResponse = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
    this.writeLine(JSON.stringify(res));
  }

  private sendNotification(method: string, params: unknown): void {
    const msg = { jsonrpc: '2.0', method, params };
    this.writeLine(JSON.stringify(msg));
  }

  private writeLine(line: string): void {
    process.stdout.write(line + '\n');
  }

  private logError(context: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ACP] ${context}: ${msg}\n`);
  }
}
