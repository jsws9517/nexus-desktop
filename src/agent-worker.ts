import readline from 'node:readline';
import { AgentService } from './agent-service.js';
import type { AgentEvent } from './agent-service.js';
import { logger } from './shared/logger.js';
import { EARLY_METHODS } from './shared/constants.js';
import { validateWorkerParams } from './shared/ipc-validation.js';
import type { WorkerMethod } from './ipc/channels.js';

type WorkerRequest =
  | { id: number; method: 'earlyInit'; params?: { cwd?: string } }
  | { id: number; method: 'init'; params?: { cwd?: string; deferMcp?: boolean } }
  | { id: number; method: 'chat'; params: { input: string } }
  | { id: number; method: 'sideChat'; params: { messages: Array<{ role: string; content: string }> } }
  | { id: number; method: 'regenerate'; params: { sessionId: string; userIndex: number } }
  | { id: number; method: 'withdraw'; params: { sessionId: string; userIndex: number } }
  | { id: number; method: 'abort' }
  | { id: number; method: 'startSession'; params?: { name?: string; sessionId?: string; metadata?: Record<string, unknown>; prevSessionId?: string } }
  | { id: number; method: 'prepareParentMemory' }
  | { id: number; method: 'listSessions'; params?: { limit?: number; offset?: number; excludeMock?: boolean; excludeEmpty?: boolean } }
  | { id: number; method: 'getMessages'; params: { sessionId: string; last?: number; limit?: number; offset?: number } }
  | { id: number; method: 'getSlashLog'; params: { sessionId: string } }
  | { id: number; method: 'getSlashLogPath'; params: { sessionId: string } }
  | { id: number; method: 'deleteSession'; params: { id: string } }
  | { id: number; method: 'renameSession'; params: { id: string; name: string } }
  | { id: number; method: 'renameProject'; params: { newName: string } }
  | { id: number; method: 'getConfig' }
  | { id: number; method: 'getProviders' }
  | { id: number; method: 'getStatus' }
  | { id: number; method: 'getPermissions' }
  | { id: number; method: 'getLanguage' }
  | { id: number; method: 'reloadConfig' }
  | { id: number; method: 'getSpeechVisionConfig' }
  | { id: number; method: 'setActiveSpeechProvider'; params: { name: string } }
  | { id: number; method: 'setActiveTtsProvider'; params: { name: string } }
  | { id: number; method: 'setActiveVisionProvider'; params: { name: string } }
  | { id: number; method: 'saveSpeechProvider'; params: { name: string; fields: Record<string, unknown> } }
  | { id: number; method: 'saveVisionProvider'; params: { name: string; fields: Record<string, unknown> } }
  | { id: number; method: 'getSessionStats'; params: { sessionId: string } }
  | { id: number; method: 'switchProvider'; params: { name: string } }
  | { id: number; method: 'switchModel'; params: { modelId: string } }
  | { id: number; method: 'setProviderOverride'; params: { name: string; model?: string } }
  | { id: number; method: 'setModelOverride'; params: { modelId: string } }
  | { id: number; method: 'setDepthOverride'; params: { level: string } }
  | { id: number; method: 'getActiveDepth' }
  | { id: number; method: 'setPermissionsOverride'; params: { mode: string } }
  | { id: number; method: 'getActiveMode' }
  | { id: number; method: 'getModels'; params?: { providerName?: string } }
  | { id: number; method: 'saveProvider'; params: { name: string; fields: Record<string, unknown> } }
  | { id: number; method: 'setCwd'; params: { cwd: string } }
  | { id: number; method: 'getDefaultProjectDir' }
  | { id: number; method: 'getSessionMetadata'; params: { sessionId: string } }
  | { id: number; method: 'setSessionMetadata'; params: { sessionId: string; metadata: Record<string, unknown> } }
  | { id: number; method: 'resolvePermission'; params: { id: string; answer: string } }
  | { id: number; method: 'setMcpEnabled'; params: { enabled: boolean } }
  | { id: number; method: 'getMcpStatus' }
  | { id: number; method: 'getMcpServers' }
  | { id: number; method: 'setMcpServer'; params: { name: string; enabled: boolean } }
  | { id: number; method: 'runSubAgent'; params: { taskId: string; prompt: string; tools?: string[]; maxTurns?: number; timeoutMs?: number; constitution?: string } }
  | { id: number; method: 'getSubAgentStatus'; params: { taskId: string } }
  | { id: number; method: 'cancelSubAgent'; params: { taskId: string } }
  // bg_job lifecycle (delegate to main-process BgJobManager via post()).
  | { id: number; method: 'bgJobCreate'; params: { title: string; prompt: string; sessionId: string; maxDurationMs?: number; maxTurns?: number } }
  | { id: number; method: 'bgJobQuery'; params: { jobId: string } }
  | { id: number; method: 'bgJobList'; params?: { sessionId?: string; status?: string } }
  | { id: number; method: 'bgJobCancel'; params: { jobId: string } }
  | { id: number; method: 'bgJobRemove'; params: { jobId: string } }
  | { id: number; method: 'bgJobProgress'; params: { jobId: string; progress?: number; note?: string } }
  // core bg_ shell jobs (worker-local JobManager).
  | { id: number; method: 'coreBgList'; params?: { sessionId?: string } }
  | { id: number; method: 'coreBgKill'; params: { jobId: string; sessionId?: string } }
  | { id: number; method: 'coreBgTail'; params: { jobId: string; lines?: number; sessionId?: string } }
  | { id: number; method: 'coreBgRemove'; params: { jobId: string; sessionId?: string } }
  // acp_router: route a prompt to a named agent role.
  | { id: number; method: 'routeViaAcp'; params: { roleId: string; prompt: string; sessionId: string; background?: boolean } }
  | { id: number; method: 'shutdown' };

