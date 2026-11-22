/**
 * Lightweight IPC parameter validation (C1).
 *
 * Worker-routed methods are validated against a single-source spec map before
 * dispatch; main-process-only handlers use the exported scalar validators.
 * Zero dependencies; failures produce a structured error message instead of
 * letting malformed input reach the core.
 */

import { ARTIFACT_TYPES } from './artifact.js';

export type FieldSpec =
  | { kind: 'string'; maxLen?: number }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'object' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'messages' }
  | { kind: 'paths' };

interface MethodSpec {
  fields: Record<string, FieldSpec>;
  optional?: readonly string[];
}

const S = {
  str: (maxLen?: number): FieldSpec => ({ kind: 'string', maxLen }),
  bool: (): FieldSpec => ({ kind: 'boolean' }),
  num: (): FieldSpec => ({ kind: 'number' }),
  obj: (): FieldSpec => ({ kind: 'object' }),
  en: (values: readonly string[]): FieldSpec => ({ kind: 'enum', values }),
  msg: (): FieldSpec => ({ kind: 'messages' }),
  paths: (): FieldSpec => ({ kind: 'paths' }),
};

export const PERMISSION_ANSWERS = ['y', 'a', 'n'] as const;
export const MAX_CHAT_INPUT = 65536;
const MAX_SIDE_CHAT_MESSAGES = 50;
/** Base64 ceiling for a captured WAV clip (120s mono 16 kHz / 16-bit ≈ 5.1 MB). */
export const MAX_VOICE_WAV_BASE64 = 7 * 1024 * 1024;

/**
 * T6 automation control-plane specs. Main-process-owned channels (no worker
 * round-trip — the store lives in the main process, see
 * src/main/automation-runner.ts). Kept OUT of WORKER_METHODS on purpose:
 * that map derives the `WorkerMethod` union, which agent-worker.ts's dispatch
 * table must fully cover. These are validated with `validateAutomationParams`
 * in the main-process handlers, and the negative-test surface uses the same
 * spec map.
 */
const AUTOMATION_METHODS: Record<string, MethodSpec> = {
  automationList: { fields: {} },
  automationUpsert: {
    fields: {
      // Omit `id` to create; provide it to update the matching row.
      id: S.str(64),
      name: S.str(200),
      enabled: S.bool(),
      schedule: S.obj(),
      prompt: S.str(65536),
      cwd: S.str(4096),
      profile: S.en(['default', 'office']),
      provider: S.str(200),
      model: S.str(500),
      missPolicy: S.en(['skip', 'catchup']),
    },
    optional: ['id', 'enabled', 'cwd', 'profile', 'provider', 'model', 'missPolicy'],
  },
  automationDelete: { fields: { id: S.str(64) } },
  automationRunNow: { fields: { id: S.str(64) } },
  automationRuns: {
    fields: { id: S.str(64), limit: S.num() },
    optional: ['id', 'limit'],
  },
};

/**
 * Main-process-only config methods (no worker round-trip). Validated with
 * `validateMainLocalParams`; kept out of WORKER_METHODS so it stays the exact
 * dispatch surface of agent-worker.ts.
 */
