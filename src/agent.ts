import chalk from 'chalk';
import { resolve, join } from 'path';
import { t, tf } from './i18n/index.js';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { ConfigManager } from './config/index.js';
import { PERMISSION_PRESETS } from './config/types.js';
import { LLMProvider, createProvider } from './llm/provider.js';
import { IdleTimeoutError } from './llm/chunk-timeout.js';
import { applyConfigTimeouts } from './llm/timeout-config.js';
import { ContextManager, CompactMetadata } from './llm/context-manager.js';
import { SessionManager } from './session/manager.js';
import { SessionMemory } from './session/memory.js';
import { ClientManager } from './mcp/client-manager.js';
import { SkillRegistry } from './skills/registry.js';
import { AcpProtocol } from './acp/protocol.js';
import { Message, ToolCall, ToolResult, ToolDefinition, AgentEvent } from './types.js';
import { Hooks, createSanityCheckHook } from './hooks/index.js';
import { createAutoValidateHook } from './hooks/auto-validate.js';
import { permissionCheckHook } from './hooks/permissions.js';
import { AuditManager } from './security/audit.js';
import { resolveApiKey } from './security/env-key-encrypt.js';
import { ThemeManager } from './theme/manager.js';
import { ProgressTracker, TaskGraph, DAGScheduler, SubAgentWorker } from './task/index.js';
import { preloadLocalVision } from './vision/local.js';
import { getTaskToolDefinitions, executeTaskTool } from './task/task-tools.js';
import { ProjectContext } from './context/index.js';

import { analyzeImage, isImageFile } from './vision/index.js';
import { authorizePath } from './security/path-authorizer.js';
import { sanitizeContent, neutralizeInstructions } from './utils/sanitize.js';
import type { FileOutput } from './types.js';

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.rb': 'text/x-ruby',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
};

function detectMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/** File extensions that are considered pushable output files */
const PUSHABLE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif', '.ico',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.wav', '.mp4', '.avi', '.mov',
  '.zip', '.tar',
  '.html', '.htm',
  '.csv', '.json', '.txt', '.md',
]);

/**
 * Detect file paths in tool result content that are pushable output files.
 * Matches common patterns like:
 *   - JSON: { "image_path": "/path/to/file.png" }
 *   - "saved to /path/to/file.png"
 *   - "output: C:\path\to\file.jpg"
 *   - absolute paths with pushable extensions
 */
function detectFilesInToolResult(content: string, toolName: string): FileOutput[] {
  const files: FileOutput[] = [];
  const seen = new Set<string>();

  function addFile(filePath: string) {
    // Normalize path separators and collapse double backslashes (from regex on JSON string)
    const normalized = filePath.replace(/\\\\/g, '\\').replace(/\//g, '\\');
    if (!seen.has(normalized.toLowerCase())) {
      if (existsSync(filePath) || existsSync(filePath.replace(/\\/g, '/'))) {
        seen.add(normalized.toLowerCase());
        files.push({
          path: filePath,
          mimeType: detectMimeType(filePath),
          name: filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1),
        });
      }
    }
  }

  // 1. Try to parse as JSON and extract known path fields
  try {
    const obj = JSON.parse(content);
    const pathFields = ['image_path', 'image_url', 'path', 'url', 'file_path', 'output_path',
                        'filePath', 'outputPath', 'fileUrl', 'imageUrl', 'local_path', 'localPath'];
    for (const field of pathFields) {
      const val = obj[field];
      if (typeof val === 'string') {
        // Could be a local path or a file:// URL
        const localPath = val.startsWith('file://') ? val.slice(7) : val;
        if (/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|pdf|docx?|xlsx?|pptx?|csv|json|txt|md|html?|mp[34]|wav|avi|mov|zip|tar)$/i.test(localPath)) {
          addFile(localPath);
        }
      }
    }
  } catch {
    // Not JSON, fall through to regex matching
  }

  // 2. Regex: match file paths with pushable extensions in text
  // Support both Unix and Windows paths, including Chinese characters
  // NOTE: '.' is NOT in the path char class so extension matching works precisely
  const pathRegex = /([A-Z]:[\\\/][\w\\\/\-\u4e00-\u9fa5]+|\/[\/\w\-\u4e00-\u9fa5]+)\.(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|pdf|docx?|xlsx?|pptx?|csv|json|txt|md|html?|mp[34]|wav|avi|mov|zip|tar)/gi;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(content)) !== null) {
    addFile(match[1] + '.' + match[2]);
  }

  return files;
}

/**
 * Strip the @-expansion suffix appended by expandAtMentions() from user input.
 * The suffix is of the form "\n\n[Referenced file: ...]" etc. and should NOT
 * be stored in the session or restored into LLM context, because:
 * 1) It causes the LLM to attempt redundant file-access tool calls on resume
 * 2) It triggers duplicate authorization prompts
 * 3) The original @path syntax in the user message is sufficient context.
 */
function stripExpansionSuffix(content: string): string {
  const idx = content.search(/\n\n\[(Referenced file|Directory|Access denied|File\/Directory not found)/);
  return idx === -1 ? content : content.slice(0, idx);
}

/**
 * Build a single-line, terminal-width-aware preview of tool call arguments.
 * Avoids two display bugs: (1) the closing `}` being chopped off by a fixed
 * 80-char slice, and (2) the preview wrapping onto a second line because it
 * exceeds the terminal width. When truncated, an ellipsis is appended so the
 * cut is explicit rather than silently dropping the trailing brace.
 */
function makeArgsPreview(args: Record<string, unknown>, name: string): string {
  // A model may emit a long string (e.g. a URL) wrapped across lines; after
  // JSON.parse that becomes a real 0x0A inside the value, which would break the
  // display line and make the \r success-update only rewrite the wrapped tail.
  // Strip control chars and collapse embedded newlines so the preview stays on
  // a single logical line.
  const raw = JSON.stringify(args ?? {})
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '');
  // Cap the rendered preview to a safe constant width. We intentionally do NOT
  // trust process.stdout.columns here: it can be inflated or stale (piped
  // output, IDE-integrated terminals, TMUX), which would skip truncation and
  // let a long arg (e.g. a URL) wrap across two terminal lines, producing the
  // dangling/duplicated status line. A fixed cap guarantees the whole status
  // line (prefix + name + args + "[12345ms]") stays under a normal terminal.
  // Overhead = "  ✓ " + name + "(" + ") [12345ms]" + margin (ANSI codes ignored)
  const overhead = name.length + 26;
  const max = Math.max(24, 100 - overhead);
  if (raw.length <= max) return raw;
  return raw.slice(0, max - 1).replace(/\s+$/, '') + '…';
}

