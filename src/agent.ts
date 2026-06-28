import chalk from 'chalk';
import { resolve } from 'path';
import { ConfigManager } from './config/index.js';
import { LLMProvider, createProvider } from './llm/provider.js';
import { ContextManager } from './llm/context-manager.js';
import { SessionManager } from './session/manager.js';
import { ClientManager } from './mcp/client-manager.js';
import { SkillRegistry } from './skills/registry.js';
import { AcpProtocol } from './acp/protocol.js';
import { Message, ToolCall, ToolResult } from './types.js';

interface ReasoningEntry {
  assistantText: string;
  toolCalls: Array<{ name: string; resultSummary: string }>;
}

export class Agent {
  config: ConfigManager;
  provider: LLMProvider;
  mcp: ClientManager;
  session: SessionManager;
  context: ContextManager;
  skills: SkillRegistry;
  acp: AcpProtocol;

  detailMode = true;
  compactLimit = 4;

  /** ACP server callback: receive LLM output text instead of stdout */
  onOutput?: (text: string) => void;
  /** Suppress tool call console output (used in ACP server mode) */
  suppressToolOutput = false;

  private currentSessionId?: string;
  private reasoningLog: ReasoningEntry[] = [];
  private busy = false;
  private abortController = new AbortController();
  private compactStartTime?: number;
  private enableAcp?: boolean;
  private isAcpServer?: boolean;

  constructor(enableAcp?: boolean, isAcpServer?: boolean) {
    this.config = new ConfigManager();
    this.enableAcp = enableAcp;
    this.isAcpServer = isAcpServer;
    const providerConfig = this.config.getProvider();
    this.provider = createProvider(providerConfig.type, providerConfig.apiKey, providerConfig.model, providerConfig.baseUrl, providerConfig.options);
    this.mcp = new ClientManager();
    this.session = new SessionManager();
    this.context = new ContextManager({ provider: this.provider });
    this.skills = new SkillRegistry();
    this.acp = new AcpProtocol();
  }

  async init(): Promise<void> {
    const cfg = this.config.get();

    // Determine ACP mode: CLI flag > config
    // In ACP server mode, skip AcpProtocol (AcpServer handles the protocol)
    const shouldEnableAcp = this.enableAcp ?? cfg.acp?.enabled ?? false;
    if (shouldEnableAcp && !this.isAcpServer) {
      await this.acp.start(cfg.acp);
    }

    // Collect external skill paths from ACP config (validate for path traversal)
    const extraPaths: string[] = [];
    const isSafePath = (p: string): boolean => {
      const normalized = resolve(p);
      if (normalized.includes('\x00')) return false;
      return !normalized.split(/[\/\\]/).some((seg: string) => seg === '..');
    };
    if (cfg.acp?.skillsPath && isSafePath(cfg.acp.skillsPath)) {
      extraPaths.push(cfg.acp.skillsPath);
    }
    for (const agent of cfg.acp?.agents || []) {
      if (agent.skillsPath && isSafePath(agent.skillsPath)) {
        extraPaths.push(agent.skillsPath);
      }
    }

    if (cfg.mcpServers) {
      await this.mcp.connectAll(cfg.mcpServers);
    }
    await this.skills.load(undefined, extraPaths);
  }

  async switchModel(modelId: string): Promise<string> {
    const currentModel = this.provider.model;
    const cfg = this.config.get();
    const providerName = cfg.activeProvider;
    const providerCfg = cfg.providers[providerName]!;

    // 持久化到 config
    this.config.setProviderField(providerName, 'model', modelId);

    // 重建 provider（同 type/apiKey/baseUrl，新 model）
    this.provider = createProvider(
      providerCfg.type,
      providerCfg.apiKey,
      modelId,
      providerCfg.baseUrl,
      providerCfg.options,
    );
    this.context.setProvider(this.provider);

    return `${currentModel} → ${modelId}`;
  }

  async switchProvider(name: string): Promise<void> {
    this.config.setActiveProvider(name);
    const providerConfig = this.config.getProvider(name);
    this.provider = createProvider(providerConfig.type, providerConfig.apiKey, providerConfig.model, providerConfig.baseUrl, providerConfig.options);
    this.context.setProvider(this.provider);
  }

  async startSession(name?: string, sessionId?: string): Promise<string> {
    if (sessionId) {
      const loaded = this.session.loadSession(sessionId);
      if (loaded) {
        this.currentSessionId = sessionId;
        this.context.setMessages(loaded.messages);
        return sessionId;
      }
    }
    const session = this.session.create(
      name || `Session ${new Date().toLocaleString()}`,
      this.config.getActiveProvider(),
      this.provider.model
    );
    this.currentSessionId = session.id;
    this.context.clear();
    return session.id;
  }

