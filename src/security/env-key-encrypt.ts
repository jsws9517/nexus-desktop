import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';

const ALGORITHM = 'aes-256-gcm';

// ---- In-memory (ephemeral) key — per process ----

function getMachineKey(): Buffer {
  const storedRaw = process.env._NEXUS_ENCRYPT_KEY;
  if (storedRaw) {
    return Buffer.from(storedRaw, 'hex');
  }
  const key = randomBytes(32);
  process.env._NEXUS_ENCRYPT_KEY = key.toString('hex');
  return key;
}

export function ephemeralEncrypt(plaintext: string): string {
  const key = getMachineKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `mem:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function ephemeralDecrypt(encoded: string): string {
  if (!encoded.startsWith('mem:')) return encoded;
  const key = getMachineKey();
  const parts = encoded.slice(4).split(':');
  if (parts.length !== 3) return encoded;
  const iv = Buffer.from(parts[0]!, 'hex');
  const authTag = Buffer.from(parts[1]!, 'hex');
  const encrypted = parts[2]!;
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

// ---- At-rest (persistent) key — survives restarts ----

const CONFIG_DIR = join(homedir(), '.nexus');
const STORAGE_KEY_PATH = join(CONFIG_DIR, '.storage-key');

function getOrCreateStorageKey(): Buffer {
  if (existsSync(STORAGE_KEY_PATH)) {
    return Buffer.from(readFileSync(STORAGE_KEY_PATH, 'utf-8').trim(), 'hex');
  }
  const key = randomBytes(32);
  mkdirSync(CONFIG_DIR, { recursive: true });
  // Store the encryption key with owner-only read/write permissions so other
  // local users/processes cannot read it and decrypt persisted API keys.
  writeFileSync(STORAGE_KEY_PATH, key.toString('hex'), { mode: 0o600 });
  // On Windows, chmod/mode 0o600 is silently ignored. Apply ACL via icacls so
  // only the current user can read the storage key.
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const user = process.env.USERNAME || process.env.USER || '';
      if (user) {
        execSync(
          `icacls "${STORAGE_KEY_PATH}" /inheritance:r /grant "${user}:(R,W)" /grant "SYSTEM:(R,W)"`,
          { stdio: 'ignore', timeout: 5000 },
        );
      }
    } catch (e) {
      // ACL hardening is best-effort on Windows; failure does not block startup.
      process.stderr.write(`[nexus] Warning: could not secure storage key file via icacls. Other local users may read it.\n  Caused by: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return key;
}

