import { Command } from 'commander';
import { ConfigManager } from '../config/index.js';
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
    .requiredOption('-k, --apiKey <key>', 'API key')
    .requiredOption('-m, --model <model>', 'Model name')
    .option('-u, --baseUrl <url>', 'Custom base URL (for compatible APIs)')
    .action((name: string, options: { type: string; apiKey: string; model: string; baseUrl?: string }) => {
      const config = new ConfigManager();
      config.setProvider(name, {
        type: options.type as 'anthropic' | 'openai' | 'custom',
        apiKey: options.apiKey,
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
}
