/**
 * Lightweight IPC parameter validation (C1).
 *
 * Worker-routed methods are validated against a single-source spec map before
 * dispatch; main-process-only handlers use the exported scalar validators.
 * Zero dependencies; failures produce a structured error message instead of
 * letting malformed input reach the core.
 */

export type FieldSpec =
  | { kind: 'string'; maxLen?: number }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'object' }
  | { kind: 'enum'; values: readonly string[] };

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
};

export const PERMISSION_ANSWERS = ['y', 'a', 'n'] as const;
export const MAX_CHAT_INPUT = 65536;

export const WORKER_METHODS: Record<string, MethodSpec> = {
  earlyInit: { fields: { cwd: S.str() }, optional: ['cwd'] },
  init: { fields: { cwd: S.str(), deferMcp: S.bool() }, optional: ['cwd', 'deferMcp'] },
  chat: { fields: { input: S.str(MAX_CHAT_INPUT) } },
  regenerate: { fields: { sessionId: S.str(), userIndex: S.num() } },
  withdraw: { fields: { sessionId: S.str(), userIndex: S.num() } },
  abort: { fields: {} },
  startSession: {
    fields: { name: S.str(), sessionId: S.str(), metadata: S.obj(), prevSessionId: S.str() },
    optional: ['name', 'sessionId', 'metadata', 'prevSessionId'],
  },
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
  renameSession: { fields: { id: S.str(), name: S.str(500) } },
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
  setPermissionsOverride: { fields: { mode: S.str(20) } },
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
  shutdown: { fields: {} },
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
  }
}

/** Validate a worker-routed request's params. Returns an error message or null. */
export function validateWorkerParams(method: string, params?: Record<string, unknown>): string | null {
  const spec = WORKER_METHODS[method];
  if (!spec) return `unknown method: ${method}`;
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