const MAIN_LOCAL_METHODS: Record<string, MethodSpec> = {
  updatePermissionsConfig: { fields: { permissions: S.obj() } },
  // T1-2: project-relative rule metadata for the @Rule mention source.
  // Paths are resolved main-side from the fixed rule-file whitelist; the only
  // renderer input is the current project cwd.
  listProjectRules: { fields: { cwd: S.str(4096) } },
  // T2-2: controlled git diff text. Only the cwd and a staged flag cross IPC —
  // git argv is built in the main process (src/main/git-shell.ts).
  gitDiff: { fields: { cwd: S.str(4096), staged: S.bool() }, optional: ['staged'] },
  // T2-3: worktree lifecycle. `name` is further restricted by
  // sanitizeWorktreeName() in the handler; git argv is main-side only.
  worktreeCreate: {
    fields: { cwd: S.str(4096), name: S.str(80), branch: S.str(200) },
    optional: ['branch'],
  },
  worktreeList: { fields: { cwd: S.str(4096) } },
  worktreeRemove: { fields: { cwd: S.str(4096), name: S.str(80) } },
  // T2-1: file-based custom agent roles (cwd-scoped scan).
  // `refresh` bypasses the short scan cache after an in-app edit/delete.
  listCustomAgents: { fields: { cwd: S.str(4096), refresh: S.bool() }, optional: ['refresh'] },
  // Writes go through this structured spec — the renderer never supplies a
  // filesystem path, only a validated id + a scope, so the main process can
  // resolve and contain the target itself. `tools` is a comma/newline list
  // parsed main-side (keeps the validation surface scalar-only).
  saveCustomAgent: {
    fields: {
      cwd: S.str(4096),
      scope: S.en(['user', 'project']),
      id: S.str(80),
      name: S.str(200),
      description: S.str(500),
      tools: S.str(8192),
      systemPrompt: S.str(65536),
    },
  },
  deleteCustomAgent: {
    fields: { cwd: S.str(4096), scope: S.en(['user', 'project']), id: S.str(80) },
  },
  // T2-4: cross-session artifact index. All filters are optional and applied
  // as parameterized SQL WHERE conditions in the main process.
  listArtifacts: {
    fields: {
      limit: S.num(),
      sessionId: S.str(200),
      type: S.en(ARTIFACT_TYPES),
      sinceMs: S.num(),
    },
    optional: ['limit', 'sessionId', 'type', 'sinceMs'],
  },
  getArtifact: { fields: { messageId: S.num() } },
  // Toolbar language switch writes the fixed ~/.nexus/config.json; no worker
  // round-trip. The renderer sends only a validated language token.
  setLanguage: { fields: { language: S.en(['zh-CN', 'en']) } },
};

