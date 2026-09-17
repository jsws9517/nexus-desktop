/**
 * Headless bridge around the nexus CLI Agent.
 *
 * The desktop worker's core service. Extracted from the former
 * src/agent-service.ts monolith into src/agent/: shared types (types.ts),
 * auto-naming topics (topic.ts) and config redaction (config-read.ts) live in
 * their own modules here; this file keeps the AgentService class, which shares
 * one `agent`/session state and would only decompose further into per-concern
 * mixins. src/agent-service.ts is now a thin re-export facade so importers
 * (agent-worker, main, worker-host, tests) stay unchanged.
 */

import { isWorkerPrompt, KEY_MASK, stripProtocolXml } from '../shared/constants.js';
import type { StoredRow } from '../session-db.js';
import { deleteAllSessionMessages, getLastUserMessageId, updateTaskGraphProjectName } from '../session-db.js';
import { appendSlashLog, readSlashLog, slashLogPath } from '../slash-log.js';
import type { SlashLogEntry } from '../slash-log.js';
import type { Agent } from 'nexus-coder/dist/src/agent.js';
import { createProvider } from 'nexus-coder/dist/src/llm/provider.js';
import type { Config, ProviderConfig } from 'nexus-coder/dist/src/config/types.js';
import type { Session } from 'nexus-coder/dist/src/session/types.js';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { INTERNAL_TOOLS, ALL_TOOL_DEFS, callBuiltinTool } from '../tools/index.js';
import { loadConstitution, CONSTITUTION_MARKER } from '../tools/agents.js';
import {
  readModelCapabilities,
  getModelCapability,
  shouldInjectVisionHint,
  buildVisionHint,
  VISION_HINT_MARKER,
  resolveContextLimit,
} from '../model-capabilities.js';
import { MEMORY_WRITE_TOOLS } from '../main/memory-kg.js';
import { GIT_WRITE_TOOLS } from '../main/git-internal.js';
import { logger } from '../shared/logger.js';
import type { AgentEvent, PermissionRequest, ProviderInfo, RateLimitStatus } from './types.js';
import { RateLimiter, inferProviderFamily } from './rate-limiter.js';
import type { SubTask } from './sub-agent/types.js';
import { extractTopic } from './topic.js';
import {
  EMPTY_USAGE,
  TurnMonitor,
  type ThinkingStall,
  type TurnUsage,
} from './turn-monitor.js';
import { redactConfig } from './config-read.js';
let sessionDbPromise: Promise<typeof import('../session-db.js')> | null = null;
function loadSessionDb(): Promise<typeof import('../session-db.js')> {
  return (sessionDbPromise ??= import('../session-db.js'));
}


/** A tool definition surfaced by the MCP hub (MCP tools carry a `server` tag). */
interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  server?: string;
}

/** Structural subset of the core `ClientManager` we patch for MCP proxying. */
interface ClientManagerLike {
  getAllTools(): Promise<McpToolDef[]> | McpToolDef[];
  callTool(name: string, args: unknown): Promise<unknown>;
  builtinTools: Array<{ name: string }>;
}

/**
 * Cap the size of a single tool result before it enters the LLM context and the
 * session store. A bash/python/read command can legitimately return hundreds of
 * KB (the core exec_command tool has no output cap; a 10MB maxBuffer), and one
 * such message — e.g. 511k chars ≈ 128k tokens for CJK content — silently fills
 * the entire context window and re-triggers "Context too large" right after a
 * /clear. Truncating at the source keeps both the live context and the persisted
 * transcript lean, and prompts the model to use targeted tools for details.
 *
 * Media embeddings are left untouched (data: URIs carry binary images). Results
 * whose `content` is not a plain string (structured MCP payloads) pass through.
 */
const MAX_TOOL_RESULT_CHARS = 30_000;
const TOOL_RESULT_HEAD_CHARS = 24_000;
const TOOL_RESULT_TAIL_CHARS = 6_000;
const TOOL_RESULT_TRUNCATED =
  '\n… [output truncated: original %d chars; showing head %d + tail %d. Use targeted tools (grep/head/tail/SQL aggregation) for specific parts] …\n';

function capToolResult<T>(res: T): T {
  if (!res || typeof res !== 'object') return res;
  const r = res as { content?: unknown; isError?: boolean; kind?: string };
  if (typeof r.content !== 'string') return res;
  const content = r.content;
  if (content.length <= MAX_TOOL_RESULT_CHARS) return res;
  // Never truncate binary image data (data URI markdown) — the provider needs
  // the full payload and the vision path handles it separately.
  if (content.slice(0, 300).includes('data:image/')) return res;
  const head = content.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = content.slice(-TOOL_RESULT_TAIL_CHARS);
  const marker = TOOL_RESULT_TRUNCATED
    .replace('%d', String(content.length))
    .replace('%d', String(TOOL_RESULT_HEAD_CHARS))
    .replace('%d', String(TOOL_RESULT_TAIL_CHARS));
  return { ...res, content: `${head}${marker}${tail}` };
}

/**
 * Marker for the block that neutralizes the core package's hard-coded
 * "[Debugging Discipline]" RULE 1 (nexus-coder dist/src/agent.js) which forbids
 * reading source files until a runnable reproduction exists. In a desktop agent
 * IDE that rule is unsatisfiable — you must read source to learn how the project
 * is built/run before you can even construct a reproduction — and it directly
 * contradicts the injected [Project Directory] + constitution blocks. The block
 * built below SUPERSEDES that clause; it is appended to system message 0 so it
 * lands AFTER the core block in reading order.
 */
export const DEBUG_OVERRIDE_MARKER = '[Debugging Discipline Override]';

/** Returns the superseding correction block for the core's RULE 1 hard-block. */
export function buildDebugDisciplineOverride(): string {
  return (
    '\n\n' +
    DEBUG_OVERRIDE_MARKER +
    '\n' +
    'This section SUPERSEDES the "RULE 1 — REPRODUCTION FIRST" clause of the ' +
    '[Debugging Discipline] block (and any "do NOT read source files" instruction there):\n' +
    '1. Reading source code IS a legitimate diagnostic step. You are NEVER forbidden from reading ' +
    'source files to understand or fix a reported issue.\n' +
    '2. When a bug is cheaply reproducible, prefer establishing a runnable reproduction ' +
    '(test/script/command that goes red on the symptom) BEFORE theorizing about the cause. ' +
    'Reading entry points, build scripts, package.json, config and existing tests to figure out ' +
    'how to build/run the project is a NORMAL part of that, not a rule violation.\n' +
    '3. When a runnable reproduction is NOT feasible (UI-only, environment/hardware-dependent, ' +
    'manual steps, external service), skip it and inspect the source directly. Never stall, ' +
    'refuse, or repeat questions because no reproduction was built.\n' +
    '4. An explicit user request to read / inspect / analyze source code ALWAYS wins and is ' +
    'handled immediately, with no reproduction gate.\n' +
    '5. Clean up any throwaway reproduction script in ONE pass (move to .trash/); never write a ' +
    'NEW script to delete the OLD one.\n'
  );
}

export class AgentService {
  private agent: Agent | null = null;
  private initialized = false;
  // Set by abort() so parallel batches can halt BETWEEN sub-tasks (the core's
  // abort() only interrupts the currently running agent.chat(); without this
  // flag the next sub-task would start immediately with a fresh AbortController).
  // Reset at the start of every user-initiated chat() so a stale request never
  // cancels a later turn.
  private stopRequested = false;
  private mcpEnabled = true;
  private pendingPermissions = new Map<string, (answer: string) => void>();
  private nextPermissionId = 1;
  /** Set by a bare `/revise`; the next plain (non-slash) message is the fix
   *  for the revise dialogue instead of a normal chat turn. */
  private pendingRevise = false;

  /**
   * Live per-turn monitor feeding the event bridge (see below). Non-null only
   * while `runTurn()` is executing; counts streamed text/thinking chars, drops
   * noise thinking deltas and guards against empty/stalled reasoning.
   */
  private activeMonitor: TurnMonitor | null = null;

  /** Estimated usage of the most recent completed turn (`chat`/`chatParallel`). */
  private lastUsage: TurnUsage | null = null;

  /**
   * True (default) to abort a turn when the model repeats the same thinking
   * block (loop signal) — a degenerate hallucination spin cannot recover, so
   * continuing only burns tokens. Idle thinking (deep-but-slow reasoning) is
   * NEVER aborted, only warned.
   */
  abortOnThinkingLoop = true;

   /** Rolling { t, used } samples of live context usage for the sidebar gauge
    *  (§G1). In-memory ONLY, bounded window (~30s), appended on each
    *  getStatus() poll from the `agent.context.getTokenCount()` the service
    *  already reads live — zero added I/O, zero prompts, unattended-safe. */
   private ctxUsageSamples: Array<{ t: number; used: number }> = [];

   /** Per-process rate limiter keyed by provider family (zhipu / agnes / unknown).
    *  Cross-session aggregation is handled by the main-process RateLimitRegistry. */
   private rateLimiter = new RateLimiter();

   /** Called after every callLlm() completes (success or failure) so the main
    *  process can aggregate per-family counters across all session workers. */
   onRateLimitReport?: (status: RateLimitStatus) => void;

  /** Per-session provider/model override (in-memory ONLY — never writes the
   *  shared global config). Populated by setProviderOverride/setModelOverride
   *  so a session worker can run a different model without polluting the
   *  config.json the whole app shares. */
  private overrideName = '';
  private overrideModel = '';
  private overrideDepth = '';
  private overrideMode = '';

  /**
   * Track compression events per session so we can warn the user when
   * compression fires too frequently — a strong signal that the configured
   * context limit is wrong (default 128k but the model actually has more or
   * less). The ring is keyed by sessionId; entries older than 5 minutes are
   * pruned on each call. `compressionWarned` tracks whether we already
   * emitted the user-facing hint for the current session to avoid spam.
   */
  /**
   * When set by the Orchestrator (§3.7), the sub-agent uses this text directly
   * and NEVER discovers the constitution via the filesystem.
   * undefined = not overridden (default: load from filesystem).
   */
  private constitutionOverride: string | undefined;

  /**
   * Set the constitution text explicitly (for sub-agents, §3.7).
   * Pass null to force 'no constitution' (skip filesystem).
   * Pass undefined to restore default filesystem loading.
   */
  setConstitutionOverride(text: string | null): void {
    this.constitutionOverride = text === null ? '' : text;
  }

  private compressionLog = new Map<string, number[]>();
  private compressionWarned = new Set<string>();

  /** Active slash-command turn accumulation. Non-null only while a `/cmd` is
   *  being executed; its buffered output is appended to the per-session log
   *  file and surfaced to the UI as a collapsible card. Null for normal turns. */
  private slashTurn: { cmd: string; anchorId?: number; buf: string } | null = null;

  /**
   * Forwarder to the shared, main-process MCP hub. Set by the worker process
   * (`sendMcp`). When non-null, this agent proxies MCP tool discovery + calls
   * through the hub instead of owning its own MCP child processes — so every
   * tab shares ONE MCP server process instead of spawning a shadow copy.
   */
  onMcpRequest?: (op: string, params?: Record<string, unknown>) => Promise<unknown>;

  onEvent?: (event: AgentEvent) => void;
  onPermission?: (req: PermissionRequest) => void;
  onLog?: (level: string, message: string) => void;

