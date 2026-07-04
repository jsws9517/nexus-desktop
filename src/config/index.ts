import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Config, ConfigSchema } from './types.js';
import { hasClaudeConfig, hasBeenAutoImported, importFromClaude, markAutoImported } from './claude-import.js';

const CONFIG_DIR = join(homedir(), '.nexus');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const MODEL_CONTEXT_PATH = join(CONFIG_DIR, 'model-context.json');

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
};

export class ConfigManager {
  private config: Config;

  constructor() {
    const isFirstRun = !existsSync(CONFIG_PATH);
    this.config = this.load();

    // Auto-import from Claude Code on first run
    if (isFirstRun && hasClaudeConfig() && !hasBeenAutoImported()) {
      importFromClaude(this, true);
      markAutoImported();
      // Reload after import
      this.config = this.load();
    }
  }

  private load(): Config {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    }
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      return ConfigSchema.parse(raw);
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  private save(): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
  }

  get(): Config {
    return this.config;
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
    return provider;
  }

  setProvider(name: string, config: Config['providers'][string]): void {
    this.config.providers[name] = config;
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

  getPromptName(): string {
    return this.config.promptName || 'you';
  }

  setPromptName(name: string): void {
    this.config.promptName = name;
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
