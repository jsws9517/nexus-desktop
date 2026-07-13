import chalk from 'chalk';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { ConfigManager } from './config/index.js';
import { LLMProvider, createProvider } from './llm/provider.js';
import { ContextManager, CompactMetadata } from './llm/context-manager.js';
import { SessionManager } from './session/manager.js';
import { SessionMemory } from './session/memory.js';
import { ClientManager } from './mcp/client-manager.js';
import { SkillRegistry } from './skills/registry.js';
import { AcpProtocol } from './acp/protocol.js';
import { Message, ToolCall, ToolResult, ToolDefinition, AgentEvent } from './types.js';
import { Hooks, createSanityCheckHook } from './hooks/index.js';
import { createAutoValidateHook } from './hooks/auto-validate.js';
import { AuditManager } from './security/audit.js';
import { resolveApiKey } from './security/env-key-encrypt.js';
import { ThemeManager } from './theme/manager.js';
import { ProgressTracker, TaskGraph, DAGScheduler, SubAgentWorker } from './task/index.js';
import { getTaskToolDefinitions, executeTaskTool } from './task/task-tools.js';
import { ProjectContext } from './context/index.js';

const REMEMBER_TOOL_DEF: ToolDefinition = {
  name: 'remember',
  description: 'Save user information to the knowledge graph for future reference across sessions. Call this whenever the user shares personal preferences, facts, or anything they want remembered. Pass the content to save — summarize the key info from the conversation (e.g. "CPU: Intel i5-1240P, RAM: 40GB").',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The content to save to the knowledge graph' },
    },
    required: ['content'],
  },
};

