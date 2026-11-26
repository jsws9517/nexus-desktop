/**
 * Whitelist merge for the desktop "Security & Permissions" settings UI (T1-4).
 *
 * The settings UI writes only the `permissions` subtree of ~/.nexus/config.json.
 * Every other top-level key (providers, MCP servers, skills, ...) and every
 * unknown permission field is ignored, so a buggy/old renderer cannot clobber
 * unrelated config. Pure functions here are unit-tested independently of IPC.
 */

export const PERMISSION_MODES = ['basic', 'prompt', 'auto', 'unattended'] as const;
export const EXEC_PERMISSIONS = ['auto', 'prompt', 'deny'] as const;
export const SAFETY_CHOICES = ['deny', 'ask'] as const;

const STRING_ARRAY_FIELDS = ['allowlist', 'safePaths', 'mcpAllowlist'] as const;
const SAFETY_ENUM_FIELDS = ['dbDeletion', 'iterativeDelete'] as const;
const SAFETY_NUMBER_FIELDS = ['batchWriteLimit'] as const;
const SAFETY_BOOL_FIELDS = ['requireGitCheckpoint', 'autoCheckpoint'] as const;
const SAFETY_STRING_ARRAY_FIELDS = ['inlineEvalWhitelist', 'testHarnessModes'] as const;

export interface MergeResult {
  ok: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function inSet(set: readonly string[], v: unknown): v is string {
  return typeof v === 'string' && (set as readonly string[]).includes(v);
}

/**
 * Merge a partial `permissions` patch into a full config object, touching ONLY
 * the `permissions` subtree. Any top-level key other than `permissions` in the
 * patch is ignored; unknown permission fields are ignored. Returns a NEW object
 * and never mutates its inputs. Validation errors are returned (not thrown).
 */
export function mergePermissionsIntoConfig(
  config: Record<string, unknown>,
  params: unknown,
): MergeResult {
  if (!isPlainObject(params) || !isPlainObject(params.permissions)) {
    return { ok: false, error: 'permissions must be an object' };
  }
  // Only the `permissions` key of the IPC params is read; any other top-level
  // key is ignored (forbidden), so unrelated config can never be written here.
  const patch = params.permissions;

  const current = isPlainObject(config.permissions) ? config.permissions : {};
  const next: Record<string, unknown> = { ...current };

  if ('mode' in patch) {
    if (!inSet(PERMISSION_MODES, patch.mode)) {
      return { ok: false, error: 'mode must be one of basic | prompt | auto | unattended' };
    }
    next.mode = patch.mode;
  }

  for (const key of STRING_ARRAY_FIELDS) {
    if (key in patch) {
      if (!isStringArray(patch[key])) {
        return { ok: false, error: `${key} must be a string array` };
      }
      next[key] = (patch[key] as string[]).slice();
    }
  }

  if ('execPermission' in patch) {
    if (!inSet(EXEC_PERMISSIONS, patch.execPermission)) {
      return { ok: false, error: 'execPermission must be one of auto | prompt | deny' };
    }
    next.execPermission = patch.execPermission;
  }

  if ('execCommandOverrides' in patch) {
    const overrides = patch.execCommandOverrides;
    if (!isPlainObject(overrides)) {
      return { ok: false, error: 'execCommandOverrides must be an object' };
    }
    const merged: Record<string, string> = {};
    for (const [cmd, level] of Object.entries(overrides)) {
      if (!inSet(EXEC_PERMISSIONS, level)) {
        return { ok: false, error: `execCommandOverrides.${cmd} is invalid` };
      }
      merged[cmd] = level;
    }
    next.execCommandOverrides = merged;
  }

  if ('safetyRules' in patch) {
    const sr = patch.safetyRules;
    if (!isPlainObject(sr)) {
      return { ok: false, error: 'safetyRules must be a JSON object' };
    }
    const curSr = isPlainObject(next.safetyRules) ? next.safetyRules : {};
    const mergedSr: Record<string, unknown> = { ...curSr };
    for (const key of SAFETY_ENUM_FIELDS) {
      if (key in sr) {
        if (!inSet(SAFETY_CHOICES, sr[key])) {
          return { ok: false, error: `safetyRules.${key} must be deny or ask` };
        }
        mergedSr[key] = sr[key];
      }
    }
    for (const key of SAFETY_NUMBER_FIELDS) {
      if (key in sr) {
        if (typeof sr[key] !== 'number' || !Number.isFinite(sr[key])) {
          return { ok: false, error: `safetyRules.${key} must be a number` };
        }
        mergedSr[key] = sr[key];
      }
    }
    for (const key of SAFETY_BOOL_FIELDS) {
      if (key in sr) {
        if (typeof sr[key] !== 'boolean') {
          return { ok: false, error: `safetyRules.${key} must be a boolean` };
        }
        mergedSr[key] = sr[key];
      }
    }
    for (const key of SAFETY_STRING_ARRAY_FIELDS) {
      if (key in sr) {
        if (!isStringArray(sr[key])) {
          return { ok: false, error: `safetyRules.${key} must be a string array` };
        }
        mergedSr[key] = (sr[key] as string[]).slice();
      }
    }
    next.safetyRules = mergedSr;
  }

  return { ok: true, config: { ...config, permissions: next } };
}