  toggleDetailMode(): boolean {
    this.detailMode = !this.detailMode;
    return this.detailMode;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Abort the current chat operation (called on ESC). Safe to call even when idle. */
  abort(): void {
    this.abortController.abort();
    this.busy = false;
  }

  async chat(userInput: string): Promise<void> {
    if (!this.currentSessionId) {
      await this.startSession();
    }

    const userMessage: Message = { role: 'user', content: userInput };
    this.context.add(userMessage);
    this.session.addMessage(this.currentSessionId!, userMessage);

    await this.context.compress();

    this.reasoningLog = [];
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.busy = true;

    // Snapshot the display mode for this entire reasoning chain
    const showDetail = this.detailMode;

    try {
      if (!showDetail && !this.onOutput) {
        this.compactStartTime = Date.now();
        process.stdout.write(chalk.dim('Thought'));
      }

      await this.runLlmTurn(showDetail, signal);

      if (signal.aborted) return;

      if (!showDetail) {
        this.renderCompactOutput();
      }
    } finally {
      this.busy = false;
    }
  }

  private async runLlmTurn(showDetail: boolean, signal: AbortSignal): Promise<void> {
    const tools = [...this.mcp.getAllTools(), ...this.skills.getTools()];
    let assistantMessage = '';
    let pendingToolCalls: ToolCall[] = [];

    const entry: ReasoningEntry = { assistantText: '', toolCalls: [] };
    if (!showDetail) {
      this.reasoningLog.push(entry);
    }

    try {
      const stream = this.provider.chat(this.context.getMessages(), tools, signal);

      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.text) {
          assistantMessage += chunk.text;
          if (this.onOutput) {
            this.onOutput(chunk.text);
          } else if (showDetail) {
            process.stdout.write(chunk.text);
          } else {
            entry.assistantText += chunk.text;
          }
        }
        if (chunk.type === 'tool_call' && chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      throw e;
    }

    if (signal.aborted) return;

    if (showDetail && !this.onOutput) {
      process.stdout.write('\n');
    }

    // Store assistant message (with tool calls if any)
    if (assistantMessage || pendingToolCalls.length > 0) {
      const msg: Message = {
        role: 'assistant',
        content: assistantMessage,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      this.context.add(msg);
      this.session.addMessage(this.currentSessionId!, msg);
    }

    // Execute ALL tool calls before re-running LLM
    for (const toolCall of pendingToolCalls) {
      if (signal.aborted) return;

      if (showDetail && !this.suppressToolOutput) {
        console.log(`\n[Tool: ${toolCall.name}]`);
      }
      const result = await this.executeTool(toolCall);
      if (showDetail && !this.suppressToolOutput) {
        console.log(`[Result]: ${result.content.slice(0, 200)}${result.content.length > 200 ? '...' : ''}\n`);
      } else {
        entry.toolCalls.push({ name: toolCall.name, resultSummary: result.content.slice(0, 200) });
      }

      const toolMsg: Message = {
        role: 'tool',
        content: result.content,
        toolCallId: toolCall.id,
      };
      this.context.add(toolMsg);
      this.session.addMessage(this.currentSessionId!, toolMsg);
    }

    if (!showDetail && pendingToolCalls.length > 0 && !this.onOutput) {
      process.stdout.write('.');
    }

    // If there were tool calls, re-run LLM with results
    if (pendingToolCalls.length > 0) {
      await this.runLlmTurn(showDetail, signal);
    }
  }

  private renderCompactOutput(): void {
    const elapsed = this.compactStartTime
      ? Math.round((Date.now() - this.compactStartTime) / 1000)
      : 0;

    // "Thought for Xs (ctrl+o to expand)"
    process.stdout.write(
      chalk.dim(` for ${elapsed}s (ctrl+o to expand)\n`),
    );

    const startIdx = Math.max(0, this.reasoningLog.length - this.compactLimit);

    for (let i = startIdx; i < this.reasoningLog.length; i++) {
      const entry = this.reasoningLog[i];

      // Main text with bullet point
      if (entry.assistantText) {
        console.log(chalk.white(`• ${entry.assistantText}`));
      }

      // Tool calls with tree structure
      const allTools = entry.toolCalls;
      if (allTools.length > 0) {
        const maxShow = 3;
        const shown = allTools.slice(0, maxShow);
        const hidden = allTools.length - maxShow;

        for (let j = 0; j < shown.length; j++) {
          const tc = shown[j]!;
          const isLastTool = j === shown.length - 1 && hidden === 0;
          const branch = isLastTool ? chalk.dim('└ ') : chalk.dim('├ ');
          const summary = tc.resultSummary
            .slice(0, 60)
            .replace(/[/\\]/g, '/')
            .replace(/\n/g, ' ');
          console.log(`${branch}${chalk.cyan(tc.name)}(${chalk.dim(summary)})`);
        }

        if (hidden > 0) {
          console.log(
            chalk.dim(`└ ... +${hidden} tool uses (ctrl+o to expand)`),
          );
        }
      }
    }

    if (this.reasoningLog.length > this.compactLimit) {
      const hidden = this.reasoningLog.length - this.compactLimit;
      console.log(
        chalk.dim(`\n(${hidden} earlier reasoning steps hidden — press Ctrl+O for full details)`),
      );
    }
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    // Check skills first
    const skillResult = await this.skills.callTool(call.name, call.arguments);
    if (skillResult) return skillResult;

    // Fall back to MCP/builtin tools
    try {
      return await this.mcp.callTool(call.name, call.arguments);
    } catch (err) {
      // If configured ACP agents have matching capabilities, try forwarding
      const acpCfg = this.config.getAcpConfig();
      if (acpCfg?.agents) {
        for (const agent of acpCfg.agents) {
          if (agent.capabilities.includes(call.name) || agent.capabilities.includes('*')) {
            try {
              this.acp.registerAgent(agent);
              const msg = await this.acp.sendTask(agent.id, { tool: call.name, args: call.arguments }, 'nexus');
              return { content: typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload) };
            } catch {
              // Continue to next agent
            }
          }
        }
      }
      throw err;
    }
  }

  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
  }
}
