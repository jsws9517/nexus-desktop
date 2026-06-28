#!/usr/bin/env node
import { Command } from 'commander';
import { registerChatCommand } from './chat.js';
import { registerSessionCommand } from './session.js';
import { registerConfigCommand } from './config.js';

const program = new Command();

program
  .name('agent')
  .description('LLM Code Agent - A simple CLI agent with MCP, Skills, and ACP support')
  .version('1.0.0')
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
    const agent = new Agent(true);
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