const REMEMBER_TOOL_DEF: ToolDefinition = {
  name: 'remember',
  description: t('remember_tool_desc'),
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: t('remember_content_desc') },
    },
    required: ['content'],
  },
};

const RECALL_TOOL_DEF: ToolDefinition = {
  name: 'recall',
  description: t('recall_tool_desc'),
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const REMEMBER_PROJECT_TOOL_DEF: ToolDefinition = {
  name: 'remember_project',
  description: t('remember_project_desc'),
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const ANALYZE_IMAGE_TOOL_DEF: ToolDefinition = {
  name: 'analyze_image',
  description: 'Analyze an image and return a description (content, objects, layout, etc.). Use this for general image understanding — identifying what is in the image, describing scenes, recognizing objects, reading diagrams. NOT for extracting raw text from screenshots or documents (use ocr_extract for that). Only call when the user uploads or links a specific image. Do NOT call on images just generated by other tools.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the image file (also accepts "image" as the key name)' },
      question: { type: 'string', description: 'Optional specific question about the image' },
    },
    required: ['path'],
  },
};

const OCR_EXTRACT_TOOL_DEF: ToolDefinition = {
  name: 'ocr_extract',
  description: '[PREFERRED for text extraction] Extract raw text from images using OCR. Use this INSTEAD of analyze_image when the user asks to read/extract/copy text from: screenshots, scanned documents, photos of text, forms, tables, presentation slides, terminal output screenshots, or any image where the main goal is getting the text content. Returns the exact extracted text characters.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the image file (also accepts "image" as the key name)' },
      language: { type: 'string', description: 'Optional language hint for OCR (e.g. "en", "ch", "ja"). Improves accuracy for specific languages.' },
    },
    required: ['path'],
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