export function atRestEncrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  // A value shaped like an env-var reference ($VAR or env:VAR) is only stored
  // in plaintext when the referenced variable is actually set. This prevents a
  // user from accidentally persisting a real secret as "env:..." and writing it
  // to disk unencrypted. If the reference does not resolve, treat the value as
  // a literal secret and encrypt it.
  if (plaintext.startsWith('$') || plaintext.startsWith('env:')) {
    const envName = plaintext.startsWith('env:')
      ? plaintext.slice(4)
      : plaintext.slice(1);
    if (process.env[envName]) return plaintext;
  }
  const key = getOrCreateStorageKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function atRestDecrypt(encoded: string): string {
  if (!encoded.startsWith('enc:')) return encoded;
  const key = getOrCreateStorageKey();
  const parts = encoded.slice(4).split(':');
  if (parts.length !== 3) return encoded;
  const iv = Buffer.from(parts[0]!, 'hex');
  const authTag = Buffer.from(parts[1]!, 'hex');
  const encrypted = parts[2]!;
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

/**
 * Read a Windows User environment variable from the registry.
 * Fallback when process.env doesn't have it (session started before var was set).
 */
let _execSync: any;
const _require = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
function getWindowsUserEnv(name: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  // Only allow valid Windows environment-variable names: [a-zA-Z_][a-zA-Z0-9_]*.
  // Anything else (spaces, quotes, semicolons, backticks, $, etc.) would break
  // out of the PowerShell -Command string and execute arbitrary PowerShell code.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return undefined;
  try {
    if (!_execSync) _execSync = _require('child_process').execSync;
    const val = _execSync(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${name}','User')"`,
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ).trim();
    return val || undefined;
  } catch { return undefined; }
}

function resolveFromEnvVar(configKey: string): string | undefined {
  if (configKey.startsWith('$')) {
    const envName = configKey.slice(1);
    return process.env[envName] || getWindowsUserEnv(envName) || undefined;
  }
  if (configKey.startsWith('env:')) {
    const envName = configKey.slice(4);
    return process.env[envName] || getWindowsUserEnv(envName) || undefined;
  }
  return undefined;
}

function tryEnvVar(...names: string[]): string | undefined {
  for (const name of names) {
    const val = process.env[name] || getWindowsUserEnv(name);
    if (val) return val;
  }
  return undefined;
}

export function resolveApiKey(configKey: string | undefined, providerType: string, providerName?: string): { apiKey: string; encrypted: boolean } {
  // 1) Try explicit env var reference in config value ($VAR or env:VAR)
  if (configKey) {
    const fromEnv = resolveFromEnvVar(configKey);
    if (fromEnv) {
      return { apiKey: ephemeralEncrypt(fromEnv), encrypted: true };
    }
  }

  // 2) Dynamic env var lookup
  if (!configKey || configKey.startsWith('$') || configKey.startsWith('env:')) {
    // 2a) Provider-name-specific env vars (handles hyphens and aliases).
    //     Examples: opencode-zen → OPENCODE_API_KEY / OPENCODE_ZEN_API_KEY
    const nameEnvExtras: Record<string, string[]> = {
      'opencode-zen': ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
    };
    if (providerName && nameEnvExtras[providerName]) {
      const byNameExtra = tryEnvVar(...nameEnvExtras[providerName]!);
      if (byNameExtra) return { apiKey: ephemeralEncrypt(byNameExtra), encrypted: true };
    }

    // 2b) API_key_<PROVIDER_NAME> (e.g. API_KEY_DEEPSEEK, API_KEY_ZHIPU)
    if (providerName) {
      const byName = tryEnvVar(`API_KEY_${providerName.toUpperCase()}`);
      if (byName) return { apiKey: ephemeralEncrypt(byName), encrypted: true };
    }

    // 2c) Type-specific generic names
    const typeGenerics: Record<string, string[]> = {
      anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
      openai: ['OPENAI_API_KEY'],
      custom: ['CUSTOM_API_KEY'],
    };
    const generics = typeGenerics[providerType] || [];
    const byGeneric = tryEnvVar(...generics);
    if (byGeneric) return { apiKey: ephemeralEncrypt(byGeneric), encrypted: true };

    // 2d) API_key_<PROVIDER_TYPE> (e.g. API_KEY_ANTHROPIC, API_KEY_OPENAI) — catch-all
    const byType = tryEnvVar(`API_KEY_${providerType.toUpperCase()}`);
    if (byType) return { apiKey: ephemeralEncrypt(byType), encrypted: true };

    // --- Nothing worked — throw actionable error ---
    const suggestions: string[] = [];
    if (providerName && nameEnvExtras[providerName]) suggestions.push(...nameEnvExtras[providerName]!);
    if (providerName) suggestions.push(`API_KEY_${providerName.toUpperCase()}`);
    suggestions.push(...generics);
    suggestions.push(`API_KEY_${providerType.toUpperCase()}`);

    const hint = configKey
      ? `Config apiKey references "${configKey}" but that environment variable is not set.`
      : 'Config apiKey is empty.';

    throw new Error(
      `No usable API key for provider "${providerName || providerType}".\n` +
      `${hint}\n` +
      `Please set one of these environment variables:\n` +
      `  ${suggestions.join(', ')}`
    );
  }

  // 3) Fall back to raw config value (plaintext or encrypted at rest)
  if (configKey && configKey.length > 0 && !configKey.startsWith('$') && !configKey.startsWith('env:')) {
    let resolved = configKey;
    if (configKey.startsWith('enc:')) {
      // at-rest encrypted blob — decrypt it. config.load() may have caught a
      // storage-key mismatch and left the raw enc: string in place, which step 3
      // would otherwise treat as a plaintext key and send to the API as-is.
      try {
        const decrypted = atRestDecrypt(configKey);
        if (decrypted === configKey) throw new Error('decryption returned the raw encrypted blob');
        resolved = decrypted;
      } catch (e) {
        throw new Error(
          `Cannot decrypt provider API key: ${e instanceof Error ? e.message : String(e)}\n` +
          `The .storage-key file (~/.nexus/.storage-key) may have changed or been deleted.\n` +
          `Re-add the provider API key to re-encrypt it with the current storage key.`
        );
      }
    }
    return { apiKey: ephemeralEncrypt(resolved), encrypted: true };
  }

  return { apiKey: '', encrypted: false };
}

export function decryptApiKey(encrypted: string): string {
  if (!encrypted || !encrypted.includes(':')) return encrypted;
  if (encrypted.startsWith('mem:')) {
    try { return ephemeralDecrypt(encrypted); } catch { return encrypted; }
  }
  if (encrypted.startsWith('enc:')) {
    try { return atRestDecrypt(encrypted); } catch { return encrypted; }
  }
  return encrypted;
}