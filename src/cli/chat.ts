import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface, emitKeypressEvents } from 'readline';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, extname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Agent } from '../agent.js';
import { showWelcomeScreen, BorderMode } from './logo.js';

const execAsync = promisify(exec);

// ---- @file/@directory expansion ----

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tiff']);
const MAX_FILE_SIZE = 200 * 1024; // 200KB

function extractAtPaths(input: string): string[] {
  const paths: string[] = [];
  // Match @"quoted path" and @path (handles file.txt, dir/, path/to/file.ts#L10-20)
  const quoted = input.matchAll(/@"([^"]+)"/g);
  for (const m of quoted) paths.push(m[1]);

  const rest = input.replace(/@"[^"]+"/g, ''); // Remove quoted to avoid double-match
  const unquoted = rest.matchAll(/(?:^|\s)@([^\s]+)/g);
  for (const m of unquoted) paths.push(m[1].replace(/#\d+(?:-\d+)?$/, '')); // Strip line ranges

  return [...new Set(paths)];
}

function isBinaryFile(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

function expandAtMentions(input: string, cwd: string): string {
  const paths = extractAtPaths(input);
  if (paths.length === 0) return input;

  let context = '';
  for (const rawPath of paths) {
    const absPath = resolve(cwd, rawPath);
    if (!existsSync(absPath)) {
      context += `\n\n[File/Directory not found: ${rawPath}]`;
      continue;
    }

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      try {
        const entries = readdirSync(absPath, { withFileTypes: true });
        const list = entries.slice(0, 200).map(e => `${e.isDirectory() ? '/' : ''}${e.name}`).join('\n');
        const truncated = entries.length > 200 ? `\n... and ${entries.length - 200} more` : '';
        context += `\n\n[Directory: ${rawPath}]\n${list}${truncated}`;
      } catch (err) {
        context += `\n\n[Cannot read directory ${rawPath}: ${err instanceof Error ? err.message : String(err)}]`;
      }
    } else if (stat.size > MAX_FILE_SIZE) {
      context += `\n\n[File too large: ${rawPath} (${Math.round(stat.size / 1024)}KB, limit ${MAX_FILE_SIZE / 1024}KB)]`;
    } else if (isBinaryFile(absPath)) {
      context += `\n\n[Binary file: ${rawPath}]`;
    } else {
      try {
        const content = readFileSync(absPath, 'utf-8');
        context += `\n\n\`\`\`${extname(rawPath).slice(1) || 'text'}\n${content}\n\`\`\``;
      } catch (err) {
        context += `\n\n[Cannot read file ${rawPath}: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }
  }

  if (context) {
    return `${input}\n${context}`;
  }
  return input;
}

// ---- !bash command ----

async function executeBashCommand(cmd: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = stdout + (stderr ? `\n${stderr}` : '');
    return output.trim() || '(no output)';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stdout = (err as { stdout?: string }).stdout || '';
    const stderr = (err as { stderr?: string }).stderr || '';
    return `Error: ${msg}\n${stdout}${stderr}`;
  }
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session')
    .option('-s, --session <id>', 'Resume an existing session')
    .option('-m, --message <text>', 'Send a single message and exit')
    .option('--border-mode <mode>', 'Welcome border mode: auto|fill (default: fill)')
    .action(async (options) => {
      if (options.borderMode) {
        process.env.NEXUS_BORDER_MODE = options.borderMode;
      }
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

  const __dirname = dirname(fileURLToPath(import.meta.url));
  let version = '1.0.0';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    version = pkg.version ?? version;
  } catch {
    // Fall back to hard-coded version
  }

  const borderMode = (process.env.NEXUS_BORDER_MODE || 'fill') as BorderMode;
  showWelcomeScreen(
    {
      name: promptName,
      model: `${agent.provider.name} · ${agent.provider.model}`,
      cwd: process.cwd(),
      version,
      sessionId: id,
    },
    borderMode,
  );

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

    // ESC: interrupt current chat
    if (key.name === 'escape') {
      if (agent.isBusy()) {
        agent.abort();
        console.log(chalk.yellow('\n[Interrupted]'));
        rl.prompt();
      }
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

  const handleLine = async (line: string): Promise<boolean> => {
    if (agent.isBusy()) {
      // Drop spurious line events triggered by readline during reasoning
      return false;
    }

    const input = line.trim();
    promptHistoryIndex = -1;
    draftInput = '';
    if (!input) {
      rl.prompt();
      return false;
    }

    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, agent, rl);
      if (!handled) {
        rl.prompt();
      }
      return handled;
    }

    // !cmd: execute bash command directly (like Claude Code's ! prefix)
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) {
        rl.prompt();
        return false;
      }
      console.log(chalk.gray(`$ ${cmd}`));
      const output = await executeBashCommand(cmd);
      console.log(output);
      rl.prompt();
      return true;
    }

    // Expand @file/@directory references into inline context
    const expandedInput = expandAtMentions(input, process.cwd());

    process.stdout.write(chalk.yellow('agent> '));
    try {
      await agent.chat(expandedInput);
    } catch (err) {
      console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    }

    if (lastDetailMode !== agent.detailMode) {
      const label = agent.detailMode ? chalk.green('FULL') : chalk.yellow('COMPACT');
      console.log(chalk.gray(`[Detail mode: ${label}]`));
      lastDetailMode = agent.detailMode;
    }

    rl.prompt();
    return true;
  };

  rl.on('line', async (line) => {
    await handleLine(line);
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
      // Trigger close event instead of direct output
      rl.close();
      return true;

    case 'help':
      console.log(chalk.bold('Commands:'));
      console.log('  /exit, /quit  - Exit the agent');
      console.log('  /session      - Show current session ID');
      console.log('  /cls          - Clear the screen (history preserved in session file)');
      console.log('  /clear        - Clear the current context');
      console.log('  /provider     - Show the current provider');
      console.log('  /model        - Show or switch the current model');
      console.log('  /tools        - List available tools');
      console.log('  /mcp          - List MCP server connections');
      console.log('  /skills       - List loaded skills/plugins');
      console.log('  /plugins      - Alias for /skills');
      console.log(chalk.gray('\nInput prefixes:'));
      console.log(chalk.gray('  !<cmd>        - Execute a bash command'));
      console.log(chalk.gray('  @<path>       - Inline file/directory content into prompt'));
      console.log(chalk.gray('                 (also: @"path with spaces", @file.ts#L10-20)'));
      console.log(chalk.gray('\nShortcuts:'));
      console.log(chalk.gray(' PageUp        - Browse to older prompt in this session'));
      console.log(chalk.gray('PageDown      - Browse to newer prompt (or back to draft)'));
      console.log(chalk.gray('  Ctrl+O        - Toggle detail mode (compact / full)'));
      return false;

    case 'session':
      console.log(`Current session: ${agent.getCurrentSessionId()}`);
      return false;

    case 'cls':
      // Clear terminal display only — session history on disk is preserved
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
      rl.prompt();
      return true;

    case 'clear':
      agent.context.clear();
      console.log(chalk.gray('Context cleared.'));
      return false;

    case 'provider':
      console.log(`Provider: ${agent.provider.name} (${agent.provider.model})`);
      return false;

    case 'model':
      if (!args[0]) {
        console.log(`Current model: ${agent.provider.model}`);
      } else {
        const change = await agent.switchModel(args[0]);
        console.log(chalk.green(`Model switched: ${change}`));
      }
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
        console.log(chalk.bold(`Skills(skills.length}):`));
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
