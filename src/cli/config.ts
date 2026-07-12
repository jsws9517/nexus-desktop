import { Command } from 'commander';
import { createInterface } from 'readline';
import { ConfigManager } from '../config/index.js';
import { NativeManager, SearchResult } from '../config/native.js';
import { importFromClaude } from '../config/claude-import.js';
import { ThemeManager } from '../theme/manager.js';

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
      console.log(t.heading('  Providers:'));
      for (const [name, p] of Object.entries(cfg.providers)) {
        const marker = name === cfg.activeProvider ? t.success('*') : ' ';
        const base = p.baseUrl ? t.textDim(` [${p.baseUrl}]`) : '';
        console.log(`    ${marker} ${name}: ${p.type} / ${p.model}${base}`);
      }
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
    .command('pkg')
    .description('List all available MCP tools and plugins that can be installed')
    .action(() => {
      const native = new NativeManager();
      const available = native.listAvailable();
      const mcpPkgs = available.filter(p => p.type === 'mcp');
      const pluginPkgs = available.filter(p => p.type === 'plugin');

      console.log(t.heading(`Available Packages (${available.length}):\n`));

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

      console.log(t.heading('  Plugins (Skills):'));
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
        console.log(t.textDim('  Run `nexus config native pkg` to see available packages.'));
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
    .command('list')
    .description('List installed native MCP tools and plugins')
    .action(() => {
      const native = new NativeManager();
      const installed = native.listInstalled();

      if (installed.length === 0) {
        console.log(t.textDim('No packages installed.'));
        console.log(t.textDim('  Run `nexus config native pkg` to see available packages.'));
        return;
      }

      console.log(t.heading(`Installed Packages (${installed.length}):\n`));
      for (const pkg of installed) {
        const label = pkg.type === 'mcp' ? t.textDim('[MCP]') : t.textDim('[Plugin]');
        console.log(`  ${t.entityName(pkg.name)} ${label}`);
        console.log(`    ${pkg.description}`);
        console.log();
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
}
