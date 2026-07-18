import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

function resolveFromEnvVar(configKey: string): string | undefined {
  if (configKey.startsWith('$')) {
    const envName = configKey.slice(1);
    return process.env[envName] || undefined;
  }
  if (configKey.startsWith('env:')) {
    const envName = configKey.slice(4);
    return process.env[envName] || undefined;
  }
  return undefined;
}

function tryEnvVar(...names: string[]): string | undefined {
  for (const name of names) {
    const val = process.env[name];
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

  // 3) Fall back to raw config value (encrypted in transit)
  if (configKey && configKey.length > 0 && !configKey.startsWith('$') && !configKey.startsWith('env:')) {
    return { apiKey: ephemeralEncrypt(configKey), encrypted: true };
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