  private async mcpRequest<T = unknown>(op: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.onMcpRequest) throw new Error('MCP proxy is not wired (no main-process hub)');
    return (await this.onMcpRequest(op, params)) as T;
  }

  /**
   * Call the LLM directly with a prompt (for decomposition, etc.).
   */
  async callLlm(options: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
  }): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');

    const messages = options.messages.map(m => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    const providerName = this.getActiveProvider();
    const providerCfg = this.agent.config.getProvider(providerName);
    const family = inferProviderFamily(providerCfg?.baseUrl);
    const rpm = this.rateLimiter.getEffectiveRpm(family);

    await this.rateLimiter.acquire(family, rpm);

    try {
      return await this.agent.provider.complete(messages);
    } catch (err: any) {
      if (err?.status === 429 || err?.isRateLimited) {
        this.rateLimiter.markRateLimited(family);
        const waitMs = this.rateLimiter.getBackoffMs(family);
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        return this.callLlm(options);
      }
      throw err;
    } finally {
      const status = this.rateLimiter.getStatus(family, providerCfg?.baseUrl);
      if (status && this.onRateLimitReport) this.onRateLimitReport(status);
    }
  }

  /**
   * Set tool allowlist for this agent (for sub-agent isolation).
   */
  setToolAllowlist(tools: Set<string>): void {
    if (this.agent) {
      this.agent.toolAllowlist = tools;
    }
  }

  /**
   * Cached MCP tool definitions fetched from the shared main-process hub. The
   * core calls `agent.mcp.getAllTools()` SYNCHRONOUSLY (per turn, to build the
   * tool list), so this patch must supply an array, not a Promise. Remote MCP
   * tools are prefetched into this cache asynchronously by `refreshMcpToolCache()`.
   */
  private mcpToolCache: McpToolDef[] = [];

  /**
   * Bounded rolling window of {t, used} context-usage samples backing
   * getContextUsage() live gauge (fill % + tokens/sec).
   */
  private ctxSamples: { t: number; used: number }[] = [];

  /**
   * Asynchronously refresh the cached MCP tool list from the shared hub. Called
   * after init / MCP toggles; failures leave the previous cache intact and log.
   */
  async refreshMcpToolCache(): Promise<void> {
    try {
      const remote = await this.mcpRequest<McpToolDef[]>('getTools');
      this.mcpToolCache = remote ?? [];
    } catch (e) {
      this.onLog?.('warn', `MCP tool cache refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Route MCP tool discovery + execution through the shared hub while keeping
   * builtin tools (file/exec/skill) running locally on this worker. The core
   * only touches `agent.mcp.getAllTools` (per turn) and `agent.mcp.callTool`
   * (per tool call), so patching just those two methods is sufficient.
   */
  private applyMcpProxy(agent: Agent): void {
    // The core ClientManager's `builtinTools` is private-ish in the typings;
    // cast through unknown so we can wrap getAllTools/callTool at runtime.
    const local = agent.mcp as unknown as ClientManagerLike;
    if (!local) return;
    const originalGetAll = local.getAllTools.bind(local);
    const originalCall = local.callTool.bind(local);
    // Builtin tools carry no `server` tag; MCP tools carry one. Keep builtin
    // local (fast, per-worker), forward only MCP tools to the hub.
    local.getAllTools = () => {
      const builtin = (originalGetAll() as McpToolDef[]).filter((t: McpToolDef) => !(t as McpToolDef).server);
      // Shadow any external server that advertises the built-in tool names,
      // then append the in-process defs (they must appear exactly once).
      const cache = this.mcpToolCache.filter((t: McpToolDef) => !INTERNAL_TOOLS.has(t.name));
      return [...builtin, ...cache, ...ALL_TOOL_DEFS];
    };
    local.callTool = async (name: string, args: unknown): Promise<unknown> => {
      let result: unknown;
      if (INTERNAL_TOOLS.has(name)) {
        result = await callBuiltinTool(name, args, {
          getConfig: () => this.agent?.['config']?.get?.(),
          requestWriteApproval: async (label: string): Promise<boolean> => {
            // Mirrors the core's onPermissionRequest semantics: auto mode is
            // global allow, unattended skips the UI entirely, interactive mode
            // surfaces an Allow/Deny card.
            const mode = this.getActiveMode();
            if (mode === 'auto' || mode === 'unattended') return true;
            const answer = await this.askPermission(`${label}: write to SQLite database`);
            const norm = answer.trim().toLowerCase();
            return norm === 'y' || norm === 'a';
          },
        });
      } else {
        const isBuiltin = (local.builtinTools as Array<{ name: string }>).some((t) => t.name === name);
        if (isBuiltin) {
          result = await originalCall(name, args);
        } else {
          // Knowledge-graph WRITE tools get the same approval gate as sqlite writes:
          // auto/unattended run them directly, interactive mode surfaces a card.
          if (MEMORY_WRITE_TOOLS.has(name)) {
            const mode = this.getActiveMode();
            if (mode !== 'auto' && mode !== 'unattended') {
              const answer = await this.askPermission(`Write to knowledge-graph memory via "${name}"`);
              const norm = answer.trim().toLowerCase();
              if (norm !== 'y' && norm !== 'a') {
                return { content: 'Write operation denied.', isError: true };
              }
            }
          }
          // Git write tools (commit/stage/reset/push/...) get the same approval gate.
          if (GIT_WRITE_TOOLS.has(name)) {
            const mode = this.getActiveMode();
            if (mode !== 'auto' && mode !== 'unattended') {
              const answer = await this.askPermission(`Run git operation "${name}"`);
              const norm = answer.trim().toLowerCase();
              if (norm !== 'y' && norm !== 'a') {
                return { content: 'Write operation denied.', isError: true };
              }
            }
          }
          result = await this.mcpRequest('callTool', { name, args });
        }
      }
      // Cap oversized output (bash / file reads / remote tools) so one result
      // cannot blow the entire context window (see capToolResult above).
      return capToolResult(result);
    };
    // The core's `getToolsForContext` applies a per-turn keyword filter to keep
    // the LLM tool list small (tokens/bigrams from the user message must match a
    // tool's name+description). That silently strips user-configured MCP tools
    // whenever the message does not literally name them (e.g. Chinese asks about
    // "LSP/语法检查" never match the English pyright_* descriptions). Re-append
    // any connected MCP tool the filter dropped so explicitly-configured servers
    // stay callable. Plan mode and role-scoped allowlists are respected: those
    // intentionally restrict the toolset and must not be widened here.
    const patchedGetAllTools = local.getAllTools.bind(local);
    const originalGetTools = (agent as unknown as {
      getToolsForContext: (input?: string) => Promise<Array<{ name: string }>>;
    }).getToolsForContext.bind(agent);
    (agent as unknown as {
      getToolsForContext: (input?: string) => Promise<Array<{ name: string }>>;
    }).getToolsForContext = async (input?: string) => {
      const tools = await originalGetTools(input);
      if (agent.planMode || (agent.toolAllowlist?.size ?? 0) > 0) return tools;
      const mcpTools = (patchedGetAllTools() as McpToolDef[]).filter((t) => t.server);
      if (mcpTools.length === 0) return tools;
      const have = new Set(tools.map((t) => t.name));
      const missing = mcpTools.filter((t) => !have.has(t.name));
      if (missing.length > 0) {
        logger.info(
          `[mcp-bridge] getToolsForContext re-appended ${missing.length}/${mcpTools.length} MCP tools ` +
            `(base=${tools.length}, input=${(input ?? '').length}): ${missing.map((t) => t.name).join(', ')}`,
        );
        return [...tools, ...missing];
      }
      return tools;
    };
    // Kick off the first prefetch so MCP tools are available (not just builtin)
    // on the first turn without blocking synchronous tool-list assembly.
    void this.refreshMcpToolCache();
  }

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

    const { Agent } = await import('nexus-coder/dist/src/agent.js');
    this.agent = new Agent();

    // Raise the session's bound projectDir to the TOP of the system prompt
    // (message 0) before every LLM call. The core's own [Project Directory]
    // block (agent.js chat()) is appended to the END of the message list via
    // context.add(), where the model reads it too late to guide path focus —
    // that is why the model drifts to cwd / ~/.nexus when analyzing architecture.
    // prependToSystem() lands our block inside the first system message (the real
    // prompt), the highest-priority position. We reuse the core's exact marker so
    // its alreadyInjected guard (agent.js) skips re-adding the low-priority one.
    this.agent.hooks = {
      ...this.agent.hooks,
      preLlmCall: async () => {
        try {
          const sid = this.agent?.getCurrentSessionId?.();
          if (!sid) return;
          const ctx = this.agent!.context;
          const msgs = ctx.getMessages();

          // --- "No user query found in messages" guard ---
          // The core invokes ensureUserInContext() ONLY inside its compression
          // paths (dist/src/llm/context-manager.js). Compression short-circuits
          // when token count is below threshold, so a multi-tool turn's 2nd+ LLM
          // call (runLlmTurn recursion) can reach provider.chat() with a message
          // tail of assistant(toolCalls)/tool and NO trailing user message. Some
          // OpenAI-compatible providers reject exactly that with
          // 400 "No user query found in messages." Mirror the core guard against
          // the LIVE message list so every call ends with the rightmost user
          // message (a plain append would duplicate it each tool iteration).
          const liveMsgs = (ctx as unknown as { messages: Array<{ role?: string }> }).messages;
          if (liveMsgs && liveMsgs.length > 0 && liveMsgs[liveMsgs.length - 1].role !== 'user') {
            let rightmostUser: { role?: string } | undefined;
            for (let i = liveMsgs.length - 1; i >= 0; i--) {
              if (liveMsgs[i].role === 'user') {
                rightmostUser = liveMsgs[i];
                break;
              }
            }
            if (rightmostUser) {
              const userIdx = liveMsgs.findIndex((m) => m.role === 'user');
              if (userIdx >= 0) liveMsgs.splice(userIdx, 1);
              liveMsgs.push(rightmostUser);
            }
          }

          // --- Project directory injection (existing) ---
          const meta = this.getSessionMetadata(sid);
          const projectDir =
            typeof meta.projectDir === 'string' && meta.projectDir ? meta.projectDir : undefined;
          if (projectDir) {
            const first = msgs[0];
            const firstContent = first?.role === 'system' && typeof first.content === 'string' ? first.content : '';
            const marker = '[Project Directory]';
            if (!(firstContent.includes(marker) && firstContent.includes(projectDir))) {
              if (!firstContent.includes(marker)) {
                ctx.replaceSystemByMarker(marker, null);
              }
              ctx.prependToSystem(
                `\n\n${marker}\n${projectDir}\n` +
                  'The user\'s active project lives EXCLUSIVELY under this directory — it is the ' +
                  'FIRST-PRIORITY directory for all project analysis, reads and writes. Prefer ' +
                  'absolute paths under this directory over cwd and over ~/.nexus, even if a ' +
                  'same-named folder exists elsewhere.\n',
              );
            }
          }

          // --- Desktop prompt fixes ---
          // Override outdated/incorrect prompts from the core package and add Desktop-specific info
          const FIX_MARKER = '[Desktop Prompt Fixes]';
          const first = msgs[0];
          const firstContent = first?.role === 'system' && typeof first.content === 'string' ? first.content : '';
          if (!firstContent.includes(FIX_MARKER)) {
            ctx.prependToSystem(
              `\n\n${FIX_MARKER}\n` +
                'IMPORTANT CORRECTIONS — override any conflicting instructions above:\n' +
                '1. DO NOT use text2image-free-CogView_single — this tool does NOT exist. If the user asks to generate images, ' +
                'explain that image generation is not available in this Desktop environment, or suggest using an external tool/service.\n' +
                '2. Cross-platform file operations:\n' +
                '   - To empty/truncate a file: use Node.js `fs.truncateSync(path, 0)` or `writeFileSync(path, "")` via exec_command\n' +
                '   - On Windows: use `fs.truncateSync()` or `echo. > file` in cmd\n' +
                '   - On Unix: `cp /dev/null file` or `> file` or `truncate -s 0 file`\n' +
                '   - Preferred universal method: write a one-line script `require("fs").truncateSync("path", 0)` and run it\n' +
                '3. When the user asks about image generation capabilities, say this Desktop app does not have built-in image generation.\n' +
                '\nDesktop-specific tools (not in core):\n' +
                '  - sequentialthinking: Structured reasoning tool for complex problems (thought branches, revisions, hypotheses)\n' +
                '  - query: Read-only SQL queries on SQLite databases\n' +
                '  - execute: Write SQL (INSERT/UPDATE/DELETE) with approval gate\n' +
                '  - list-tables / describe-table / create-table / drop-table: SQLite schema management\n' +
                '  - insert-record / update-record / delete-record: SQLite row operations\n' +
                '  - list_directory_with_sizes: Directory listing with recursive size info\n' +
                '  - read_media_file: Read images/media as inline Markdown data-URIs\n' +
                '  - get_current_time / convert_time: Timezone-aware time utilities\n' +
                '  - fetch: HTTP requests with content extraction\n' +
                '  - 36 git_* tools: Full git operations (commit, branch, merge, etc.)\n',
            );
          }

          // --- Debugging Discipline RULE 1 relaxation (core hard-block) ---
          // The core base prompt (nexus-coder dist/src/agent.js) unconditionally
          // appends "[Debugging Discipline]" whose RULE 1 forbids reading source
          // before a runnable reproduction exists — unsatisfiable for a desktop
          // IDE and contradictory to the [Project Directory] / constitution blocks
          // injected above. Append a superseding section (lands after the core
          // block, so it is read later and overrides it).
          if (!firstContent.includes(DEBUG_OVERRIDE_MARKER)) {
            ctx.prependToSystem(buildDebugDisciplineOverride());
          }

          // --- Project constitution (P0, from Tolten Aegis) ---
          // Inject the .nexus project constitution into EVERY model step,
          // under a clearly delimited marker so it is strippable/auditable.
          // Refused for unauthorized roots; size-capped internally (32 KB).
          // Only local sessions: sub-agents (parallel phase) get the text
          // explicitly passed by the Orchestrator (see adoption plan §3.7).
          try {
            let text = this.constitutionOverride !== undefined ? (this.constitutionOverride || null) : null;
            if (!text) {
              // Sub-agent sessions (Orchestrator §3.7): override is set, so we
              // NEVER discover the constitution via the filesystem in the worker.
              const constitution = await loadConstitution(projectDir ?? process.cwd());
              if (constitution.reason === 'ok' && constitution.text) text = constitution.text;
              else if (constitution.reason === 'too-large') {
                this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);
              } else if (constitution.reason === 'unauthorized') {
                this.onLog?.('debug', 'Constitution skipped: project root not authorized');
              }
            }
            if (text) {
              if (!firstContent.includes(CONSTITUTION_MARKER)) {
                ctx.prependToSystem(
                  `\n\n${CONSTITUTION_MARKER}\n${text}\n${CONSTITUTION_MARKER}\n`,
                );
              }
            } else if (firstContent.includes(CONSTITUTION_MARKER)) {
              // Rule set removed / no longer resolvable — clear the block.
              ctx.replaceSystemByMarker(CONSTITUTION_MARKER, null);
            }
          } catch {
            // Prompt decoration must never break a turn.
          }

          // --- Vision-route hint (P0, from ModLens auto-detect-and-route) ---
          // Only inject when the model is POSITIVELY confirmed text-only
          // (declared vision:false). Native-vision / unknown models never get
          // the hint — conservative rule, mirrors ModLens.
          try {
            const caps = readModelCapabilities(this.getConfig());
            const activeModel = this.getActiveModel();
            if (shouldInjectVisionHint(caps, activeModel)) {
              if (!firstContent.includes(VISION_HINT_MARKER)) {
                ctx.prependToSystem(`\n\n${VISION_HINT_MARKER}\n${buildVisionHint(activeModel)}\n`);
              }
            } else if (firstContent.includes(VISION_HINT_MARKER)) {
              ctx.replaceSystemByMarker(VISION_HINT_MARKER, null);
            }
          } catch {
            // Prompt decoration must never break a turn.
          }

          // --- Work-mode skill enforcement ---
          // When the user message references data files or analysis tasks,
          // inject a system prompt that FORCES the model to use deterministic
          // skills (sheet.read / sheet.analyze / bi.chart) instead of narrating.
          const WORK_MARKER = '[Work Mode: Skill Enforcement]';
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
          const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : '';
          const hasDataFile = /\.(csv|xlsx?|tsv)\b/i.test(lastUserText);
          const hasAnalysisKeyword = /分析|统计|图表|chart|analyze|data|visualiz/i.test(lastUserText);
          if ((hasDataFile || hasAnalysisKeyword) && !lastUserText.startsWith('/')) {
            if (!firstContent.includes(WORK_MARKER)) {
              ctx.prependToSystem(
                `\n\n${WORK_MARKER}\n` +
                  'CRITICAL WORK-MODE RULES — you MUST follow these exactly:\n' +
                  '1. When the user provides or references a data file (CSV, Excel, TSV), you MUST call `sheet.read` to load it. NEVER narrate or summarize file contents from memory.\n' +
                  '2. When the user asks for statistics (sum, mean, min, max, count, etc.), you MUST call `sheet.analyze`. NEVER compute statistics manually.\n' +
                  '3. When the user asks for a chart or visualization, you MUST call `bi.chart`. NEVER describe a chart in text.\n' +
                  '4. NEVER skip tool calls. Every data operation MUST go through the corresponding skill tool.\n' +
                  '5. After all tool calls complete, provide a brief summary of the results.\n',
              );
            }
          } else if (!hasDataFile && !hasAnalysisKeyword) {
            // Non-work-mode: remove the enforcement prompt if present
            ctx.replaceSystemByMarker(WORK_MARKER, null);
          }
        } catch {
          // Prompt decoration must never break a turn.
        }
      },
    };

    // Route ALL permission prompts to the UI — both the MCP/tool prompt and the
    // path authorization (read_text_file etc.) use this single bridge. The CLI
    // wires the same via setPermissionPrompter; without it the path prompter
    // falls back to a dead stdin readline inside the worker and instantly denies.
    const { setPermissionPrompter } = await import('nexus-coder/dist/src/security/path-authorizer.js');
    setPermissionPrompter((question: string) => this.askPermission(question));

    // The audit manager (remember tool / user_info / dangerous-command gates) also
    // ships an askUser bridge, but the CLI is the only path that wires it. Without
    // it the worker falls back to a dead-stdin readline here: remember's
    // requestApproval() never resolves and the agent kills the tool at 60s
    // ("Tool 'remember' timed out after 60s"). recall has no audit gate, which is
    // why reads keep working while every remember write times out.
    // Normalize the UI's 'y' (once) / 'a' (always) to the audit's expected 'y'.
    this.agent.audit.setAskUser(async (question: string) => {
      // auto/unattended treat the audit gates as auto-approved: remember only
      // writes the user's knowledge graph and user_info is a preference note —
      // both non-destructive, and unattended mode keeps its own safety net for
      // destructive operations. The audit bridge receives only prompt text (not
      // the tool name), so gating on mode is the allowlist-equivalent here.
      const mode = this.getActiveMode();
      if (mode === 'auto' || mode === 'unattended') return 'y';
      const answer = await this.askPermission(question);
      const norm = answer.trim().toLowerCase();
      return norm === 'y' || norm === 'a' ? 'y' : norm;
    });

    this.agent.onEvent = (event: AgentEvent) => this.handleAgentEvent(event);
    // onOutput is used by slash-command and non-streaming paths (e.g. runRemoteSlashCommand's
    // /plan /go /tasks). When we are inside a slash turn, route it to the slash
    // log/card channel; otherwise surface it as a plain text event.
    this.agent.onOutput = (text: string) => {
      if (this.slashTurn) {
        this.pushSlashText(text);
        return;
      }
      this.onEvent?.({ type: 'text', text });
    };
    this.agent.onPermissionRequest = async (
      toolName: string,
      _toolCallId: string,
      toolArgs: unknown,
    ) => {
      // Auto mode: skip UI prompt entirely — let downstream checks handle everything.
      // The safety gate (unattended) is intentionally more conservative; in auto mode
      // there's no safety gate so we trust the allowlist + safe paths.
      if (this.getActiveMode() === 'auto') {
        return { verdict: 'allow' as const };
      }
      const summary =
        toolArgs && typeof toolArgs === 'object'
          ? JSON.stringify(toolArgs).slice(0, 200)
          : '';
      const answer = await this.askPermission(
        `Tool "${toolName}" requested permission.\nArgs: ${summary}`,
      );
      // 'y' (once) and 'a' (always) both allow; the core has no per-tool
      // persistence so 'a' behaves like a one-time allow here (path prompts
      // still persist 'a' via the path-authorizer's GLOBAL_SCOPE).
      return { verdict: ['y', 'a'].includes(answer.trim().toLowerCase()) ? 'allow' : 'deny' };
    };
    this.applyMcpProxy(this.agent);
    // Watch context-manager progress callbacks to detect repeated compressions.
    // When the same session triggers ≥ 3 compresses within 5 minutes, inform
    // the user that their model's context limit may need an explicit entry in
    // config.json's modelContextLimits map.
    const ctx = this.agent.context;
    const origOnProgress = ctx.onProgress;
    ctx.onProgress = (...args: Parameters<NonNullable<typeof origOnProgress>>) => {
      origOnProgress?.(...args);
      const msg = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (!msg.toLowerCase().includes('compress')) return;
      const sid = this.agent?.getCurrentSessionId?.() ?? '';
      if (!sid) return;
      const log = this.compressionLog.get(sid) ?? [];
      const now = Date.now();
      // Prune entries older than 5 minutes.
      const recent = log.filter((t) => now - t < 5 * 60_000);
      recent.push(now);
      this.compressionLog.set(sid, recent);
      if (recent.length >= 3 && !this.compressionWarned.has(sid)) {
        this.compressionWarned.add(sid);
        const cap = this.getModelCapabilityForActive();
        if (cap?.contextLimit) {
          // Declared capability exists — the warning is informational only:
          // the real fix is already in config (modelCapabilities.contextLimit).
          this.onLog?.('warn',
            `Session "${sid}" was compressed ${recent.length} times in 5 min. ` +
            `Declared context limit for ${this.getActiveModel() || 'active model'} is ` +
            `${cap.contextLimit} tokens — if compressions persist, lower it or reduce ` +
            `tool-result sizes (MAX_TOOL_RESULT_CHARS).`,
          );
        } else {
          this.onLog?.('warn',
            `Session "${sid}" was compressed ${recent.length} times in 5 min. ` +
            `The model's context limit may not match reality — add it to config.json's ` +
            `"modelCapabilities" map (e.g. "${this.getActiveModel() || 'model-id'}": ` +
            `{ "contextLimit": 524288, "vision": false }) to fix.`,
          );
        }
      }
    };
this.onLog?.('info', `Nexus core ready for reads (cwd=${process.cwd()})`);
  }

  /**
   * Phase 2 of startup: full init (skills load). MCP is owned by the shared
   * main-process hub, NOT by this worker, so no shadow MCP processes are
   * spawned per worker/tab. This method keeps the core from connecting MCP
   * locally (by temporarily clearing cfg.mcpServers around agent.init()) and
   * relies on the hub proxy wired in `earlyInit` for any MCP tool access. The
   * `defer` flag now just chooses whether init waits for the hub to begin its
   * background connect (default) or returns immediately.
   */
  async init(cwd?: string, opts?: { deferMcp?: boolean }): Promise<void> {
    await this.earlyInit(cwd);
    const agent = this.agent;
    if (!agent) throw new Error('Agent not initialized');
    const defer = !!opts?.deferMcp;
    const cfg = agent.config.get();
    const savedMcp = cfg.mcpServers;
    if (savedMcp) cfg.mcpServers = {};
    try {
      await agent.init();
    } finally {
      if (savedMcp) cfg.mcpServers = savedMcp;
    }
    // Kick the hub so MCP servers connect once (globally), without blocking
    // this worker. Tools appear in every tab once the hub they proxy is ready.
    void this.mcpRequest('connect')
      .then(() => this.refreshMcpToolCache())
      .catch(() => {});
    // 首次启动：若 ~/.nexus/provider-models.yaml 不存在则创建默认模板
    AgentService.ensureProviderModelsYaml();
    this.initialized = true;
    this.onLog?.('info', `Nexus core initialized (cwd=${process.cwd()}, deferMcp=${defer})`);
  }

  async shutdown(): Promise<void> {
    const agent = this.agent;
    if (agent) await agent.shutdown();
    this.initialized = false;
    this.agent = null;
  }

  /**
   * Ensure ~/.nexus/provider-models.yaml exists with a default template on first run.
   * Only writes when the file is absent — never overwrites user-edited content.
   */
  static ensureProviderModelsYaml(): void {
    const yamlPath = join(homedir(), '.nexus', 'provider-models.yaml');
    if (existsSync(yamlPath)) return;
    try {
      mkdirSync(join(homedir(), '.nexus'), { recursive: true });
      const DEFAULT =
        '# 自定义模型列表 — 免费/优先模型置顶，与 API 返回列表合并展示\n' +
        '# Custom model list — free/priority models appear at the top of the dropdown, followed by the API list.\n' +
        '#\n' +
        '# freeModels       始终出现在列表最顶端（免费/推荐模型）\n' +
        '# freeModels       Always appears at the very top (free / recommended models)\n' +
        '# priorityModels   出现在 freeModels 之后、API 模型之前\n' +
        '# priorityModels   Appears after freeModels, before the API-fetched models\n' +
        '#\n' +
        '# 修改此文件后无需重启 App，下次打开对应 provider 的下拉菜单即生效\n' +
        '# Edit this file and the dropdown updates automatically on next open — no restart needed.\n' +
        '#\n' +
        '# ---- 示例 / Example ----\n' +
        'providers:\n' +
        '  zhipu:\n' +
        '    freeModels:\n' +
        '      # - glm-4.7-flash\n' +
        '      # - glm-z1-flash\n' +
        '    priorityModels:\n' +
        '      # - glm-4-flash-250414\n' +
        '  agnes:\n' +
        '    freeModels:\n' +
        '      # - agnes-2.5-flash\n' +
        '    priorityModels: []\n' +
        '  deepseek:\n' +
        '    freeModels: []\n' +
        '    priorityModels:\n' +
        '      # - deepseek-v4-pro\n' +
        '      # - deepseek-v4-flash\n' +
        '  qiniu:\n' +
        '    freeModels: []\n' +
        '    priorityModels: []\n' +
        '  zen:\n' +
        '    freeModels: []\n' +
        '    priorityModels: []\n';
      writeFileSync(yamlPath, DEFAULT, 'utf-8');
    } catch {}
  }

  private persistUserInput(input: string): number | null {
    const agent = this.agent;
    if (!agent) return null;
    const sid = agent.getCurrentSessionId?.();
    if (!sid) return null;
    try {
      agent.session.addMessage(sid, { role: 'user', content: input });
      // addMessage does not return the row id; read back the last user row we
      // just inserted so the slash card can be anchored on reload.
      return getLastUserMessageId(sid);
    } catch (e) {
      this.onLog?.('warn', `Persist user input failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Slash commands (e.g. /plan /go /tasks) are intercepted by the core's chat()
   * and return BEFORE the user message is persisted to the session DB, so the
   * transcript would otherwise miss them. Persist the raw input ourselves so
   * history/resume matches what the user actually typed. Persisted BEFORE the
   * turn so the row lands ahead of any sub-agent worker blocks that /go spawns.
   * Returns the inserted user-row id (anchor for the slash-output card).
   */
  private persistSlashInput(input: string): number | null {
    if (!input.trim().startsWith('/')) return null;
    return this.persistUserInput(input);
  }

  /**
   * Determine if parallel execution is appropriate.
   */
  private shouldUseParallel(prompt: string): boolean {
    // Declarative statements (conjunctions without action verbs) must not
    // enter the parallel path at all — they belong in a single runTurn.
    if (this.isDeclarativePrompt(prompt)) return false;

    // Universal: 2+ conjunctions → likely parallel task list
    const conjunctionRegex = /(?:和|与|以及|，|,|、|＆|&|and|et|y|и|أو)/gi;
    const conjunctionCount = (prompt.match(conjunctionRegex) || []).length;
    if (conjunctionCount >= 2) return true;

    // Per-language patterns (synced across all 6 UN languages)
    const patterns = [
      // === Chinese (中文) - 中国、新加坡 ===
      /分析.*和.*(?:和|与|以及)/i,
      /比较.*(?:与|和).*(?:与|和)/i,
      /并行/,
      /同时.*(?:处理|执行|分析|完成)/i,
      /分别.*(?:处理|执行|分析|完成)/i,
      /请.*(?:处理|执行|分析).*(?:和|与|以及)/i,
      
      // === English - US, UK, Canada, Australia ===
      /\bparallel\b/i,
      /\bconcurrent(ly)?\b/i,
      /\bsimultaneous(ly)?\b/i,
      /\banalyze.*and.*and/i,
      /\bcompare.*with.*and/i,
      /\bprocess.*and.*and/i,
      /\bdo.*and.*and/i,
      
      // === French (Français) - France, Canada, Belgium, Switzerland ===
      /\bparallèlement\b/i,
      /\bsimultanément\b/i,
      /\banalyser.*et.*et/i,
      /\bcomparer.*et.*et/i,
      /\btraiter.*et.*et/i,
      /\bfaire.*et.*et/i,
      
      // === Russian (Русский) - Russia, Belarus, Kyrgyzstan ===
      /\bпараллельно\b/i,
      /\bодновременно\b/i,
      /\bанализировать.*и.*и/i,
      /\bсравнить.*и.*и/i,
      /\bобработать.*и.*и/i,
      /\bсделать.*и.*и/i,
      
      // === Spanish (Español) - Spain, Mexico, Argentina, Colombia ===
      /\bparalelamente\b/i,
      /\bsimultáneamente\b/i,
      /\banalizar.*y.*y/i,
      /\bcomparar.*y.*y/i,
      /\bprocesar.*y.*y/i,
      /\brealizar.*y.*y/i,
      
      // === Arabic (العربية) - Saudi, Egypt, UAE, Iraq ===
      /\bبالتوازي\b/,
      /\bفي نفس الوقت\b/,
      /\bتحليل.*و.*و/,
      /\bمقارنة.*و.*و/,
      /\bمعالجة.*و.*و/,
      
      // === Task list patterns (universal) ===
      /(?:任务|task|tâche|tarea|задача|مهمة)\s*[1-9]\s*[,.]?\s*(?:任务|task|tâche|tarea|задача|مهمة)\s*[2-9]/i,
    ];
    
    return patterns.some(p => p.test(prompt));
  }

  /**
   * Event bridge used as `agent.onEvent`. Feeds the active turn monitor: drops
   * noise thinking deltas, counts real streamed chars, and fires the thinking
   * stall guard. The raw event is then forwarded to the UI unchanged.
   */
  private handleAgentEvent(event: AgentEvent): void {
    // Strip leaked protocol XML (</parameter></invoke></tool_calls> residue,
    // <system-reminder> blocks) before anything counts or renders it.
    if (event.type === 'text' && typeof event.text === 'string') {
      const clean = stripProtocolXml(event.text);
      if (!clean) return; // pure protocol residue — nothing user-visible
      if (clean !== event.text) event = { ...event, text: clean };
    }
    const mon = this.activeMonitor;
    if (mon) {
      if (event.type === 'thinking' && typeof event.thinking === 'string') {
        if (mon.isNoise(event.thinking)) return; // drop noise — never counted/rendered
        mon.noteThinking(event.thinking);
        const stall = mon.checkStall();
        if (stall.stalled) {
          mon.markStallHandled();
          this.handleThinkingStall(stall);
        }
      } else if (event.type === 'text' && typeof event.text === 'string') {
        mon.noteText(event.text);
      } else if (event.type === 'tool_call_start') {
        mon.noteProgress();
      }
    }
    this.onEvent?.(event);
  }

  /**
   * Reaction to a thinking-stall verdict (loop / idle) from the turn monitor.
   * Loop = degenerate hallucination spin → abort the turn (stops the token
   * burn). Idle = deep-but-slow reasoning → warn only, never abort blindly.
   */
  private handleThinkingStall(stall: ThinkingStall): void {
    const model = this.getActiveModel() || 'active model';
    if (stall.reason === 'loop') {
      this.onLog?.(
        'warn',
        `[thinking-guard] model "${model}" repeated the same thinking block ` +
          `${stall.repeatCount} times (~${stall.thinkingTokens} tokens) with no progress — ` +
          `aborting this turn to stop the token burn.`,
      );
      this.onEvent?.({
        type: 'thinking_stall',
        reason: stall.reason,
        thinkingTokens: stall.thinkingTokens,
        repeatCount: stall.repeatCount,
        aborting: this.abortOnThinkingLoop,
      });
      if (this.abortOnThinkingLoop) this.agent?.abort?.();
    } else {
      this.onLog?.(
        'warn',
        `[thinking-guard] model "${model}" produced ~${stall.thinkingTokens} thinking tokens ` +
          `without yielding text or a tool call.`,
      );
      this.onEvent?.({
        type: 'thinking_stall',
        reason: stall.reason,
        thinkingTokens: stall.thinkingTokens,
        repeatCount: stall.repeatCount,
        aborting: false,
      });
    }
  }

  /**
   * Run one raw agent turn under the turn monitor and report estimated usage.
   * This is the single choke point every agent.chat() in this service flows
   * through (single turn, parallel sub-tasks), so `completion` reflects the
   * actual streamed text + thinking and `prompt` the live context size.
   */
  private async runTurn(input: string): Promise<TurnUsage> {
    const agent = this.agent;
    if (!agent) throw new Error('Agent not initialized');
    const monitor = new TurnMonitor();
    monitor.setPromptBaseline(agent.context?.getTokenCount?.() ?? 0);
    this.activeMonitor = monitor;

    // Rate-limit the main chat path (distinct from callLlm which handles
    // sub-agent decomposition). Acquire before every turn; report after so
    // the main-process registry can aggregate across all open session tabs.
    const providerName = this.getActiveProvider();
    const providerCfg = agent.config.getProvider(providerName);
    const family = inferProviderFamily(providerCfg?.baseUrl);
    const rpm = this.rateLimiter.getEffectiveRpm(family);
    await this.rateLimiter.acquire(family, rpm);

    try {
      await agent.chat(input);
    } finally {
      this.activeMonitor = null;
      const status = this.rateLimiter.getStatus(family, providerCfg?.baseUrl);
      if (status && this.onRateLimitReport) this.onRateLimitReport(status);
    }

    const usage = monitor.finish();
    this.lastUsage = usage;
    return usage;
  }

  /**
   * Run a full chat turn (slash handling + parallel detection included) and
   * return the estimated token usage for the whole call. Used by the isolated
   * sub-agent path (agent-worker runSubAgent) so task cards report real numbers
   * instead of the hardcoded zeros.
   */
  async chatForUsage(input: string): Promise<TurnUsage> {
    await this.chat(input);
    return this.lastUsage ?? EMPTY_USAGE;
  }

  async chat(input: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy()) throw new Error('Agent is busy');

    // A fresh user send starts with a clean stop state: the flag only gates a
    // parallel batch that is CURRENTLY executing, never the next turn.
    this.stopRequested = false;

    // Proactive progressive summary: compress incrementally before the LLM call
    // when token delta since last summary exceeds the threshold. Prevents large
    // sudden compressions and keeps context fresh across long sessions.
    if (this.agent) {
      const cw = this.agent.config.getContextWindow?.();
      const ctx = this.agent.context;
      if (cw && ctx) {
        const delta = ctx.getTokenCount() - ctx.getLastSummaryTokenCount();
        if (delta >= cw.summaryThreshold && ctx.getMessages().length >= ctx.getSummaryAfterMsgs() && ctx.getSummaryCount() < 20) {
          await ctx.proactiveSummarize();
        }
      }
    }

    // Check if parallel execution should be used
    if (this.shouldUseParallel(input)) {
      await this.chatParallel(input);
      return;
    }
    
    // chat() resolves pending askUser with the next user input, otherwise runs a turn
    const isSlash = input.trim().startsWith('/');
    const isClear = /^\/clear(?:\s|$)/i.test(input.trim());
    const anchorId = (isSlash && !isClear) ? this.persistSlashInput(input) : null;
    // /clear must NOT be persisted: the clear action itself is not a meaningful
    // conversation turn, and writing it to the DB would add a stale row that a
    // tab reopen would reload back into context — defeating the whole purpose.
    // Also: /clear must NOT use the slash-channel (slashTurn). If it did, the
    // core's emit("Context cleared.") would open a collapsible slash card, and
    // finalizeSlashTurn() would write an anchorId=null entry into the per-session
    // slash-log file. On every subsequent tab-switch / reload, insertSlashCards()
    // hits the "no anchorId → appendChild at end" fallback (renderer.ts:1639),
    // which is why the /clear card keeps reappearing at the conversation tail.
    // Route /clear through the plain-text channel instead so the output renders
    // as an ordinary message and no log entry is written.
    this.slashTurn = isSlash && !isClear ? { cmd: input.trim(), anchorId: anchorId ?? undefined, buf: '' } : null;
    const bridged = await this.handleDagCommand(input);
    if (bridged) {
      this.finalizeSlashTurn();
      return;
    }

    // Auto-name session on first user message
    const sid = this.agent.getCurrentSessionId?.();
    if (sid) {
      try {
        const session = this.agent.session.get(sid);
        if (session && input.trim().length > 0) {
          // Check if session has default name (time-based format) or no name
          const hasDefaultName = !session.name || 
            session.name.trim() === '' ||
            /^Session \d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/.test(session.name);
          
          if (hasDefaultName) {
            const autoName = extractTopic(input.trim());
            if (autoName) {
              this.agent.session.rename(sid, autoName);
              this.onEvent?.({ type: 'sessionRenamed', sessionId: sid, name: autoName });
            }
          }
        }
      } catch (err) {
        // Log error for debugging but don't throw (non-critical feature)
        this.onLog?.('debug', `Auto-rename failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.runTurn(input);
    // /clear wipes the in-memory context but DB rows persist; snapshot a token
    // baseline so the side-panel counter restarts from ~0 instead of continuing
    // to show the cumulative total, then tell the UI to refresh immediately.
    if (isClear) {
      const clearedSid = this.agent.getCurrentSessionId?.();
      if (clearedSid) {
        // Snapshot the raw total BEFORE deletion so the baseline remains valid
        // (it is keyed on the pre-delete MAX(id); after deletion the raw counter
        // drops to 0 and max(0, 0 − baseline) = 0, which is correct).
        await this.recordContextClearBaseline(clearedSid);
        // Now actually delete every persisted row so a tab reopen does not
        // reload the old transcript back into context (the core's startSession
        // calls setMessages with every DB row — without this deletion the clear
        // would be undone the moment the user switches tabs).
        deleteAllSessionMessages(clearedSid);
      }
    }
    // Plain /go is run by the core's own slash handling (its executePlan stamps
    // the session metadata.projectDir with the sandbox ~/.nexus/tasks/outputs/<name>).
    // Mirror the /setdir side effects so the worker chdirs and the UI refresh
    // follows — /go --loop and /commit are already bridged separately in
    // runPlanExecution, which calls applyPlanProjectDir() itself.
    if (/^\/go(?:\s|$)/i.test(input.trim())) {
      const sid = this.agent.getCurrentSessionId?.();
      if (sid) await this.applyPlanProjectDir(sid);
    }
    this.finalizeSlashTurn();
  }

  /**
   * Parallel execution mode.
   * 
   * Since the worker process cannot create WorkerHost instances (Electron-only),
   * we use fallback decomposition and execute tasks sequentially in the current
   * worker. The UI still shows parallel cards for visual feedback.
   */
  private async chatParallel(prompt: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    if (this.agent.isBusy()) throw new Error('Agent is busy');
    
    const sessionId = this.agent.getCurrentSessionId?.() ?? 'unknown';
    
    // Decompose the prompt into sub-tasks (fallback: split by conjunctions)
    const subTasks = this.fallbackDecompose(prompt);

    if (subTasks.length <= 1 || this.isDeclarativePrompt(prompt)) {
      // Declarative statement or single coherent task — skip parallel UI,
      // run a normal single turn so sequentialthinking handles the reasoning.
      await this.runTurn(prompt);
      return;
    }
    
    // Persist the original user input exactly once (the visible transcript row)
    this.persistUserInput(prompt);
    
    // Store parallel execution state in session metadata for persistence
    const parallelState = {
      prompt,
      tasks: subTasks.map(t => ({
        id: t.id,
        description: t.description,
        prompt: t.prompt,
        status: 'pending' as const,
      })),
      startTime: Date.now(),
    };
    this.setSessionMetadata(sessionId, { 
      ...this.getSessionMetadata(sessionId),
      parallelExecution: parallelState 
    });
    
    // Emit parallel_start event
    this.onEvent?.({ 
      type: 'parallel_start', 
      sessionId, 
      prompt,
      tasks: subTasks.map(t => ({ id: t.id, description: t.description, status: 'pending' })),
    });
    
    // Track task results
    const taskResults: Array<{
      taskId: string;
      status: string;
      output: string;
      durationMs: number;
      error?: string;
      tokenUsage: { prompt: number; completion: number };
    }> = [];
    
    // Record a sub-task that was never (fully) run because the user stopped the
    // batch — persisted to metadata, surfaced to the card/sidebar as cancelled.
    const cancelTask = (task: SubTask): void => {
      taskResults.push({
        taskId: task.id,
        status: 'cancelled',
        output: task.description,
        durationMs: 0,
        error: 'Stopped by user',
        tokenUsage: { prompt: 0, completion: 0 },
      });
      this.updateParallelTaskStatus(sessionId, task.id, 'cancelled');
      this.onEvent?.({
        type: 'task_progress',
        taskId: task.id,
        status: 'cancelled',
        description: task.description,
        error: 'Stopped by user',
      });
    };
    
    // Execute each sub-task sequentially. The core's abort() only interrupts the
    // currently running agent.chat(); the loop itself MUST also consult
    // stopRequested so a Stop halts the WHOLE batch instead of silently starting
    // the next sub-task with a brand-new AbortController.
    for (let i = 0; i < subTasks.length; i++) {
      const task = subTasks[i];
      
      // Stop landed while this task was queued (between sub-tasks) — cancel it
      // and everything still ahead, don't start fresh work after a Stop.
      if (this.stopRequested) {
        for (let j = i; j < subTasks.length; j++) cancelTask(subTasks[j]);
        break;
      }
      
      const startTime = Date.now();
      
      // Update metadata: task running
      this.updateParallelTaskStatus(sessionId, task.id, 'running');
      
      // Emit task_progress: running
      this.onEvent?.({
        type: 'task_progress',
        taskId: task.id,
        status: 'running',
        description: task.description,
      });
      
      try {
        // Execute the sub-task using the existing agent.
        // This will properly handle turn_start/turn_end and persist to DB.
        // The prompt is wrapped in the shared worker markers so the persisted
        // row is classified as a worker block — hidden from the transcript and
        // excluded from the regenerate() user index — and the original request
        // is carried along as context, matching the sub-agent pipeline. Without
        // the markers each fragment would surface as its own visible user row.
        // Capture the actual agent text output so the card shows the real
        // response rather than the placeholder description.
        const prevOnEvent = this.onEvent;
        const textBuf: string[] = [];
        this.onEvent = (event: AgentEvent) => {
          if (event.type === 'text' && typeof event.text === 'string') textBuf.push(event.text);
          prevOnEvent?.(event);
        };

        const usage = await this.runTurn(this.wrapWorkerPrompt(task.prompt, prompt));

        this.onEvent = prevOnEvent;
        const actualOutput = textBuf.join('').trim();
        const durationMs = Date.now() - startTime;

        if (this.stopRequested) {
          // agent.chat() returns cleanly even when aborted mid-run — that "clean"
          // return is exactly how the core reports a Stop. Record this task (and
          // the remaining queue) as cancelled and halt the batch here.
          taskResults.push({
            taskId: task.id,
            status: 'cancelled',
            output: task.description,
            durationMs,
            error: 'Stopped by user',
            tokenUsage: { prompt: usage.prompt, completion: usage.completion },
          });
          this.updateParallelTaskStatus(sessionId, task.id, 'cancelled');
          this.onEvent?.({
            type: 'task_progress',
            taskId: task.id,
            status: 'cancelled',
            description: task.description,
            error: 'Stopped by user',
          });
          for (let j = i + 1; j < subTasks.length; j++) cancelTask(subTasks[j]);
          break;
        }

        taskResults.push({
          taskId: task.id,
          status: 'succeeded',
          output: actualOutput || task.description,
          durationMs,
          tokenUsage: { prompt: usage.prompt, completion: usage.completion },
        });
        
        // Update metadata: task succeeded
        this.updateParallelTaskStatus(sessionId, task.id, 'succeeded');
        
        // Emit task_progress: succeeded
        this.onEvent?.({
          type: 'task_progress',
          taskId: task.id,
          status: 'succeeded',
          description: task.description,
        });
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        // Preserve original task description in output
        taskResults.push({
          taskId: task.id,
          status: 'failed',
          output: task.description,
          durationMs,
          error: errorMsg,
          tokenUsage: { prompt: 0, completion: 0 },
        });
        
        // Update metadata: task failed
        this.updateParallelTaskStatus(sessionId, task.id, 'failed');
        
        // Emit task_progress: failed
        this.onEvent?.({
          type: 'task_progress',
          taskId: task.id,
          status: 'failed',
          description: task.description,
          error: errorMsg,
        });
      }
    }
    
    // Keep parallel state in metadata for history (don't delete)
    // This allows restoring the parallel execution info when switching back to this session

    // Aggregate the real (estimated) usage across every sub-task so parallel_end
    // reports an honest total instead of hardcoded zeros (§ token accounting).
    const totalUsage = taskResults.reduce<TurnUsage>(
      (acc, r) => ({
        prompt: acc.prompt + (r.tokenUsage?.prompt ?? 0),
        completion: acc.completion + (r.tokenUsage?.completion ?? 0),
        thinkingChars: acc.thinkingChars,
        textChars: acc.textChars,
        thinkingDeltas: acc.thinkingDeltas,
        thinkingEstimate: acc.thinkingEstimate,
      }),
      { ...EMPTY_USAGE },
    );
    this.lastUsage = totalUsage;

    // Emit parallel_end event
    this.onEvent?.({
      type: 'parallel_end',
      sessionId,
      tasks: taskResults,
      tokenUsage: totalUsage,
    });
  }

  /**
   * Update task status in session metadata.
   */
  private updateParallelTaskStatus(
    sessionId: string, 
    taskId: string, 
    status: string
  ): void {
    const meta = this.getSessionMetadata(sessionId);
    const parallelState = meta.parallelExecution as {
      tasks: Array<{ id: string; status: string }>;
    } | undefined;
    
    if (parallelState?.tasks) {
      const task = parallelState.tasks.find(t => t.id === taskId);
      if (task) {
        task.status = status as any;
        this.setSessionMetadata(sessionId, meta);
      }
    }
  }

  /**
   * Wrap a fallback sub-task prompt in the shared worker markers so the row this
   * worker persists is filtered from the transcript and ignored by the
   * regenerate() user index (constants.ts isWorkerPrompt / isWorkerBlockText).
   * The original request is embedded as context — mirroring how the real
   * sub-agent pipeline builds its [Project Directory] / [Original Request]
   * blocks — so each fragment still executes with full user intent.
   */
  private wrapWorkerPrompt(taskPrompt: string, originalPrompt: string): string {
    return `[Original Request]\n${originalPrompt}\n\n---\n\n${taskPrompt}`;
  }

  /**
   * Detect purely declarative prompts — statement-like expressions with
   * no action verb (no 分析/读取/生成/查找 etc.) that merely describe or
   * compare concepts. These should not spawn parallel tasks; just run a
   * normal single-turn reasoning pass via sequentialthinking.
   */
  private isDeclarativePrompt(prompt: string): boolean {
    const actionVerbs = '分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释|解决|修复|实现|开发|写|画|设计';
    // Has conjunctions but NO action verb anywhere → declarative
    const hasConjunction = /(?:和|与|以及|、|&|and)/i.test(prompt);
    const hasVerb = new RegExp(`\\b(${actionVerbs})\\b`, 'i').test(prompt);
    return hasConjunction && !hasVerb;
  }

  /**
   * Fallback decomposition: split prompt by conjunctions and generate meaningful descriptions.
   * Only splits when the prompt contains multiple independent clause patterns
   * (e.g. "分析A和生成B"), not when conjunctions connect paired nouns (e.g. "A和B").
   */
  private fallbackDecompose(prompt: string): Array<{
    id: string;
    description: string;
    prompt: string;
  }> {
    // Detect if prompt has multiple independent action clauses
    const actionVerbs = '分析|对比|比较|读取|生成|处理|查找|查询|提取|创建|编辑|删除|修改|总结|翻译|解释';
    const hasMultiClause = new RegExp(`\\b(${actionVerbs})\\b.*(?:和|与|以及|&|and).*.?\\b(${actionVerbs})\\b`, 'i').test(prompt);

    if (!hasMultiClause) {
      // Single coherent task — do NOT split on noun conjunctions
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: prompt,
      }];
    }

    // Split on clause boundaries: sentence terminators or inter-clause conjunctions
    const parts = prompt
      .split(/(?:[。；；\.]|(?<=\S)\s*(?:和|与|以及|&|and)\s*(?=\S))/gi)
      .map(p => p.trim())
      .filter(p => p.length > 8);

    if (parts.length <= 1) {
      return [{
        id: 'task_1',
        description: 'Complete user request',
        prompt: prompt,
      }];
    }

    return parts.map((part, index) => ({
      id: `task_${index + 1}`,
      description: this.generateTaskDescription(part, index + 1),
      prompt: part,
    }));
  }

  /**
   * Generate a meaningful description for a sub-task.
   * All descriptions follow the same format: "Task N: <content>"
   */
  private generateTaskDescription(part: string, index: number): string {
    // Truncate to consistent length
    const maxLen = 50;
    const truncated = part.length > maxLen ? part.substring(0, maxLen) + '...' : part;
    return `Task ${index}: ${truncated}`;
  }

  // ---------------------------------------------------------------- DAG bridge
  // /commit, /revise and /go --loop are implemented on the interactive CLI path
  // only (src/cli/chat.ts); the core's runRemoteSlashCommand allowlist rejects
  // them over a remote channel. This desktop-side bridge routes them straight
  // onto the core's public plan methods so the desktop gets the same behaviour
  // with zero core changes.

  /** Parse a `/cmd args` line. Returns null for non-slash / malformed input. */
  private parseSlash(input: string): { cmd: string; args: string[] } | null {
    if (!input.startsWith('/')) return null;
    const parts = input.split(/\s+/);
    const raw = parts[0] ?? '';
    if (raw.length <= 1) return null;
    return { cmd: raw.slice(1).toLowerCase(), args: parts.slice(1) };
  }

  private emitText(text: string): void {
    if (this.slashTurn) {
      this.pushSlashText(text);
      return;
    }
    this.onEvent?.({ type: 'text', text });
  }

  /** Route a chunk of slash output to the UI as a collapsible card and buffer
   *  it for the per-session log file. Emits `slash_start` on the first chunk so
   *  the renderer opens exactly one card per command, then `slash` deltas. */
  private pushSlashText(text: string): void {
    const t = this.slashTurn;
    if (!t) return;
    if (t.buf === '') {
      this.onEvent?.({ type: 'slash_start', command: t.cmd, anchorId: t.anchorId });
    }
    t.buf += text;
    this.onEvent?.({ type: 'slash', text });
  }

  /** Finalize the active slash turn: append the buffered output to the
   *  per-session markdown log and tell the renderer to close the card. Always
   *  emits `slash_end` (even for empty output) so the renderer can drop a
   *  card that never received real content. */
  private finalizeSlashTurn(): void {
    const t = this.slashTurn;
    this.slashTurn = null;
    if (!t) return;
    const sid = this.agent?.getCurrentSessionId?.();
    const hasContent = t.buf.trim().length > 0;
    if (hasContent && sid) {
      try {
        appendSlashLog(sid, {
          ts: new Date().toISOString(),
          command: t.cmd,
          anchorId: t.anchorId,
          content: t.buf,
        });
      } catch (e) {
        this.onLog?.('warn', `Slash log write failed: ${(e as Error).message}`);
      }
    }
    this.onEvent?.({ type: 'slash_end', anchorId: t.anchorId, command: t.cmd });
  }

  /** Returns true when the input was consumed by the DAG bridge. */
  private async handleDagCommand(input: string): Promise<boolean> {
    if (!this.agent) return false;
    const trimmed = input.trim();
    const parsed = this.parseSlash(trimmed);
    if (!parsed) {
      // Bare /revise armed revise mode — the next plain message is the fix.
      if (this.pendingRevise) {
        this.pendingRevise = false;
        this.persistUserInput(trimmed);
        await this.runRevise(trimmed);
        return true;
      }
      return false;
    }
    // Any slash command cancels a pending bare-/revise prompt.
    this.pendingRevise = false;
    const { cmd, args } = parsed;
    if (cmd === 'manual' || cmd === 'help') {
      // /manual is normally rendered by the core registry (getManualText). The
      // desktop appends a short section for its own commands that are missing
      // from that registry (desktop-only /chcwd, plus a note clarifying that
      // /setdir also switches the worker immediately on this client).
      let text = '';
      try {
        const { getManualText } = await import('nexus-coder/dist/src/slash/registry.js');
        text = getManualText();
      } catch {
        text = '';
      }
      text += '\n' +
        'Desktop (Nexus Desktop) only:\n' +
        '  /chcwd [path]        Temporarily switch runtime working directory (not persisted)\n' +
        '  /setdir [path]       (desktop) also switches the worker now (core records only projectDir)\n' +
        '  /rename-project <name>  Rename project across dirs, DB, and metadata (lowercase+hyphens)\n' +
        '  /compact             Compress the current context (summarize/truncate) to free window space\n';
      this.emitText(text + '\n');
      return true;
    }
    if (cmd === 'revise') {
      await this.runRevise(args.join(' ').trim());
      return true;
    }
    if (cmd === 'commit') {
      await this.runPlanExecution(args, true);
      return true;
    }
    if (cmd === 'go' && args.some((a) => a.startsWith('--loop'))) {
      await this.runPlanExecution(args, false);
      return true;
    }
    if (cmd === 'rename') {
      const newName = args.join(' ').trim();
      if (newName) {
        const sid = this.agent.getCurrentSessionId?.();
        if (sid) {
          this.agent.session.rename(sid, newName);
          this.emitText(`Session renamed to: ${newName}\n`);
          this.onEvent?.({ type: 'sessionRenamed', sessionId: sid, name: newName });
        }
      } else {
        this.emitText('Usage: /rename <new name>\n');
      }
      return true;
    }
    if (cmd === 'rename-project') {
      const newName = args.join(' ').trim();
      if (newName) {
        await this.renameProject(newName);
      } else {
        this.emitText('Usage: /rename-project <new-name>\n');
      }
      return true;
    }
    if (cmd === 'depth') {
      // /depth | /depth switch <level> | /depth set <level> | /depth <level>
      const sub = (args[0] || '').toLowerCase();
      const levelArg = sub === 'switch' || sub === 'set' ? (args[1] || '') : (args[0] || '');
      if (!levelArg) {
        this.emitText(`Current depth: ${this.getActiveDepth()}\n`);
      } else {
        const valid = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        const level = valid.includes(levelArg) ? levelArg : null;
        if (!level) {
          this.emitText(`Invalid depth: "${levelArg}". Valid: ${valid.join(' | ')}\n`);
        } else {
          await this.setDepthOverride(level);
          this.emitText(`Depth set: ${level}\n`);
        }
      }
      return true;
    }
    if (cmd === 'setdir' || cmd === 'chcwd') {
      // Help flags are intercepted before any path resolution (a folder could
      // legitimately be named "help", but "setdir help" is far more likely to be
      // someone asking for usage).
      const isHelp = args.length === 0 && false ||
        args.some((a) => /^(help|-h|--help|\?)$/i.test(a));
      if (isHelp) {
        this.emitText(
          cmd === 'setdir'
            ? 'Usage: /setdir [path]\n  Persistently bind this session to a project directory: the worker chdirs now and projectDir is recorded so a later resume re-opens here. With no path, uses the current folder.\n'
            : 'Usage: /chcwd [path]\n  Temporarily switch this session\'s runtime working directory (does NOT persist to metadata). With no path, uses the current folder.\n',
        );
        return true;
      }
      const sid = this.agent.getCurrentSessionId?.();
      if (!sid) {
        this.emitText('No active session. Open or create a session first.\n');
        return true;
      }
      const rawPath = args.join(' ').trim();
      const target = !rawPath ? process.cwd() : isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
      await this.setCwd(target);
      if (cmd === 'setdir') {
        // /setdir — explicit, permanent counter to the transient folder-button
        // switch (which never rebinds a session that already owns a project).
        this.agent.setProjectLocation?.(target, { projectDir: target });
        // Persist projectDir into session metadata so the desktop renderer's
        // sidebar project row and a later resume / resolveProjectDir can read it
        // (setProjectLocation only records it in the agent's own project state).
        try {
          this.setSessionMetadata(sid, { projectDir: target });
        } catch {}
        this.emitText(`Project directory set to ${target} (persisted)\n`);
      } else {
        this.emitText(`Working directory switched to ${target} (temporary)\n`);
      }
      this.onEvent?.({ type: 'cwdChanged', cwd: target, sessionId: sid });
      return true;
    }
    if (cmd === 'bypass') {
      // /bypass | /bypass auto | /bypass off
      const sub = (args[0] || '').toLowerCase();
      if (!sub || sub === 'status') {
        this.emitText(`Permission mode: ${this.getActiveMode()}\n`);
      } else if (sub === 'auto') {
        await this.setPermissionsOverride('auto');
        this.emitText('Bypass ON: whitelist active, tools run without prompting.\n');
      } else if (sub === 'unattended') {
        await this.setPermissionsOverride('unattended');
        this.emitText('Unattended mode ON: auto-approve with safety gate (destructive ops hard-blocked).\n');
      } else if (sub === 'off' || sub === 'prompt') {
        await this.setPermissionsOverride('prompt');
        this.emitText('Bypass OFF: reverted to prompt mode (each tool asks).\n');
      } else {
        this.emitText('Usage: /bypass [auto|unattended|off|status]\n');
      }
      return true;
    }
    if (cmd === 'compact') {
      // /compact is CLI_ONLY in the core registry (remote channels get
      // "Command /compact is not available over a remote channel"), so the
      // desktop intercepts it here and drives the core's own compression engine
      // directly — same behaviour, no core registry change needed.
      const msgs = this.agent.context.getMessages();
      const before = msgs.length;
      const tokensBefore = this.agent.context.getTokenCount();
      if (before < 4) {
        this.emitText('Not enough history to compress.\n');
      } else {
        // Resolve the limit against the ACTUAL in-memory provider (the session's
        // model override may differ from the persisted config model, whose name
        // might not even resolve a known context window).
        const modelLimit = this.agent.config.getModelContextLimit(this.agent.provider?.model);
        await this.agent.context.compress();
        const after = this.agent.context.getMessages().length;
        const tokensAfter = this.agent.context.getTokenCount();
        const saved = tokensBefore - tokensAfter;
        if (after === before && saved <= 0) {
          // The engine only compresses past its trigger threshold (85% of the
          // window by default); report the honest no-op instead of a fake
          // "Compressed 199 → 199 (0 tokens)" success line.
          const usage = modelLimit > 0 ? `${Math.round((tokensBefore / modelLimit) * 100)}%` : 'unknown';
          this.emitText(
            `Nothing to compress: context is at ${tokensBefore} tokens (${usage} of its ${modelLimit}-token window), below the compression trigger.\n`,
          );
        } else {
          this.emitText(`Compressed ${before} → ${after} messages (${tokensBefore} → ${tokensAfter} tokens).\n`);
        }
      }
      return true;
    }
    return false;
  }

  private async runRevise(instruction: string): Promise<void> {
    if (!this.agent) return;
    if (!this.agent.currentPlan) {
      this.emitText('No plan to revise. Use /plan <request>, then /go, then /revise.\n');
      return;
    }
    this.agent.enterReviseMode?.();
    if (instruction) {
      try {
        await this.agent.revisePlan(instruction);
      } catch (err) {
        this.emitText(`Revision failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } else {
      this.pendingRevise = true;
      this.emitText(
        'Entering revise mode. Describe how to fix the failed breakpoint; the failed subgraph will be re-planned. /go to re-run, or /revise <fix> to revise inline.\n',
      );
    }
  }

  /** Shared /commit + /go --loop execution path (plan resolution incl. redo). */
  private async runPlanExecution(args: string[], commit: boolean): Promise<void> {
    if (!this.agent) return;
    const redo = args.includes('redo');
    let plan = this.agent.currentPlan;
    const sid = this.agent.getCurrentSessionId?.();
    if (!plan) {
      if (sid) {
        plan = this.agent.tracker.getGraphBySession(sid);
        if (plan) this.agent.currentPlan = plan;
      }
    } else if (!redo) {
      const hasWork = plan.nodes.some(
        (n: { status: string }) => n.status !== 'completed' && n.status !== 'cancelled',
      );
      if (!hasWork && sid) {
        const sessionGraph = this.agent.tracker.getGraphBySession(sid);
        if (sessionGraph && sessionGraph.id !== plan.id) {
          plan = sessionGraph;
          this.agent.currentPlan = sessionGraph;
        }
      }
    }
    if (!plan) {
      this.emitText('? No plan found. Use /plan <request> first.\n');
      return;
    }
    if (commit) this.agent.exitPlanMode?.();
    if (redo) {
      for (const n of plan.nodes) {
        n.status = 'pending';
        n.result = undefined;
        n.error = undefined;
        n.retryCount = 0;
        n.updatedAt = Date.now();
      }
      this.agent.tracker.updateGraph(plan);
      this.emitText(`? Reset ${plan.nodes.length} tasks to pending for redo.\n`);
    }
    const completed = plan.nodes.filter((n: { status: string }) => n.status === 'completed').length;
    const failed = plan.nodes.filter((n: { status: string }) => n.status === 'failed').length;
    const pending = plan.nodes.filter(
      (n: { status: string }) => n.status === 'pending' || n.status === 'in_progress',
    ).length;
    if (completed > 0) {
      this.emitText(`Resuming ? ${completed} done, ${failed} failed, ${pending} remaining.\n`);
    }
    this.emitText('Executing plan...\n');
    try {
      const result = await this.runPlanWithLoop(args);
      this.emitText(`? ${result}\n`);
    } catch (err) {
      this.emitText(`? Execution failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    // executePlan() stamped metadata.projectDir with the sandbox outputs dir;
    // finish the implicit setdir: chdir the worker, sync agent project state and
    // refresh the UI (rside project row + the open-project dir label).
    if (sid) await this.applyPlanProjectDir(sid);
  }

  /**
   * Run the current plan, honoring `/go --loop[=N|∞|config]` (mirrors the CLI
   * parse in src/cli/chat.ts). `--loop=0` → single run; `--loop`/`--loop=config`
   * → config loop.maxRounds; `--loop=∞/-1` → unlimited.
   */
  private async runPlanWithLoop(args: string[]): Promise<string> {
    const loopArg = args.find((a) => a.startsWith('--loop'));
    let loopOverride: number | null = null;
    if (loopArg) {
      let raw = loopArg.includes('=') ? loopArg.slice('--loop'.length + 1) : '';
      if (!raw) {
        const i = args.indexOf(loopArg);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) raw = next;
      }
      if (raw === '' || raw === 'config') {
        loopOverride = null;
      } else if (raw === '∞' || raw === 'inf' || raw === 'infinity' || raw === '-1') {
        loopOverride = -1;
      } else {
        const n = Number.parseInt(raw, 10);
        loopOverride = Number.isInteger(n) ? n : null;
      }
    }
    const agent = this.agent;
    if (!agent) return 'Execution failed: agent not initialized';
    const loopCfg = agent.config.getLoopConfig();
    const maxRounds = loopOverride ?? loopCfg.maxRounds;
    return maxRounds !== 0
      ? await agent.executePlanWithLoop(maxRounds)
      : await agent.executePlan();
  }
  // ---------------------------------------------------------------------- end

  abort(): void {
    this.stopRequested = true;
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
    if (this.agent.getCurrentSessionId() !== sessionId) {
      throw new Error('Session mismatch: target session is not the active one');
    }
    const { getMessageRows, deleteMessagesFrom } = await loadSessionDb();
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
    if (this.agent.getCurrentSessionId() !== sessionId) {
      throw new Error('Session mismatch: target session is not the active one');
    }
    const { getMessageRows, deleteMessagesFrom } = await loadSessionDb();
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
      const res = (await this.mcpRequest('setEnabled', { enable: enabled })) as { ok: boolean; error?: string };
      if (!res.ok) return res;
      this.mcpEnabled = enabled;
      this.onLog?.('info', `MCP ${enabled ? 'enabled' : 'disabled'}`);
      await this.refreshMcpToolCache();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.onLog?.('warn', `MCP toggle failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  async getMcpStatus(): Promise<{ enabled: boolean; servers: Array<Record<string, unknown>> }> {
    try {
      const st = (await this.mcpRequest('status')) as { enabled: boolean; servers: Array<Record<string, unknown>> };
      return { enabled: !!st?.enabled, servers: st?.servers ?? [] };
    } catch {
      return { enabled: this.mcpEnabled, servers: [] };
    }
  }

  /**
   * Registered MCP servers from config, with live connection state (via hub).
   */
  async getMcpServers(): Promise<Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string; stderr?: string }>> {
    try {
      const res = (await this.mcpRequest('servers')) as Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string }>;
      return res.map((s) => ({ ...s, autoStart: !!s.autoStart, connected: !!s.connected, toolCount: Number(s.toolCount ?? 0) }));
    } catch {
      return [];
    }
  }

  /**
   * Toggle a single MCP server (via hub). Idempotent.
   */
  async setMcpServer(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.agent) return { ok: false, error: 'Agent not initialized' };
    try {
      const res = (await this.mcpRequest('setServer', { name, enable: enabled })) as { ok: boolean; error?: string };
      if (!res.ok) return res;
      this.onLog?.('info', `MCP server "${name}" ${enabled ? 'connected' : 'disconnected'}`);
      await this.refreshMcpToolCache();
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.onLog?.('warn', `MCP server "${name}" toggle failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  async startSession(
    name?: string,
    sessionId?: string,
    metadata?: Record<string, unknown>,
    prevSessionId?: string,
  ): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.pendingRevise = false;
    // Desktop /new: create a derived session inside THIS worker so the core's
    // injectDerivedContext runs in-process (the inherited memory baseline stays
    // in this worker's memory, matching CLI /new exactly). The parent's memory
    // was already summarized/compressed by prepareParentMemory() in the PARENT's
    // worker (which owns the real in-memory conversation); persisting it again
    // here would run against THIS worker's empty context and poison the parent
    // with a degenerate "[待续/下一步] 无" summary. So we only point
    // currentSessionId at the parent — startSession() then captures it as
    // prevSessionId and injects the (already real) baseline. Only applies to
    // the create-new branch (no sessionId) — a resume must not be moved.
    if (prevSessionId && !sessionId) {
      this.agent.joinSession(prevSessionId);
    }
    const newSessionId = await this.agent.startSession(name, sessionId, metadata);
    // The core's startSession (resume path) calls context.setMessages with every
    // DB row but performs NO compression — unlike resumeSession which summarises
    // when the transcript exceeds the context window. A bloated session tab
    // reloaded after an app restart therefore fires the "Context too large" guard
    // on the very next LLM turn. Compress here if the freshly-loaded context
    // already overshoots the budget, so the user can keep working without an
    // explicit /clear.
    if (sessionId && !name) {
      try {
        const tokenCount = this.agent.context.getTokenCount();
        const modelLimit = this.agent.config.getModelContextLimit(this.agent.provider?.model);
        const msgs = this.agent.context.getMessages();
        if (tokenCount > modelLimit * 0.95 && msgs.length >= 4) {
          this.onLog?.('info', `Session ${sessionId} resumes with ${tokenCount} tokens (>95% of ${modelLimit}); compressing…`);
          await this.agent.context.compress();
        }
      } catch (e) {
        this.onLog?.('warn', `Post-resume compress failed: ${(e as Error).message}`);
      }
    }
    // The core ALWAYS stamps projectDir: process.cwd() onto a freshly created
    // session (agent.startSession), which on Desktop leaks the parent worker's
    // project directory into every new session. A brand-new session must stay
    // projectDir-less until the user explicitly binds one via Open Project or
    // /setdir. We normalize it here: store an empty-string sentinel (the key
    // then EXISTS, so the core's resume-time ensureMetadata sees it and never
    // auto-fills a real path). An explicitly passed metadata.projectDir wins.
    // Distinguish two create-new sources:
    //   - Desktop /new (prevSessionId set): the derived session INHERITS the
    //     parent session's metadata.projectDir so the new worker's cwd (resolved
    //     from that same dir by the renderer) stays authoritative and a bound
    //     project continues across the derived tab. An unbound parent -> ''.
    //   - Brand-new empty session (no prevSessionId): '' so no project leaks in.
    if (!sessionId && newSessionId) {
      let inherited = '';
      if (prevSessionId) {
        try {
          const pd = this.agent.session.get(prevSessionId)?.metadata?.projectDir;
          inherited = typeof pd === 'string' && pd ? pd : '';
        } catch {
          inherited = '';
        }
      }
      if (metadata && typeof metadata.projectDir === 'string') inherited = metadata.projectDir;
      try {
        this.setSessionMetadata(newSessionId, { projectDir: inherited });
      } catch {}
    }
    return newSessionId;
  }

  /**
   * Finalize the CURRENT session's memory in its OWN process before it spawns a
   * derived /new session: compress the real in-memory context when it is large
   * enough (same guard as core /new), then persist a real structured summary.
   * Degenerate parent memory (non-empty but lacking the '[决策/约束]' marker —
   * e.g. written by an earlier buggy /new against an empty worker context) is
   * cleared first so persistSessionSummary regenerates a genuine baseline that
   * the derived session can carry forward. Runs best-effort; failures are logged
   * and reported via the result object, never thrown.
   */
  async prepareParentMemory(): Promise<{ msgs: number; compressed: boolean; summary: boolean; cleared: boolean }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const msgs = this.agent.context.getMessages();
    let compressed = false;
    if (msgs.length >= 4) {
      try {
        await this.agent.context.compress();
        compressed = true;
      } catch (e) {
        this.onLog?.('warn', `parent context compress failed: ${(e as Error).message}`);
      }
    }
    const sid = this.agent.getCurrentSessionId();
    let summary = false;
    let cleared = false;
    if (sid) {
      try {
        const existing = this.agent.sessionMemory.load(sid) || '';
        if (existing.trim() && !existing.includes('[决策/约束]')) {
          this.agent.sessionMemory.remove(sid);
          cleared = true;
        }
        await this.agent.persistSessionSummary(sid);
        summary = true;
      } catch (e) {
        this.onLog?.('warn', `prepareParentMemory persist failed: ${(e as Error).message}`);
      }
    }
    return { msgs: msgs.length, compressed, summary, cleared };
  }

  async listSessions(options?: { limit?: number; offset?: number; excludeMock?: boolean; excludeEmpty?: boolean; search?: string }): Promise<{ items: Session[]; total: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const limit = options?.limit;
    const offset = options?.offset ?? 0;
    const q = options?.search?.trim().toLowerCase();
    if (!options?.excludeMock && !options?.excludeEmpty && !q) {
      return this.agent.session.list({ limit, offset });
    }
    // Desktop-side filtering (the core SQL is untouched): fetch the full
    // candidate set, apply the filters, then slice + recount so pagination and
    // the page numbers stay exact for the filtered list.
    const all = this.agent.session.list({}).items ?? [];
    let items = all;
    if (options?.excludeMock) {
      // Inner-test/beta sessions use mock models (model id contains "mock").
      items = items.filter((s) => !/mock/i.test(String(s.model ?? '')));
    }
    if (options?.excludeEmpty) {
      // Skip empty-context sessions (CLI scratch / AI-intermediary noise).
      const { getNonEmptySessionIds } = await loadSessionDb();
      const nonEmpty = getNonEmptySessionIds();
      items = items.filter((s) => nonEmpty.has(String(s.id)));
    }
    if (q) {
      // Session-name/id search plus task-graph matching: a query that is (or
      // contains) a graphId or project name from task_graphs resolves to the
      // sessions that own those graphs.
      const { getSessionIdsByTaskGraph } = await loadSessionDb();
      const byTaskGraph = getSessionIdsByTaskGraph(q);
      items = items.filter((s) => {
        const name = String(s.name ?? '').toLowerCase();
        const id = String(s.id ?? '').toLowerCase();
        return name.includes(q) || id.includes(q) || byTaskGraph.has(String(s.id));
      });
    }
    const total = items.length;
    const sliced = limit !== undefined && limit >= 0 ? items.slice(offset, offset + limit) : items.slice(offset);
    return { items: sliced, total };
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
  ): Promise<{ items: StoredRow[]; total: number; userBefore: number }> {
    if (!this.agent) throw new Error('Agent not initialized');
    // SQL-windowed reads (src/session-db.ts) so a long session never loads
    // every row into memory just to paginate.
    const { getMessageWindow, getMessageLast } = await loadSessionDb();
    if (options?.last !== undefined) {
      const w = getMessageLast(sessionId, options.last);
      return { items: w.items, total: w.total, userBefore: w.userBefore };
    }
    const limit = options?.limit ?? 500;
    const offset = options?.offset ?? 0;
    const w = getMessageWindow(sessionId, offset, limit);
    return { items: w.items, total: w.total, userBefore: w.userBefore };
  }

  /**
   * Slash-command output archive for a session (read back from the per-session
   * markdown log; see src/slash-log.ts). Returned to the renderer so collapsible
   * cards survive a session reload — the content lives on disk, never in the
   * LLM session DB.
   */
  getSlashLog(sessionId: string): SlashLogEntry[] {
    try {
      return readSlashLog(sessionId);
    } catch {
      return [];
    }
  }

  /** Absolute path of the per-session slash log file (for the "open file" action). */
  getSlashLogPath(sessionId: string): string {
    return slashLogPath(sessionId);
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.agent.deleteSession(id);
  }

  async renameSession(id: string, name: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    this.agent.session.rename(id, name);
  }

  /**
   * Rename project: copy dirs to new name, update references, delete old dirs.
   *
   * Order matters on Windows:
   * 1. cwd away from old dir (releases file locks)
   * 2. Copy old dirs → new name
   * 3. Update references in new dirs
   * 4. Delete old dirs
   * 5. Update DB + session metadata
   * 6. cwd into new dir
   */
  async renameProject(newName: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');

    if (!/^[a-z0-9][a-z0-9-]*$/.test(newName)) {
      this.emitText('Invalid project name. Use lowercase letters, digits, and hyphens only (e.g. "my-project").\n');
      return;
    }

    const plan = this.agent.currentPlan;
    if (!plan || !plan.projectName) {
      this.emitText('No active project to rename. Use /plan first.\n');
      return;
    }

    const oldName = plan.projectName;
    if (oldName === newName) {
      this.emitText(`Project is already named "${oldName}".\n`);
      return;
    }

    const nexusDir = join(homedir(), '.nexus', 'tasks');
    const outputsDir = join(nexusDir, 'outputs');
    const projectDir = join(nexusDir, 'project');
    const oldOutputsPath = join(outputsDir, oldName);
    const newOutputsPath = join(outputsDir, newName);
    const oldProjectPath = join(projectDir, oldName);
    const newProjectPath = join(projectDir, newName);

    const errors: string[] = [];

    // 1. cwd away from old dir to release file locks
    try {
      await this.setCwd(homedir());
    } catch {}

    // 2. Copy outputs dir → new name
    if (existsSync(oldOutputsPath)) {
      try {
        const { cpSync } = await import('node:fs');
        cpSync(oldOutputsPath, newOutputsPath, { recursive: true });
      } catch (err) {
        errors.push(`copy outputs: ${(err as Error).message}`);
      }
    }

    // 3. Copy project dir → new name
    if (existsSync(oldProjectPath)) {
      try {
        const { cpSync } = await import('node:fs');
        cpSync(oldProjectPath, newProjectPath, { recursive: true });
      } catch (err) {
        errors.push(`copy project: ${(err as Error).message}`);
      }
    }

    // 4. Update graph.json in NEW project dir
    try {
      const graphPath = join(newProjectPath, 'graph.json');
      if (existsSync(graphPath)) {
        const graphContent = readFileSync(graphPath, 'utf-8');
        const graph = JSON.parse(graphContent);
        graph.projectName = newName;
        writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf-8');
      }
    } catch (err) {
      errors.push(`graph.json: ${(err as Error).message}`);
    }

    // 5. Update REQUIREMENTS.md in NEW project dir
    try {
      const reqPath = join(newProjectPath, 'REQUIREMENTS.md');
      if (existsSync(reqPath)) {
        let content = readFileSync(reqPath, 'utf-8');
        content = content.replace(
          new RegExp(`\\*\\*Project\\*\\*:\\s*${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          `**Project**: ${newName}`
        );
        writeFileSync(reqPath, content, 'utf-8');
      }
    } catch (err) {
      errors.push(`REQUIREMENTS.md: ${(err as Error).message}`);
    }

    // 6. Update .task-complete.json in NEW outputs dir
    try {
      const tcPath = join(newOutputsPath, '.task-complete.json');
      if (existsSync(tcPath)) {
        const tcContent = readFileSync(tcPath, 'utf-8');
        const tc = JSON.parse(tcContent);
        tc.projectName = newName;
        writeFileSync(tcPath, JSON.stringify(tc, null, 2), 'utf-8');
      }
    } catch (err) {
      errors.push(`.task-complete.json: ${(err as Error).message}`);
    }

    // 7. Delete old dirs
    try {
      const { rmSync } = await import('node:fs');
      if (existsSync(oldOutputsPath)) rmSync(oldOutputsPath, { recursive: true, force: true });
    } catch (err) {
      errors.push(`delete old outputs: ${(err as Error).message}`);
    }
    try {
      const { rmSync } = await import('node:fs');
      if (existsSync(oldProjectPath)) rmSync(oldProjectPath, { recursive: true, force: true });
    } catch (err) {
      errors.push(`delete old project: ${(err as Error).message}`);
    }

    // 8. Update task_graphs.project_name in SQLite
    try {
      if (plan.id) {
        updateTaskGraphProjectName(plan.id, newName);
      }
    } catch (err) {
      errors.push(`task_graphs DB: ${(err as Error).message}`);
    }

    // 9. Update in-memory plan
    plan.projectName = newName;
    plan.updatedAt = Date.now();

    // 10. Update session metadata + cwd into new dir
    const sid = this.agent.getCurrentSessionId?.();
    if (sid) {
      try {
        this.setSessionMetadata(sid, { projectDir: newOutputsPath });
        await this.setCwd(newOutputsPath);
        this.agent?.setProjectLocation?.(newOutputsPath, { projectDir: newOutputsPath });
        this.onEvent?.({ type: 'cwdChanged', cwd: newOutputsPath, sessionId: sid });
      } catch (err) {
        errors.push(`session metadata: ${(err as Error).message}`);
      }
    }

    if (errors.length > 0) {
      this.emitText(`Project renamed to "${newName}" with some warnings:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    } else {
      this.emitText(`Project renamed: "${oldName}" → "${newName}"\n`);
    }
  }

  async switchProvider(name: string): Promise<void> {
    if (!this.agent) throw new Error('Agent not initialized');
    await this.agent.switchProvider(name);
  }

  async switchModel(modelId: string): Promise<string> {
    if (!this.agent) throw new Error('Agent not initialized');
    return this.agent.switchModel(modelId);
  }

  /**
   * Per-session provider switch. Like the core `switchProvider`, but applies
   * the provider IN-MEMORY ONLY (reassigns `this.provider` + context) and
   * never writes to the shared global config.json. Safe for a session worker
   * that must not pollute other tabs/sessions.
   */
  async setProviderOverride(name: string, model?: string): Promise<{ provider: string; model: string }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const cfg: Config = this.agent.config.get();
    const providerCfg = cfg.providers?.[name];
    if (!providerCfg) throw new Error(`Provider "${name}" not configured`);
    const resolvedModel = model || providerCfg.model;
    const providerConfig = this.agent.config.getProvider(name);
    const p = createProvider(
      providerConfig.type,
      providerConfig.apiKey,
      resolvedModel,
      providerConfig.baseUrl,
      providerConfig.options,
      name,
      providerConfig.depth,
    );
    this.agent.provider = p;
    this.agent.context?.setProvider(p);
    const newLimit = this.agent.config.getModelContextLimit(resolvedModel);
    this.agent.context?.setMaxContextTokens(newLimit);
    this.overrideName = name;
    this.overrideModel = resolvedModel;
    return { provider: name, model: resolvedModel };
  }

  /**
   * Per-session model switch. Rebuilds the current provider with a new model
   * IN-MEMORY ONLY — never writes to the shared global config.json.
   */
  async setModelOverride(modelId: string): Promise<{ provider: string; model: string }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const cfg: Config = this.agent.config.get();
    const providerName = this.overrideName || cfg.activeProvider;
    const providerCfg = cfg.providers?.[providerName];
    if (!providerCfg) throw new Error(`Provider "${providerName}" not configured`);
    const providerConfig = this.agent.config.getProvider(providerName);
    const p = createProvider(
      providerConfig.type,
      providerConfig.apiKey,
      modelId,
      providerConfig.baseUrl,
      providerConfig.options,
      providerName,
      providerConfig.depth,
    );
    this.agent.provider = p;
    this.agent.context?.setProvider(p);
    const newLimit = this.agent.config.getModelContextLimit(modelId);
    this.agent.context?.setMaxContextTokens(newLimit);
    this.overrideName = providerName;
    this.overrideModel = modelId;
    return { provider: providerName, model: modelId };
  }

  /**
   * Per-session thinking-depth override (in-memory ONLY). Rebuilds the current
   * provider with the overridden depth without writing to the shared config.
   */
  async setDepthOverride(level: string): Promise<{ depth: string }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const cfg: Config = this.agent.config.get();
    const providerName = this.overrideName || cfg.activeProvider;
    const providerConfig = this.agent.config.getProvider(providerName);
    const depth = level || this.overrideDepth || providerConfig.depth || 'off';
    const p = createProvider(
      providerConfig.type,
      providerConfig.apiKey,
      this.overrideModel || providerConfig.model,
      providerConfig.baseUrl,
      providerConfig.options,
      providerName,
      depth as Parameters<typeof createProvider>[6],
    );
    this.agent.provider = p;
    this.agent.context?.setProvider(p);
    const newLimit = this.agent.config.getModelContextLimit(this.overrideModel || providerConfig.model);
    this.agent.context?.setMaxContextTokens(newLimit);
    this.overrideDepth = depth;
    return { depth };
  }

  getActiveDepth(): string {
    return this.overrideDepth || this.agent?.getCurrentDepth?.() || 'off';
  }

  /**
   * Per-session permissions-mode override (in-memory ONLY). Uses the core's
   * setPermissionsInMemory so it never touches the shared config.json.
   */
  async setPermissionsOverride(mode: string): Promise<{ mode: string }> {
    if (!this.agent) throw new Error('Agent not initialized');
    const valid = ['prompt', 'auto', 'unattended'];
    if (!valid.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
    this.agent.config.setPermissionsInMemory({ mode: mode as 'auto' | 'prompt' | 'unattended' });
    this.overrideMode = mode;
    return { mode };
  }

  getActiveMode(): string {
    return this.overrideMode || this.agent?.config?.getPermissions?.()?.mode || 'prompt';
  }

  async setCwd(cwd: string): Promise<void> {
    if (!cwd) return;
    try {
      if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    } catch {}
    process.chdir(cwd);
    this.onLog?.('info', `Project directory set to ${cwd}`);
  }

  /**
   * Finish the "implicit /setdir" after /go: executePlan() has already stamped
   * session metadata.projectDir with the plan sandbox (~/.nexus/tasks/outputs/<name>),
   * but the worker cwd, the agent's own project state and the UI are untouched.
   * Only act when the bound dir differs from the worker's live cwd (so a session
   * whose projectDir was never set — the /plan case — binds once, and repeats
   * are no-ops). Mirrors the /setdir side effects: chdir, setProjectLocation,
   * persist a redundant-but-consistent metadata write, then emit cwdChanged so
   * the renderer refreshes the right-side project row AND the open-project label.
   */
  private async applyPlanProjectDir(sessionId: string): Promise<void> {
    if (!this.agent) return;
    const meta = this.getSessionMetadata(sessionId);
    const projectDir = typeof meta.projectDir === 'string' && meta.projectDir ? meta.projectDir : undefined;
    if (!projectDir) return;
    // Only re-bind when the worker is not already sitting in that dir.
    let liveCwd: string;
    try {
      liveCwd = process.cwd();
    } catch {
      liveCwd = '';
    }
    if (liveCwd === projectDir) return;
    try {
      await this.setCwd(projectDir);
      this.agent?.setProjectLocation?.(projectDir, { projectDir });
    } catch (err) {
      this.onLog?.('warn', `applyPlanProjectDir chdir failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.setSessionMetadata(sessionId, { projectDir });
    } catch {}
    this.onEvent?.({ type: 'cwdChanged', cwd: projectDir, sessionId });
    this.onLog?.('info', `Implicit setdir after /go: ${projectDir}`);
  }

  getCwd(): string {
    return process.cwd();
  }

  getDefaultProjectDir(): string {
    const dir = join(homedir(), '.nexus', 'tasks');
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {}
    return dir;
  }

  getSessionMetadata(sessionId: string): Record<string, unknown> {
    if (!this.agent?.session) return {};
    return this.agent.session.get(sessionId)?.metadata ?? {};
  }

  setSessionMetadata(sessionId: string, metadata: Record<string, unknown>): void {
    if (!this.agent?.session) return;
    this.agent.session.updateMetadata(sessionId, metadata);
  }

  getProviders(): ProviderInfo[] {
    if (!this.agent) return [];
    const cfg = this.agent.config.get();
    const active = cfg.activeProvider;
    return Object.entries(cfg.providers ?? {}).map(([name, p]: [string, ProviderConfig]) => ({
      name,
      type: p.type,
      model: p.model,
      baseUrl: p.baseUrl,
      hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    }));
  }

  getActiveProvider(): string {
    return this.overrideName || this.agent?.config?.getActiveProvider?.() || '';
  }

  getActiveModel(): string {
    return this.overrideModel || this.agent?.provider?.model || '';
  }

  /**
   * Resolve the declared capability for the active model (modelCapabilities
   * map in config.json). Backs the compression-warning upgrade (P0, §5.3).
   */
  getModelCapabilityForActive() {
    try {
      return getModelCapability(readModelCapabilities(this.getConfig()), this.getActiveModel());
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the declared context limit for the active model. Returns the
   * declared value from modelCapabilities (preferred), legacy modelContextLimits,
   * or undefined when unknown. Used by getStatus → renderer context gauge (§5.3).
   */
  getActiveContextLimit(): number | undefined {
    try {
      const cfg = this.getConfig();
      const caps = readModelCapabilities(cfg);
      const legacy = (cfg as any)?.modelContextLimits as Record<string, number> | undefined;
      return resolveContextLimit(caps, this.getActiveModel(), legacy);
    } catch {
      return undefined;
    }
  }

  /**
  /** Live context usage + tokens/sec for the §G1 sidebar gauge. Samples the
   *  SAME live `agent.context.getTokenCount()` the service already polls for
   *  compression (zero added I/O, zero prompts, unattended-safe) and the
   *  active model's context limit; keeps a bounded in-memory rolling window
   *  of {t, used} samples so the gauge shows a truthful fill % plus a genuine
   *  streaming TPS (tokens/sec growth while a turn streams; ~0 when idle). */
  getContextUsage(): { used: number; limit: number | undefined; pct: number; tps: number } {
    let used = 0;
    try {
      used = this.agent?.context?.getTokenCount?.() ?? 0;
    } catch {
      used = 0;
    }
    const limit = this.getActiveContextLimit();
    const now = Date.now();
    const ROLLING_MS = 30_000;
    this.ctxSamples.push({ t: now, used });
    while (this.ctxSamples.length && now - this.ctxSamples[0].t > ROLLING_MS) this.ctxSamples.shift();
    if (this.ctxSamples.length > 512) this.ctxSamples.splice(0, this.ctxSamples.length - 512);
    let tps = 0;
    if (this.ctxSamples.length >= 2) {
      const first = this.ctxSamples[0];
      const last = this.ctxSamples[this.ctxSamples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt > 0) tps = Math.max(0, (last.used - first.used) / dt);
    }
    const pct = limit && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    return { used, limit, pct, tps };
  }

  getSummaryCount(): number {
    return this.agent?.context?.getSummaryCount?.() ?? 0;
  }

  getSummaryThresholdTokens(): number {
    return this.agent?.context?.getSummaryThresholdTokens?.() ?? 100000;
  }

  getRateLimitStatus(): RateLimitStatus | null {
    if (!this.agent) return null;
    const providerName = this.getActiveProvider();
    const providerCfg = this.agent.config.getProvider(providerName);
    const family = inferProviderFamily(providerCfg?.baseUrl);
    return this.rateLimiter.getStatus(family, providerCfg?.baseUrl);
  }

  inferProviderFamily(baseUrl?: string): 'zhipu' | 'agnes' | 'unknown' {
    return inferProviderFamily(baseUrl);
  }

  getLastSummaryTokenCount(): number {
    return this.agent?.context?.getLastSummaryTokenCount?.() ?? 0;
  }

  getStrategyCounts(): { summarize: number; truncate: number; snapshot: number } {
    return this.agent?.context?.getStrategyCounts?.() ?? { summarize: 0, truncate: 0, snapshot: 0 };
  }

  /**
   * Fetch the model list for a provider from its API (OpenAI-compatible
   * GET /models, Anthropic GET /v1/models). Returns a structured result so the
   * caller can tell a REAL list apart from a failed probe — a failed/empty
   * probe yields `models: []` + `ok: false` (never a masqueraded single-model
   * "fallback"), so the renderer can retry instead of caching a dead list.
   */
  async getModels(providerName?: string): Promise<{ models: string[]; ok: boolean; error?: string }> {
    const out = { models: [] as string[], ok: false, error: undefined as string | undefined };
    if (!this.agent) return out;
    let provider: { type: string; apiKey?: string; baseUrl?: string; model?: string } | undefined;
    try {
      provider = this.agent.config.getProvider(providerName);
    } catch {
      provider = undefined;
    }
    if (!provider || typeof provider.apiKey !== 'string' || provider.apiKey.length === 0) {
      out.error = providerName ? `provider "${providerName}" has no API key` : 'no provider';
      return out;
    }
    // getProvider() returns an in-memory encrypted blob (mem:/enc:). Decrypt it
    // to the real key — sending the blob as the Bearer token yields 401 even
    // though the stored key is valid (createProvider does the same).
    let apiKey: string;
    try {
      const { decryptApiKey } = await import('nexus-coder/dist/src/security/env-key-encrypt.js');
      apiKey = decryptApiKey(provider.apiKey);
    } catch {
      apiKey = provider.apiKey;
    }
    if (!apiKey) {
      out.error = `provider "${providerName}" has no usable API key`;
      return out;
    }
    const type = provider.type || 'openai';
    const base = (provider.baseUrl || (type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
    // Probe every plausible /models URL shape: a custom baseUrl may omit the
    // standard /v1 prefix (then /models 404s while chat still works).
    const candidates =
      type === 'anthropic'
        ? [`${base}/v1/models`]
        : base.endsWith('/v1')
          ? [`${base}/models`]
          : [`${base}/models`, `${base}/v1/models`, 'https://api.openai.com/v1/models'];
    let ids: string[] = [];
    let lastErr: Error | undefined;
    for (const url of [...new Set(candidates)]) {
      try {
        const res = await fetch(url, {
          headers:
            type === 'anthropic'
              ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
              : { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: Array<{ id: string }> };
        ids = (json?.data ?? []).map((m) => m.id).filter(Boolean);
        if (ids.length > 0) break;
        lastErr = new Error('empty model list');
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (ids.length === 0) {
      // 智谱等 provider：/models API 不返回免费模型，尝试从外置 YAML 补充
      if (providerName) {
        try {
          const yamlPath = join(homedir(), '.nexus', 'provider-models.yaml');
          if (existsSync(yamlPath)) {
            const raw = readFileSync(yamlPath, 'utf-8');
            const yaml = await import('js-yaml');
            const cfg = yaml.load(raw) as Record<string, unknown> | undefined;
            const pCfg = ((cfg?.providers as Record<string, Record<string, string[]>>) ?? {})[providerName] ?? {};
            const free = (pCfg.freeModels ?? []).map((m: string) => m.trim().toLowerCase()).filter(Boolean);
            const priority = (pCfg.priorityModels ?? []).map((m: string) => m.trim().toLowerCase()).filter(Boolean);
            if (free.length || priority.length) {
              const merged = [...new Set([...free, ...priority])];
              out.models = merged;
              out.ok = true;
              (out as any).separatorIndex = merged.length;
              return out;
            }
          }
        } catch {}
      }
      out.error = lastErr?.message ?? 'models endpoint unreachable';
      return out;
    }
    // 有 providerName 时合并外置 YAML 中的 free/priority 模型（免费置顶）
    if (providerName) {
      try {
        const yamlPath = join(homedir(), '.nexus', 'provider-models.yaml');
        if (existsSync(yamlPath)) {
          const raw = readFileSync(yamlPath, 'utf-8');
          const yaml = await import('js-yaml');
          const cfg = yaml.load(raw) as Record<string, unknown> | undefined;
          const pCfg = ((cfg?.providers as Record<string, Record<string, string[]>>) ?? {})[providerName] ?? {};
          const free = (pCfg.freeModels ?? []).map((m: string) => m.trim().toLowerCase()).filter(Boolean);
          const priority = (pCfg.priorityModels ?? []).map((m: string) => m.trim().toLowerCase()).filter(Boolean);
          if (free.length || priority.length) {
            const merged = [...new Set([...free, ...priority, ...ids])];
            const freeSet = new Set(free);
            const prioritySet = new Set(priority);
            const sorted = [
              ...merged.filter(m => freeSet.has(m)),
              ...merged.filter(m => prioritySet.has(m) && !freeSet.has(m)),
              ...merged.filter(m => !freeSet.has(m) && !prioritySet.has(m)),
            ];
            out.models = sorted;
            out.ok = true;
            (out as any).separatorIndex = free.length + priority.filter(m => !freeSet.has(m)).length;
            return out;
          }
        }
      } catch {}
    }
    out.models = ids;
    out.ok = true;
    return out;
  }

  getPermissions(): {
    mode: string;
    allowlist: string[];
    safePaths: string[];
    mcpAllowlist: string[];
    safetyRules?: {
      dbDeletion?: string;
      iterativeDelete?: string;
      batchWriteLimit?: number;
      requireGitCheckpoint?: boolean;
      autoCheckpoint?: boolean;
    };
  } {
    if (!this.agent?.config?.getPermissions) {
      return { mode: 'prompt', allowlist: [], safePaths: [], mcpAllowlist: [], safetyRules: {} };
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
    // 热应用 contextWindow 压缩参数变更（Web 面板保存后即时生效）
    this.agent.applyContextWindow?.();
    return { ok: true };
  }

  /** Speech (STT/TTS) + vision provider config with masked keys and active selection. */
  getSpeechVisionConfig(): Record<string, unknown> {
    if (!this.agent?.config) return {};
    const cfg = this.agent.config;
    const speech: Array<Record<string, unknown>> = Object.entries(
      (cfg.getSpeechProviders?.() ?? {}) as Record<string, Record<string, unknown>>,
    ).map(([name, p]) => ({
      name,
      category: p.category ?? 'stt',
      model: p.model ?? '',
      baseUrl: p.baseUrl ?? '',
      voice: p.voice ?? '',
      hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    }));
    const vision: Array<Record<string, unknown>> = Object.entries(
      (cfg.getVisionProviders?.() ?? {}) as Record<string, Record<string, unknown>>,
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
    const cfg = this.agent.config;
    const existing = (cfg.getSpeechProviders?.()?.[name] ?? {}) as Record<string, unknown>;
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
    cfg.setSpeechProvider(name, next as Parameters<typeof cfg.setSpeechProvider>[1]);
  }

  saveVisionProvider(name: string, fields: { apiKey?: string; model?: string; baseUrl?: string }): void {
    if (!this.agent?.config) throw new Error('Agent not initialized');
    const cfg = this.agent.config;
    const existing = (cfg.getVisionProviders?.()?.[name] ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl !== undefined ? fields.baseUrl : existing.baseUrl ?? '',
      model: fields.model !== undefined && fields.model !== '' ? fields.model : existing.model ?? '',
    };
    if (fields.apiKey && fields.apiKey !== KEY_MASK) {
      next.apiKey = fields.apiKey;
    }
    cfg.setVisionProvider(name, next as Parameters<typeof cfg.setVisionProvider>[1]);
  }

  /** Cumulative token estimate for a session. Incremental: after the first full
   *  scan only new rows are tokenized (provider change invalidates the cache
   *  via the provider/model cache key). Falls back to the core's char/4
   *  heuristic when the active provider has no countTokens. */
  async getSessionStats(sessionId: string): Promise<{ tokenEstimate: number; messageCount: number }> {
    if (!this.agent?.session) return { tokenEstimate: 0, messageCount: 0 };
    const { estimateSessionTokensCached } = await loadSessionDb();
    const provider = this.agent.provider;
    const cacheKey = provider ? `${provider.name}/${provider.model}` : 'fallback';
    return estimateSessionTokensCached(sessionId, cacheKey, this.sessionTokenEstimator(provider), 500);
  }

  /** Build the per-session token estimator matching the active provider (or the
   *  char/4 fallback). Shared by getSessionStats and recordContextClearBaseline
   *  so a `/clear` snapshot is taken with the exact same estimator/cache key. */
  private sessionTokenEstimator(
    provider: { countTokens?: (s: string) => number; name?: string; model?: string } | undefined,
  ): (content: string, thinking?: string) => number {
    return (content, thinking) => {
      const count = (s: string): number => (provider?.countTokens ? provider.countTokens(s) : Math.ceil(s.length / 4)) || 0;
      return count(content ?? '') + (thinking ? count(thinking) : 0);
    };
  }

  /** Snapshot the running token totals right after `/clear` so the side panel
   *  restarts from ~0. Rows are deleted by deleteAllSessionMessages below, but
   *  the baseline is recorded BEFORE deletion so the cache key (which includes
   *  the pre-delete MAX(id)) remains valid; once rows vanish the raw counter
   *  drops to 0 and max(0, 0 − snapshot) = 0. */
  private async recordContextClearBaseline(sessionId: string): Promise<void> {
    try {
      const { recordTokenBaseline } = await loadSessionDb();
      const provider = this.agent?.provider;
      const cacheKey = provider ? `${provider.name}/${provider.model}` : 'fallback';
      recordTokenBaseline(sessionId, cacheKey, this.sessionTokenEstimator(provider), 500);
      this.onEvent?.({ type: 'context_cleared', sessionId });
    } catch (err) {
      this.onLog?.('warn', `Token baseline record failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getConfig(): Record<string, unknown> {
    if (!this.agent) return {};
    const cfg = this.agent.config.get();
    return redactConfig(cfg);
  }

  saveProvider(
    name: string,
    fields: { type?: string; apiKey?: string; model?: string; baseUrl?: string; options?: Record<string, unknown> },
  ): void {
    if (!this.agent) throw new Error('Agent not initialized');
    const cfg = this.agent.config;
    const cur = cfg.get();
    const existing = cur.providers?.[name] ?? {};
    const next: Record<string, unknown> = {
      type: fields.type ?? existing.type ?? 'openai',
      model: fields.model ?? existing.model ?? '',
      apiKey: existing.apiKey ?? '',
      baseUrl: fields.baseUrl ?? existing.baseUrl,
      options: fields.options ?? existing.options ?? {},
    };
    if (fields.apiKey && fields.apiKey !== KEY_MASK) {
      next.apiKey = fields.apiKey;
    }
    cfg.setProvider(name, next as Parameters<typeof cfg.setProvider>[1]);
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