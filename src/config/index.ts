import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Config, ConfigSchema } from './types.js';
import { hasClaudeConfig, hasBeenAutoImported, importFromClaude, markAutoImported, isSafeMcpCommand } from './claude-import.js';
import { resolveApiKey, decryptApiKey, atRestEncrypt, atRestDecrypt } from '../security/env-key-encrypt.js';

const CONFIG_DIR = join(homedir(), '.nexus');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const MODEL_CONTEXT_PATH = join(CONFIG_DIR, 'model-context.json');

let warnedAboutSchemaOnce = false;

const DEFAULT_CONFIG: Config = {
  activeProvider: 'anthropic',
  providers: {
    anthropic: {
      type: 'anthropic',
      apiKey: '',
      model: 'claude-sonnet-4-6-20251001',
    },
    openai: {
      type: 'openai',
      apiKey: '',
      model: 'gpt-4o',
    },
  },
  visionMode: 'local-first',
  activeVisionProvider: 'glm-4v',
  visionProviders: {
    'glm-4v': {
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4.6v-flash',
    },
  },
  qualityGate: {
    autoTest: true,
    autoCommit: false,
  },
  permissions: {
    mode: 'prompt',
    allowlist: [],
    safePaths: ['~/.nexus/tasks', '.'],
    mcpAllowlist: [],
  },
  acp: {
    enabled: false,
    port: 3456,
    permissionMode: 'auto',
    timeouts: {
      watchdogRemoteMs: 120000,
      heartbeatMs: 15000,
    },
  },
};

export class ConfigManager {
  private config: Config;

  constructor() {
    const isFirstRun = !existsSync(CONFIG_PATH);
    this.config = this.load();

    // Auto-encrypt plaintext API keys that were manually placed in config.json
    // (e.g. direct file edits). This keeps on-disk keys consistent with the
    // encryption policy even when bypassing the CLI/Web UI.
    if (this.autoEncryptPlaintextKeys()) {
      this.save();
    }

    // Auto-import from Claude Code on first run
    if (isFirstRun && hasClaudeConfig() && !hasBeenAutoImported()) {
      importFromClaude(this, true);
      markAutoImported();
      // Reload after import
      this.config = this.load();
      if (this.autoEncryptPlaintextKeys()) {
        this.save();
      }
    }
  }

