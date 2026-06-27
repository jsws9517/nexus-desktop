import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface, emitKeypressEvents } from 'readline';
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
  const promptName = agent.config.getPromptName();
  console.log(chalk.green(`Session started: ${id}`));
  console.log(chalk.gray('Type /help for commands, /exit to quit'));
  console.log(chalk.gray('Use PageUp/PageDown to browse prompts, Ctrl+O to toggle detail mode\n'));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan(`${promptName}> `),
  });

  emitKeypressEvents(process.stdin, rl);

  // Prevent readline from intercepting our custom keys (Ctrl+O operate-and-get-next,
  // PageUp/PageDown history navigation). We handle them via keypress events.
  const originalTtyWrite = (rl as any)._ttyWrite.bind(rl);
  (rl as any)._ttyWrite = function (s: string, key: { name?: string; ctrl?: boolean }) {
    if (key && (key.name === 'pageup' || key.name === 'pagedown' || (key.ctrl && key.name === 'o'))) {
      return;
    }
    return originalTtyWrite(s, key);
  };

  let promptHistoryIndex = -1;
  let draftInput = '';

  function getUserMessages(): string[] {
    return agent.context.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
  }

  function setLine(text: string): void {
    process.nextTick(() => {
      rl.write(null, { ctrl: true, name: 'e' });
      rl.write(null, { ctrl: true, name: 'u' });
      rl.write(text);
    });
  }

  let lastDetailMode = agent.detailMode;

  process.stdin.on('keypress', (_str, key) => {
    if (key.ctrl && key.name === 'o') {
      const mode = agent.toggleDetailMode();
      const label = mode ? chalk.green('FULL') : chalk.yellow('COMPACT');
      if (agent.isBusy()) {
        // Suppress output during reasoning to avoid breaking compact progress
        return;
      }
      console.log(`\n[Detail mode: ${label}]`);
      rl.prompt();
      lastDetailMode = mode;
      return;
    }

    if (key.name === 'pageup') {
      const userMessages = getUserMessages();
      if (userMessages.length === 0) return;

      if (promptHistoryIndex === -1) {
        draftInput = rl.line;
      }

      const nextIndex = promptHistoryIndex + 1;
      if (nextIndex < userMessages.length) {
        promptHistoryIndex = nextIndex;
        setLine(userMessages[userMessages.length - 1 - promptHistoryIndex]);
      }
    } else if (key.name === 'pagedown') {
      if (promptHistoryIndex === -1) return;

      const userMessages = getUserMessages();
      const nextIndex = promptHistoryIndex - 1;
      if (nextIndex >= 0) {
        promptHistoryIndex = nextIndex;
        setLine(userMessages[userMessages.length - 1 - promptHistoryIndex]);
      } else {
        promptHistoryIndex = -1;
        setLine(draftInput);
      }
    }
  });

  rl.prompt();

  rl.on('line', async (line) => {
    if (agent.isBusy()) {
      // Drop spurious line events triggered by readline during reasoning
      return;
    }

    const input = line.trim();
    promptHistoryIndex = -1;
    draftInput = '';
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

    if (lastDetailMode !== agent.detailMode) {
      const label = agent.detailMode ? chalk.green('FULL') : chalk.yellow('COMPACT');
      console.log(chalk.gray(`[Detail mode: ${label}]`));
      lastDetailMode = agent.detailMode;
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
      console.log('  /mcp          - List MCP server connections');
      console.log('  /skills       - List loaded skills/plugins');
      console.log('  /plugins      - Alias for /skills');
      console.log(chalk.gray('\nShortcuts:'));
      console.log(chalk.gray('  PageUp        - Browse to older prompt in this session'));
      console.log(chalk.gray('  PageDown      - Browse to newer prompt (or back to draft)'));
      console.log(chalk.gray('  Ctrl+O        - Toggle detail mode (compact / full)'));
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

    case 'mcp':
      const conns = agent.mcp.listConnections();
      if (conns.length === 0) {
        console.log(chalk.gray('No external MCP servers connected.'));
      } else {
        console.log(chalk.bold(`MCP Servers (${conns.length}):`));
        for (const c of conns) {
          console.log(`  ${chalk.cyan(c.name)} - ${c.toolCount} tools [${c.status}]`);
        }
      }
      return false;

    case 'skills':
    case 'plugins':
      const skills = agent.skills.list();
      if (skills.length === 0) {
        console.log(chalk.gray('No skills loaded. Place modules in ~/.llm-agent/skills/'));
      } else {
        console.log(chalk.bold(`Skills (${skills.length}):`));
        for (const s of skills) {
          console.log(`  ${chalk.cyan(s.name)} v${s.version}${s.description ? ' - ' + s.description : ''}`);
        }
      }
      return false;

    default:
      console.log(chalk.yellow(`Unknown command: /${cmd}`));
      return false;
  }
}
