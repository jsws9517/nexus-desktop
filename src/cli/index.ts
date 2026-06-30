#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerChatCommand } from './chat.js';
import { registerSessionCommand } from './session.js';
import { registerConfigCommand } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let cliVersion = '1.0.0';
for (const candidate of [
  join(__dirname, '..', '..', '..', 'package.json'),
  join(__dirname, '..', '..', 'package.json'),
]) {
  try {
    const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
    if (pkg?.name === 'nexus-coder' && pkg?.version) {
      cliVersion = pkg.version;
      break;
    }
  } catch {
    // Try next candidate
  }
}

const program = new Command();

program
  .name('agent')
  .description('LLM Code Agent - A simple CLI agent with MCP, Skills, and ACP support')
  .version(cliVersion)
  .option('--acp', 'Enable ACP agent-to-agent communication')
  .option('--no-acp', 'Explicitly disable ACP mode');

registerChatCommand(program);
registerSessionCommand(program);
registerConfigCommand(program);

// Default command: chat or ACP server
program.action(async () => {
  const opts = program.opts();
  const enableAcp = opts.acp === true ? true : opts.acp === false ? false : undefined;

  if (enableAcp === true) {
    // ACP server mode: stdio JSON-RPC
    const { Agent } = await import('../agent.js');
    const { AcpServer } = await import('../acp/server.js');
    const agent = new Agent(true, true);
    await agent.init();
    const server = new AcpServer(agent);
    await server.start();
    await agent.shutdown();
    return;
  }

  const { startInteractiveChat } = await import('./chat.js');
  await startInteractiveChat(undefined, enableAcp);
});

program.parse();
