import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync, mkdirSync, cpSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ConfigManager } from '../config/index.js';

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('Configuration management');

  configCmd
    .command('import-claude')
    .description('Import MCP servers and skills from Claude Code config (~/.claude.json)')
    .action(() => {
      const config = new ConfigManager();
      const claudeJsonPath = join(homedir(), '.claude.json');
      const claudeSkillsDir = join(homedir(), '.claude', 'skills');
      const agentSkillsDir = join(homedir(), '.llm-agent', 'skills');

      let importedMcp = 0;
      let skippedMcp = 0;
      let importedSkills = 0;
      let skippedSkills = 0;

      // ---- Import MCP Servers ----
      if (existsSync(claudeJsonPath)) {
        try {
          const claudeConfig = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'));
          const mcpServers = claudeConfig.mcpServers || {};

          for (const [name, srv] of Object.entries(mcpServers)) {
            const server = srv as Record<string, unknown>;
            const command = String(server.command || '');
            if (!command) {
              skippedMcp++;
              continue;
            }
            // Skip if already exists
            const existing = config.getMcpServers();
            if (existing && name in existing) {
              console.log(chalk.gray(`  MCP "${name}" already exists, skipping`));
              skippedMcp++;
              continue;
            }
            config.addMcpServer(name, {
              command,
              args: Array.isArray(server.args) ? server.args.map(String) : undefined,
              env: server.env && typeof server.env === 'object'
                ? Object.fromEntries(Object.entries(server.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
                : undefined,
              autoStart: true,
            });
            console.log(chalk.green(`  + MCP "${name}"`));
            importedMcp++;
          }
        } catch (err) {
          console.log(chalk.red(`Failed to read ~/.claude.json: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else {
        console.log(chalk.yellow('~/.claude.json not found'));
      }

      // ---- Import Skills ----
      // Claude Code skills are in ~/.claude/skills/ with index.json
      if (existsSync(claudeSkillsDir)) {
        const indexPath = join(claudeSkillsDir, 'index.json');
        if (existsSync(indexPath)) {
          try {
            const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
            const skills = index.skills || [];
            mkdirSync(agentSkillsDir, { recursive: true });

            // Copy index.json for loader metadata
            try {
              cpSync(indexPath, join(agentSkillsDir, 'index.json'));
            } catch {
              // Non-fatal
            }

            for (const skill of skills) {
              const skillName = skill.name;
              const skillPath = join(claudeSkillsDir, skill.path.replace(/^\.\//, ''));

              const targetDir = join(agentSkillsDir, skillName);
              if (existsSync(targetDir)) {
                console.log(chalk.gray(`  Skill "${skillName}" already exists, skipping`));
                skippedSkills++;
                continue;
              }

              // Copy skill directory (both JS and SKILL.md formats)
              try {
                cpSync(skillPath, targetDir, { recursive: true });
                console.log(chalk.green(`  + Skill "${skillName}"`));
                importedSkills++;
              } catch {
                skippedSkills++;
              }
            }
          } catch (err) {
            console.log(chalk.red(`Failed to read skills index: ${err instanceof Error ? err.message : String(err)}`));
          }
        } else {
          console.log(chalk.yellow('No skills/index.json found in ~/.claude/skills/'));
        }
      } else {
        console.log(chalk.yellow('~/.claude/skills/ not found'));
      }

      console.log(chalk.bold('\nImport Summary:'));
      console.log(`  MCP servers: ${chalk.green(importedMcp + ' imported')}, ${chalk.gray(skippedMcp + ' skipped')}`);
      console.log(`  Skills: ${chalk.green(importedSkills + ' imported')}, ${chalk.gray(skippedSkills + ' skipped')}`);
      console.log(chalk.gray('  JS skills expose tools; SKILL.md skills provide context via init()'));

    });

  configCmd
    .command('list')
    .description('List current configuration')
    .action(() => {
      const config = new ConfigManager();
      const cfg = config.get();
      console.log(chalk.bold('Configuration:'));
      console.log(`  Active provider: ${chalk.cyan(cfg.activeProvider)}`);
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

      if (parts.length === 2 && parts[0] === 'provider') {
        // e.g. config set provider.openai.model gpt-4o
        const providerName = parts[1];
        const field = parts[2];
        if (field) {
          config.setProviderField(providerName, field, value);
          console.log(chalk.green(`Set ${key} = ${value}`));
          return;
        }
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