/** JSON-RPC transport. stdio (dev/system node) or parentPort (Electron utilityProcess). */
const useParentPort = !!(process as unknown as { parentPort?: { postMessage: (m: unknown) => void } })
  .parentPort;

function send(msg: unknown): void {
  if (useParentPort) {
    (process as unknown as { parentPort: { postMessage: (m: unknown) => void } }).parentPort.postMessage(msg);
  } else {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

function respond(id: number, data?: unknown): void {
  send({ type: 'result', id, ok: true, data });
}

function respondError(id: number, error: unknown): void {
  send({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) });
}

// Worker -> main request channel (shared MCP hub proxy). The worker issues a
// request carrying an id + op; the main process's WorkerHost forwards to the
// hub and replies with { type: 'mcpResult', id, ok, data|error }.
type McpOp = 'getTools' | 'callTool' | 'status' | 'servers' | 'setServer' | 'setEnabled';
let mcpNextId = 1e9;
const mcpPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function sendMcp(op: McpOp, params?: Record<string, unknown>): Promise<unknown> {
  const id = mcpNextId++;
  send({ type: 'mcpRequest', id, op, data: params ?? {} });
  return new Promise((resolve, reject) => {
    mcpPending.set(id, { resolve, reject });
  });
}

function resolveMcpResult(msg: {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
}): void {
  if (msg.id == null) return;
  const p = mcpPending.get(msg.id);
  if (!p) return;
  mcpPending.delete(msg.id);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error || 'MCP proxy request failed'));
}

// Worker → main bg_job request channel. The worker cannot access BgJobManager
// directly (it lives in main), so it posts a 'bgJobRequest' that the main
// process's WorkerHost forwards to BgJobManager and replies with 'bgJobResult'.
type BgJobOp = 'create' | 'query' | 'list' | 'cancel' | 'remove' | 'progress';
let bgJobNextId = 2e9;
const bgJobPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function sendBgJobRequest(op: BgJobOp, params?: Record<string, unknown>): Promise<unknown> {
  const id = bgJobNextId++;
  send({ type: 'bgJobRequest', id, op, data: params ?? {} });
  return new Promise((resolve, reject) => {
    bgJobPending.set(id, { resolve, reject });
  });
}

function resolveBgJobResult(msg: {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
}): void {
  if (msg.id == null) return;
  const p = bgJobPending.get(msg.id);
  if (!p) return;
  bgJobPending.delete(msg.id);
  if (msg.ok) p.resolve(msg.data);
  else p.reject(new Error(msg.error || 'bg_job request failed'));
}

