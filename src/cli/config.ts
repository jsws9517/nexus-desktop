import { Command } from 'commander';
import { createInterface } from 'readline';
import { ConfigManager } from '../config/index.js';
import { PERMISSION_PRESETS } from '../config/types.js';
import { NativeManager, SearchResult } from '../config/native.js';
import { importFromClaude } from '../config/claude-import.js';
import { ThemeManager } from '../theme/manager.js';
import { setCurrentLang, getCurrentLang, t as i18nTr, tf as i18nTf } from '../i18n/index.js';
import { registerOpencodeZenCommand, renderOpencodeZenStatus } from './opencode-zen.js';

const _theme = new ThemeManager();
const t = _theme.token;

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Configuration management');

  configCmd
    .command('import-claude')
    .description('Import MCP servers and skills from Claude Code config (~/.claude.json)')
    .action(() => {
      const config = new ConfigManager();
      const result = importFromClaude(config, false);

      if (result.mcpImported > 0) {
        console.log(t.success(`\nImported ${result.mcpImported} MCP server(s) from Claude Code`));
      }
      if (result.skillsImported > 0) {
        console.log(t.success(`Imported ${result.skillsImported} skill(s) from Claude Code`));
      }
      if (result.mcpImported === 0 && result.skillsImported === 0) {
        console.log(t.textDim('Nothing new to import from Claude Code config'));
      }
      if (result.mcpSkipped > 0 || result.skillsSkipped > 0) {
        console.log(t.textDim(`Skipped: ${result.mcpSkipped} MCP, ${result.skillsSkipped} skills (already exist)`));
      }
    });

  configCmd
    .command('list')
    .description('List current configuration')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      console.log(t.heading('Configuration:'));
      console.log(`  Active provider: ${t.entityName(cfg.activeProvider)}`);
      console.log(`  Prompt name: ${t.entityName(cfg.promptName || 'you')}`);
      console.log(`  Language: ${t.entityName(cfg.language || 'en')}`);
      console.log(t.heading('  Providers:'));
      for (const [name, p] of Object.entries(cfg.providers)) {
        const marker = name === cfg.activeProvider ? t.success('*') : ' ';
        const base = p.baseUrl ? t.textDim(` [${p.baseUrl}]`) : '';
        console.log(`    ${marker} ${name}: ${p.type} / ${p.model}${base}`);
      }
      if (cfg.providers['opencode-zen']) {
        console.log('');
        console.log(t.heading('  OpenCode Zen:'));
        console.log(renderOpencodeZenStatus(cfg).split('\n').map((l) => '    ' + l).join('\n'));
      }
      const visionMode = cfg.visionMode || 'local-first';
      const activeVp = cfg.activeVisionProvider || 'glm-4v';
      const vpCount = Object.keys(cfg.visionProviders || {}).length;
      console.log(`\n  Vision mode: ${t.entityName(visionMode)}`);
      console.log(`  Active vision provider: ${t.entityName(activeVp)} (${vpCount} configured)`);
      const acpCfg = cfg.acp || {};
      const acpStatus = acpCfg.enabled ? t.success('enabled') : t.textDim('disabled');
      const agentCount = (acpCfg.agents || []).length;
      console.log(`  ACP mode: ${acpStatus} (${agentCount} agent(s))`);
      if (acpCfg.port) console.log(`  ACP port: ${acpCfg.port}`);
      const qg = cfg.qualityGate || {};
      const autoTest = qg.autoTest !== false;
      const autoCommit = qg.autoCommit === true;
      console.log(`  Quality Gate: auto-test=${autoTest ? t.success('on') : t.textDim('off')}, auto-commit=${autoCommit ? t.success('on') : t.textDim('off')}`);
      if (cfg.mcpServers) {
        console.log(t.heading('  MCP Servers:'));
        for (const [name, s] of Object.entries(cfg.mcpServers)) {
          console.log(`    ${name}: ${s.command} ${(s.args || []).join(' ')}`);
        }
      }
    });

  configCmd
    .command('add-provider <name>')
    .description('Add a new LLM provider')
    .requiredOption('-t, --type <type>', 'Provider type: anthropic, openai, custom')
    .option('-k, --apiKey <key>', 'API key (or set via API_KEY_<NAME> env var, e.g. API_KEY_ANTHROPIC, API_KEY_DEEPSEEK)')
    .requiredOption('-m, --model <model>', 'Model name')
    .option('-u, --baseUrl <url>', 'Custom base URL (for compatible APIs)')
    .action(async (name: string, options: { type: string; apiKey?: string; model: string; baseUrl?: string }) => {
      let apiKey = options.apiKey || '';
      if (!apiKey) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        apiKey = await new Promise<string>(resolve => {
          rl.question(t.warning('Enter API key (will be encrypted at rest): '), answer => {
            rl.close();
            resolve(answer.trim());
          });
        });
      }
      const config = new ConfigManager();
      config.setProvider(name, {
        type: options.type as 'anthropic' | 'openai' | 'custom',
        apiKey,
        model: options.model,
        baseUrl: options.baseUrl,
      });
      console.log(t.success(`Added provider: ${name} (${options.type} / ${options.model})`));
      if (options.baseUrl) {
        console.log(t.textDim(`  Base URL: ${options.baseUrl}`));
      }
    });

  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action((key: string, value: string) => {
      const config = new ConfigManager();
      const parts = key.split('.');

      if (parts.length >= 3 && parts[0] === 'provider') {
        const providerName = parts[1];
        const field = parts.slice(2).join('.');
        config.setProviderField(providerName, field, value);
        console.log(t.success(`Set ${key} = ${value}`));
        return;
      }

      if (key === 'activeProvider') {
        config.setActiveProvider(value);
        console.log(t.success(`Switched to provider: ${value}`));
        return;
      }

      console.log(t.warning(`Unsupported config key: ${key}`));
    });

  configCmd
    .command('switch <provider>')
    .description('Switch active provider')
    .action((provider: string) => {
      const config = new ConfigManager();
      config.setActiveProvider(provider);
      console.log(t.success(`Switched to provider: ${provider}`));
    });

  configCmd
    .command('set-name <name>')
    .description('Set the chat prompt name (default: you)')
    .action((name: string) => {
      const config = new ConfigManager();
      config.setPromptName(name);
      console.log(t.success(`Chat prompt name set to: ${name}`));
    });

  const langCmd = configCmd.command('language').description('Language settings (en / zh-CN)');

  langCmd
    .command('list')
    .description('List available languages and current setting')
    .action(() => {
      const config = new ConfigManager();
      const current = config.getLanguage();
      const isZh = getCurrentLang() === 'zh-CN';
      const langs = isZh
        ? '  en     - English\n  zh-CN  - 简体中文'
        : '  en     - English\n  zh-CN  - Simplified Chinese';
      console.log(i18nTf('config_lang_list')(t.entityName(current), langs));
    });

  langCmd
    .command('set <lang>')
    .description('Set language (en | zh-CN)')
    .action((lang: string) => {
      if (lang !== 'en' && lang !== 'zh-CN') {
        console.log(t.error(i18nTf('config_lang_invalid')(lang)));
        return;
      }
      const config = new ConfigManager();
      config.setLanguage(lang);
      setCurrentLang(lang);
      console.log(t.success(i18nTf('config_lang_set')(lang)));
    });

  const visionCmd = configCmd.command('vision').description('Vision provider settings for analyze_image tool');

  visionCmd
    .command('list')
    .description('List configured vision providers (* = active)')
    .action(() => {
      const config = new ConfigManager();
      const active = config.getActiveVisionProvider();
      const providers = config.getVisionProviders();
      console.log(t.heading('Vision Providers:'));
      if (Object.keys(providers).length === 0) {
        console.log(t.textDim('  No vision providers configured.'));
        console.log(t.textDim('  Use "nexus config vision set <name> -k ... -u ... -m ..." to add one.'));
        return;
      }
      for (const [name, p] of Object.entries(providers)) {
        const marker = name === active ? t.success('*') : ' ';
        const keyHint = p.apiKey
          ? (p.apiKey.startsWith('$') || p.apiKey.startsWith('env:')
            ? t.textDim('[env ref]')
            : t.textDim('[key set]'))
          : t.warning('[no key]');
        console.log(`  ${marker} ${name}: ${p.model} ${keyHint}`);
        console.log(`    ${t.textDim(p.baseUrl)}`);
      }
    });

  visionCmd
    .command('set <name>')
    .description(`Configure a vision provider for the analyze_image tool.\n` +
      `    -k <key>    API key (plaintext, or \\$ENV_VAR / env:ENV_VAR to read from environment)\n` +
      `    -u <url>    Full API endpoint URL (e.g. https://open.bigmodel.cn/api/paas/v4/chat/completions)\n` +
      `    -m <model>  Model name (e.g. glm-4.6v-flash)\n` +
      `  The key is encrypted at rest.\n` +
      `  \\$VAR / env:VAR stores the variable name and resolves at runtime.\n` +
      `  PowerShell: use single quotes to prevent \\$var expansion:\n` +
      `    nexus config vision set glm-4v -k '\\$ZHIPU_KEY' -u 'https://open.bigmodel.cn/api/paas/v4/chat/completions' -m glm-4.6v-flash\n` +
      `  CMD: no quoting needed, but \\%VAR\\% expands immediately:\n` +
      `    nexus config vision set glm-4v -k %ZHIPU_KEY% -u https://open.bigmodel.cn/api/paas/v4/chat/completions -m glm-4.6v-flash`)
    .option('-k, --apiKey [key]', 'API key (plaintext, or $ENV_VAR / env:ENV_VAR; use quotes in PowerShell)')
    .requiredOption('-u, --baseUrl <url>', 'Full API endpoint URL (e.g. .../chat/completions)')
    .requiredOption('-m, --model <model>', 'Model name')
    .action((name: string, options: { apiKey?: string | boolean; baseUrl: string; model: string }) => {
      const missing: string[] = [];
      const hints: string[] = [];

      if (typeof options.apiKey !== 'string' || !options.apiKey) {
        missing.push('--apiKey (-k)');
        hints.push(
          '  API key is missing or empty.\n' +
          '  In PowerShell, use single quotes so $VAR is NOT expanded:\n' +
          '    nexus config vision set <name> -k \'$ENV_VAR_NAME\' -u \'...\' -m \'...\'\n' +
          '  Or use $env:VAR (expands to the actual value):\n' +
          '    nexus config vision set <name> -k "$env:ENV_VAR_NAME" -u "..." -m "..."'
        );
      }
      if (!options.baseUrl) {
        missing.push('--baseUrl (-u)');
        hints.push(
          '  URL is missing. This can happen when PowerShell drops an empty\n' +
          '  argument after $VAR expansion. Use single quotes around all args.'
        );
      }
      if (!options.model) {
        missing.push('--model (-m)');
        hints.push('  Model name is missing.');
      }

      if (missing.length > 0) {
        console.log(t.error(`Missing required options: ${missing.join(', ')}`));
        for (const h of hints) console.log(t.textDim(h));
        return;
      }

      const config = new ConfigManager();
      config.setVisionProvider(name, { apiKey: options.apiKey as string, baseUrl: options.baseUrl, model: options.model });
      config.setActiveVisionProvider(name);
      console.log(t.success(`Vision provider "${name}" configured and set as active.`));
    });

  visionCmd
    .command('switch <name>')
    .description('Switch the active vision provider (used by analyze_image tool)')
    .action((name: string) => {
      const config = new ConfigManager();
      try {
        config.setActiveVisionProvider(name);
        console.log(t.success(`Active vision provider: ${name}`));
      } catch (err) {
        console.log(t.error(`Failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  visionCmd
    .command('remove <name>')
    .description('Remove a vision provider')
    .action((name: string) => {
      const config = new ConfigManager();
      const providers = config.getVisionProviders();
      if (!providers[name]) {
        console.log(t.error(`Vision provider "${name}" not found.`));
        return;
      }
      config.removeVisionProvider(name);
      console.log(t.success(`Removed vision provider: ${name}`));
    });

  const visionModeCmd = configCmd.command('vision-mode').description('Vision mode settings (local-first | cloud-first | local-only | cloud-only)');

  visionModeCmd
    .command('list')
    .description('Show current vision mode and available options')
    .action(() => {
      const config = new ConfigManager();
      const mode = config.getVisionMode();
      console.log(t.heading(`\nCurrent vision mode: ${t.entityName(mode)}`));
      console.log(t.textDim('  local-first   — Try local Florence-2 first, fall back to cloud'));
      console.log(t.textDim('  cloud-first   — Try cloud provider first, fall back to local'));
      console.log(t.textDim('  local-only    — Use local Florence-2 only (no cloud calls)'));
      console.log(t.textDim('  cloud-only    — Use cloud provider only (no local calls)'));
    });

  visionModeCmd
    .command('set <mode>')
    .description('Set vision mode (local-first | cloud-first | local-only | cloud-only)')
    .action((mode: string) => {
      const valid = ['local-first', 'cloud-first', 'local-only', 'cloud-only'] as const;
      if (!valid.includes(mode as typeof valid[number])) {
        console.log(t.error(`Invalid mode: "${mode}". Available: ${valid.join(', ')}`));
        return;
      }
      const config = new ConfigManager();
      config.setVisionMode(mode);
      console.log(t.success(`Vision mode set to: ${mode}`));
    });

  const mcpCmd = configCmd.command('mcp').description('MCP server management');

  mcpCmd
    .command('list')
    .description('List MCP servers')
    .action(() => {
      const config = new ConfigManager();
      const servers = config.getMcpServers();
      if (!servers || Object.keys(servers).length === 0) {
        console.log(t.textDim('No MCP servers configured.'));
        return;
      }
      console.log(t.heading('MCP Servers:'));
      for (const [name, s] of Object.entries(servers)) {
        console.log(`  ${name}: ${s.command} ${(s.args || []).join(' ')}`);
      }
    });

  mcpCmd
    .command('add <name>')
    .requiredOption('-c, --command <cmd>', 'Command to run')
    .option('-a, --args <args...>', 'Arguments')
    .action((name: string, options: { command: string; args?: string[] }) => {
      const config = new ConfigManager();
      config.addMcpServer(name, {
        command: options.command,
        args: options.args,
      });
      console.log(t.success(`Added MCP server: ${name}`));
    });

  mcpCmd
    .command('remove <name>')
    .description('Remove an MCP server')
    .action((name: string) => {
      const config = new ConfigManager();
      config.removeMcpServer(name);
      console.log(t.success(`Removed MCP server: ${name}`));
    });

  // ACP configuration commands
  const acpCmd = configCmd.command('acp').description('ACP agent-to-agent configuration');

  acpCmd
    .command('list')
    .description('Show ACP status and registered agents')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      const acpCfg = cfg.acp || {};
      const acpStatus = acpCfg.enabled ? t.success('enabled') : t.textDim('disabled');
      console.log(t.heading('ACP Configuration:'));
      console.log(`  Status: ${acpStatus}`);
      console.log(`  Port: ${acpCfg.port || t.textDim('not set (default 3000)')}`);
      console.log(`  Skills path: ${acpCfg.skillsPath || t.textDim('not set')}`);
      const agents = acpCfg.agents || [];
      if (agents.length > 0) {
        console.log(t.heading(`  Agents (${agents.length}):`));
        for (const agent of agents) {
          console.log(`    ${t.entityName(agent.name)} (${agent.id})`);
          console.log(`      Endpoint: ${agent.endpoint}`);
          console.log(`      Capabilities: ${agent.capabilities.join(', ')}`);
        }
      } else {
        console.log(t.textDim('  No ACP agents configured'));
      }
    });

  acpCmd
    .command('enable')
    .description('Enable ACP mode in configuration')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      const acpConfig = cfg.acp || {};
      acpConfig.enabled = true;
      config.setAcpConfig(acpConfig);
      console.log(t.success('ACP mode enabled in configuration'));
    });

  acpCmd
    .command('disable')
    .description('Disable ACP mode in configuration')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      const acpConfig = cfg.acp || {};
      acpConfig.enabled = false;
      config.setAcpConfig(acpConfig);
      console.log(t.success('ACP mode disabled in configuration'));
    });

  acpCmd
    .command('add-agent <name>')
    .description('Add an ACP agent')
    .requiredOption('-e, --endpoint <url>', 'Agent endpoint URL')
    .requiredOption('-c, --capabilities <list>', 'Comma-separated capabilities (e.g., chat,code,mcp)')
    .action((name: string, options: { endpoint: string; capabilities: string }) => {
      const config = new ConfigManager();
      const cfg = config.get();
      const acpConfig = cfg.acp || {};
      const agents = acpConfig.agents || [];

      const id = name.toLowerCase().replace(/\s+/g, '-');
      agents.push({
        id,
        name,
        endpoint: options.endpoint,
        capabilities: options.capabilities.split(',').map((c: string) => c.trim()).filter(Boolean),
      });

      acpConfig.agents = agents;
      config.setAcpConfig(acpConfig);
      console.log(t.success(`Added ACP agent: ${name} (${id})`));
      console.log(t.textDim(`  Endpoint: ${options.endpoint}`));
      console.log(t.textDim(`  Capabilities: ${options.capabilities}`));
    });

  acpCmd
    .command('list-agents')
    .description('List registered ACP agents')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      const acpConfig = cfg.acp;
      const agents = acpConfig?.agents || [];

      if (agents.length === 0) {
        console.log(t.textDim('No ACP agents configured'));
        return;
      }

      console.log(t.heading(`ACP Agents (${agents.length}):`));
      for (const agent of agents) {
        console.log(`  ${t.entityName(agent.name)} (${agent.id})`);
        console.log(`    Endpoint: ${agent.endpoint}`);
        console.log(`    Capabilities: ${agent.capabilities.join(', ')}`);
      }
    });

  acpCmd
    .command('remove-agent <name>')
    .description('Remove an ACP agent')
    .action((name: string) => {
      const config = new ConfigManager();
      const cfg = config.get();
      const acpConfig = cfg.acp;
      if (!acpConfig?.agents || acpConfig.agents.length === 0) {
        console.log(t.textDim('No ACP agents configured'));
        return;
      }

      const id = name.toLowerCase().replace(/\s+/g, '-');
      const beforeCount = acpConfig.agents.length;
      acpConfig.agents = acpConfig.agents.filter((a) => a.id !== id && a.name !== name);

      if (acpConfig.agents.length === beforeCount) {
        console.log(t.warning(`Agent not found: ${name}`));
        return;
      }

      config.setAcpConfig(acpConfig);
      console.log(t.success(`Removed ACP agent: ${name}`));
    });

  // Native packages management (MCP servers + plugins)
  const nativeCmd = configCmd.command('native').description('Native package management (MCP servers and plugins)');

  nativeCmd
    .command('list')
    .description('List all available and installed native MCP tools and plugins')
    .action(() => {
      const native = new NativeManager();
      const available = native.listAvailable();
      const mcpPkgs = available.filter(p => p.type === 'mcp');
      const pluginPkgs = available.filter(p => p.type === 'plugin');

      console.log(t.heading(`Packages (${available.length}):\n`));

      console.log(t.heading('  MCP Servers:'));
      for (const pkg of mcpPkgs) {
        const installed = native.isInstalled(pkg.name) ? t.success(' [installed]') : '';
        console.log(`    ${t.entityName(pkg.name)}${installed}`);
        console.log(`      ${pkg.description}`);
        if (pkg.options && pkg.options.length > 0) {
          console.log(`      ${t.textDim('Options: ' + pkg.options.map(o => o.flag + ' <' + o.label + '>').join(', '))}`);
        }
        console.log();
      }

      console.log(t.heading('  Plugins:'));
      for (const pkg of pluginPkgs) {
        const installed = native.isInstalled(pkg.name) ? t.success(' [installed]') : '';
        console.log(`    ${t.entityName(pkg.name)}${installed}`);
        console.log(`      ${pkg.description}`);
        console.log();
      }

      console.log(t.textDim('  Install: nexus config native install <name>'));
      console.log(t.textDim('  Install all: nexus config native install --all'));
    });

  nativeCmd
    .command('install [name]')
    .description('Install a native MCP tool or plugin')
    .option('--all', 'Install all available packages')
    .option('--dir <path>', 'Allowed directory (for filesystem)')
    .option('--token <token>', 'GitHub token (for github)')
    .option('--db <path>', 'Database path (for sqlite)')
    .action(async (name: string | undefined, options: { all?: boolean; dir?: string; token?: string; db?: string }) => {
      const native = new NativeManager();

      if (options.all) {
        console.log(t.heading('Installing all packages...\n'));
        const results = await native.installAll();
        for (const r of results) {
          const icon = r.startsWith('✓') ? t.success(r[0]) : r.startsWith('✗') ? t.error(r[0]) : t.textDim(r[0]);
          console.log(`  ${icon}${r.slice(1)}`);
        }
        console.log(t.textDim('\nRestart the agent to activate newly installed packages.'));
        return;
      }

      if (!name) {
        console.log(t.warning('Usage: nexus config native install <name> [options]'));
        console.log(t.textDim('  Run `nexus config native list` to see available packages.'));
        return;
      }

      const pkg = native.getPackage(name);
      if (!pkg) {
        console.log(t.error(`Package "${name}" not found.`));
        console.log(t.textDim(`  Available: ${native.getAvailableNames().join(', ')}`));
        return;
      }

      const params: Record<string, string> = {};
      if (options.dir) params.dir = options.dir;
      if (options.token) params.token = options.token;
      if (options.db) params.db = options.db;

      try {
        const result = await native.install(name, params);
        console.log(t.success(result));
      } catch (err) {
        console.log(t.error(err instanceof Error ? err.message : String(err)));
      }
    });

  nativeCmd
    .command('search <query>')
    .description('Search for MCP tools and plugins from npm registry and GitHub')
    .action(async (query: string) => {
      const native = new NativeManager();

      console.log(t.heading(`Searching for "${query}"...\n`));

      try {
        const results = await native.search(query);

        if (results.length === 0) {
          console.log(t.textDim('No results found.'));
          return;
        }

        const npmResults = results.filter(r => r.source === 'npm');
        const ghResults = results.filter(r => r.source === 'github');
        const curatedResults = results.filter(r => r.source === 'curated');

        if (npmResults.length > 0) {
          console.log(t.heading(`  npm Registry (${npmResults.length}):`));
          for (const r of npmResults) {
            console.log(`    ${t.entityName(r.name)} ${t.textDim('v' + r.version)}`);
            console.log(`      ${r.description}`);
            console.log(`      ${t.textDim('Install:')} ${r.installHint}`);
            console.log();
          }
        }

        if (ghResults.length > 0) {
          const isPluginRepo = (r: SearchResult) =>
            r.installHint && (r.installHint.includes('~/.nexus') || r.installHint.includes('git clone'));
          const pluginRepoResults = ghResults.filter(isPluginRepo);
          const otherGhResults = ghResults.filter(r => !isPluginRepo(r));

          if (otherGhResults.length > 0) {
            console.log(t.heading(`  GitHub (${otherGhResults.length}):`));
            for (const r of otherGhResults) {
              console.log(`    ${t.entityName(r.name)} ${t.textDim(r.version)}`);
              console.log(`      ${r.description}`);
              console.log(`      ${t.textDim(r.url)}`);
              console.log();
            }
          }

          if (pluginRepoResults.length > 0) {
            console.log(t.heading(`  Plugin Repos (${pluginRepoResults.length}):`));
            for (const r of pluginRepoResults) {
              console.log(`    ${t.entityName(r.name)} ${t.textDim(r.version)}`);
              console.log(`      ${r.description}`);
              console.log(`      ${t.textDim(r.installHint)}`);
              console.log();
            }
          }
        }

        if (curatedResults.length > 0) {
          console.log(t.heading(`  Curated (${curatedResults.length}):`));
          for (const r of curatedResults) {
            const installed = native.isInstalled(r.name) ? t.success(' [installed]') : '';
            console.log(`    ${t.entityName(r.name)}${installed}`);
            console.log(`      ${r.description}`);
            console.log(`      ${t.textDim('Install:')} ${r.installHint}`);
            console.log();
          }
        }
      } catch (err) {
        console.log(t.error(`Search failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  nativeCmd
    .command('install-npm <package>')
    .description('Install an MCP server from npm marketplace (e.g., lsp-mcp-server)')
    .option('--token <token>', 'API token / environment variable')
    .action(async (pkg: string, options: { token?: string }) => {
      const native = new NativeManager();
      console.log(t.textDim(`Fetching ${pkg} from npm registry...`));
      try {
        const result = await native.installFromNpm(pkg, options.token ? { token: options.token } : undefined);
        console.log(t.success(result));
      } catch (err) {
        console.log(t.error(err instanceof Error ? err.message : String(err)));
      }
    });

  nativeCmd
    .command('install-gh <repo>')
    .description('Install an MCP server from GitHub (e.g., ktnyt/cclsp)')
    .option('--token <token>', 'GitHub token / environment variable')
    .action(async (repo: string, options: { token?: string }) => {
      const native = new NativeManager();
      console.log(t.textDim(`Cloning ${repo} from GitHub...`));
      try {
        const result = await native.installFromGitHub(repo, options.token ? { token: options.token } : undefined);
        console.log(t.success(result));
      } catch (err) {
        console.log(t.error(err instanceof Error ? err.message : String(err)));
      }
    });

  // Web UI
  configCmd
    .command('web')
    .description('Start the config management web UI')
    .option('-p, --port <port>', 'Port number', '3457')
    .action(async (options: { port: string }) => {
      const port = parseInt(options.port, 10) || 3457;
      console.log(t.textDim('Starting Config Web UI...'));
      const { startWebUi } = await import('../config/web.js');
      const server = await startWebUi(port);
      // Keep running until Ctrl+C
      await new Promise(() => {});
    });

  // OpenCode Zen authentication flow (Anthropic-compatible gateway)
  registerOpencodeZenCommand(configCmd);

  // Permission whitelist (白名单) management
  const permCmd = configCmd.command('permissions').description('Permission whitelist — pre-approve tools so the agent never prompts (e.g. edit mode)');

  permCmd
    .command('list')
    .description('Show current permission whitelist and mode')
    .action(() => {
      const config = new ConfigManager();
      const p = config.getPermissions();
      console.log(t.heading('Permissions:'));
      console.log(`  Mode: ${p.mode === 'auto' ? t.success('auto (whitelist active)') : t.textDim('prompt (always ask)')}`);
      if (p.allowlist.length === 0) {
        console.log(t.textDim('  Allowlist: (empty)'));
      } else {
        console.log('  Allowlist:');
        for (const name of p.allowlist) console.log(`    - ${name}`);
      }
    });

  permCmd
    .command('add <tool...>')
    .description('Add tool(s) to the permission whitelist')
    .action((tools: string[]) => {
      const config = new ConfigManager();
      const cur = config.getPermissions();
      const next = [...new Set([...cur.allowlist, ...tools])];
      config.setPermissions({ allowlist: next });
      console.log(t.success(`Added to whitelist: ${tools.join(', ')}`));
      console.log(t.textDim('Enable with: nexus config permissions enable'));
    });

  permCmd
    .command('remove <tool...>')
    .description('Remove tool(s) from the permission whitelist')
    .action((tools: string[]) => {
      const config = new ConfigManager();
      const cur = config.getPermissions();
      const next = cur.allowlist.filter((t) => !tools.includes(t));
      config.setPermissions({ allowlist: next });
      console.log(t.success(`Removed from whitelist: ${tools.join(', ')}`));
    });

  permCmd
    .command('enable')
    .description('Enable auto mode — whitelisted tools run without prompting')
    .action(() => {
      const config = new ConfigManager();
      const cur = config.getPermissions();
      if (cur.allowlist.length === 0) {
        console.log(t.warning('Allowlist is empty. Add tools first, e.g. nexus config permissions preset edit'));
        return;
      }
      config.setPermissions({ mode: 'auto' });
      console.log(t.success('Permission whitelist ENABLED (auto mode). Whitelisted tools will not prompt.'));
    });

  permCmd
    .command('disable')
    .description('Disable auto mode — revert to always prompting')
    .action(() => {
      const config = new ConfigManager();
      config.setPermissions({ mode: 'prompt' });
      console.log(t.success('Permission whitelist DISABLED (prompt mode). Tools will ask again.'));
    });

  permCmd
    .command('preset <name>')
    .description('Apply a built-in preset to the allowlist. Currently: edit')
    .action((name: string) => {
      const preset = PERMISSION_PRESETS[name];
      if (!preset) {
        console.log(t.error(`Unknown preset: "${name}". Available: ${Object.keys(PERMISSION_PRESETS).join(', ') || '(none)'}`));
        return;
      }
      const config = new ConfigManager();
      config.setPermissions({ allowlist: [...preset.allowlist] });
      console.log(t.success(`Applied preset "${name}": ${preset.description}`));
      console.log(t.textDim('Enable with: nexus config permissions enable'));
    });

  // Path whitelist for exec_command (auto-approve commands run inside these dirs)
  const pathCmd = permCmd.command('path').description('Manage exec safe-path whitelist (commands run inside these dirs are auto-approved)');

  pathCmd
    .command('list')
    .description('Show configured exec safe paths')
    .action(() => {
      const config = new ConfigManager();
      const p = config.getPermissions();
      console.log(t.heading('Exec safe paths:'));
      if (p.safePaths.length === 0) {
        console.log(t.textDim('  (none — exec_command always prompts)'));
      } else {
        for (const sp of p.safePaths) console.log(`    - ${sp}`);
      }
      console.log(t.textDim('  "." = agent start directory (pwd); "~" = home'));
    });

  pathCmd
    .command('add <path...>')
    .description('Add path(s) to the exec safe-path whitelist')
    .action((paths: string[]) => {
      const config = new ConfigManager();
      const cur = config.getPermissions();
      const next = [...new Set([...cur.safePaths, ...paths])];
      config.setPermissions({ safePaths: next });
      console.log(t.success(`Added safe path(s): ${paths.join(', ')}`));
    });

  pathCmd
    .command('remove <path...>')
    .description('Remove path(s) from the exec safe-path whitelist')
    .action((paths: string[]) => {
      const config = new ConfigManager();
      const cur = config.getPermissions();
      const next = cur.safePaths.filter((p) => !paths.includes(p));
      config.setPermissions({ safePaths: next });
      console.log(t.success(`Removed safe path(s): ${paths.join(', ')}`));
    });
}
