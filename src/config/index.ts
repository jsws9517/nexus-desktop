import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Config, ConfigSchema } from './types.js';
import { hasClaudeConfig, hasBeenAutoImported, importFromClaude, markAutoImported } from './claude-import.js';

const CONFIG_DIR = join(homedir(), '.llm-agent');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

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
}