const service = new AgentService();
service.onEvent = (event: AgentEvent) => send({ type: 'event', event });
service.onPermission = (req) => { tracePerm(`askPermission id=${req.id}`); send({ type: 'permission', ...req }); };
service.onLog = (level, message) => send({ type: 'log', level, message });
service.onRateLimitReport = (data) => send({ type: 'rateLimitReport', data });
// Forward MCP tool discovery + calls to the shared main-process hub (single
// owner, one OS process per server �?no per-tab shadow MCP processes).
service.onMcpRequest = (op, params) =>
  sendMcp(op as McpOp, params).catch((e) => {
    logger.debug(`mcp proxy "${op}" failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  });

// The main process un-gates renderer requests after a timeout even when the
// core is still initializing (init can stall on network fetches), so requests
// can reach the worker while service.init() is still running.
//
// Startup is split into two phases:
//   earlyInit �?constructs the Agent (config/session/provider), fast.
//   init      �?MCP connect + skills load, slow.
// Sub-agent state tracking
const subAgentStates = new Map<string, { status: string; startTime: number }>();

// Read-only session/config methods only need phase 1 and must NOT wait for
// phase 2; mutations (chat, MCP toggles, ...) wait on the full init promise.
// Full serialization is NOT an option: abort() must stay able to run
// concurrently with an in-flight chat().
let earlyPromise: Promise<void> | null = null;
let earlyDone = false;
let initPromise: Promise<void> | null = null;
let initDone = false;

// EARLY_METHODS imported from src/shared/constants.ts (single source).

function writeDiag(data: unknown): void {
  logger.debug(`init-diag ${JSON.stringify(data)}`);
}
function tracePerm(msg: string): void {
  logger.debug(`perm ${msg}`);
}

// Single dispatch table replacing the historic switch. Each handler mirrors its
// old case body 1:1: it returns the value to respond with (or throws), and the
// dispatcher in handleRequest performs the actual respond/respondError. earlyInit
// stays on its own fast path (handled before dispatch).
type DispatchMethod = Exclude<WorkerMethod, 'earlyInit'>;
// Uniform handler signature: `req` is cast at the single dispatch site. Each
// literal entry re-narrows it (WorkerRequest & { method: 'X' }) so bodies keep
// full param typing without paying a giant per-key union at lookup time.
type DispatchHandler = (req: never) => unknown;
const HANDLERS: Record<DispatchMethod, DispatchHandler> = {
  init: async (req: WorkerRequest & { method: 'init' }) => {
    const t0 = Date.now();
    try {
      initPromise = service.init(req.params?.cwd, { deferMcp: req.params?.deferMcp });
      await initPromise;
      initDone = true;
      writeDiag({ ok: true, ms: Date.now() - t0, cwd: service.getCwd() });
      return { ok: true, cwd: service.getCwd() };
    } catch (e) {
      initDone = false;
      writeDiag({ ok: false, ms: -1, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
      throw e;
    }
  },
  chat: async (req: WorkerRequest & { method: 'chat' }) => {
    await service.chat(req.params.input);
  },
  sideChat: async (req: WorkerRequest & { method: 'sideChat' }) => {
    // Isolated scratch conversation: a fresh AgentService per request, seeded
    // with the renderer-held transcript. It never touches the session store,
    // the main worker's context, or its busy state �?side chat stays usable
    // while the real session is mid-turn and can never pollute it.
    //
    // Unlike the previous callLlm() path (which was a bare provider.complete()
    // with zero tools), we now call init() so the full tool system (skills,
    // MCP proxy, builtin tools) is wired up, then run through the normal
    // agent.chat() loop so tool calls are actually executed.
    const messages = req.params.messages.map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }));
    const tempService = new AgentService();
    await tempService.init();
    // Wire an event collector so we can extract the final assistant text
    // without forwarding events to the main UI (side chat is isolated).
    const collected: string[] = [];
    const prevOnEvent = tempService['onEvent'];
    (tempService as any)['onEvent'] = (event: unknown) => {
      if (event && typeof event === 'object' && (event as { type: string }).type === 'text') {
        const text = (event as { text: string }).text;
        if (text) collected.push(text);
      }
    };
    try {
      // Run the full chat turn with the last user message; the pre-built
      // transcript is held by the renderer and replayed each request.
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      const input = lastUserMsg ? lastUserMsg.content : '';
      await tempService.chat(input);
    } finally {
      (tempService as any)['onEvent'] = prevOnEvent;
    }
    const reply = collected.join('');
    return { reply };
  },
  regenerate: async (req: WorkerRequest & { method: 'regenerate' }) => {
    await service.regenerate(req.params.sessionId, req.params.userIndex);
  },
  withdraw: async (req: WorkerRequest & { method: 'withdraw' }) => service.withdraw(req.params.sessionId, req.params.userIndex),
  abort: () => {
    service.abort();
  },
  startSession: async (req: WorkerRequest & { method: 'startSession' }) => service.startSession(req.params?.name, req.params?.sessionId, req.params?.metadata, req.params?.prevSessionId),
  prepareParentMemory: () => service.prepareParentMemory(),
  listSessions: (req: WorkerRequest & { method: 'listSessions' }) => service.listSessions(req.params ?? {}),
  getMessages: (req: WorkerRequest & { method: 'getMessages' }) => service.getMessages(req.params.sessionId, req.params),
  getSlashLog: (req: WorkerRequest & { method: 'getSlashLog' }) => service.getSlashLog(req.params.sessionId),
  getSlashLogPath: (req: WorkerRequest & { method: 'getSlashLogPath' }) => service.getSlashLogPath(req.params.sessionId),
  deleteSession: async (req: WorkerRequest & { method: 'deleteSession' }) => {
    await service.deleteSession(req.params.id);
  },
  renameSession: async (req: WorkerRequest & { method: 'renameSession' }) => {
    await service.renameSession(req.params.id, req.params.name);
  },
  renameProject: async (req: WorkerRequest & { method: 'renameProject' }) => {
    await service.renameProject(req.params.newName);
  },
  getConfig: () => service.getConfig(),
  getProviders: () => service.getProviders(),
  getStatus: () => ({
    cwd: service.getCwd(),
    busy: service.busy,
    provider: service.getActiveProvider(),
    model: service.getActiveModel(),
    contextLimit: service.getActiveContextLimit(),
    contextUsage: service.getContextUsage(),
    summaryCount: service.getSummaryCount() ?? 0,
    summaryThreshold: service.getSummaryThresholdTokens() ?? 100000,
    lastSummaryTokens: service.getLastSummaryTokenCount() ?? 0,
    strategyCounts: service.getStrategyCounts(),
    rateLimit: service.getRateLimitStatus(),
  }),
  getPermissions: () => service.getPermissions(),
  getLanguage: () => service.getLanguage(),
  reloadConfig: () => service.reloadConfig(),
  getSpeechVisionConfig: () => service.getSpeechVisionConfig(),
  setActiveSpeechProvider: (req: WorkerRequest & { method: 'setActiveSpeechProvider' }) => {
    service.setActiveSpeechProvider(req.params.name);
  },
  setActiveTtsProvider: (req: WorkerRequest & { method: 'setActiveTtsProvider' }) => {
    service.setActiveTtsProvider(req.params.name);
  },
  setActiveVisionProvider: (req: WorkerRequest & { method: 'setActiveVisionProvider' }) => {
    service.setActiveVisionProvider(req.params.name);
  },
  saveSpeechProvider: (req: WorkerRequest & { method: 'saveSpeechProvider' }) => {
    service.saveSpeechProvider(req.params.name, req.params.fields);
  },
  saveVisionProvider: (req: WorkerRequest & { method: 'saveVisionProvider' }) => {
    service.saveVisionProvider(req.params.name, req.params.fields);
  },
  getSessionStats: (req: WorkerRequest & { method: 'getSessionStats' }) => service.getSessionStats(req.params.sessionId),
  switchProvider: async (req: WorkerRequest & { method: 'switchProvider' }) => {
    await service.switchProvider(req.params.name);
  },
  switchModel: (req: WorkerRequest & { method: 'switchModel' }) => service.switchModel(req.params.modelId),
  setProviderOverride: (req: WorkerRequest & { method: 'setProviderOverride' }) => service.setProviderOverride(req.params.name, req.params.model),
  setModelOverride: (req: WorkerRequest & { method: 'setModelOverride' }) => service.setModelOverride(req.params.modelId),
  setDepthOverride: (req: WorkerRequest & { method: 'setDepthOverride' }) => service.setDepthOverride(req.params.level),
  getActiveDepth: () => service.getActiveDepth(),
  setPermissionsOverride: (req: WorkerRequest & { method: 'setPermissionsOverride' }) => service.setPermissionsOverride(req.params.mode),
  getActiveMode: () => service.getActiveMode(),
  getModels: (req: WorkerRequest & { method: 'getModels' }) => service.getModels(req.params?.providerName),
  saveProvider: (req: WorkerRequest & { method: 'saveProvider' }) => {
    service.saveProvider(req.params.name, req.params.fields);
  },
  setCwd: async (req: WorkerRequest & { method: 'setCwd' }) => {
    await service.setCwd(req.params.cwd);
    return { cwd: service.getCwd() };
  },
  getDefaultProjectDir: () => ({ dir: service.getDefaultProjectDir() }),
  getSessionMetadata: (req: WorkerRequest & { method: 'getSessionMetadata' }) => service.getSessionMetadata(req.params.sessionId),
  setSessionMetadata: (req: WorkerRequest & { method: 'setSessionMetadata' }) => {
    service.setSessionMetadata(req.params.sessionId, req.params.metadata);
  },
  resolvePermission: async (req: WorkerRequest & { method: 'resolvePermission' }) => {
    tracePerm(`resolvePermission id=${req.params.id} answer=${req.params.answer}`);
    await service.resolvePermission(req.params.id, req.params.answer);
  },
  setMcpEnabled: (req: WorkerRequest & { method: 'setMcpEnabled' }) => service.setMcpEnabled(req.params.enabled),
  getMcpStatus: () => service.getMcpStatus(),
  getMcpServers: () => service.getMcpServers(),
  setMcpServer: (req: WorkerRequest & { method: 'setMcpServer' }) => service.setMcpServer(req.params.name, req.params.enabled),
  // DEAD (2026-09-26): only `SubAgentExecutor` requests `runSubAgent`, and that
  // class is unreachable (src/main/index.ts `handleParallelRequest` has no call
  // site); `nexus:runSubAgent` has neither an ipcMain handler nor a preload
  // export. Real sub-agent runs go through core `SubAgentWorker` (nexus-coder).
  // See docs/module-map-panels-and-runs.md §3.
  runSubAgent: async (req: WorkerRequest & { method: 'runSubAgent' }) => {
    const { taskId, prompt, tools, maxTurns, timeoutMs, constitution } = req.params;
    subAgentStates.set(taskId, { status: 'running', startTime: Date.now() });
    
    try {
      const tempService = new AgentService();
      await tempService.earlyInit();
      
      // Constitution inheritance (§3.7): the Orchestrator passes the text
      // explicitly; the worker performs NO filesystem discovery for it.
      if (typeof constitution === 'string') {
        tempService.setConstitutionOverride(constitution.length > 0 ? constitution : null);
      }
      
      if (tools && tools.length > 0) {
        tempService.setToolAllowlist(new Set(tools));
      }
      
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Task ${taskId} timed out`)), timeoutMs ?? 60000)
      );
      
      const usage = await Promise.race([
        tempService.chatForUsage(prompt),
        timeoutPromise,
      ]);
      
      subAgentStates.set(taskId, { status: 'succeeded', startTime: Date.now() });
      return {
        output: `Task ${taskId} completed successfully`,
        tokenUsage: { prompt: usage.prompt, completion: usage.completion },
      };
    } catch (error) {
      subAgentStates.set(taskId, { status: 'failed', startTime: Date.now() });
      throw error;
    }
  },
  getSubAgentStatus: (req: WorkerRequest & { method: 'getSubAgentStatus' }) => {
    const state = subAgentStates.get(req.params.taskId);
    return state ?? { status: 'unknown' };
  },
  cancelSubAgent: (req: WorkerRequest & { method: 'cancelSubAgent' }) => {
    subAgentStates.set(req.params.taskId, { status: 'cancelled', startTime: Date.now() });
    return { success: true };
  },
  // bg_job lifecycle: forward to main-process BgJobManager via sendBgJobRequest.
  // The worker cannot create its own BgJobManager (it lives in main); instead
  // it posts a 'bgJobRequest' that the main process's WorkerHost forwards to
  // BgJobManager and replies with 'bgJobResult'.
  bgJobCreate: async (req: WorkerRequest & { method: 'bgJobCreate' }) => {
    const { title, prompt, sessionId, maxDurationMs, maxTurns } = req.params;
    return sendBgJobRequest('create', { title, prompt, sessionId, maxDurationMs, maxTurns });
  },
  bgJobQuery: async (req: WorkerRequest & { method: 'bgJobQuery' }) => {
    return sendBgJobRequest('query', { jobId: req.params.jobId });
  },
  bgJobList: async (req: WorkerRequest & { method: 'bgJobList' }) => {
    return sendBgJobRequest('list', req.params);
  },
  bgJobCancel: async (req: WorkerRequest & { method: 'bgJobCancel' }) => {
    return sendBgJobRequest('cancel', { jobId: req.params.jobId });
  },
  bgJobRemove: async (req: WorkerRequest & { method: 'bgJobRemove' }) => {
    return sendBgJobRequest('remove', { jobId: req.params.jobId });
  },
  bgJobProgress: async (req: WorkerRequest & { method: 'bgJobProgress' }) => {
    return sendBgJobRequest('progress', req.params);
  },
  // core bg_ shell jobs: hit this worker's JobManager (reconcile first so a
  // prior restart re-adopts RUNNING rows before we list/kill/tail them).
  coreBgList: async (req: WorkerRequest & { method: 'coreBgList' }) => {
    return service.listCoreBgJobs(req.params?.sessionId);
  },
  coreBgKill: async (req: WorkerRequest & { method: 'coreBgKill' }) => {
    return service.killCoreBgJob(req.params.jobId);
  },
  coreBgTail: async (req: WorkerRequest & { method: 'coreBgTail' }) => {
    return service.tailCoreBgJob(req.params.jobId, req.params.lines);
  },
  coreBgRemove: async (req: WorkerRequest & { method: 'coreBgRemove' }) => {
    return service.removeCoreBgJob(req.params.jobId);
  },
  // acp_router: resolve role config inline (read-only), then hand off via bgJobRequest
  // when background:true is requested.
  routeViaAcp: async (req: WorkerRequest & { method: 'routeViaAcp' }) => {
    const { roleId, prompt, sessionId, background } = req.params;
    // Read role config from .nexus/agents/<roleId>/SKILL.md
    const { discoverRoles } = await import('./tools/acp-router.js');
    const roles = await discoverRoles(process.cwd());
    const role = roles.find((r: { name: string }) => r.name === roleId);
    if (!role) {
      return { ok: false, error: `Role "${roleId}" not found` };
    }
    if (background) {
      // Enqueue as a persistent bg_job — survives worker crashes.
      // ⚠️ DEAD BRANCH: `BgJobManager.create()` only records `queued` and no
      // runner ever executes `prompt` (see src/main/bg-job-manager.ts header),
      // so this job would decay to `stale` after STUCK_THRESHOLD. On top of
      // that the whole `routeViaAcp` method has no caller (no ipcMain handler,
      // no preload export) — `acp_router(action=route)` only returns config.
      // See docs/module-map-panels-and-runs.md §3.
      return sendBgJobRequest('create', {
        title: `[${roleId}] ${prompt.slice(0, 80)}`,
        prompt: `[Role: ${roleId}]\n${role.systemPrompt}\n\n---\n\n${prompt}`,
        sessionId,
        toolAllowlist: role.frontmatter.tools,
        maxDurationMs: role.frontmatter.maxDurationMs,
        maxTurns: role.frontmatter.maxTurns,
        constitution: role.frontmatter.constitution,
      });
    }
    // Inline execution: spawn a temp service with the role's system prompt.
    const tempService = new AgentService();
    await tempService.earlyInit();
    if (role.frontmatter.tools?.length) {
      tempService.setToolAllowlist(new Set(role.frontmatter.tools));
    }
    if (role.frontmatter.constitution) {
      tempService.setConstitutionOverride(role.frontmatter.constitution);
    }
    // Inject the role system prompt into the temp agent.
    const { Agent } = await import('nexus-coder/dist/src/agent.js');
    try {
      const usage = await tempService.chatForUsage(prompt);
      return { ok: true, roleId, output: `Role ${roleId} completed`, tokenUsage: usage };
    } catch (e) {
      return { ok: false, roleId, error: e instanceof Error ? e.message : String(e) };
    }
  },
  shutdown: () => service.shutdown(),
};

