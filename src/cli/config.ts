import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from '../config/index.js';
import { importFromClaude } from '../config/claude-import.js';

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Configuration management');

  configCmd
    .command('import-claude')
    .description('Import MCP servers and skills from Claude Code config (~/.claude.json)')
    .action(() => {
      const config = new ConfigManager();
      const result = importFromClaude(config, false);

      if (result.mcpImported > 0) {
        console.log(chalk.green(`\nImported ${result.mcpImported} MCP server(s) from Claude Code`));
      }
      if (result.skillsImported > 0) {
        console.log(chalk.green(`Imported ${result.skillsImported} skill(s) from Claude Code`));
      }
      if (result.mcpImported === 0 && result.skillsImported === 0) {
        console.log(chalk.gray('Nothing new to import from Claude Code config'));
      }
      if (result.mcpSkipped > 0 || result.skillsSkipped > 0) {
        console.log(chalk.gray(`Skipped: ${result.mcpSkipped} MCP, ${result.skillsSkipped} skills (already exist)`));
      }
    });

  configCmd
    .command('list')
    .description('List current configuration')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      console.log(chalk.bold('Configuration:'));
      console.log(`  Active provider: ${chalk.cyan(cfg.activeProvider)}`);
      console.log(`  Prompt name: ${chalk.cyan(cfg.promptName || 'you')}`);
      console.log(chalk.bold('  Providers:'));
      for (const [name, p] of Object.entries(cfg.providers)) {
        const marker = name === cfg.activeProvider ? chalk.green('*') : ' ';
        console.log(`    ${marker} ${name}: ${p.type} / ${p.model}`);
      }
      if (cfg.mcpServers) {
        console.log(chalk.bold('  MCP Servers:'));
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
      console.log(chalk.green(`Added provider: ${name} (${options.type} / ${options.model})`));
      if (options.baseUrl) {
        console.log(chalk.gray(`  Base URL: ${options.baseUrl}`));
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
        console.log(chalk.green(`Set ${key} = ${value}`));
        return;
      }

      if (key === 'activeProvider') {
        config.setActiveProvider(value);
        console.log(chalk.green(`Switched to provider: ${value}`));
        return;
      }

      console.log(chalk.yellow(`Unsupported config key: ${key}`));
    });

  configCmd
    .command('switch <provider>')
    .description('Switch active provider')
    .action((provider: string) => {
      const config = new ConfigManager();
      config.setActiveProvider(provider);
      console.log(chalk.green(`Switched to provider: ${provider}`));
    });

  configCmd
    .command('set-name <name>')
    .description('Set the chat prompt name (default: you)')
    .action((name: string) => {
      const config = new ConfigManager();
      config.setPromptName(name);
      console.log(chalk.green(`Chat prompt name set to: ${name}`));
    });

  const mcpCmd = configCmd.command('mcp').description('MCP server management');

  mcpCmd
    .command('list')
    .description('List MCP servers')
    .action(() => {
      const config = new ConfigManager();
      const servers = config.getMcpServers();
      if (!servers || Object.keys(servers).length === 0) {
        console.log(chalk.gray('No MCP servers configured.'));
        return;
      }
      console.log(chalk.bold('MCP Servers:'));
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
      console.log(chalk.green(`Added MCP server: ${name}`));
    });

  mcpCmd
    .command('remove <name>')
    .description('Remove an MCP server')
    .action((name: string) => {
      const config = new ConfigManager();
      config.removeMcpServer(name);
      console.log(chalk.green(`Removed MCP server: ${name}`));
    });
}
