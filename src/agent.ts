import { ConfigManager } from './config/index.js';
import { LLMProvider, createProvider } from './llm/provider.js';
import { ContextManager } from './llm/context-manager.js';
import { SessionManager } from './session/manager.js';
import { ClientManager } from './mcp/client-manager.js';
import { SkillRegistry } from './skills/registry.js';
import { AcpProtocol } from './acp/protocol.js';
import { Message, ChatChunk, ToolCall, ToolResult } from './types.js';

export class Agent {
  config: ConfigManager;
  provider: LLMProvider;
  mcp: ClientManager;
  session: SessionManager;
  context: ContextManager;
  skills: SkillRegistry;
  acp: AcpProtocol;

  private currentSessionId?: string;
  private isRunning = false;

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

  async chat(userInput: string): Promise<void> {
    if (!this.currentSessionId) {
      await this.startSession();
    }

    const userMessage: Message = { role: 'user', content: userInput };
    this.context.add(userMessage);
    this.session.addMessage(this.currentSessionId!, userMessage);

    await this.context.compress();

    const tools = [
      ...this.mcp.getAllTools(),
      ...this.skills.getTools(),
    ];

    let assistantMessage = '';
    let pendingToolCalls: ToolCall[] = [];

    const stream = this.provider.chat(this.context.getMessages(), tools);

    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.text) {
        assistantMessage += chunk.text;
        process.stdout.write(chunk.text);
      }
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        pendingToolCalls.push(chunk.toolCall);
      }
    }

    process.stdout.write('\n');

    // Store assistant message
    if (assistantMessage || pendingToolCalls.length > 0) {
      const msg: Message = {
        role: 'assistant',
        content: assistantMessage,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      this.context.add(msg);
      this.session.addMessage(this.currentSessionId!, msg);
    }

    // Execute tool calls
    for (const toolCall of pendingToolCalls) {
      console.log(`\n[Tool: ${toolCall.name}]`);
      const result = await this.executeTool(toolCall);
      console.log(`[Result]: ${result.content.slice(0, 200)}${result.content.length > 200 ? '...' : ''}\n`);

      const toolMsg: Message = {
        role: 'tool',
        content: result.content,
        toolCallId: toolCall.id,
      };
      this.context.add(toolMsg);
      this.session.addMessage(this.currentSessionId!, toolMsg);

      // Re-run LLM with tool result
      await this.continueChat();
    }
  }

  private async continueChat(): Promise<void> {
    const tools = [...this.mcp.getAllTools(), ...this.skills.getTools()];
    let assistantMessage = '';
    let pendingToolCalls: ToolCall[] = [];

    const stream = this.provider.chat(this.context.getMessages(), tools);

    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.text) {
        assistantMessage += chunk.text;
        process.stdout.write(chunk.text);
      }
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        pendingToolCalls.push(chunk.toolCall);
      }
    }

    process.stdout.write('\n');

    if (assistantMessage || pendingToolCalls.length > 0) {
      const msg: Message = {
        role: 'assistant',
        content: assistantMessage,
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      };
      this.context.add(msg);
      this.session.addMessage(this.currentSessionId!, msg);
    }

    for (const toolCall of pendingToolCalls) {
      console.log(`\n[Tool: ${toolCall.name}]`);
      const result = await this.executeTool(toolCall);
      console.log(`[Result]: ${result.content.slice(0, 200)}${result.content.length > 200 ? '...' : ''}\n`);

      const toolMsg: Message = {
        role: 'tool',
        content: result.content,
        toolCallId: toolCall.id,
      };
      this.context.add(toolMsg);
      this.session.addMessage(this.currentSessionId!, toolMsg);
      await this.continueChat();
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