  private autoEncryptPlaintextKeys(): boolean {
    let changed = false;
    if (this.config?.providers) {
      for (const key of Object.keys(this.config.providers)) {
        const p = this.config.providers[key]!;
        const ak = p.apiKey;
        if (ak && !ak.startsWith('enc:') && !ak.startsWith('$') && !ak.startsWith('env:')) {
          p.apiKey = atRestEncrypt(ak);
          changed = true;
        }
      }
    }
    if (this.config?.mcpServers) {
      for (const srv of Object.values(this.config.mcpServers)) {
        if (!srv?.env) continue;
        for (const [k, v] of Object.entries(srv.env)) {
          if (v && !v.startsWith('enc:') && !v.startsWith('$') && !v.startsWith('env:')) {
            srv.env[k] = atRestEncrypt(v);
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  private load(): Config {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }

    let raw: Config;
    try {
      raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
      if (raw.providers) {
        for (const key of Object.keys(raw.providers)) {
          const p = raw.providers[key]!;
          try { p.apiKey = atRestDecrypt(p.apiKey); } catch { /* keep original */ }
        }
      }
    } catch (err) {
      if (!warnedAboutSchemaOnce) {
        warnedAboutSchemaOnce = true;
        process.stderr.write('[nexus] ~/.nexus/config.json could not be parsed as JSON. Falling back to defaults; your previous config is lost.\n');
      }
      return DEFAULT_CONFIG;
    }

    try {
      return ConfigSchema.parse(raw);
    } catch (err) {
      // Schema validation failed. NEVER silently return DEFAULT_CONFIG here:
      // any subsequent save() would then overwrite the user's on-disk config
      // with the defaults. Return the raw object so user data is preserved.
      if (!warnedAboutSchemaOnce) {
        warnedAboutSchemaOnce = true;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[nexus] ~/.nexus/config.json failed schema validation; loading raw data to prevent data loss.\n` +
          `  ${msg.replace(/\n/g, '\n  ')}\n` +
          `  Edit ~/.nexus/config.json manually, or run \`nexus config add-provider ...\` to overwrite a single entry.\n`
        );
      }
      return raw;
    }
  }

  save(): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const config = structuredClone(this.config);
    if (config.providers) {
      for (const key of Object.keys(config.providers)) {
        const p = config.providers[key]!;
        p.apiKey = atRestEncrypt(p.apiKey);
      }
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  get(): Config {
    return this.config;
  }

  getLanguage(): string {
    return this.config.language || 'en';
  }

  setLanguage(lang: string): void {
    this.config.language = lang as 'en' | 'zh-CN';
    this.save();
  }

  getVisionMode(): string {
    return this.config.visionMode || 'local-first';
  }

  setVisionMode(mode: string): void {
    this.config.visionMode = mode as 'local-first' | 'cloud-first' | 'local-only' | 'cloud-only';
    this.save();
  }

  getQualityGate(): { autoTest: boolean; autoCommit: boolean } {
    const qg = (this.config as Record<string, unknown>).qualityGate as
      | { autoTest?: boolean; autoCommit?: boolean }
      | undefined;
    return {
      autoTest: qg?.autoTest ?? true,
      autoCommit: qg?.autoCommit ?? false,
    };
  }

  setQualityGate(partial: Partial<{ autoTest: boolean; autoCommit: boolean }>): void {
    const cur = this.getQualityGate();
    (this.config as Record<string, unknown>).qualityGate = { ...cur, ...partial };
    this.save();
  }

  getPermissions(): { mode: 'prompt' | 'auto'; allowlist: string[]; safePaths: string[]; mcpAllowlist: string[] } {
    const p = (this.config as Record<string, unknown>).permissions as
      | { mode?: 'prompt' | 'auto'; allowlist?: string[]; safePaths?: string[]; mcpAllowlist?: string[] }
      | undefined;
    return {
      mode: p?.mode ?? 'prompt',
      allowlist: p?.allowlist ? [...p.allowlist] : [],
      safePaths: p?.safePaths ? [...p.safePaths] : [],
      mcpAllowlist: p?.mcpAllowlist ? [...p.mcpAllowlist] : [],
    };
  }

  setPermissions(partial: Partial<{ mode: 'prompt' | 'auto'; allowlist: string[]; safePaths?: string[]; mcpAllowlist?: string[] }>): void {
    const cur = this.getPermissions();
    (this.config as Record<string, unknown>).permissions = { ...cur, ...partial };
    this.save();
  }

  /**
   * Mutate the live (in-memory) permissions WITHOUT persisting to disk.
   * Used by temporary switches (e.g. /go autonomous mode) so an interrupted run
   * cannot leave the on-disk config stuck in 'auto' whitelist mode.
   */
  setPermissionsInMemory(partial: Partial<{ mode: 'prompt' | 'auto'; allowlist: string[]; safePaths?: string[]; mcpAllowlist?: string[] }>): void {
    const cur = this.getPermissions();
    (this.config as Record<string, unknown>).permissions = { ...cur, ...partial };
  }

  getVisionProviders(): Record<string, { apiKey: string; baseUrl: string; model: string }> {
    return (this.config.visionProviders || {}) as any;
  }

  getActiveVisionProvider(): string {
    return this.config.activeVisionProvider || 'glm-4v';
  }

  setActiveVisionProvider(name: string): void {
    this.config.activeVisionProvider = name;
    this.save();
  }

  getVisionProvider(name?: string): { apiKey: string; baseUrl: string; model: string } {
    const key = name || this.getActiveVisionProvider();
    const providers = this.getVisionProviders();
    const provider = providers[key];
    if (!provider) {
      throw new Error(`Vision provider "${key}" not found`);
    }
    const resolved = resolveApiKey(provider.apiKey, 'custom', key);
    return { ...provider, apiKey: resolved.apiKey };
  }

  setVisionProvider(name: string, config: { apiKey: string; baseUrl: string; model: string }): void {
    if (!this.config.visionProviders) {
      this.config.visionProviders = {};
    }
    this.config.visionProviders[name] = { ...config, apiKey: atRestEncrypt(config.apiKey) };
    this.save();
  }

  removeVisionProvider(name: string): void {
    if (this.config.visionProviders) {
      delete this.config.visionProviders[name];
      if (this.config.activeVisionProvider === name) {
        const remaining = Object.keys(this.config.visionProviders);
        this.config.activeVisionProvider = remaining[0] || 'glm-4v';
      }
      this.save();
    }
  }

  // ── OCR Providers ──────────────────────────────────────────────────

  getOcrProviders(): Record<string, { type: string; apiKey?: string; baseUrl?: string; model?: string; command?: string; args?: string[]; languages?: string[] }> {
    return (this.config.ocrProviders || {}) as any;
  }

  getActiveOcrProvider(): string {
    return this.config.activeOcrProvider || '';
  }

  setActiveOcrProvider(name: string): void {
    this.config.activeOcrProvider = name;
    this.save();
  }

  getOcrProvider(name?: string): { type: string; apiKey?: string; baseUrl?: string; model?: string; command?: string; args?: string[]; languages?: string[] } {
    const key = name || this.getActiveOcrProvider();
    const providers = this.getOcrProviders();
    const provider = providers[key];
    if (!provider) {
      throw new Error(`OCR provider "${key}" not found`);
    }
    if (provider.apiKey) {
      const resolved = resolveApiKey(provider.apiKey, 'custom', key);
      return { ...provider, apiKey: resolved.apiKey };
    }
    return { ...provider };
  }

  setOcrProvider(name: string, config: { type: string; apiKey?: string; baseUrl?: string; model?: string; command?: string; args?: string[]; languages?: string[] }): void {
    if (!this.config.ocrProviders) {
      this.config.ocrProviders = {};
    }
    const entry: any = { ...config };
    if (entry.apiKey) {
      entry.apiKey = atRestEncrypt(entry.apiKey);
    }
    this.config.ocrProviders[name] = entry;
    this.save();
  }

  removeOcrProvider(name: string): void {
    if (this.config.ocrProviders) {
      delete this.config.ocrProviders[name];
      if (this.config.activeOcrProvider === name) {
        const remaining = Object.keys(this.config.ocrProviders);
        this.config.activeOcrProvider = remaining[0] || '';
      }
      this.save();
    }
  }

  // ── Speech Providers ───────────────────────────────────────────────────

  getSpeechProviders(): Record<string, any> {
    return (this.config.speechProviders || {}) as any;
  }

  getActiveSpeechProvider(): string {
    return this.config.activeSpeechProvider || '';
  }

  setActiveSpeechProvider(name: string): void {
    this.config.activeSpeechProvider = name;
    this.save();
  }

  getActiveTtsProvider(): string {
    return this.config.activeTtsProvider || '';
  }

  setActiveTtsProvider(name: string): void {
    this.config.activeTtsProvider = name;
    this.save();
  }

  getSpeechProvider(name?: string): any {
    const key = name || this.getActiveSpeechProvider();
    const providers = this.getSpeechProviders();
    const provider = providers[key];
    if (!provider) {
      throw new Error(`Speech provider "${key}" not found`);
    }
    if (provider.apiKey) {
      const resolved = resolveApiKey(provider.apiKey, 'custom', key);
      return { ...provider, apiKey: resolved.apiKey };
    }
    return { ...provider };
  }

  setSpeechProvider(name: string, config: { apiKey: string; baseUrl: string; model: string; category?: string; voice?: string; language?: string }): void {
    if (!this.config.speechProviders) {
      this.config.speechProviders = {};
    }
    const entry: any = { ...config };
    if (entry.apiKey) {
      entry.apiKey = atRestEncrypt(entry.apiKey);
    }
    this.config.speechProviders[name] = entry;
    this.save();
  }

  removeSpeechProvider(name: string): void {
    if (this.config.speechProviders) {
      delete this.config.speechProviders[name];
      if (this.config.activeSpeechProvider === name) {
        const remaining = Object.keys(this.config.speechProviders);
        this.config.activeSpeechProvider = remaining[0] || '';
      }
      if (this.config.activeTtsProvider === name) {
        const remaining = Object.keys(this.config.speechProviders);
        this.config.activeTtsProvider = remaining[0] || '';
      }
      this.save();
    }
  }

  removeProvider(name: string): void {
    if (!this.config.providers || !this.config.providers[name]) {
      throw new Error(`Provider "${name}" not found`);
    }
    if (this.config.activeProvider === name) {
      throw new Error(`Cannot delete the active provider "${name}". Switch to another provider first.`);
    }
    delete this.config.providers[name];
    this.save();
  }

  getActiveProvider(): string {
    return this.config.activeProvider;
  }

  setActiveProvider(name: string): void {
    if (!this.config.providers[name]) {
      throw new Error(`Provider "${name}" not found`);
    }
    this.config.activeProvider = name;
    this.save();
  }

  getProvider(name?: string) {
    const key = name || this.config.activeProvider;
    const provider = this.config.providers[key];
    if (!provider) {
      throw new Error(`Provider "${key}" not configured`);
    }
    const resolved = resolveApiKey(provider.apiKey, provider.type, key);
    return { ...provider, apiKey: resolved.apiKey };
  }

  // ── Vision Capability Management ────────────────────────────────────────

  getVisionWhitelist(): string[] {
    return [...(this.config.visionWhitelist || [])];
  }

  addVisionWhitelist(pattern: string): void {
    if (!this.config.visionWhitelist) this.config.visionWhitelist = [];
    if (!this.config.visionWhitelist.includes(pattern)) {
      this.config.visionWhitelist.push(pattern);
      this.save();
    }
  }

  removeVisionWhitelist(pattern: string): void {
    if (this.config.visionWhitelist) {
      this.config.visionWhitelist = this.config.visionWhitelist.filter(p => p !== pattern);
      this.save();
    }
  }

  getVisionBlacklist(): string[] {
    return [...(this.config.visionBlacklist || [])];
  }

  addVisionBlacklist(pattern: string): void {
    if (!this.config.visionBlacklist) this.config.visionBlacklist = [];
    if (!this.config.visionBlacklist.includes(pattern)) {
      this.config.visionBlacklist.push(pattern);
      this.save();
    }
  }

  removeVisionBlacklist(pattern: string): void {
    if (this.config.visionBlacklist) {
      this.config.visionBlacklist = this.config.visionBlacklist.filter(p => p !== pattern);
      this.save();
    }
  }

  getVisionCapabilityCache(): Record<string, boolean> {
    return { ...(this.config.visionCapabilityCache || {}) };
  }

  setVisionCapabilityCache(key: string, value: boolean): void {
    if (!this.config.visionCapabilityCache) this.config.visionCapabilityCache = {};
    this.config.visionCapabilityCache[key] = value;
    this.save();
  }

  clearVisionCapabilityCache(): void {
    this.config.visionCapabilityCache = {};
    this.save();
  }

  getDecryptedApiKey(name?: string): string {
    const provider = this.getProvider(name);
    return decryptApiKey(provider.apiKey);
  }

  setProvider(name: string, config: Config['providers'][string]): void {
    const storedConfig = { ...config, apiKey: atRestEncrypt(config.apiKey) };
    this.config.providers[name] = storedConfig;
    this.save();
  }

  setProviderField(name: string, field: string, value: unknown): void {
    const provider = this.config.providers[name];
    if (!provider) {
      throw new Error(`Provider "${name}" not found`);
    }
    (provider as Record<string, unknown>)[field] = value;
    this.save();
  }

  listProviders(): string[] {
    return Object.keys(this.config.providers);
  }

  getMcpServers(): Record<string, Config['mcpServers'] extends infer T ? T extends object ? T[keyof T] : never : never> | undefined {
    return this.config.mcpServers;
  }

  addMcpServer(name: string, server: NonNullable<Config['mcpServers']>[string]): void {
    const command = String((server as Record<string, unknown>).command || '');
    const args = (server as Record<string, unknown>).args;
    // All MCP servers are auto-started on next launch, so a malicious `command`
    // would execute arbitrary code. Reject anything that is not a simple, safe
    // executable (no shell metacharacters, no inline/sh compound commands).
    if (!isSafeMcpCommand(command, args)) {
      throw new Error(`Refusing to add MCP server "${name}": launch command "${command}" is not a safe, simple executable.`);
    }
    // Encrypt plaintext env values before persisting
    if ((server as Record<string, unknown>).env) {
      const env = (server as Record<string, unknown>).env as Record<string, string>;
      for (const k of Object.keys(env)) {
        const v = env[k];
        if (v && !v.startsWith('enc:') && !v.startsWith('$') && !v.startsWith('env:')) {
          env[k] = atRestEncrypt(v);
        }
      }
    }
    this.config.mcpServers = this.config.mcpServers || {};
    (this.config.mcpServers as Record<string, unknown>)[name] = server;
    this.save();
  }

  removeMcpServer(name: string): void {
    if (this.config.mcpServers) {
      delete (this.config.mcpServers as Record<string, unknown>)[name];
      this.save();
    }
  }

  getAcpConfig(): Config['acp'] {
    return this.config.acp;
  }

  setAcpConfig(acp: NonNullable<Config['acp']>): void {
    this.config.acp = acp;
    this.save();
  }

  getAcpTimeouts(): NonNullable<NonNullable<Config['acp']>['timeouts']> {
    return this.config.acp?.timeouts || {};
  }

  setAcpTimeout(field: 'chunkIdleMs' | 'watchdogRemoteMs' | 'heartbeatMs', value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Timeout "${field}" must be a positive number (ms)`);
    }
    const acp = { ...(this.config.acp || {}), timeouts: { ...(this.config.acp?.timeouts || {}), [field]: Math.floor(value) } };
    this.config.acp = acp;
    this.save();
  }

  clearAcpTimeout(field: 'chunkIdleMs' | 'watchdogRemoteMs' | 'heartbeatMs'): void {
    if (!this.config.acp?.timeouts) return;
    const next = { ...this.config.acp.timeouts };
    delete next[field];
    const acp = { ...this.config.acp };
    acp.timeouts = Object.keys(next).length > 0 ? next : undefined;
    this.config.acp = acp;
    this.save();
  }

  getPromptName(): string {
    return this.config.promptName || 'you';
  }

  setPromptName(name: string): void {
    this.config.promptName = name;
    this.save();
  }

  setNativeInstalled(list: string[]): void {
    this.config.nativeInstalled = [...new Set(list)];
    this.save();
  }

  getNativeDisabled(): string[] {
    return this.config.nativeDisabled || [];
  }

  setNativeDisabled(list: string[]): void {
    this.config.nativeDisabled = [...new Set(list)];
    this.save();
  }

  setRegisteredMarketplaces(list: Array<{ name: string; source: string; plugins: Array<{ name: string; description: string; source: string; category?: string; version?: string }> }>): void {
    this.config.registeredMarketplaces = list;
    this.save();
  }

  getModelContextLimit(model?: string): number {
    const modelName = model || this.getProvider().model;
    // 1. Check model-context.json (auto-learned limits)
    const learned = this.loadModelContextFile();
    if (learned[modelName]) return learned[modelName]!;
    // 2. Check modelContextLimits map (user-configured in config.json)
    if (this.config.modelContextLimits?.[modelName]) {
      return this.config.modelContextLimits[modelName]!;
    }
    // 3. Check provider-level maxContextTokens
    if (this.getProvider().maxContextTokens) {
      return this.getProvider().maxContextTokens!;
    }
    // 4. Default
    return 8192;
  }

  learnModelContextLimit(model: string, limit: number): void {
    const data = this.loadModelContextFile();
    data[model] = limit;
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(MODEL_CONTEXT_PATH, JSON.stringify(data, null, 2));
  }

  private loadModelContextFile(): Record<string, number> {
    if (!existsSync(MODEL_CONTEXT_PATH)) return {};
    try {
      return JSON.parse(readFileSync(MODEL_CONTEXT_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }
}
