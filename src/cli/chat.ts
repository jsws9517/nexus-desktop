import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { Agent } from '../agent.js';

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session')
    .option('-s, --session <id>', 'Resume an existing session')
    .option('-m, --message <text>', 'Send a single message and exit')
    .action(async (options) => {
      if (options.message) {
        await runSingleMessage(options.message, options.session);
      } else {
        await startInteractiveChat(options.session);
      }
    });

  program
    .command('run <prompt>')
    .description('Execute a single prompt and exit')
    .action(async (prompt: string) => {
      await runSingleMessage(prompt);
    });
}

export async function startInteractiveChat(sessionId?: string): Promise<void> {
  const agent = new Agent();
  await agent.init();

  const id = await agent.startSession(undefined, sessionId);
  console.log(chalk.green(`Session started: ${id}`));
  console.log(chalk.gray('Type /help for commands, /exit to quit\n'));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('you> '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, agent, rl);
      if (!handled) {
        rl.prompt();
      }
      return;
    }

    process.stdout.write(chalk.yellow('agent> '));
    try {
      await agent.chat(input);
    } catch (err) {
      console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    console.log(chalk.gray('\nGoodbye!'));
    await agent.shutdown();
    process.exit(0);
  });
}

async function runSingleMessage(message: string, sessionId?: string): Promise<void> {
  const agent = new Agent();
  await agent.init();
  await agent.startSession(undefined, sessionId);

  try {
    await agent.chat(message);
  } catch (err) {
    console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  } finally {
    await agent.shutdown();
  }
}

async function handleSlashCommand(input: string, agent: Agent, rl: ReturnType<typeof createInterface>): Promise<boolean> {
  const [cmd, ...args] = input.slice(1).split(' ');

  switch (cmd) {
    case 'exit':
    case 'quit':
      console.log(chalk.gray('Goodbye!'));
      await agent.shutdown();
      rl.close();
      return true;

    case 'help':
      console.log(chalk.bold('Commands:'));
      console.log('  /exit, /quit  - Exit the agent');
      console.log('  /session      - Show current session ID');
      console.log('  /clear        - Clear the current context');
      console.log('  /provider     - Show current provider');
      console.log('  /tools        - List available tools');
      return false;

    case 'session':
      console.log(`Current session: ${agent.getCurrentSessionId()}`);
      return false;

    case 'clear':
      agent.context.clear();
      console.log(chalk.gray('Context cleared.'));
      return false;

    case 'provider':
      console.log(`Provider: ${agent.provider.name} (${agent.provider.model})`);
      return false;

    case 'tools':
      const tools = [...agent.mcp.getAllTools(), ...agent.skills.getTools()];
      console.log(chalk.bold(`Available tools (${tools.length}):`));
      for (const t of tools) {
        console.log(`  ${chalk.cyan(t.name)} - ${t.description}`);
      }
      return false;

    default:
      console.log(chalk.yellow(`Unknown command: /${cmd}`));
      return false;
  }
}