export const WORKER_METHODS = {
  earlyInit: { fields: { cwd: S.str() }, optional: ['cwd'] },
  init: { fields: { cwd: S.str(), deferMcp: S.bool() }, optional: ['cwd', 'deferMcp'] },
  // ACP target registration only, no skills / MCP. Session workers run
  // earlyInit + initAcp + loadSkills, but acp.start() lives inside the
  // core's Agent.init(), so without this they have an empty registry and
  // every acp_route call fails.
  initAcp: { fields: {} },
  // Skill-registry load, split out of the core's Agent.init() so session
  // workers can populate their SkillRegistry without the full init (MCP stays
  // hub-owned by the global worker). One filesystem scan, idempotent.
  loadSkills: { fields: {} },
  chat: { fields: { input: S.str(MAX_CHAT_INPUT) } },
  // Mid-turn follow-up: merged into the running turn's context instead of
  // waiting for the in-flight chat() to finish. `rollback` additionally asks the
  // core to discard the interrupted attempt (destructive; core config gated).
  steer: { fields: { input: S.str(MAX_CHAT_INPUT), rollback: S.bool() }, optional: ['rollback'] },
  // Undo a rollback from a backup written under ~/.nexus/trash/rollback/.
  restore: { fields: { backupPath: S.str(4096) } },
  sideChat: { fields: { messages: S.msg() } },
  regenerate: { fields: { sessionId: S.str(), messageId: S.num() } },
  withdraw: { fields: { sessionId: S.str(), messageId: S.num() } },
  abort: { fields: {} },
  startSession: {
    fields: { name: S.str(), sessionId: S.str(), metadata: S.obj(), prevSessionId: S.str() },
    optional: ['name', 'sessionId', 'metadata', 'prevSessionId'],
  },
  prepareParentMemory: { fields: {} },
  listSessions: {
    fields: {
      limit: S.num(),
      offset: S.num(),
      excludeMock: S.bool(),
      excludeEmpty: S.bool(),
      search: S.str(200),
    },
    optional: ['limit', 'offset', 'excludeMock', 'excludeEmpty', 'search'],
  },
  getMessages: {
    fields: { sessionId: S.str(), last: S.num(), limit: S.num(), offset: S.num() },
    optional: ['last', 'limit', 'offset'],
  },
  deleteSession: { fields: { id: S.str() } },
  // One-time attachment RAG. `paths` arrives as a string[] (validated as an
  // object — arrays pass) and is re-checked per entry in the worker.
  ragIngest: { fields: { sessionId: S.str(), paths: S.paths() } },
  ragRemove: { fields: { sessionId: S.str(), path: S.str(4096) } },
  ragClear: { fields: { sessionId: S.str() } },
  ragStatus: { fields: { sessionId: S.str() } },
  ragCapabilities: { fields: {} },
  renameSession: { fields: { id: S.str(), name: S.str(500) } },
  renameProject: { fields: { newName: S.str(200) } },
  getConfig: { fields: {} },
  getProviders: { fields: {} },
  getStatus: { fields: {} },
  getPermissions: { fields: {} },
  getLanguage: { fields: {} },
  reloadConfig: { fields: {} },
  getSpeechVisionConfig: { fields: {} },
  setActiveSpeechProvider: { fields: { name: S.str(200) } },
  setActiveTtsProvider: { fields: { name: S.str(200) } },
  setActiveVisionProvider: { fields: { name: S.str(200) } },
  saveSpeechProvider: { fields: { name: S.str(200), fields: S.obj() } },
  saveVisionProvider: { fields: { name: S.str(200), fields: S.obj() } },
  getSessionStats: { fields: { sessionId: S.str() } },
  switchProvider: { fields: { name: S.str(200) } },
  switchModel: { fields: { modelId: S.str(500) } },
  setProviderOverride: { fields: { name: S.str(200), model: S.str(500) }, optional: ['model'] },
  setModelOverride: { fields: { modelId: S.str(500) } },
  setDepthOverride: { fields: { level: S.str(10) } },
  getActiveDepth: { fields: {} },
  setPermissionsOverride: { fields: { mode: S.str(20), sessionId: S.str() }, optional: ['sessionId'] },
  getActiveMode: { fields: { sessionId: S.str() }, optional: ['sessionId'] },
  getModels: { fields: { providerName: S.str(200) }, optional: ['providerName'] },
  saveProvider: { fields: { name: S.str(200), fields: S.obj() } },
  setCwd: { fields: { cwd: S.str(4096) } },
  getDefaultProjectDir: { fields: {} },
  getSessionMetadata: { fields: { sessionId: S.str() } },
  setSessionMetadata: { fields: { sessionId: S.str(), metadata: S.obj() } },
  resolvePermission: { fields: { id: S.str(200), answer: S.en(PERMISSION_ANSWERS), sessionId: S.str() }, optional: ['sessionId'] },
  setMcpEnabled: { fields: { enabled: S.bool() } },
  getMcpStatus: { fields: {} },
  getMcpServers: { fields: {} },
  setMcpServer: { fields: { name: S.str(200), enabled: S.bool() } },
  getSlashLog: { fields: { sessionId: S.str() } },
  getSlashLogPath: { fields: { sessionId: S.str() } },
  // core bg_ shell jobs (worker-local JobManager; reconcile+list/kill/tail/remove).
  // sessionId routes callForSession to the owning session worker (same as list).
  coreBgList: { fields: { sessionId: S.str(200) }, optional: ['sessionId'] },
  coreBgKill: { fields: { jobId: S.str(200), sessionId: S.str(200) }, optional: ['sessionId'] },
  coreBgTail: { fields: { jobId: S.str(200), lines: S.num(), sessionId: S.str(200) }, optional: ['lines', 'sessionId'] },
  coreBgRemove: { fields: { jobId: S.str(200), sessionId: S.str(200) }, optional: ['sessionId'] },
  shutdown: { fields: {} },
} satisfies Record<string, MethodSpec>;

