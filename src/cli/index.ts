#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
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

// Default command: chat
program.action(async () => {
  const { startInteractiveChat } = await import('./chat.js');
  const opts = program.opts();
  const enableAcp = opts.acp === true ? true : opts.acp === false ? false : undefined;
  await startInteractiveChat(undefined, enableAcp);
});

program.parse();