const RECALL_TOOL_DEF: ToolDefinition = {
  name: 'recall',
  description: 'MUST CALL FIRST when the user asks about their personal information, identity, name, preferences, computer config, or anything that may have been saved in the knowledge graph from previous sessions. Retrieves all previously remembered user data. No arguments needed.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const REMEMBER_PROJECT_TOOL_DEF: ToolDefinition = {
  name: 'remember_project',
  description: 'Save project-specific information (architecture decisions, conventions, key facts) to the project knowledge base. The content is captured automatically from the current message. Use this for project-level context, NOT personal info.',
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

export interface TurnMetrics {
  turnNumber: number;
  llmCallTime: number;
  toolExecTime: number;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  contextTokensAfter: number;
  compactStrategy?: string;
}

export class Agent {
  config: ConfigManager;
  provider: LLMProvider;
  mcp: ClientManager;
  session: SessionManager;
  sessionMemory: SessionMemory;
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

  /** Task decomposition and progress tracking */
  tracker = new ProgressTracker();
  currentPlan?: TaskGraph;
  planMode = false;

  /** Project context (reads .nexus/ directory) */
  projectContext = new ProjectContext();

  /** Pending /btw info to inject on next LLM turn */
  pendingBtw?: string;

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

  /** Metrics for observability */
  private metrics: TurnMetrics[] = [];
  private turnStartTime = 0;
  private turnLlmTime = 0;

  /** Theme accessor */
  private themeMgr = new ThemeManager();
  private get t() { return this.themeMgr.token; }

  /** Get session metrics */
  getSessionMetrics(): TurnMetrics[] {
    return [...this.metrics];
  }

  constructor(enableAcp?: boolean, isAcpServer?: boolean) {
    this.config = new ConfigManager();
    this.enableAcp = enableAcp;
    this.isAcpServer = isAcpServer;
    const providerConfig = this.config.getProvider();
    this.provider = createProvider(providerConfig.type, providerConfig.apiKey, providerConfig.model, providerConfig.baseUrl, providerConfig.options, this.config.getActiveProvider());
    this.mcp = new ClientManager();
    this.session = new SessionManager();
    this.sessionMemory = new SessionMemory();
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
        this.injectSessionMemory();
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
如果某个工具调用失败，请报告具体的错误信息。
 用户信息会在获得许可后通过 remember 工具保存到知识图谱（存储于 ~/.nexus 目录）。
 会话中用户通过 ! 命令执行的 bash 输出结果（如系统配置、硬件信息等）也包含在对话上下文中，若其中有可用于个性化服务的用户信息（如电脑配置、工作环境等），请主动调用 remember 将其持久化到知识图谱。
 使用 recall 工具可以获取之前记住的用户信息（如姓名、昵称、爱好、电脑配置等），当用户询问个人信息时请先调用 recall。
 使用 remember_project 工具可以保存项目相关的信息（如架构决策、编码约定等），这些信息会保存在当前项目的 .nexus/knowledge/ 目录中。`;

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

    // Inject project context (.nexus/PROJECT.md, rules, knowledge)
    await this.projectContext.load(process.cwd());
    await this.projectContext.inject(this.context);

    // Auto-save user info to knowledge graph
    await this.saveUserInfoIfNeeded(userInput);

    // Reset tool error tracking for each user input
    this.toolErrorCount.clear();
    this.currentUserInput = userInput;
    const userMessage: Message = { role: 'user', content: userInput };
    this.context.add(userMessage);
    this.session.addMessage(this.currentSessionId!, userMessage);

    // Set compression progress callback to emit thinking events
    this.context.onProgress = (msg) => this.onEvent?.({ type: 'thinking', thinking: msg });
    await this.context.compress();
    this.context.onProgress = undefined;

    // Auto-register sanity check + auto-validate + /btw injection hooks for each chat
    const sanityCheck = createSanityCheckHook(userInput);
    const autoValidate = createAutoValidateHook();
    const userHooks = this.hooks;
    this.hooks = {
      ...(userHooks || {}),
      preLlmCall: async (ctx) => {
        // Inject /btw info into system prompt preamble before LLM sees messages
        if (this.pendingBtw) {
          this.context.prependToSystem(`[Context: ${this.pendingBtw}]`);
          this.pendingBtw = undefined;
        }
        await userHooks?.preLlmCall?.(ctx);
      },
      preToolUse: async (ctx) => {
        const check = await sanityCheck(ctx);
        if (check !== 'allow') return check;
        return userHooks?.preToolUse ? userHooks.preToolUse(ctx) : 'allow';
      },
      postToolUse: async (ctx) => {
        await autoValidate(ctx);
        await userHooks?.postToolUse?.(ctx);
      },
    };

    this.reasoningLog = [];
    this.currentTurn = 0;
    this.metrics = [];
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.busy = true;

    // Snapshot the display mode for this entire reasoning chain
    const showDetail = this.detailMode;

    this.onEvent?.({ type: 'session_start', sessionId: this.currentSessionId! });

    try {
      if (!showDetail && !this.onOutput) {
        this.compactStartTime = Date.now();
        process.stdout.write(this.t.textDim('Thought'));
      }

      await this.runLlmTurn(showDetail, signal);

      if (signal.aborted) return;

      if (!showDetail) {
        this.renderCompactOutput();
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (this.hooks?.onError) {
        await this.hooks.onError({ turn: this.currentTurn, signal, userInput: this.currentUserInput }, err);
      }
      // Auto-learn model context limit from API error
      const errStr = err.message;
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
      if (this.currentSessionId && this.currentUserInput) {
        this.updateSessionMemory();
      }
      if (this.metrics.length > 1 && !this.onOutput) {
        this.printSessionReport();
      }
    }
  }

  private printSessionReport(): void {
    const totalLlmTime = this.metrics.reduce((s, m) => s + m.llmCallTime, 0);
    const totalToolTime = this.metrics.reduce((s, m) => s + m.toolExecTime, 0);
    const totalTokens = this.context.getTokenCount();
    const compactCount = this.metrics.filter(m => m.compactStrategy).length;

    process.stderr.write(this.t.textDim(`\n╌ Session Report ╌\n`));
    process.stderr.write(this.t.textDim(`Turns: ${this.metrics.length}  `));
    process.stderr.write(this.t.textDim(`LLM: ${(totalLlmTime / 1000).toFixed(1)}s  `));
    process.stderr.write(this.t.textDim(`Tools: ${(totalToolTime / 1000).toFixed(1)}s  `));
    process.stderr.write(this.t.textDim(`Tokens: ${totalTokens.toLocaleString()}`));
    if (compactCount > 0) {
      process.stderr.write(this.t.textDim(`  Compact: ${compactCount}x`));
    }
    process.stderr.write(this.t.textDim('\n'));
  }

  private updateSessionMemory(): void {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    const session = this.session.get(sessionId);
    const sessionName = session?.name || sessionId;
    const msgs = this.context.getMessages();
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const lastUser = userMsgs[userMsgs.length - 1];

    // build a condensed memory entry
    const toolCalls = msgs.filter((m) => m.role === 'assistant' && m.toolCalls);
    const toolNames = [...new Set(toolCalls.flatMap((m) => m.toolCalls?.map((tc) => tc.name) || []))];
    const entryParts: string[] = [];
    if (lastUser && this.currentUserInput) {
      entryParts.push(lastUser.content.slice(0, 120));
    }
    if (toolNames.length > 0) {
      entryParts.push(`[tools: ${toolNames.join(', ')}]`);
    }
    if (entryParts.length === 0) return;

    const line = `- ${entryParts.join(' ')}\n`;
    const existing = this.sessionMemory.load(sessionId) || '';
    this.sessionMemory.save(sessionId, sessionName, existing + line);
  }

  private injectSessionMemory(): void {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    const memory = this.sessionMemory.load(sessionId);
    if (!memory) return;
    const msgs = this.context.getMessages();
    const sysIdx = msgs.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      const sys = msgs[sysIdx]!;
      if (!sys.content.includes('[会话记忆]')) {
        sys.content += `\n\n[会话记忆]:\n${memory}`;
      }
    } else {
      this.context.add({ role: 'system', content: `[会话记忆]:\n${memory}` });
    }
  }

  private async runLlmTurn(showDetail: boolean, signal: AbortSignal): Promise<void> {
    this.currentTurn++;
    if (this.currentTurn > this.maxTurns) return;

    this.onEvent?.({ type: 'turn_start', turn: this.currentTurn });
    this.turnStartTime = Date.now();
    this.turnLlmTime = 0;

    const allTools = this.mcp.getAllTools();
    let tools: ToolDefinition[] = [
      ...allTools.filter(t => !INTERNAL_TOOLS.has(t.name)),
      ...this.skills.getTools(),
      ...this.getAcpTools(),
      REMEMBER_TOOL_DEF,
      RECALL_TOOL_DEF,
      REMEMBER_PROJECT_TOOL_DEF,
      ...getTaskToolDefinitions(),
    ];

    // In plan mode, restrict to read-only + task tools
    if (this.planMode) {
      const allowedNames = new Set([
        'file_read', 'read_text_file', 'read_multiple_files', 'list_directory', 'get_file_info', 'directory_tree',
        'fetch_url', 'web_search', 'web_fetch',
        'decompose_task', 'query_tasks', 'search_nodes', 'search_files', 'open_nodes',
        'remember', 'recall', 'remember_project',
      ]);
      tools = tools.filter((t) => allowedNames.has(t.name));
    }

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

    if (this.hooks?.preLlmCall) {
      await this.hooks.preLlmCall({ turn: this.currentTurn, signal, userInput: this.currentUserInput, toolDefinitions: tools });
    }

    try {
      const llmStart = Date.now();
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
          const clean = chunk.thinking.replace(/\uFFFD/g, '');
          this.onEvent?.({ type: 'thinking', thinking: clean });
          if (showDetail && !this.onOutput) {
            process.stdout.write(chalk.italic(this.t.thinking(clean)));
          }
        }
        if (chunk.type === 'tool_call' && chunk.toolCall) {
          // Clean U+FFFD from tool call arguments for display
          if (chunk.toolCall.arguments) {
            const cleanArgs: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(chunk.toolCall.arguments)) {
              cleanArgs[k] = typeof v === 'string' ? v.replace(/\uFFFD/g, '') : v;
            }
            chunk.toolCall.arguments = cleanArgs;
          }
          pendingToolCalls.push(chunk.toolCall);
          this.onEvent?.({ type: 'tool_call_start', index: pendingToolCalls.length - 1, name: chunk.toolCall.name, args: chunk.toolCall.arguments });
        }
      }
      this.turnLlmTime = Date.now() - llmStart;
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
      // Auto-save long generated content to file
      this.autoSaveLongContent(assistantMessage);
    }

    if (this.hooks?.postLlmCall) {
      const postMsg: Message = { role: 'assistant', content: assistantMessage, toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined };
      await this.hooks.postLlmCall({ turn: this.currentTurn, signal, message: postMsg, userInput: this.currentUserInput, toolDefinitions: tools });
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

      const argsPreview = JSON.stringify(toolCall.arguments ?? {}).slice(0, 80);
      if (showDetail && !this.suppressToolOutput) {
        process.stdout.write(`  ${this.t.spinner('●')} ${this.t.toolCallName(toolCall.name)}(${this.t.textDim(argsPreview)})`);
      }
      let result: ToolResult;
      const toolStart = Date.now();
      try {
        result = await this.executeTool(toolCall);
      } catch (err) {
        result = { content: `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const toolElapsed = Date.now() - toolStart;
      if (showDetail && !this.suppressToolOutput) {
        if (result.isError) {
          process.stdout.write(`\r  ${this.t.error('✗')} ${this.t.toolCallName(toolCall.name)}(${this.t.textDim(argsPreview)}) ${this.t.textDim(`[${toolElapsed}ms]`)}\n`);
          process.stdout.write(`    ${this.t.error(result.content.slice(0, 200))}\n`);
        } else {
          process.stdout.write(`\r  ${this.t.success('✓')} ${this.t.toolCallName(toolCall.name)}(${this.t.textDim(argsPreview)}) ${this.t.textDim(`[${toolElapsed}ms]`)}\n`);
        }
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

    const turnElapsed = Date.now() - this.turnStartTime;
    const contextTokens = this.context.getTokenCount();
    this.metrics.push({
      turnNumber: this.currentTurn,
      llmCallTime: this.turnLlmTime,
      toolExecTime: turnElapsed - this.turnLlmTime,
      toolCount: pendingToolCalls.length,
      inputTokens: 0,
      outputTokens: 0,
      contextTokensAfter: contextTokens,
      compactStrategy: this.context.lastCompactMetadata?.strategy,
    });

    const stopReason = signal.aborted ? 'aborted' : (pendingToolCalls.length > 0 ? 'tool_use' : 'end_turn');
    this.onEvent?.({ type: 'turn_end', stopReason });
    await this.hooks?.onTurnEnd?.({ turn: this.currentTurn, signal, userInput: this.currentUserInput });

    // If there were tool calls, re-run LLM with results
    if (pendingToolCalls.length > 0) {
      // Check if ALL tool calls have failed 3+ times — break the infinite loop
      const allFailed = pendingToolCalls.every((tc) => {
        const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
        return (this.toolErrorCount.get(key) || 0) >= 3;
      });
      if (allFailed && pendingToolCalls.length > 0) {
        if (showDetail && !this.onOutput) {
          console.log(this.t.warning('\n⚠ All tool calls failed repeatedly. Stopping.'));
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
      this.t.textDim(` for ${elapsed}s (ctrl+o to expand)\n`),
    );

    const startIdx = Math.max(0, this.reasoningLog.length - this.compactLimit);

    for (let i = startIdx; i < this.reasoningLog.length; i++) {
      const entry = this.reasoningLog[i];

      // Main text with bullet point
      if (entry.assistantText) {
        console.log(this.t.textPrimary(`• ${entry.assistantText}`));
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
          const branch = isLastTool ? this.t.textDim('└ ') : this.t.textDim('├ ');
          const summary = tc.resultSummary
            .slice(0, 60)
            .replace(/[/\\]/g, '/')
            .replace(/\n/g, ' ');
          console.log(`${branch}${this.t.toolCallName(tc.name)}(${this.t.textDim(summary)})`);
        }

        if (hidden > 0) {
          console.log(
            this.t.textDim(`└ ... +${hidden} tool uses (ctrl+o to expand)`),
          );
        }
      }
    }

    if (this.reasoningLog.length > this.compactLimit) {
      const hidden = this.reasoningLog.length - this.compactLimit;
      console.log(
        this.t.textDim(`\n(${hidden} earlier reasoning steps hidden — press Ctrl+O for full details)`),
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

    // Handle recall tool (agent-level, reads from KG)
    if (call.name === 'recall') {
      return this.handleRecall();
    }

    // Handle remember_project tool (saves project-specific info to .nexus/knowledge/)
    if (call.name === 'remember_project') {
      return this.handleRememberProject(safeArgs);
    }

    // 1. Check local skills first
    const skillResult = await this.skills.callTool(call.name, safeArgs);
    if (skillResult) return skillResult;

    // 1.5 Check task tools (decompose_task, spawn_subagent, query_tasks)
    const taskResult = await executeTaskTool(call.name, safeArgs, {
      agent: this,
      tracker: this.tracker,
      sessionId: this.currentSessionId,
    });
    if (taskResult) return taskResult;

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
    const modelLimit = this.config.getModelContextLimit();
    const maxTokens = this.config.getProvider().maxContextTokens || modelLimit || 8192;

    if (tokenCount > maxTokens && loaded.messages.length >= 4) {
      const messages = loaded.messages;

      // Dynamic keep count: use up to 50% of context budget for recent messages
      const keepBudget = Math.floor(maxTokens * 0.5);
      let keepTokens = 0;
      let keepCount = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const t = this.provider?.countTokens(messages[i].content) || Math.ceil(messages[i].content.length / 4);
        if (keepTokens + t > keepBudget && keepCount >= 6) break;
        keepTokens += t;
        keepCount++;
      }
      keepCount = Math.max(6, Math.min(messages.length, keepCount));

      // Find safe split point: don't cut inside a tool_call chain
      let splitIdx = messages.length - keepCount;
      while (splitIdx > 0) {
        const prev = messages[splitIdx - 1];
        if (prev.role === 'assistant' && prev.toolCalls && prev.toolCalls.length > 0) {
          const toolCallIds = new Set(prev.toolCalls.map(tc => tc.id));
          const hasOrphanedTools = messages.slice(splitIdx).some(
            m => m.role === 'tool' && m.toolCallId && toolCallIds.has(m.toolCallId),
          );
          if (hasOrphanedTools) {
            splitIdx--;
            continue;
          }
        }
        const curr = messages[splitIdx];
        if (curr.role === 'tool' && curr.toolCallId) {
          for (let j = splitIdx - 1; j >= 0; j--) {
            const m = messages[j];
            if (m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === curr.toolCallId)) {
              splitIdx = j;
              break;
            }
            if (m.role === 'user') break;
          }
          continue;
        }
        break;
      }

      const toSummarize = messages.slice(0, splitIdx);
      const toKeep = messages.slice(splitIdx);

      const summary = await this.summarizeMessages(toSummarize);
      const memoryContent = this.sessionMemory.load(sessionId);
      const memoryNote = memoryContent
        ? `\n\n[会话记忆]:\n${memoryContent}`
        : '';
      this.context.setMessages([
        { role: 'system', content: `[已恢复会话「${loaded.session.name}」— 原始 ${tokenCount} tokens，已压缩为摘要，保留了最近 ${keepCount} 条消息]\n\n${summary}${memoryNote}` },
        ...toKeep,
      ]);
      this.currentSessionId = sessionId;
      return { restored: true, compressed: true, sessionName: loaded.session.name };
    }

    this.currentSessionId = sessionId;
    this.context.setMessages(loaded.messages);
    this.injectSessionMemory();
    return { restored: true, compressed: false, sessionName: loaded.session.name };
  }

  private async summarizeMessages(messages: Message[]): Promise<string> {
    // Limit total input to ~20000 chars to balance detail vs context
    const MAX_TOTAL_CHARS = 20000;
    let totalChars = 0;
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      // Prioritize assistant messages (they contain generated content like novels)
      const limit = m.role === 'assistant' ? 3000 : 1500;
      const text = m.content.slice(0, limit);
      if (totalChars + text.length > MAX_TOTAL_CHARS) {
        if (m.role === 'assistant') {
          // Always include assistant content, truncate to remaining budget
          const remaining = MAX_TOTAL_CHARS - totalChars;
          if (remaining > 100) lines.push(`${m.role}: ${text.slice(0, remaining)}`);
        }
        break;
      }
      totalChars += text.length;
      lines.push(`${m.role}: ${text}`);
    }

    return await this.provider.complete([{
      role: 'user',
      content: `请将以下对话历史压缩为详细的上下文摘要，保留关键信息、所有已生成的内容（如小说章节正文、代码等）、用户的要求、以及已做出的决策和结论。\n\n${lines.join('\n')}`,
    }]);
  }

  /** Auto-save long assistant responses to files in ~/.nexus/_cache/ so they survive compression */
  private autoSaveLongContent(content: string): void {
    if (!content || content.length < 500) return;
    const dir = resolve(homedir(), '.nexus', '_cache');
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = content.split('\n')[0]?.trim().slice(0, 50).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '') || 'content';
    const filename = `${timestamp}_${title}.md`;
    writeFileSync(join(dir, filename), content, 'utf-8');
    if (!this.onOutput) {
      process.stdout.write(`\n\x1b[2m[Auto-saved: ~/.nexus/_cache/${filename}]\x1b[0m\n`);
    }
  }

  private async injectMemoryContext(): Promise<void> {
    try {
      const allTools = this.mcp.getAllTools();
      const hasMemoryTools = allTools.some(t => ['search_nodes', 'open_nodes'].includes(t.name));
      if (!hasMemoryTools) return;

      // Retrieve all entities from the knowledge graph for context injection
      const result = await this.mcp.callTool('search_nodes', { query: '' });
      if (result.isError || !result.content) {
        // Fallback: try semantic search to retrieve remembered user info
        const semantic = await this.mcp.callTool('search_semantic', { query: 'user', limit: 20 });
        if (semantic.isError || !semantic.content) return;
        const sContent = semantic.content.trim();
        if (!sContent || sContent === '[]' || sContent === '{}') return;
        try {
          const parsed = JSON.parse(sContent);
          if (!parsed.results?.length) return;
        } catch { return; }
        this._injectToSystemPrompt(sContent);
        return;
      }

      const content = result.content.trim();
      try {
        const parsed = JSON.parse(content);
        const entities = parsed.entities ?? parsed.results ?? [];
        if (entities.length === 0) return;
      } catch {
        if (!content || content === '[]' || content === '{}') return;
      }

      this._injectToSystemPrompt(content);
    } catch {
      // Memory tools unavailable, skip injection
    }
  }

  private _injectToSystemPrompt(content: string): void {
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
  }

  private readonly OBSERVATION_CONSOLIDATION_THRESHOLD = 15;

  private async handleRemember(_args: Record<string, unknown> | undefined): Promise<ToolResult> {
    const content = (typeof _args?.content === 'string' ? _args.content : this.currentUserInput || '').trim();
    if (!content) {
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

      // Check if 'user' entity already exists — append if so, create if not
      const existing = await this.mcp.callTool('search_nodes', { query: 'user' });
      let entityExists = false;
      if (!existing.isError && existing.content) {
        try {
          const parsed = JSON.parse(existing.content.trim());
          const entities = parsed.entities ?? parsed.results ?? [];
          entityExists = entities.some((e: { name?: string }) => e.name === 'user');
        } catch { /* ignore parse error */ }
      }

      if (entityExists && allTools.some(t => t.name === 'add_observations')) {
        // Append to existing entity
        await this.mcp.callTool('add_observations', {
          name: 'user',
          observations: [content],
        });
        // Auto-consolidate if too many observations
        await this.autoConsolidateObservations('user');
      } else {
        // Create new entity (create_entities merges observations on conflict)
        await this.mcp.callTool('create_entities', {
          entities: [{
            name: 'user',
            entityType: 'person',
            observations: [content],
          }],
        });
      }

      return { content: `Remembered: ${content}` };
    } catch (err) {
      return { content: `Failed to save: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private async handleRecall(): Promise<ToolResult> {
    try {
      const allTools = this.mcp.getAllTools();
      if (!allTools.some(t => t.name === 'search_nodes')) {
        // KG not available, fall back to .remember files directly
        const rememberContent = this.readRememberFiles();
        if (rememberContent) return { content: rememberContent, isError: false };
        return { content: 'No previous remembered data found.', isError: false };
      }

      // 1st priority: search mcp-memory knowledge graph
      const queries = ['', 'user'];
      for (const q of queries) {
        const result = await this.mcp.callTool('search_nodes', { query: q });
        if (!result.isError && result.content) {
          const content = result.content.trim();
          if (content && content !== '[]' && content !== '{}') {
            return { content: `[知识图谱]\n${content}`, isError: false };
          }
        }
      }

      // 2nd priority: semantic search
      const semantic = await this.mcp.callTool('search_semantic', { query: 'user', limit: 20 });
      if (!semantic.isError && semantic.content) {
        const sContent = semantic.content.trim();
        if (sContent && sContent !== '[]' && sContent !== '{}') {
          return { content: `[知识图谱]\n${sContent}`, isError: false };
        }
      }

      // 3rd priority: fall back to .remember session files
      const rememberContent = this.readRememberFiles();
      if (rememberContent) return { content: `[.remember 会话记忆]\n${rememberContent}`, isError: false };

      return { content: 'No previous remembered data found.', isError: false };
    } catch {
      return { content: 'No previous remembered data found.', isError: false };
    }
  }

  private readRememberFiles(): string {
    try {
      const rememberDir = resolve(process.cwd(), '.remember');
      if (!existsSync(rememberDir)) return '';

      const parts: string[] = [];

      // Priority order: now.md > today-*.md > recent.md > remember.md > archive.md
      const nowPath = join(rememberDir, 'now.md');
      if (existsSync(nowPath)) {
        const content = readFileSync(nowPath, 'utf-8').trim();
        if (content) parts.push(`[近期记忆]\n${content}`);
      }

      // Read today-*.md files (newest first)
      try {
        const files = readdirSync(rememberDir)
          .filter(f => /^today-\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .sort()
          .reverse();
        for (const file of files.slice(0, 3)) {
          const content = readFileSync(join(rememberDir, file), 'utf-8').trim();
          if (content) parts.push(`[${file.replace('.md', '')}]\n${content}`);
        }
      } catch { /* ignore read errors */ }

      const recentPath = join(rememberDir, 'recent.md');
      if (existsSync(recentPath)) {
        const content = readFileSync(recentPath, 'utf-8').trim();
        if (content) parts.push(`[近期归档]\n${content}`);
      }

      const rememberPath = join(rememberDir, 'remember.md');
      if (existsSync(rememberPath)) {
        const content = readFileSync(rememberPath, 'utf-8').trim();
        if (content) parts.push(`[持久记忆]\n${content}`);
      }

      return parts.join('\n\n');
    } catch {
      return '';
    }
  }

  private async handleRememberProject(_args: Record<string, unknown> | undefined): Promise<ToolResult> {
    const content = this.currentUserInput || '';
    if (!content.trim()) {
      return { content: 'Nothing to remember.', isError: true };
    }
    try {
      const projectDir = process.cwd();
      const projectName = projectDir.split(/[/\\]/).pop() || 'project';
      const key = `memory-${Date.now()}`;
      await this.projectContext.saveKnowledge(key, content);
      return { content: `Saved project memory: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}` };
    } catch (err) {
      return { content: `Failed to save project memory: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private async autoConsolidateObservations(entityName: string): Promise<void> {
    try {
      const allTools = this.mcp.getAllTools();
      if (!allTools.some(t => t.name === 'open_nodes')) return;

      const open = await this.mcp.callTool('open_nodes', { names: [entityName] });
      if (open.isError || !open.content) return;

      const parsed = JSON.parse(open.content.trim());
      const entities = parsed.entities ?? [];
      if (entities.length === 0) return;

      const obs = entities[0].observations ?? [];
      if (obs.length < this.OBSERVATION_CONSOLIDATION_THRESHOLD) return;

      // Add a consolidation metadata observation to track auto-summary
      if (allTools.some(t => t.name === 'add_observations')) {
        await this.mcp.callTool('add_observations', {
          name: entityName,
          observations: [`[auto-summary] ${obs.length} observations recorded for ${entityName}`],
          kind: 'metadata',
        });
      }
    } catch {
      // Silent: consolidation is best-effort
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

      // Append to existing 'user' entity or create a new person entity
      const existing = await this.mcp.callTool('search_nodes', { query: name });
      let entityExists = false;
      if (!existing.isError && existing.content) {
        try {
          const parsed = JSON.parse(existing.content.trim());
          const entities = parsed.entities ?? parsed.results ?? [];
          entityExists = entities.some((e: { name?: string }) => e.name === name);
        } catch { /* ignore */ }
      }

      if (entityExists && allTools.some(t => t.name === 'add_observations')) {
        await this.mcp.callTool('add_observations', {
          name,
          observations,
        });
      } else {
        await this.mcp.callTool('create_entities', {
          entities: [{
            name,
            entityType: 'person',
            observations,
          }],
        });
      }
    } catch {
      // Silent fail
    }
  }

  async plan(request: string): Promise<string> {
    this.planMode = true;
    const response = await this.provider.complete([{
      role: 'user',
      content: `你是一个架构师。请对以下需求进行分析，输出详细的实现计划。

要求：
1. 分析需求的关键点
2. 列出实现步骤（按依赖关系排序）
3. 每个步骤标注需要使用的技术/工具
4. 不可执行任何代码修改操作，只输出计划

需求: ${request}`,
    }]);
    return response;
  }

  async executePlan(): Promise<string> {
    this.planMode = false;
    if (!this.currentPlan) {
      return 'No plan to execute. Use /plan first.';
    }
    const worker = new SubAgentWorker(this);
    const scheduler = new DAGScheduler(worker, this.tracker);
    try {
      await scheduler.execute(this.currentPlan);
      return 'Plan execution completed.';
    } catch (err) {
      return `Plan execution failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
  }
}