let _acpDebugEnabled = !!process.env.NEXUS_ACP_DEBUG;
const _acpLog = (msg: string) => { if (_acpDebugEnabled) process.stderr.write(msg); };

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
  /** ACP server callback: receive file output (image/document) for push to client */
  onFileOutput?: (file: FileOutput) => void;
  /** Suppress tool call console output (used in ACP server mode) */
  suppressToolOutput = false;
  /** ACP permission request callback: await user permission before executing a tool */
  onPermissionRequest?: (toolName: string, toolCallId: string, toolArgs: unknown) => Promise<{ verdict: 'allow' | 'deny' }>;

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

  /** Optional allowlist restricting which tools this agent may call.
   *  Used by role-scoped sub-agents (e.g. tester/committer) to enforce
   *  read-only or git-only behaviour. `undefined` = all tools allowed. */
  toolAllowlist?: Set<string>;

  /** Pending /btw info to inject on next LLM turn */
  pendingBtw?: string;

  private currentSessionId?: string;
  private currentUserInput?: string;
  private reasoningLog: ReasoningEntry[] = [];
  private busy = false;
  /** Turn generation counter — guards busy against stale finally blocks. When a
   *  hung turn eventually completes in the background, its finally compares
   *  turnGen to ensure it doesn't clear busy for a subsequently started turn. */
  private turnGen = 0;
  private abortController = new AbortController();
  private compactStartTime?: number;
  private enableAcp?: boolean;
  private isAcpServer?: boolean;

  /** Pending askUser question — resolved when user provides their next input */
  private pendingAsk: { question: string; resolve: (answer: string | null) => void } | null = null;
  /** Pending ACP tool call awaiting permission approval (prompt mode) */
  private pendingAcpToolCall: { toolName: string; args: Record<string, unknown> } | null = null;

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
    applyConfigTimeouts(this.config.getAcpTimeouts());
    if (this.config.getAcpConfig()?.debug) _acpDebugEnabled = true;
    const providerConfig = this.config.getProvider();
    this.provider = createProvider(providerConfig.type, providerConfig.apiKey, providerConfig.model, providerConfig.baseUrl, providerConfig.options, this.config.getActiveProvider());
    this.mcp = new ClientManager();
    this.mcp.agent = this;
    this.session = new SessionManager();
    this.sessionMemory = new SessionMemory();
    this.context = new ContextManager({ provider: this.provider, maxContextTokens: this.config.getModelContextLimit() });
    this.skills = new SkillRegistry();
    this.acp = new AcpProtocol();
  }

  async init(): Promise<void> {
    // Preload local vision model (Florence-2) in background
    preloadLocalVision();

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
      if (!p || p.includes('\x00')) return false;
      // Reject any path that contains a parent-directory segment or an
      // absolute path/drive root — skill paths must stay relative to the
      // project so a malicious ACP config cannot reach arbitrary files.
      if (p.split(/[\/\\]/).some((seg: string) => seg === '..')) return false;
      if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // Windows drive root
      if (p.startsWith('/') || p.startsWith('\\')) return false; // absolute
      const normalized = resolve(process.cwd(), p);
      const cwdNorm = resolve(process.cwd());
      // Ensure the resolved path is still inside the current working directory.
      if (normalized !== cwdNorm && !normalized.startsWith(cwdNorm + String(process.platform === 'win32' ? '\\' : '/'))) {
        return false;
      }
      return true;
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
        // Strip expansion suffix from stored user messages so the LLM doesn't
        // see stale [Referenced file: ...] markers and attempt redundant tool calls.
        const cleanMessages = loaded.messages.map(m =>
          m.role === 'user' ? { ...m, content: stripExpansionSuffix(m.content) } : m,
        );
        this.context.setMessages(cleanMessages);
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

  /** Prompt the user for a yes/no tool-permission decision. */
  private async promptForPermission(question: string): Promise<boolean> {
    const prompter = (globalThis as unknown as Record<string, ((q: string) => Promise<string>) | undefined>).__nexusPermissionPrompter;
    if (typeof prompter === 'function') {
      const answer = await prompter(question);
      return answer.trim().toLowerCase() === 'y';
    }
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<boolean>((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
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

    // ACP permission approval: user replied with "继续"/"y" to approve a pending tool call
    if (this.isAcpServer && this.pendingAcpToolCall) {
      const trimmed = userInput.trim().toLowerCase();
      if (trimmed === '继续' || trimmed === 'y' || trimmed === 'yes' || trimmed === 'continue') {
        const saved = this.pendingAcpToolCall;
        this.pendingAcpToolCall = null;
        const result = await this.executeTool({ id: `perm-${Date.now()}`, name: saved.toolName, arguments: saved.args });
        const text = result.isError
          ? `❌ 工具 "${saved.toolName}" 执行失败：${result.content}`
          : `✅ 工具 "${saved.toolName}" 执行成功\n${result.content}`;
        this.onOutput?.(text);
        return;
      }
      // User denied; clear pending call and continue with normal flow
      this.pendingAcpToolCall = null;
    }

    // Slash commands are intercepted by the CLI layer before reaching here, so a
    // '/'-prefixed input arriving here means it came through a remote channel
    // (ACP / cc-connect / Feishu) AND was not intercepted by cc-connect's built-in
    // command set. Handle that safe subset directly instead of forwarding to the
    // model (or to a remote claude agent). This keeps command handling inside nexus
    // and avoids exposing write/destructive commands over a chat channel. CLI
    // behavior is unaffected (the CLI intercepts '/' before calling chat()).
    if (userInput.trim().startsWith('/')) {
      const handled = await this.runRemoteSlashCommand(userInput);
      if (handled) return;
    }

    if (!this.currentSessionId) {
      await this.startSession();
    }

    // Add system prompt to encourage tool use
    const hasSystem = this.context.getMessages().some((m) => m.role === 'system');
    if (!hasSystem) {
      let systemPrompt = t('systemPrompt');

      if (this.isAcpServer) {
        const acpTools = this.getAcpTools();
        if (acpTools.length > 0) {
          systemPrompt += tf('acpToolsAvailable')(acpTools.map(t => t.name).join(', '));
        }
      }

      // Inject vision/OCR capability info so the model knows its own limits and fallback chain
      try {
        const { isVisionCapable } = await import('./vision/capability.js');
        const providerName = this.config.getActiveProvider();
        const modelName = this.provider.model;
        const pCfg = (() => { try { const p = this.config.getProvider(providerName); return { apiKey: p.apiKey, baseUrl: p.baseUrl, type: p.type }; } catch { return undefined; } })();
        const visionCapable = await isVisionCapable(providerName, modelName, pCfg);

        if (visionCapable) {
          // Model has native vision — tell it to handle images directly
          systemPrompt +=
            '\n\n[Vision Capability]\n' +
            'Your current model supports native vision (image input). When the user uploads or references an image, you can ' +
            'process it directly — use the analyze_image tool for image understanding. The ocr_extract tool is also ' +
            'available but generally unnecessary since you can read text from images natively. Do NOT attempt to describe ' +
            'images using text guessing or ask the user to describe images to you — use analyze_image instead.';
        } else {
          // Model does NOT have native vision — explain the fallback chain
          const ocrName = (() => {
            try {
              const ocrActive = this.config.getActiveOcrProvider();
              const ocrProviders = this.config.getOcrProviders();
              if (ocrActive && ocrProviders[ocrActive]) {
                const p = ocrProviders[ocrActive];
                return p.model ? `${ocrActive} (${p.model})` : ocrActive;
              }
            } catch {}
            return null;
          })();
          const visionName = (() => {
            try {
              const vActive = this.config.getActiveVisionProvider();
              const vProviders = this.config.getVisionProviders();
              if (vActive && vProviders[vActive]) {
                const p = vProviders[vActive];
                return p.model ? `${vActive} (${p.model})` : vActive;
              }
            } catch {}
            return null;
          })();

          systemPrompt +=
            '\n\n[Image Processing — Tool Chain]\n' +
            'Your current model does NOT natively support image input. To handle images, use these fallback tools:\n' +
            '  1. ocr_extract — FIRST CHOICE for reading text from images (screenshots, documents, terminal output, slides, forms).\n' +
            '     When the user says "read this image", "extract text", "识别图片中的文字" — use ocr_extract.\n' +
            '     Active OCR provider: ' + (ocrName || 'none configured') + '\n' +
            '  2. analyze_image — for general image understanding (describing scenes, objects, layout, diagrams).\n' +
            '     Only use this when the user asks what is IN or SHOWN in an image, not just the text.\n' +
            '     Active vision provider: ' + (visionName || 'none configured') + '\n' +
            'Rule: If the request is about extracting text, call ocr_extract first. Only fall back to analyze_image if ocr_extract fails.';
        }
      } catch {
        // If capability detection fails, do not add extra info
      }

      // Inject project creation directory guidance
      try {
        const { execSync } = await import('child_process');
        let isGitProject = false;
        try {
          execSync('git rev-parse --git-dir', { cwd: process.cwd(), stdio: 'pipe', encoding: 'utf-8' });
          isGitProject = true;
        } catch { /* not a git project */ }

        if (isGitProject) {
          const { join } = await import('path');
          const { homedir } = await import('os');
          const sandboxDir = join(homedir(), '.nexus', 'tasks', 'outputs');
          const parentDir = join(process.cwd(), '..');
          // Skip npm global install directory — never create projects here
          const cwdLower = process.cwd().toLowerCase();
          const npmGlobalDir = join(homedir(), 'AppData', 'Roaming', 'npm').toLowerCase();
          const isNpmGlobal = cwdLower === npmGlobalDir || cwdLower.startsWith(npmGlobalDir + '\\');
          const { preAuthorizeRoot } = await import('./security/path-authorizer.js');
          preAuthorizeRoot(sandboxDir, 'global');
          systemPrompt +=
            '\n\n[Project Creation — Directory Strategy]\n' +
            (isNpmGlobal
              ? 'The current directory is the npm global install directory — do NOT create projects here.\n'
              : 'The current directory is an existing git project. Do NOT create new projects inside it.\n') +
            'When the user asks you to create a NEW project (e.g. "create a new git project", "新建项目"):\n' +
            '  1. Do NOT create inside the current directory.\n' +
            '  2. Do NOT spend time listing directories to "find" a place — just pick one immediately.\n' +
            '  3. DEFAULT: Create under the sandbox: ' + sandboxDir + '/<project-name>/\n' +
            '     This is always safe, auto-authorized, and isolated.\n' +
            '  4. ALTERNATIVE: If the user explicitly says "next to this project" or "beside it", use the parent: ' + parentDir + '/<project-name>/\n' +
            '  5. NEVER guess, NEVER list directories repeatedly, NEVER ask where — just create in the sandbox.\n' +
            '  6. IMPORTANT: Before writing ANY file, you MUST first create the directory using create_directory or mkdir. Files cannot be written to a non-existent directory.\n' +
            '  7. If a directory with the same name already exists, append a sequence number: web-demo-2, web-demo-3, etc.\n' +
            '  Step-by-step: (a) create_directory → (b) write_file files → (c) exec_command "git init && git add . && git commit"\n' +
            '  Example: user says "create web-demo project" → create_directory ' + sandboxDir + '/web-demo → then write files.\n\n---\n';
        }
      } catch {
        // If detection fails, skip
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
    // Store only the raw input (without expandAtMentions suffix) in the session
    // so that on history recall / session resume the LLM doesn't see
    // [Referenced file: ...] markers and attempt redundant file tool calls.
    this.session.addMessage(this.currentSessionId!, { ...userMessage, content: stripExpansionSuffix(userInput) });

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
        // In ACP server mode, use configured permission mode
        if (this.isAcpServer) {
          const acpPermMode = this.config.getAcpConfig()?.permissionMode || 'auto';
          if (acpPermMode === 'auto') return 'allow';
          // prompt mode: use ACP protocol if available, else fallback to text
          if (ctx.toolCall && this.onPermissionRequest) {
            const result = await this.onPermissionRequest(ctx.toolCall.name, ctx.toolCall.id || '', ctx.toolCall.arguments || {});
            if (result.verdict === 'allow') return 'allow';
            return { verdict: 'deny', reason: 'User denied permission' };
          }
          if (ctx.toolCall) {
            this.pendingAcpToolCall = { toolName: ctx.toolCall.name, args: ctx.toolCall.arguments || {} };
            const question = `🔐 Permission needed for tool "${ctx.toolCall.name}", params: ${JSON.stringify(ctx.toolCall.arguments)}\nReply "continue" to allow, or anything else to deny`;
            this.onOutput?.(`\n${question}\n`);
          }
          return { verdict: 'deny', reason: '🔐 Awaiting user permission - reply "continue" to allow' };
        }
        // Enforce the built-in permission policy (dangerous commands, protected
        // paths, denied tools). This runs before any user-supplied hook.
        const permCfg = this.config.getPermissions();
        // Resolve the originating MCP server for this tool (if any) so the
        // MCP whitelist can match by server or exact tool name.
        const toolName = ctx.toolCall?.name;
        const toolServer = toolName
          ? (ctx.toolDefinitions || []).find((t) => t.name === toolName)?.server
          : undefined;
        if (toolServer && ctx.toolCall) ctx.toolCall.server = toolServer;
        const policy = await permissionCheckHook(ctx, (q) =>
          this.promptForPermission(q), {
            allowlist: permCfg.allowlist,
            mode: permCfg.mode,
            safePaths: permCfg.safePaths,
            resolveCwd: () => process.cwd(),
            mcpAllowlist: permCfg.mcpAllowlist,
            toolServer,
          });
        if (policy !== 'allow') return policy;
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
    const myGen = ++this.turnGen;
    this.busy = true;

    // Snapshot the display mode for this entire reasoning chain
    const showDetail = this.detailMode;

    this.onEvent?.({ type: 'session_start', sessionId: this.currentSessionId! });

    try {
      if (!showDetail && !this.onOutput && !this.suppressToolOutput) {
        this.compactStartTime = Date.now();
        this.renderOut(this.t.textDim('Thought'));
      }

      await this.runLlmTurn(showDetail, signal);

      if (signal.aborted) return;

      if (!showDetail) {
        this.renderCompactOutput();
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // A watchdog abort or a stalled-stream idle timeout is an intentional
      // turn termination, not a crash. Do NOT re-throw it: the turn has already
      // been handled (partial text sent / clean error reply) and re-throwing
      // would reject agent.chat() and risk tearing down the ACP process.
      if (signal.aborted || e instanceof IdleTimeoutError) {
        // Guarded: only the current turn's finally may clear busy, so a
        // background-hung old turn doesn't corrupt a newly started turn.
        return;
      }
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
      if (this.turnGen === myGen) this.busy = false;
      this.onEvent?.({ type: 'session_end' });
      if (this.currentSessionId && this.currentUserInput) {
        this.updateSessionMemory();
      }
      if (this.metrics.length > 1 && !this.onOutput) {
        this.printSessionReport();
      }
    }
  }

  /**
   * Handle a slash command arriving over a remote channel (ACP / cc-connect / Feishu).
   *
   * IMPORTANT: cc-connect intercepts a fixed set of built-in commands locally and
   * never forwards them to the agent (see its builtinCommands table: /help, /memory,
   * /skills, /model, /provider, etc.). This method therefore only ever receives the
   * commands cc-connect does NOT recognize and forwards verbatim to the agent. So we
   * only implement the subset that (a) is NOT a cc-connect builtin and (b) is safe to
   * run over a chat channel (read-only, no shell/file writes).
   *
   * /model, /models, /provider, /providers are handled upstream by the ACP server
   * (src/acp/server.ts handleSessionPrompt) BEFORE agent.chat is called, so they
   * never reach this method — they are intentionally left to that layer.
   *
   * Returns true if the input was consumed as a command (output already emitted),
   * false otherwise. In the interactive CLI, slash commands are intercepted by
   * handleLine before chat() is called, so this path is only ever hit for remote input.
   */

  /**
   * Render output guard (P0: stdout purity for ACP/remote channels).
   *
   * When nexus runs as an ACP agent, `process.stdout` is the JSON-RPC transport
   * shared with cc-connect — any non-protocol text written there corrupts the
   * framing and the client never receives a reply (unlike a normal CLI agent
   * where stdout is just the terminal). Every piece of user-facing rendering in
   * this class must therefore go to stderr in remote/ACP mode; only
   * AcpServer.writeLine may write protocol frames to stdout.
   *
   * This guard is defensive: the display paths are already gated by
   * `!this.onOutput` / `showDetail`, but routing through here guarantees stdout
   * stays pure even if those guards are relaxed.
   */
  private renderOut(s: string): void {
    const text = s.endsWith('\n') ? s : s + '\n';
    if (this.onOutput || this.isAcpServer) {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
  }

  private async runRemoteSlashCommand(input: string): Promise<boolean> {
    const trimmed = input.trim();
    const [cmd, ...args] = trimmed.slice(1).split(' ');
    const lc = cmd.toLowerCase();

    // Emit output through the active channel (ACP onOutput), else stdout.
    const emit = (s: string) => {
      if (this.onOutput) this.onOutput(s.endsWith('\n') ? s : s + '\n');
      else process.stdout.write(s.endsWith('\n') ? s : s + '\n');
    };
    const deny = (reason: string) => {
      emit(this.t.warning(`Command "/${cmd}" is not available over a remote channel: ${reason}`));
    };

    // Only commands that are NOT cc-connect builtins (cc-connect intercepts those
    // locally and never forwards them) and NOT already handled by the ACP server
    // (/model, /models, /provider, /providers). Everything here is read-only/safe.
    const allowed = new Set([
      'session', 'insight', 'view', 'tools', 'mcp', 'plugins', 'theme', 'new',
    ]);

    if (!allowed.has(lc)) {
      emit(this.t.warning(`Command "/${cmd}" is not available over a remote channel. ` +
        `cc-connect handles /model, /provider, /help, /memory, /skills, /theme locally; ` +
        `the ACP server handles /models and /providers. ` +
        `Available here: /session /view /tools /mcp /plugins /theme /new`));
      return true;
    }

    try {
      switch (lc) {
        case 'session': {
          const sid = this.getCurrentSessionId();
          const info = sid ? this.session.get(sid) : undefined;
          emit(`  Name: ${info?.name || '(unnamed)'}`);
          emit(`  ID:   ${sid ?? '(none)'}`);
          return true;
        }

        case 'insight': {
          emit(this.t.textDim('Cross-session insight is not available over the remote channel.'));
          return true;
        }

        case 'view': {
          const arg = args[0];
          let sid: string | undefined;
          if (arg && /^\d+$/.test(arg)) {
            const sessions = this.session.list();
            sid = sessions[parseInt(arg, 10) - 1]?.id;
          } else {
            sid = arg || this.getCurrentSessionId();
          }
          if (!sid) { emit(this.t.warning('No active session.')); return true; }
          let messages;
          try { messages = this.session.getMessages(sid); }
          catch { emit(this.t.error(`Session not found: ${sid}`)); return true; }
          if (!messages || messages.length === 0) { emit(this.t.textDim('No messages in this session.')); return true; }
          emit(this.t.heading(`Session: ${sid} (${messages.length} messages)`));
          for (let i = 0; i < messages.length; i++) {
            const m = messages[i]!;
            const preview = m.content.slice(0, 120).replace(/\n/g, ' ');
            emit(`  ${String(i + 1).padStart(3)}. ${m.role}: ${this.t.textDim(preview)}`);
          }
          return true;
        }

        case 'tools': {
          const tools = [...this.mcp.getAllTools(), ...this.skills.getTools()];
          emit(this.t.heading(`Available tools (${tools.length}):`));
          for (const tool of tools) emit(`  ${tool.name} - ${tool.description}`);
          return true;
        }

        case 'mcp': {
          const conns = this.mcp.listConnections();
          if (conns.length === 0) { emit(this.t.textDim('No external MCP servers connected.')); return true; }
          emit(this.t.heading(`MCP Servers (${conns.length}):`));
          for (const c of conns) emit(`  ${c.name} - ${c.toolCount} tools [${c.status}]`);
          return true;
        }

        case 'plugins': {
          const plugins = this.skills.list().filter(s => s.source === 'plugins');
          if (plugins.length === 0) { emit(this.t.textDim('No plugins loaded.')); return true; }
          emit(this.t.heading(`Plugins (${plugins.length}):`));
          for (const s of plugins) emit(`  ${s.name} v${s.version}${s.description ? ' - ' + s.description : ''}`);
          return true;
        }

        case 'new': {
          const msgs = this.context.getMessages();
          if (msgs.length >= 4) {
            emit(this.t.textDim('Compressing history before new session...'));
            try {
              await this.context.compress();
              const after = this.context.getMessages();
              emit(this.t.success(`Compressed ${msgs.length} -> ${after.length} messages.`));
            } catch (err) {
              emit(this.t.warning('Compression failed, starting new session anyway.'));
            }
          }
          const id = await this.startSession();
          emit(this.t.success(`New session started: ${id}`));
          return true;
        }

        case 'theme': {
          if (args[0]) { deny('theme switching is disabled over remote channels'); return true; }
          const _themeMgr = this.themeMgr;
          if (_themeMgr) {
            emit(this.t.heading(`Current theme: ${_themeMgr.currentThemeName}`));
            emit(this.t.textDim('Available themes: ' + _themeMgr.listThemes().join(', ')));
          } else {
            emit(this.t.textDim('Theme manager unavailable.'));
          }
          return true;
        }

        default:
          emit(this.t.warning(`Command "/${cmd}" is not available over a remote channel.`));
          return true;
      }
    } catch (err) {
      emit(this.t.error(`Command error: ${err instanceof Error ? err.message : String(err)}`));
      return true;
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
      const memTag = t('memory_section');
      if (!sys.content.includes(memTag)) {
        sys.content += tf('session_memory')(memory);
      }
    } else {
      this.context.add({ role: 'system', content: tf('session_memory')(memory) });
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
      ANALYZE_IMAGE_TOOL_DEF,
      OCR_EXTRACT_TOOL_DEF,
      ...getTaskToolDefinitions(),
    ];

    // Filter tools based on user input keywords to reduce reasoning overhead.
    // For reasoning models (DeepSeek-V4), 76 tools cause excessive thinking time.
    // Strategy: extract (a) whitespace/punctuation-separated tokens for English,
    // (b) explicit tool names (@name), and (c) Chinese bigrams for CJK text.
    const inputText = this.currentUserInput || '';
    const lowerInput = inputText.toLowerCase();
    // 1. Whitespace/punctuation-separated tokens
    const tokens = lowerInput.split(/[\s,，。.、!！?？:：;；()（）[\]【】]+/).filter(k => k.length >= 2);
    // 2. Chinese bigrams (overlapping pairs of CJK characters)
    const cjkBigrams: string[] = [];
    for (let i = 0; i < inputText.length - 1; i++) {
      const pair = inputText.slice(i, i + 2);
      if (/[\u4e00-\u9fff]/.test(pair[0]!) && /[\u4e00-\u9fff]/.test(pair[1]!)) {
        cjkBigrams.push(pair);
      }
    }
    const keywords = [...new Set([...tokens, ...cjkBigrams])];
    const essentialTools = new Set([
      'file_read', 'read_text_file', 'read_multiple_files', 'list_directory', 'get_file_info', 'directory_tree',
      'write_file', 'file_write', 'edit_file', 'file_edit', 'create_file', 'append_file',
      'fetch_url', 'web_search', 'web_fetch',
      'remember', 'recall', 'remember_project',
      'decompose_task', 'query_tasks',
      'analyze_image', 'ocr_extract',
    ]);

    // When the current LLM model supports native vision, exclude ocr_extract
    // to avoid unnecessary tool calls — the model can read text directly from images.
    const { isVisionCapable } = await import('./vision/capability.js');
    const providerName = this.config.getActiveProvider();
    const model = this.provider.model;
    const providerConfig = (() => {
      try {
        const p = this.config.getProvider(providerName);
        return { apiKey: p.apiKey, baseUrl: p.baseUrl, type: p.type };
      } catch { return undefined; }
    })();
    if (await isVisionCapable(providerName, model, providerConfig)) {
      tools = tools.filter(t => t.name !== 'ocr_extract');
    }

    if (keywords.length > 0) {
      tools = tools.filter((t) => {
        if (essentialTools.has(t.name)) return true;
        const text = `${t.name} ${t.description}`.toLowerCase();
        return keywords.some((k) => text.includes(k.toLowerCase()));
      });
      // If filtering removed everything, restore essential + skills
      if (tools.length === 0) {
        tools = [
          ...allTools.filter(t => !INTERNAL_TOOLS.has(t.name) && essentialTools.has(t.name)),
          ...this.skills.getTools(),
        ];
      }
    }

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

    // Role-scoped allowlist (e.g. tester/committer sub-agents)
    if (this.toolAllowlist && this.toolAllowlist.size > 0) {
      tools = tools.filter((t) => this.toolAllowlist!.has(t.name));
    }

    let assistantMessage = '';
    let pendingToolCalls: ToolCall[] = [];
    // Tracks whether the last direct stdout write ended with a newline, so that
    // tool-call spinner lines always start on a fresh line (otherwise the
    // subsequent \r-based status overwrite clobbers streamed text on the same line).
    let lastWriteEndedNl = true;

    const entry: ReasoningEntry = { assistantText: '', toolCalls: [] };
    if (!showDetail) {
      this.reasoningLog.push(entry);
    }

    if (this.hooks?.preLlmCall) {
      await this.hooks.preLlmCall({ turn: this.currentTurn, signal, userInput: this.currentUserInput, toolDefinitions: tools });
    }

    const llmStart = Date.now();
    let firstChunkTime = 0;
    if (this.isAcpServer) {
      _acpLog(`[ACP Timing] llmStart=${llmStart} msgCount=${this.context.getMessages().length} tools=${tools.length}\n`);
    }
    try {
      const stream = this.provider.chat(this.context.getMessages(), tools, signal);

      for await (const chunk of stream) {
        if (firstChunkTime === 0) {
          firstChunkTime = Date.now();
          if (this.isAcpServer) {
            _acpLog(`[ACP Timing] firstChunkAt=${firstChunkTime} delta=${firstChunkTime - llmStart}ms\n`);
          }
        }
        if (chunk.type === 'text' && chunk.text) {
          const clean = chunk.text.replace(/\uFFFD/g, '');
          assistantMessage += clean;
          this.onEvent?.({ type: 'text', text: clean });
          if (this.onOutput) {
            this.onOutput(clean);
            lastWriteEndedNl = clean.endsWith('\n');
          } else if (showDetail) {
            this.renderOut(clean);
            lastWriteEndedNl = clean.endsWith('\n');
          } else {
            entry.assistantText += clean;
          }
        }
        if (chunk.type === 'thinking' && chunk.thinking) {
          const clean = chunk.thinking.replace(/\uFFFD/g, '');
          this.onEvent?.({ type: 'thinking', thinking: clean });
          if (showDetail && !this.onOutput) {
            this.renderOut(chalk.italic(this.t.thinking(clean)));
            lastWriteEndedNl = clean.endsWith('\n');
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
      if (this.isAcpServer) {
        _acpLog(`[ACP Timing] streamDone elapsed=${Date.now() - llmStart}ms tools=${tools.length}\n`);
      }
    } catch (e) {
      if (this.isAcpServer) {
        _acpLog(`[ACP Timing] streamError elapsed=${Date.now() - llmStart}ms errType=${e instanceof IdleTimeoutError ? 'IdleTimeout' : signal.aborted ? 'Aborted' : 'Other'}\n`);
      }
      if (signal.aborted) {
        // Watchdog aborted the turn (e.g. upstream model stream hung). Emit a
        // short, terminating note to the remote/ACP client so the user knows
        // why there is no real answer (and can switch models) instead of just
        // seeing an empty reply.
        const note = assistantMessage
          ? '\n\n[response truncated: the model stream was interrupted (timed out)]'
          : '[no response: the model stream was interrupted (timed out). Try a different model or provider.]';
        if (this.onOutput) {
          this.onOutput(note);
        } else if (showDetail) {
          this.renderOut(note);
        }
        return;
      }
      if (e instanceof IdleTimeoutError) {
        // Upstream stream went half-dead. If we already streamed some text,
        // keep it and append a short note; otherwise surface a clean error so
        // the (remote/ACP) client gets a terminating reply instead of hanging.
        const note = '\n\n[model stream stalled — no response chunk received in time; truncated]';
        const finalText = (assistantMessage || '') + (assistantMessage ? note : '[model stream stalled — no response received in time]');
        if (this.onOutput) {
          this.onOutput(finalText);
        } else if (showDetail) {
          this.renderOut(finalText);
        }
        if (finalText) {
          const msg: Message = { role: 'assistant', content: finalText };
          this.context.add(msg);
          this.session.addMessage(this.currentSessionId!, msg);
        }
        return;
      }
      throw e;
    }

    if (signal.aborted) return;

    if (showDetail && !this.onOutput) {
      this.renderOut('\n');
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
    const toolExecStart = Date.now();
    if (this.isAcpServer && pendingToolCalls.length > 0) {
      _acpLog(`[ACP Timing] toolExec tool=${pendingToolCalls[0]!.name} hasApiBigModel=${!!process.env.API_BigModel}\n`);
    }
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
            this.renderOut(`\n[Blocked: ${toolCall.name}] — ${reason}`);
          }
          const toolContent = reason;
          this.onEvent?.({ type: 'tool_result', index: tci, name: toolCall.name, content: toolContent, isError: true });
          const toolMsg: Message = { role: 'tool', content: toolContent, toolCallId: toolCall.id };
          this.context.add(toolMsg);
          this.session.addMessage(this.currentSessionId!, toolMsg);
          continue;
        }
      }

      const argsPreview = makeArgsPreview(toolCall.arguments ?? {}, toolCall.name);
      if (showDetail && !this.suppressToolOutput) {
        // Always start the spinner on its own fresh line. We deliberately avoid
        // the \r-based in-place "spinner -> result" overwrite: the visible
        // content area can be narrower than process.stdout.columns (the
        // box-drawing border constrains it), so a long line wraps and \r would
        // only rewrite the last wrapped segment, leaving the first segment
        // dangling as a duplicate line.
        if (!lastWriteEndedNl) {
          this.renderOut('\n');
        }
        this.renderOut(`  ${this.t.spinner('●')} ${this.t.toolCallName(toolCall.name)}(${this.t.textDim(argsPreview)})\n`);
        lastWriteEndedNl = true;
      }
      let result: ToolResult;
      const toolStart = Date.now();
      try {
        const TOOL_TIMEOUT_MS = 60000;
        result = await Promise.race([
          this.executeTool(toolCall),
          new Promise<ToolResult>((_, reject) =>
            setTimeout(() => reject(new Error(`Tool '${toolCall.name}' timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        result = { content: `Error executing ${toolCall.name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const toolElapsed = Date.now() - toolStart;
      if (showDetail && !this.suppressToolOutput) {
        if (result.isError) {
          const line = `  ${this.t.error('✗')} ${this.t.toolCallName(toolCall.name)}(${this.t.textDim(argsPreview)}) ${this.t.textDim(`[${toolElapsed}ms]`)}`;
          this.renderOut(`${line}\n`);
          this.renderOut(`    ${this.t.error(result.content.slice(0, 200))}\n`);
          lastWriteEndedNl = true;
        } else {
          const line = `  ${this.t.success('✓')} ${this.t.toolCallName(toolCall.name)}(${this.t.textDim(argsPreview)}) ${this.t.textDim(`[${toolElapsed}ms]`)}`;
          this.renderOut(`${line}\n`);
          lastWriteEndedNl = true;
        }
      } else {
        entry.toolCalls.push({ name: toolCall.name, resultSummary: result.content.slice(0, 200) });
      }

      // Emit tool_result event, but suppress intermediate errors in ACP/server mode
      if (!this.suppressToolOutput || !result.isError) {
        this.onEvent?.({ type: 'tool_result', index: tci, name: toolCall.name, content: result.content, isError: result.isError });
      }

      // Detect generated files in tool results and emit file_ready events for push
      if (!result.isError && this.onFileOutput) {
        const detectedFiles = detectFilesInToolResult(result.content, toolCall.name);
        if (detectedFiles.length > 0) {
          process.stderr.write(`[file-push] ${toolCall.name} → ${detectedFiles.length} file(s): ${detectedFiles.map(f => f.name).join(', ')}\n`);
        }
        for (const file of detectedFiles) {
          this.onEvent?.({ type: 'file_ready', path: file.path, mimeType: file.mimeType, name: file.name });
          this.onFileOutput(file);
        }
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

    if (this.isAcpServer && pendingToolCalls.length > 0) {
      _acpLog(`[ACP Timing] toolDone elapsed=${Date.now() - toolExecStart}ms\n`);
    }

    if (!showDetail && pendingToolCalls.length > 0 && !this.onOutput) {
      this.renderOut('.');
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
      if (this.isAcpServer) {
        _acpLog(`[ACP Timing] turn2Start after=${Date.now() - this.turnStartTime}ms\n`);
      }
      await this.runLlmTurn(showDetail, signal);
      if (this.isAcpServer) {
        _acpLog(`[ACP Timing] turn2Done elapsed=${Date.now() - this.turnStartTime}ms\n`);
      }
    }
  }

  private renderCompactOutput(): void {
    // In remote/ACP mode the assistant text is already streamed to the client
    // via onOutput (session/update frames). Rendering compact output to stdout
    // here would inject non-protocol text into the ACP transport and corrupt
    // framing (the client then never receives a clean reply). Skip it entirely.
    if (this.onOutput || this.isAcpServer) return;
    if (this.suppressToolOutput) return;

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

  private acpToolsCache: ToolDefinition[] | null = null;
  private acpToolsCachedAgents: unknown[] | null = null;

  getAcpTools(): ToolDefinition[] {
    const acpCfg = this.config.getAcpConfig();
    const agents = acpCfg?.agents;
    if (this.acpToolsCache && this.acpToolsCachedAgents === agents) {
      return this.acpToolsCache;
    }
    const tools: ToolDefinition[] = [];
    for (const agent of agents || []) {
      if (agent.tools) {
        for (const t of agent.tools) {
          tools.push({
            name: t.name,
            description: `${t.description}${tf('acp_tool_suffix')(agent.name)}`,
            inputSchema: (t.inputSchema || { type: 'object', properties: {} }) as Record<string, unknown>,
          });
        }
      }
    }
    this.acpToolsCache = tools;
    this.acpToolsCachedAgents = agents ?? null;
    return tools;
  }

  invalidateAcpToolsCache(): void {
    this.acpToolsCache = null;
    this.acpToolsCachedAgents = null;
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

    if (call.name === 'analyze_image') {
      return this.handleAnalyzeImage(safeArgs);
    }

    if (call.name === 'ocr_extract') {
      return this.handleOcrExtract(safeArgs);
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

    // 3. Forward to configured ACP agents in parallel, return first success
    const acpCfg = this.config.getAcpConfig();
    const agents = acpCfg?.agents?.filter((agent) => {
      const hasTool = agent.tools?.some((t) => t.name === call.name);
      const hasCapability = agent.capabilities.some((c) => c === '*' || call.name === c || call.name.split('_').includes(c));
      return hasTool || hasCapability;
    });

    if (!agents || agents.length === 0) {
      throw new Error(`Tool '${call.name}' not found locally and no ACP agent provides it`);
    }

    for (const agent of agents) {
      this.acp.registerAgent(agent);
    }

    const promises = agents.map((agent) =>
      this.acp.sendTask(agent.id, { tool: call.name, args: safeArgs }, 'nexus')
        .then((msg) => ({
          content: typeof msg.payload === 'string'
            ? msg.payload
            : JSON.stringify(msg.payload, null, 2),
        })),
    );

    try {
      return await Promise.any(promises);
    } catch {
      const results = await Promise.allSettled(promises);
      const errors = results
        .map((r, i) => r.status === 'rejected' ? `${agents[i]!.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : null)
        .filter((e): e is string => e !== null);
      throw new Error(`Tool '${call.name}' not found. All ACP agents failed:\n${errors.map((e) => '  - ' + e).join('\n')}`);
    }
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

      const toSummarize = messages.slice(0, splitIdx).map(m =>
        m.role === 'user' ? { ...m, content: stripExpansionSuffix(m.content) } : m,
      );
      const toKeep = messages.slice(splitIdx).map(m =>
        m.role === 'user' ? { ...m, content: stripExpansionSuffix(m.content) } : m,
      );

      const summary = await this.summarizeMessages(toSummarize);
      const memoryContent = this.sessionMemory.load(sessionId);
      const memoryNote = memoryContent
        ? tf('session_memory')(memoryContent)
        : '';
      this.context.setMessages([
        { role: 'system', content: tf('session_restore')(loaded.session.name, tokenCount, keepCount, summary, memoryNote) },
        ...toKeep,
      ]);
      this.currentSessionId = sessionId;
      return { restored: true, compressed: true, sessionName: loaded.session.name };
    }

    this.currentSessionId = sessionId;
    // Strip expansion suffix from stored user messages so the LLM doesn't
    // see stale [Referenced file: ...] markers and attempt redundant tool calls.
    const cleanMessages = loaded.messages.map(m =>
      m.role === 'user' ? { ...m, content: stripExpansionSuffix(m.content) } : m,
    );
    this.context.setMessages(cleanMessages);
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
      content: tf('compression_prompt')(lines.join('\n')),
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
      let fetched: string | null = null;
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
        fetched = sContent;
      } else {
        const content = result.content.trim();
        try {
          const parsed = JSON.parse(content);
          const entities = parsed.entities ?? parsed.results ?? [];
          if (entities.length === 0) return;
        } catch {
          if (!content || content === '[]' || content === '{}') return;
        }
        fetched = content;
      }

      if (fetched == null) return;
      // Treat knowledge-graph content as untrusted DATA, not instructions.
      // Strip control chars and neutralize any instruction-injection framing
      // before it can reach the system prompt.
      const sanitized = sanitizeContent(fetched);
      const { text: neutralized, redacted } = neutralizeInstructions(sanitized);
      this._injectToSystemPrompt(neutralized, redacted);
    } catch {
      // Memory tools unavailable, skip injection
    }
  }

  /**
   * Inject remembered knowledge-graph content into the system prompt inside an
   * explicit untrusted-data boundary. The model is told this is read-only data
   * it must NOT follow as instructions, mitigating indirect prompt injection.
   */
  private _injectToSystemPrompt(content: string, redacted = false): void {
    const msgs = this.context.getMessages();
    const sysMsg = msgs.find(m => m.role === 'system');
    if (sysMsg) {
      const section = t('remembered_info');
      const existingIdx = sysMsg.content.indexOf(section);
      if (existingIdx >= 0) {
        sysMsg.content = sysMsg.content.substring(0, existingIdx);
      }
      let body = content;
      if (redacted) {
        body += '\n\n[Note: some content was filtered because it resembled prompt-injection instructions.]';
      }
      sysMsg.content += `\n\n${section}\n<user_data untrusted="true">\n${body}\n</user_data>`;
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
            return { content: tf('knowledge_graph')(content), isError: false };
          }
        }
      }

      // 2nd priority: semantic search
      const semantic = await this.mcp.callTool('search_semantic', { query: 'user', limit: 20 });
      if (!semantic.isError && semantic.content) {
        const sContent = semantic.content.trim();
        if (sContent && sContent !== '[]' && sContent !== '{}') {
          return { content: tf('knowledge_graph')(sContent), isError: false };
        }
      }

      // 3rd priority: fall back to .remember session files
      const rememberContent = this.readRememberFiles();
      if (rememberContent) return { content: tf('remember_session')(rememberContent), isError: false };

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
        if (content) parts.push(tf('recent_memory')(content));
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
        if (content) parts.push(tf('recent_archive')(content));
      }

      const rememberPath = join(rememberDir, 'remember.md');
      if (existsSync(rememberPath)) {
        const content = readFileSync(rememberPath, 'utf-8').trim();
        if (content) parts.push(tf('persistent_memory')(content));
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

  private async handleAnalyzeImage(args: Record<string, unknown>): Promise<ToolResult> {
    const imagePath = String(args.path || args.image || '').trim();
    if (!imagePath) {
      return { content: 'Error: image path is required', isError: true };
    }
    if (!isImageFile(imagePath)) {
      return { content: `Error: "${imagePath}" is not a supported image file. Supported: .png, .jpg, .jpeg, .gif, .webp, .bmp`, isError: true };
    }
    // Authorize the image path — analysis reads the file and may upload it to
    // a cloud vision provider, so arbitrary-file access must be gated.
    const absImagePath = resolve(process.cwd(), imagePath);
    const authorized = await authorizePath(absImagePath);
    if (!authorized) {
      return { content: `Access denied: "${imagePath}" is not in the allowed path list and access was rejected by user.`, isError: true };
    }
    const question = typeof args.question === 'string' ? args.question.trim() : undefined;
    try {
      const description = await analyzeImage(imagePath, question);
      return { content: description, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Image analysis failed: ${msg}`, isError: true };
    }
  }

  private async handleOcrExtract(args: Record<string, unknown>): Promise<ToolResult> {
    const imagePath = String(args.path || args.image || '').trim();
    if (!imagePath) {
      return { content: 'Error: image path is required', isError: true };
    }
    const absImagePath = resolve(process.cwd(), imagePath);
    const authorized = await authorizePath(absImagePath);
    if (!authorized) {
      return { content: `Access denied: "${imagePath}" is not in the allowed path list.`, isError: true };
    }
    const language = typeof args.language === 'string' ? args.language.trim() : undefined;
    try {
      const { extractText } = await import('./ocr/index.js');
      const result = await extractText(imagePath, language);
      const providerInfo = result.model ? `${result.provider} (${result.model})` : result.provider;
      return { content: `[OCR via ${providerInfo}]\n${result.text}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `OCR extraction failed: ${msg}`, isError: true };
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
      content: tf('plan_prompt')(request),
    }]);
    return response;
  }

  async executePlan(): Promise<string> {
    this.planMode = false;
    if (!this.currentPlan) {
      return 'No plan to execute. Use /plan first.';
    }
    // During autonomous plan execution, auto-enable the permission whitelist so
    // the agent is not interrupted by per-tool prompts. This is TEMPORARY and
    // never persisted: we snapshot the user's real setting and restore it after.
    const restored = this._withAutoWhitelist();
    const worker = new SubAgentWorker(this);
    const scheduler = new DAGScheduler(worker, this.tracker);
    try {
      await scheduler.execute(this.currentPlan);
      return 'Plan execution completed.';
    } catch (err) {
      return `Plan execution failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      restored();
    }
  }

  /**
   * Temporarily switch permissions to auto-whitelist mode for the duration of an
   * autonomous run. If the user has no allowlist configured, the built-in `edit`
   * preset is applied in-memory only. Returns a function that restores the
   * previous (persisted) permission state. Does NOT write to disk.
   */
  private _withAutoWhitelist(): () => void {
    const prev = this.config.getPermissions();
    const hadAllowlist = prev.allowlist.length > 0;

    if (prev.mode !== 'auto' || !hadAllowlist) {
      const allowlist = hadAllowlist ? prev.allowlist : PERMISSION_PRESETS.edit.allowlist;
      // Mutate the live (in-memory) config object WITHOUT persisting to disk, so
      // an interrupted autonomous run cannot leave the on-disk config stuck in
      // 'auto' whitelist mode.
      this.config.setPermissionsInMemory({ mode: 'auto', allowlist: [...allowlist] });
      this.onEvent?.({ type: 'text', text: `[permissions] auto-whitelist ON (temporary, restored after /go)` });
    }

    return () => {
      // Restore the original persisted state in-memory (disk file is untouched).
      this.config.setPermissionsInMemory({ mode: prev.mode, allowlist: [...prev.allowlist] });
    };
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
  }
}