/**
 * Desktop-only worker RPCs — implemented in agent-worker.ts but intentionally
 * NOT part of `WORKER_METHODS`: that map mirrors the core's shared
 * `WORKER_METHODS` contract (asserted byte-for-byte by test/contract.test.mjs).
 * Voice transcription is a desktop-local capability built on core's exported
 * `transcribeAudio()`; there is no corresponding core RPC to coordinate with,
 * so registering it in the shared contract would be a false dependency.
 */
export const DESKTOP_WORKER_METHODS = {
  voiceTranscribe: { fields: { audio: S.str(MAX_VOICE_WAV_BASE64) } },
} satisfies Record<string, MethodSpec>;

const ALL_WORKER_METHODS: Record<string, MethodSpec> = {
  ...WORKER_METHODS,
  ...DESKTOP_WORKER_METHODS,
};

function checkField(value: unknown, spec: FieldSpec, path: string): string | null {
  switch (spec.kind) {
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (spec.maxLen !== undefined && value.length > spec.maxLen) {
        return `${path} exceeds max length ${spec.maxLen}`;
      }
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a finite number`;
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? null
        : `${path} must be an object`;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? null
        : `${path} must be one of [${spec.values.join(', ')}]`;
    case 'paths':
      return isValidPathList(value) ? null : `${path} must be an array of at most 50 path strings`;
    case 'messages': {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIDE_CHAT_MESSAGES) {
        return `${path} must be a non-empty array of at most ${MAX_SIDE_CHAT_MESSAGES} messages`;
      }
      for (let i = 0; i < value.length; i++) {
        const m = value[i] as { role?: unknown; content?: unknown };
        if (!m || typeof m !== 'object' || Array.isArray(m)) return `${path}[${i}] must be an object`;
        if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') {
          return `${path}[${i}].role must be 'user' | 'assistant' | 'system'`;
        }
        if (typeof m.content !== 'string' || m.content.length > MAX_CHAT_INPUT) {
          return `${path}[${i}].content must be a string ≤ ${MAX_CHAT_INPUT}`;
        }
      }
      return null;
    }
  }
}

/** Validate a worker-routed request's params. Returns an error message or null. */
export function validateWorkerParams(method: string, params?: Record<string, unknown>): string | null {
  const spec = ALL_WORKER_METHODS[method];
  if (!spec) return `unknown method: ${method}`;
  return validateParamsAgainst(spec, params);
}

/**
 * Validate a T6 automation control-plane request's params (main-process-owned
 * channels; see `AUTOMATION_METHODS` above). Same error-shape contract as
 * `validateWorkerParams` so the handlers and negative tests share one pattern.
 */
export function validateAutomationParams(
  method: string,
  params?: Record<string, unknown>,
): string | null {
  const spec = AUTOMATION_METHODS[method];
  if (!spec) return `unknown automation method: ${method}`;
  return validateParamsAgainst(spec, params);
}

/** Validate a main-local config method's params (see MAIN_LOCAL_METHODS). */
export function validateMainLocalParams(
  method: string,
  params?: Record<string, unknown>,
): string | null {
  const spec = MAIN_LOCAL_METHODS[method];
  if (!spec) return `unknown main-local method: ${method}`;
  return validateParamsAgainst(spec, params);
}

function validateParamsAgainst(
  spec: MethodSpec,
  params?: Record<string, unknown>,
): string | null {
  if (!params) return null;
  for (const [key, fieldSpec] of Object.entries(spec.fields)) {
    const value = params[key];
    if (value === undefined) {
      if (spec.optional?.includes(key)) continue;
      return `missing required param: ${key}`;
    }
    const err = checkField(value, fieldSpec, `params.${key}`);
    if (err) return err;
  }
  return null;
}

// ---- scalar guards for main-process-only handlers ----
export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function isValidPathList(v: unknown): v is string[] {
  return isStringArray(v) && v.length <= 50 && v.every((p) => p.length <= 4096);
}