async function handleRequest(line: string | Record<string, unknown>): Promise<void> {
  let req: WorkerRequest;
  if (typeof line === 'string') {
    if (!line.trim()) return;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
  } else {
    // utilityProcess (packaged) delivers the request object directly via parentPort.
    req = line as unknown as WorkerRequest;
    if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return;
  }
  if (req.method === 'earlyInit') {
    try {
      const t0 = Date.now();
      earlyPromise = service.earlyInit(req.params?.cwd);
      await earlyPromise;
      earlyDone = true;
      writeDiag({ early: true, ok: true, ms: Date.now() - t0, cwd: service.getCwd() });
      respond(req.id, { ok: true, cwd: service.getCwd() });
    } catch (e) {
      earlyDone = false;
      writeDiag({ early: true, ok: false, ms: -1, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
      respondError(req.id, e);
    }
    return;
  }
  // C1: validate params against the single-source spec before dispatch.
  {
    const r = req as unknown as { method: string; params?: Record<string, unknown> };
    const err = validateWorkerParams(r.method, r.params);
    if (err) {
      respondError(req.id, new Error(`invalid request: ${err}`));
      return;
    }
  }
  if (req.method === 'init' && earlyPromise !== null) {
    // Serialize init after earlyInit so the two can never double-construct the
    // Agent (service.init() reuses the Agent built by earlyInit).
    await earlyPromise.catch(() => {});
  } else if (EARLY_METHODS.has(req.method) && earlyPromise !== null && !earlyDone) {
    // Early reads only need the Agent object, not the MCP/skills phase.
    await earlyPromise.catch(() => {});
  }
  if (req.method !== 'init' && !EARLY_METHODS.has(req.method) && initPromise !== null && !initDone) {
    await initPromise.catch(() => {});
  }
  const handler = HANDLERS[req.method as DispatchMethod];
  if (!handler) {
    respondError(req.id, `Unknown method: ${(req as { method: string }).method}`);
    return;
  }
  try {
    const data = await handler(req as never);
    respond(req.id, data);
    if (req.method === 'shutdown') process.exit(0);
  } catch (e) {
    respondError(req.id, e);
  }
}

if (useParentPort) {
  const pp = (process as unknown as { parentPort: { on: (ev: 'message', cb: (e: { data: string | { type: string; id?: number; ok?: boolean; data?: unknown; error?: string } }) => void) => void } }).parentPort;
  pp.on('message', (e) => {
    const d = e.data as unknown;
    if (d && typeof d === 'object' && 'type' in d) {
      const msg = d as { type?: string; id?: number; ok?: boolean; data?: unknown; error?: string };
      if (msg.type === 'mcpResult') {
        resolveMcpResult(msg);
        return;
      }
      if (msg.type === 'bgJobResult') {
        resolveBgJobResult(msg);
        return;
      }
    }
    void handleRequest(d as string | Record<string, unknown>);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { type?: string };
      if (msg.type === 'mcpResult') {
        resolveMcpResult(msg as { id?: number; ok?: boolean; data?: unknown; error?: string });
        return;
      }
      if (msg.type === 'bgJobResult') {
        resolveBgJobResult(msg as { id?: number; ok?: boolean; data?: unknown; error?: string });
        return;
      }
    } catch { /* not JSON — fall through */ }
    void handleRequest(line);
  });
}

process.on('uncaughtException', (err) => {
  send({ type: 'log', level: 'error', message: err.stack ?? err.message });
});
