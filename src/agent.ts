import chalk from 'chalk';
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

  detailMode = false; // false = compact (default), true = full
  compactLimit = 4;

  private currentSessionId?: string;
  private reasoningLog: ReasoningEntry[] = [];
  private busy = false;

  constructor() {
    this.config = new ConfigManager();
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
    if (cfg.mcpServers) {
      await this.mcp.connectAll(cfg.mcpServers);
    }
    await this.skills.load();
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

  async chat(userInput: string): Promise<void> {
    if (!this.currentSessionId) {
      await this.startSession();
    }

    const userMessage: Message = { role: 'user', content: userInput };
    this.context.add(userMessage);
    this.session.addMessage(this.currentSessionId!, userMessage);

    await this.context.compress();

    this.reasoningLog = [];
    this.busy = true;

    // Snapshot the display mode for this entire reasoning chain
    const showDetail = this.detailMode;

    try {
      if (!showDetail) {
        process.stdout.write(chalk.gray('[Thinking'));
      }

      await this.runLlmTurn(showDetail);

      if (!showDetail) {
        process.stdout.write(chalk.gray(']\n'));
        this.renderCompactOutput();
      }
    } finally {
      this.busy = false;
    }
  }

  private async runLlmTurn(showDetail: boolean): Promise<void> {
    const tools = [...this.mcp.getAllTools(), ...this.skills.getTools()];
    let assistantMessage = '';
    let pendingToolCalls: ToolCall[] = [];

    const entry: ReasoningEntry = { assistantText: '', toolCalls: [] };
    if (!showDetail) {
      this.reasoningLog.push(entry);
    }

    const stream = this.provider.chat(this.context.getMessages(), tools);

    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.text) {
        assistantMessage += chunk.text;
        if (showDetail) {
          process.stdout.write(chunk.text);
        } else {
          entry.assistantText += chunk.text;
        }
      }
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        pendingToolCalls.push(chunk.toolCall);
      }
    }

    if (showDetail) {
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
      if (showDetail) {
        console.log(`\n[Tool: ${toolCall.name}]`);
      }
      const result = await this.executeTool(toolCall);
      if (showDetail) {
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

    if (!showDetail && pendingToolCalls.length > 0) {
      process.stdout.write('.');
    }

    // If there were tool calls, re-run LLM with results
    if (pendingToolCalls.length > 0) {
      await this.runLlmTurn(showDetail);
    }
  }

  private renderCompactOutput(): void {
    const startIdx = Math.max(0, this.reasoningLog.length - this.compactLimit);

    for (let i = startIdx; i < this.reasoningLog.length; i++) {
      const entry = this.reasoningLog[i];
      const isLast = i === this.reasoningLog.length - 1;

      if (!isLast) {
        console.log(chalk.gray(`\n[Step ${i + 1}/${this.reasoningLog.length}]`));
      }

      process.stdout.write(entry.assistantText);

      for (const tc of entry.toolCalls) {
        console.log(`\n[Tool: ${tc.name}]`);
        console.log(`[Result]: ${tc.resultSummary}${tc.resultSummary.length >= 200 ? '...' : ''}`);
      }
    }

    if (this.reasoningLog.length > this.compactLimit) {
      const hidden = this.reasoningLog.length - this.compactLimit;
      console.log(chalk.gray(`\n(${hidden} earlier reasoning steps hidden — press Ctrl+O for full details)`));
    }
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    return this.mcp.callTool(call.name, call.arguments);
  }

  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
  }
}
