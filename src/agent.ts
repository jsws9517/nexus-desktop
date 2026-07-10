import chalk from 'chalk';
import { resolve } from 'path';
import { ConfigManager } from './config/index.js';
import { LLMProvider, createProvider } from './llm/provider.js';
import { ContextManager } from './llm/context-manager.js';
import { SessionManager } from './session/manager.js';
import { ClientManager } from './mcp/client-manager.js';
import { SkillRegistry } from './skills/registry.js';
import { AcpProtocol } from './acp/protocol.js';
import { Message, ToolCall, ToolResult, ToolDefinition, AgentEvent } from './types.js';
import { Hooks, createSanityCheckHook } from './hooks/index.js';
import { AuditManager } from './security/audit.js';
import { resolveApiKey } from './security/env-key-encrypt.js';

const REMEMBER_TOOL_DEF: ToolDefinition = {
  name: 'remember',
  description: 'Save user information to the knowledge graph for future reference across sessions. Call this (with no arguments needed) whenever the user shares personal preferences, facts, or anything they want remembered. The content is captured automatically from the user\'s message.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/** Tools reserved for internal system calls — never exposed to the LLM. */
const INTERNAL_TOOLS = new Set([
  'search_nodes', 'search_semantic', 'open_nodes',
  'create_entities', 'create_relations', 'add_observations',
  'delete_entities', 'delete_observations', 'delete_relations',
  'migrate', 'analyze_entity_split', 'propose_entity_split_tool',
  'execute_entity_split_tool', 'find_split_candidates',
  'find_duplicate_observations', 'consolidation_report',
  'add_reflection', 'search_reflections', 'end_relation',
]);

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
  /** Agent event stream callback: receive structured events */
  onEvent?: (event: AgentEvent) => void;
  /** Suppress tool call console output (used in ACP server mode) */
  suppressToolOutput = false;

  /** User-defined hooks for lifecycle events */
  hooks?: Hooks;

  /** Security audit manager */
  audit = new AuditManager();

  private currentSessionId?: string;
  private currentUserInput?: string;
  private reasoningLog: ReasoningEntry[] = [];
  private busy = false;
  private abortController = new AbortController();
  private compactStartTime?: number;
  private enableAcp?: boolean;
  private isAcpServer?: boolean;

  /** Pending askUser question — resolved when user provides their next input */
  private pendingAsk: { question: string; resolve: (answer: string | null) => void } | null = null;

  // Turn budget
  maxTurns = 25;
  currentTurn = 0;

  /** Track tool error count per (toolName + args hash) to break infinite retry loops */
  private toolErrorCount: Map<string, number> = new Map();

  constructor(enableAcp?: boolean, isAcpServer?: boolean) {
    this.config = new ConfigManager();
    this.enableAcp = enableAcp;
    this.isAcpServer = isAcpServer;
    const providerConfig = this.config.getProvider();
    this.provider = createProvider(providerConfig.type, providerConfig.apiKey, providerConfig.model, providerConfig.baseUrl, providerConfig.options, this.config.getActiveProvider());
    this.mcp = new ClientManager();
    this.session = new SessionManager();
    this.context = new ContextManager({ provider: this.provider, maxContextTokens: this.config.getModelContextLimit() });
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
    // Create AgentContext so skills can call MCP/builtin tools
    const agentCtx = {
      callTool: (name: string, args: Record<string, unknown>) =>
        this.executeTool({ id: `skill-${Date.now()}`, name, arguments: args }),
      sendMessage: async (msg: string) => { this.onOutput?.(msg); },
      askUser: (question: string, options?: string[]) => this.askUser(question, options),
    };
    await this.skills.load(agentCtx, extraPaths);
  }

   async switchModel(modelId: string): Promise<string> {
     const currentModel = this.provider.model;
     const cfg = this.config.get();
     const providerName = cfg.activeProvider;
     const providerCfg = cfg.providers[providerName]!;

     // 持久化到 config
     this.config.setProviderField(providerName, 'model', modelId);

      // 重建 provider（同 type/apiKey/baseUrl，新 model）
      const { apiKey: resolvedKey } = resolveApiKey(providerCfg.apiKey, providerCfg.type, providerName);
      this.provider = createProvider(
        providerCfg.type,
        resolvedKey,
        modelId,
        providerCfg.baseUrl,
        providerCfg.options,
        providerName,
      );
     this.context.setProvider(this.provider);

     // 同步更新 context 阈值
     const newLimit = this.config.getModelContextLimit(modelId);
     this.context.setMaxContextTokens(newLimit);

     return `${currentModel} → ${modelId}`;
   }

  async switchProvider(name: string): Promise<void> {
    this.config.setActiveProvider(name);
    const providerConfig = this.config.getProvider(name);
    this.provider = createProvider(providerConfig.type, providerConfig.apiKey, providerConfig.model, providerConfig.baseUrl, providerConfig.options, name);
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

  /** Ask the user a question, pausing execution until they respond. */
  askUser(question: string, options?: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      this.pendingAsk = { question, resolve };

      // Send the question to the user
      let text = question;
      if (options && options.length > 0) {
        text += '\n\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      }
      this.onOutput?.(`\n${text}\n`);
      this.onEvent?.({ type: 'text', text: `\n${text}\n` });
    });
  }

  /** Resolve a pending askUser call with the user's input. Returns true if resolved. */
  resolvePendingAsk(input: string): boolean {
    if (!this.pendingAsk) return false;
    const { resolve } = this.pendingAsk;
    this.pendingAsk = null;
    resolve(input);
    return true;
  }

  /** Abort the current chat operation (called on ESC). Safe to call even when idle. */
  abort(): void {
    this.abortController.abort();
    this.busy = false;
  }

  async chat(userInput: string): Promise<void> {
    // If a skill is waiting for user input, resolve it and return
    if (this.resolvePendingAsk(userInput)) {
      return;
    }

    if (!this.currentSessionId) {
      await this.startSession();
    }

    // Add system prompt to encourage tool use
    const hasSystem = this.context.getMessages().some((m) => m.role === 'system');
    if (!hasSystem) {
      let systemPrompt = `你是一个智能助手，可以根据用户请求调用工具完成任务。
当前可用的工具包括本地工具和由 ACP 智能体提供的远程工具。
当用户明确要求调用某个工具时（如 text2image-free-CogView、text2image-trial-aliyun 等），请严格按照要求调用相应的工具，不要自行决定使用其他工具代替。
如果某个工具调用失败，请报告具体的错误信息。`;

      if (this.isAcpServer) {
        const acpTools = this.getAcpTools();
        if (acpTools.length > 0) {
          systemPrompt += `\n\n可用的远程 ACP 工具: ${acpTools.map(t => t.name).join(', ')}`;
        }
      }

      this.context.add({ role: 'system', content: systemPrompt });
    }

    // Inject memory context before LLM call
    await this.injectMemoryContext();

    // Auto-save user info to knowledge graph
    await this.saveUserInfoIfNeeded(userInput);

    // Reset tool error tracking for each user input
    this.toolErrorCount.clear();
    this.currentUserInput = userInput;
    const userMessage: Message = { role: 'user', content: userInput };
    this.context.add(userMessage);
    this.session.addMessage(this.currentSessionId!, userMessage);

    await this.context.compress();

    // Auto-register sanity check hook for each chat
    const sanityCheck = createSanityCheckHook(userInput);
    const userHooks = this.hooks;
    this.hooks = {
      ...(userHooks || {}),
      preToolUse: async (ctx) => {
        const check = await sanityCheck(ctx);
        if (check !== 'allow') return check;
        return userHooks?.preToolUse ? userHooks.preToolUse(ctx) : 'allow';
      },
    };

    this.reasoningLog = [];
    this.currentTurn = 0;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.busy = true;

    // Snapshot the display mode for this entire reasoning chain
    const showDetail = this.detailMode;

    this.onEvent?.({ type: 'session_start', sessionId: this.currentSessionId! });

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
    } catch (e) {
      // Auto-learn model context limit from API error
      const errStr = e instanceof Error ? e.message : String(e);
      const contextMatch = errStr.match(/maximum context length is (\d+)/i);
      if (contextMatch) {
        const actualLimit = parseInt(contextMatch[1]!, 10);
        this.config.learnModelContextLimit(this.provider.model, actualLimit);
        this.context.setMaxContextTokens(actualLimit);
      }
      throw e;
    } finally {
      this.busy = false;
      this.onEvent?.({ type: 'session_end' });
    }
  }

  private async runLlmTurn(showDetail: boolean, signal: AbortSignal): Promise<void> {
    this.currentTurn++;
    if (this.currentTurn > this.maxTurns) return;

    this.onEvent?.({ type: 'turn_start', turn: this.currentTurn });

    const allTools = this.mcp.getAllTools();
    const tools = [
      ...allTools.filter(t => !INTERNAL_TOOLS.has(t.name)),
      ...this.skills.getTools(),
      ...this.getAcpTools(),
      REMEMBER_TOOL_DEF,
    ];

    // Debug: log tool count in ACP server mode
    if (this.isAcpServer) {
      process.stderr.write(`[ACP Debug] Tools: ${tools.length} total`);
      const acpToolNames = this.getAcpTools().map((t) => t.name);
      if (acpToolNames.length > 0) {
        process.stderr.write(` | ACP: ${acpToolNames.join(', ')}`);
      }
      process.stderr.write('\n');
    }

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
          const clean = chunk.text.replace(/\uFFFD/g, '');
          assistantMessage += clean;
          this.onEvent?.({ type: 'text', text: clean });
          if (this.onOutput) {
            this.onOutput(clean);
          } else if (showDetail) {
            process.stdout.write(clean);
          } else {
            entry.assistantText += clean;
          }
        }
        if (chunk.type === 'thinking' && chunk.thinking) {
          this.onEvent?.({ type: 'thinking', thinking: chunk.thinking });
          if (showDetail && !this.onOutput) {
            process.stdout.write(chalk.dim(chalk.italic(chunk.thinking)));
          }
        }
        if (chunk.type === 'tool_call' && chunk.toolCall) {
          pendingToolCalls.push(chunk.toolCall);
          this.onEvent?.({ type: 'tool_call_start', index: pendingToolCalls.length - 1, name: chunk.toolCall.name, args: chunk.toolCall.arguments });
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
    for (let tci = 0; tci < pendingToolCalls.length; tci++) {
      const toolCall = pendingToolCalls[tci]!;
      if (signal.aborted) return;

      // preToolUse hook — allow deny with reason
      const hookCtx = { turn: this.currentTurn, toolCall, signal, userInput: this.currentUserInput, toolDefinitions: tools };
      if (this.hooks?.preToolUse) {
        const hookResult = await this.hooks.preToolUse(hookCtx);
        const isDenied = hookResult !== 'allow';
        if (isDenied) {
          const reason = hookResult.verdict === 'deny' ? hookResult.reason : 'Tool was blocked by security policy.';
          if (showDetail && !this.suppressToolOutput) {
            console.log(`\n[Blocked: ${toolCall.name}] — ${reason}`);
          }
          const toolContent = reason;
          this.onEvent?.({ type: 'tool_result', index: tci, name: toolCall.name, content: toolContent, isError: true });
          const toolMsg: Message = { role: 'tool', content: toolContent, toolCallId: toolCall.id };
          this.context.add(toolMsg);
          this.session.addMessage(this.currentSessionId!, toolMsg);
          continue;
        }
      }

      if (showDetail && !this.suppressToolOutput) {
        console.log(`\n[Tool: ${toolCall.name}]`);
      }
      let result: ToolResult;
      try {
        result = await this.executeTool(toolCall);
      } catch (err) {
        result = { content: `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (showDetail && !this.suppressToolOutput) {
        console.log(`[Result]: ${result.content.slice(0, 200)}${result.content.length > 200 ? '...' : ''}\n`);
      } else {
        entry.toolCalls.push({ name: toolCall.name, resultSummary: result.content.slice(0, 200) });
      }

      // Emit tool_result event, but suppress intermediate errors in ACP/server mode
      if (!this.suppressToolOutput || !result.isError) {
        this.onEvent?.({ type: 'tool_result', index: tci, name: toolCall.name, content: result.content, isError: result.isError });
      }

      // Track repeated tool failures to detect all-failed turns (break recursive loop)
      if (result.isError) {
        const errKey = `${toolCall.name}:${JSON.stringify(toolCall.arguments)}`;
        const failCount = (this.toolErrorCount.get(errKey) || 0) + 1;
        this.toolErrorCount.set(errKey, failCount);
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

    const stopReason = signal.aborted ? 'aborted' : (pendingToolCalls.length > 0 ? 'tool_use' : 'end_turn');
    this.onEvent?.({ type: 'turn_end', stopReason });

    // If there were tool calls, re-run LLM with results
    if (pendingToolCalls.length > 0) {
      // Check if ALL tool calls have failed 3+ times — break the infinite loop
      const allFailed = pendingToolCalls.every((tc) => {
        const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        return (this.toolErrorCount.get(key) || 0) >= 3;
      });
      if (allFailed && pendingToolCalls.length > 0) {
        if (showDetail && !this.onOutput) {
          console.log(chalk.yellow('\n⚠ All tool calls failed repeatedly. Stopping.'));
        }
        return;
      }
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

  getAcpTools(): ToolDefinition[] {
    const acpCfg = this.config.getAcpConfig();
    const tools: ToolDefinition[] = [];
    for (const agent of acpCfg?.agents || []) {
      if (agent.tools) {
        for (const t of agent.tools) {
          tools.push({
            name: t.name,
            description: `${t.description} (由 ${agent.name} agent 提供)`,
            inputSchema: (t.inputSchema || { type: 'object', properties: {} }) as Record<string, unknown>,
          });
        }
      }
    }
    return tools;
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    // Normalize arguments — LLM often emits tool calls with undefined/missing args
    const safeArgs: Record<string, unknown> = call.arguments ?? {};

    // Handle remember tool (agent-level, saves to KG)
    if (call.name === 'remember') {
      return this.handleRemember(safeArgs);
    }

    // 1. Check local skills first
    const skillResult = await this.skills.callTool(call.name, safeArgs);
    if (skillResult) return skillResult;

    // 2. Fall back to MCP/builtin tools
    let mcpResult: ToolResult;
    try {
      mcpResult = await this.mcp.callTool(call.name, safeArgs);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const argsPreview = JSON.stringify(safeArgs).slice(0, 200);
      mcpResult = { content: `Tool "${call.name}" error: ${errMsg}\nArgs: ${argsPreview}`, isError: true };
    }
    const toolNotFound = mcpResult.content === `Tool "${call.name}" not found`;
    if (!toolNotFound) {
      return mcpResult;
    }

    // 3. Forward to configured ACP agents
    const acpCfg = this.config.getAcpConfig();
    if (!acpCfg?.agents || acpCfg.agents.length === 0) {
      throw new Error(`Tool '${call.name}' not found locally and no ACP agents configured`);
    }

    const errors: string[] = [];
    for (const agent of acpCfg.agents) {
      // Check if this agent provides the requested tool
      const hasTool = agent.tools?.some((t) => t.name === call.name);
      const hasCapability = agent.capabilities.includes(call.name) || agent.capabilities.includes('*');

      if (!hasTool && !hasCapability) continue;

      try {
        this.acp.registerAgent(agent);
        const msg = await this.acp.sendTask(
          agent.id,
            { tool: call.name, args: safeArgs },
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
      ? `ACP forwarding failed:\n${errors.map((e) => '  - ' + e).join('\n')}`
      : 'No ACP agent provides this tool';
    throw new Error(`Tool '${call.name}' not found. ${errorDetail}`);
  }

   getCurrentSessionId(): string | undefined {
     return this.currentSessionId;
   }

   renameSession(name: string): void {
     if (this.currentSessionId) {
       this.session.rename(this.currentSessionId, name);
     }
   }

   async resumeSession(sessionId: string): Promise<{ restored: boolean; compressed: boolean; sessionName: string }> {
     const loaded = this.session.loadSession(sessionId);
     if (!loaded) return { restored: false, compressed: false, sessionName: '' };

     const tokenCount = this.session.getTokenEstimate(sessionId, this.provider);
     const maxTokens = this.config.getProvider().maxContextTokens || 8192;

     if (tokenCount > maxTokens && loaded.messages.length >= 4) {
       const messages = loaded.messages;
       const keepCount = Math.min(6, messages.length);

       // Find safe split point: don't cut inside a tool_call chain
       let splitIdx = messages.length - keepCount;
       while (splitIdx > 0) {
         const prev = messages[splitIdx - 1];
         // If previous message is assistant with tool_calls, check if tool results follow
         if (prev.role === 'assistant' && prev.toolCalls && prev.toolCalls.length > 0) {
           const toolCallIds = new Set(prev.toolCalls.map(tc => tc.id));
           const hasOrphanedTools = messages.slice(splitIdx).some(
             m => m.role === 'tool' && m.toolCallId && toolCallIds.has(m.toolCallId),
           );
           if (hasOrphanedTools) {
             splitIdx--; // move left to include the assistant message
             continue;
           }
         }
         // If current message is a tool message, move left to include its assistant
         const curr = messages[splitIdx];
         if (curr.role === 'tool' && curr.toolCallId) {
           for (let j = splitIdx - 1; j >= 0; j--) {
             const m = messages[j];
             if (m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === curr.toolCallId)) {
               splitIdx = j; // include the assistant
               break;
             }
             if (m.role === 'user') break;
           }
           continue;
         }
         break; // safe split point found
       }

       const toSummarize = messages.slice(0, splitIdx);
       const toKeep = messages.slice(splitIdx);

       const summary = await this.summarizeMessages(toSummarize);
       this.context.setMessages([
         { role: 'system', content: `[已恢复会话「${loaded.session.name}」— 原始 ${tokenCount} tokens，已压缩为摘要]\n\n${summary}` },
         ...toKeep,
       ]);
       this.currentSessionId = sessionId;
       return { restored: true, compressed: true, sessionName: loaded.session.name };
     }

     this.currentSessionId = sessionId;
     this.context.setMessages(loaded.messages);
     return { restored: true, compressed: false, sessionName: loaded.session.name };
   }

   private async summarizeMessages(messages: Message[]): Promise<string> {
     // Limit total input to ~8000 chars to avoid exceeding model context
     const MAX_TOTAL_CHARS = 8000;
     let totalChars = 0;
     const lines: string[] = [];
     for (const m of messages) {
       if (m.role !== 'user' && m.role !== 'assistant') continue;
       const text = m.content.slice(0, 500);
       if (totalChars + text.length > MAX_TOTAL_CHARS) break;
       totalChars += text.length;
       lines.push(`${m.role}: ${text}`);
     }

     return await this.provider.complete([{
       role: 'user',
       content: `请将以下对话历史压缩为简洁的上下文摘要，保留关键信息、决策和结论：\n\n${lines.join('\n')}`,
     }]);
   }

  private async injectMemoryContext(): Promise<void> {
    try {
      const allTools = this.mcp.getAllTools();
      const hasMemoryTools = allTools.some(t => ['search_nodes', 'open_nodes'].includes(t.name));
      if (!hasMemoryTools) return;

      const result = await this.mcp.callTool('search_nodes', { query: '' });
      if (result.isError || !result.content) return;

      const content = result.content.trim();
      // check if result is effectively empty
      try {
        const parsed = JSON.parse(content);
        const entities = parsed.entities ?? parsed.results ?? [];
        if (entities.length === 0) return;
      } catch {
        // fallback: skip if empty-looking
        if (!content || content === '[]' || content === '{}') return;
      }

      const msgs = this.context.getMessages();
      const sysMsg = msgs.find(m => m.role === 'system');
      if (sysMsg) {
        const section = `[知识图谱中已有的用户信息]:`;
        const existingIdx = sysMsg.content.indexOf(section);
        if (existingIdx >= 0) {
          sysMsg.content = sysMsg.content.substring(0, existingIdx);
        }
        sysMsg.content += `\n\n${section}\n${content}`;
      }
    } catch {
      // Memory tools unavailable, skip injection
    }
  }

  private async handleRemember(_args: Record<string, unknown> | undefined): Promise<ToolResult> {
    const content = this.currentUserInput || '';
    if (!content.trim()) {
      return { content: 'Nothing to remember.', isError: true };
    }
    const approval = await this.audit.requestApproval({ type: 'tool_call', name: 'remember', args: {} });
    if (approval === 'deny') {
      return { content: 'Save cancelled by user.', isError: true };
    }
    try {
      const allTools = this.mcp.getAllTools();
      if (!allTools.some(t => t.name === 'create_entities')) {
        return { content: 'Knowledge graph tools not available.', isError: true };
      }
      await this.mcp.callTool('create_entities', {
        entities: [{
          name: 'user',
          entityType: 'person',
          observations: [content],
        }],
      });
      return { content: `Remembered: ${content}` };
    } catch (err) {
      return { content: `Failed to save: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private async saveUserInfoIfNeeded(userInput: string): Promise<void> {
    const nameMatch = userInput.match(/(?:my name is|my name's|i'?m called|call me)\s+(\w+)/i);
    const nicknameMatch = userInput.match(/(?:my nickname is|my nick name is)\s+(\w+)/i);
    if (!nameMatch && !nicknameMatch) return;

    const detail = nameMatch?.[0] || nicknameMatch?.[0] || '';
    const approval = await this.audit.requestApproval({ type: 'user_info', detail });
    if (approval === 'deny') return;

    try {
      const allTools = this.mcp.getAllTools();
      if (!allTools.some(t => t.name === 'create_entities')) return;

      const name = nameMatch?.[1] || nicknameMatch?.[1] || 'user';
      const observations: string[] = [];
      if (nameMatch?.[1]) observations.push(`User's name is ${nameMatch[1]}`);
      if (nicknameMatch?.[1]) observations.push(`User's nickname is ${nicknameMatch[1]}`);

      await this.mcp.callTool('create_entities', {
        entities: [{
          name,
          entityType: 'person',
          observations,
        }],
      });
    } catch {
      // Silent fail
    }
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
  }
}
