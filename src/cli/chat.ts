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
      const globalOpts = program.opts();
      const enableAcp = globalOpts.acp === true ? true : globalOpts.acp === false ? false : undefined;
      if (options.message) {
        await runSingleMessage(options.message, options.session, enableAcp);
      } else {
        await startInteractiveChat(options.session, enableAcp);
      }
    });

  program
    .command('run <prompt>')
    .description('Execute a single prompt and exit')
    .action(async (prompt: string) => {
      const globalOpts = program.opts();
      const enableAcp = globalOpts.acp === true ? true : globalOpts.acp === false ? false : undefined;
      await runSingleMessage(prompt, undefined, enableAcp);
    });
}

export async function startInteractiveChat(sessionId?: string, enableAcp?: boolean): Promise<void> {
  const agent = new Agent(enableAcp);
  await agent.init();

  const id = await agent.startSession(undefined, sessionId);
  const promptName = agent.config.getPromptName();

  const __dirname = dirname(fileURLToPath(import.meta.url));
  let version = '1.0.0';
  for (const candidate of [
    join(__dirname, '..', '..', '..', 'package.json'),
    join(__dirname, '..', '..', 'package.json'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (pkg?.name === 'nexus-coder' && pkg?.version) {
        version = pkg.version;
        break;
      }
    } catch {
      // Try next candidate
    }
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

  // Show hint when active provider has no API key configured
  const activeProvider = agent.config.getProvider();
  if (!activeProvider.apiKey) {
    console.log(chalk.dim('  Tip: Run') + ' agent config detect-local ' + chalk.dim('to connect to a local LLM proxy'));
    console.log('');
  }

  // ---- Custom multi-line input handler ----
  // Fully replaces readline's line-by-line processing with a keypress-driven
  // system that supports:
  //   Enter       — submit the input buffer (ignored if empty/whitespace)
  //   Ctrl+Enter  — insert newline for multi-line input
  //   PageUp/Down — navigate prompt history
  //   Paste       — auto-detected; during paste Enter inserts \n instead of submitting

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  emitKeypressEvents(process.stdin, rl);

  // Completely suppress readline's internal line processing.
  // We handle all input via raw keypress events below.
  (rl as any)._ttyWrite = function () {};

  let promptHistoryIndex = -1;
  let draftInput = '';

  function getUserMessages(): string[] {
    return agent.context.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
  }

  // --- Multi-line input state ---
  let inputBuffer = '';
  let prevContentLines = 0;
  const INDENT = promptName.length + 2; // "name> " width

  // Paste detection: rapid keypresses within PASTE_MS window
  const PASTE_MS = 150;
  let lastKeypressTime = 0;
  let isPasteMode = false;
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;

  const promptLabel = () => chalk.cyan(`${promptName}> `);

  function countContentLines(text: string): number {
    if (!text) return 0;
    const cols = process.stdout.columns || 80;
    const segments = text.split('\n');
    let lines = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (i === 0) {
        const avail = cols - INDENT;
        if (avail <= 0) {
          lines += Math.max(1, Math.ceil(seg.length / cols));
        } else if (seg.length > avail) {
          lines += Math.ceil((seg.length - avail) / cols);
        }
      } else {
        lines += Math.max(1, Math.ceil(seg.length / cols));
      }
    }
    return lines;
  }

  function renderInput(text: string): void {
    if (prevContentLines > 0) {
      process.stdout.write(`\x1B[${prevContentLines}A`);
    }
    process.stdout.write('\r\x1B[J');
    if (text) {
      const display = text.replace(/\n/g, '\n' + ' '.repeat(INDENT));
      process.stdout.write(`${promptLabel()}${display}`);
    } else {
      process.stdout.write(promptLabel());
    }
    prevContentLines = countContentLines(text);
  }

  // --- Interactive question mode (for /resume, /history delete) ---
  let isQuestionMode = false;

  async function customQuestion(query: string): Promise<string> {
    process.stdout.write(query);
    return new Promise<string>((resolve) => {
      let answer = '';
      isQuestionMode = true;
      const handler = (str: string | undefined, k: any) => {
        if (!k) return;
        if (k.name === 'enter' && !k.ctrl) {
          process.stdin.removeListener('keypress', handler);
          process.stdout.write('\n');
          isQuestionMode = false;
          resolve(answer);
          return;
        }
        if (k.name === 'escape') {
          process.stdin.removeListener('keypress', handler);
          isQuestionMode = false;
          resolve('');
          return;
        }
        if (k.ctrl && k.name === 'c') {
          process.stdin.removeListener('keypress', handler);
          isQuestionMode = false;
          rl.close();
          resolve('');
          return;
        }
        if (k.name === 'backspace') {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            process.stdout.write('\b \b');
          }
          return;
        }
        if (typeof str === 'string' && str.length === 1 && !k.ctrl && !k.meta) {
          answer += str;
          process.stdout.write(str);
        }
      };
      process.stdin.on('keypress', handler);
    });
  }

  let lastDetailMode = agent.detailMode;

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;
    if (isQuestionMode) return;

    // Paste burst detection
    const now = Date.now();
    const inPasteBurst = (now - lastKeypressTime) < PASTE_MS;
    lastKeypressTime = now;

    if (inPasteBurst && key.name !== 'enter') {
      isPasteMode = true;
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        isPasteMode = false;
        pasteTimer = null;
      }, PASTE_MS);
    }

    // Ctrl+O: toggle detail mode
    if (key.ctrl && key.name === 'o') {
      const mode = agent.toggleDetailMode();
      const label = mode ? chalk.green('FULL') : chalk.yellow('COMPACT');
      if (agent.isBusy()) return;
      process.stdout.write('\n');
      console.log(`[Detail mode: ${label}]`);
      renderInput(inputBuffer);
      lastDetailMode = mode;
      return;
    }

    // ESC: interrupt current chat
    if (key.name === 'escape') {
      if (agent.isBusy()) {
        agent.abort();
        process.stdout.write('\n');
        console.log(chalk.yellow('[Interrupted]'));
        renderInput(inputBuffer);
      }
      return;
    }

    // Ctrl+C: exit
    if (key.ctrl && key.name === 'c') {
      rl.close();
      return;
    }

    // PageUp: navigate to older prompt in history
    if (key.name === 'pageup') {
      const userMessages = getUserMessages();
      if (userMessages.length === 0) return;
      if (promptHistoryIndex === -1) draftInput = inputBuffer;
      const nextIndex = promptHistoryIndex + 1;
      if (nextIndex < userMessages.length) {
        promptHistoryIndex = nextIndex;
        inputBuffer = userMessages[userMessages.length - 1 - promptHistoryIndex]!;
        renderInput(inputBuffer);
      }
      return;
    }

    // PageDown: navigate to newer prompt (or back to draft)
    if (key.name === 'pagedown') {
      if (promptHistoryIndex === -1) return;
      const userMessages = getUserMessages();
      const nextIndex = promptHistoryIndex - 1;
      if (nextIndex >= 0) {
        promptHistoryIndex = nextIndex;
        inputBuffer = userMessages[userMessages.length - 1 - promptHistoryIndex]!;
        renderInput(inputBuffer);
      } else {
        promptHistoryIndex = -1;
        inputBuffer = draftInput;
        renderInput(inputBuffer);
      }
      return;
    }

    // Enter (without Ctrl): submit
    // During paste mode, Enter inserts \n instead of submitting
    if (key.name === 'enter' && !key.ctrl) {
      if (isPasteMode) {
        inputBuffer += '\n';
        renderInput(inputBuffer);
      } else {
        if (inputBuffer.trim().length === 0) {
          renderInput(inputBuffer);
        } else {
          const line = inputBuffer;
          inputBuffer = '';
          prevContentLines = 0;
          process.stdout.write('\n');
          handleLine(line);
        }
      }
      return;
    }

    // Ctrl+Enter: insert newline into the buffer
    if (key.name === 'enter' && key.ctrl) {
      inputBuffer += '\n';
      renderInput(inputBuffer);
      return;
    }

    // Backspace: remove last character
    if (key.name === 'backspace') {
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1);
        renderInput(inputBuffer);
      }
      return;
    }

    // Tab: insert 2 spaces
    if (key.name === 'tab') {
      inputBuffer += '  ';
      renderInput(inputBuffer);
      return;
    }

    // Regular printable characters
    if (str && str.length === 1 && !key.ctrl && !key.meta) {
      inputBuffer += str;
      renderInput(inputBuffer);
      return;
    }
  });

  renderInput('');

  const handleLine = async (line: string): Promise<void> => {
    if (agent.isBusy()) return;

    const input = line.trim();
    promptHistoryIndex = -1;
    draftInput = '';
    if (!input) return;

    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, agent, rl, customQuestion);
      if (!handled) {
        renderInput(inputBuffer);
      }
      return;
    }

    // !cmd: execute bash command directly
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      console.log(chalk.gray(`$ ${cmd}`));
      const output = await executeBashCommand(cmd);
      console.log(output);
      return;
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
  };

  rl.on('close', async () => {
    console.log(chalk.gray('\nGoodbye!'));
    await agent.shutdown();
    process.exit(0);
  });
}

async function runSingleMessage(message: string, sessionId?: string, enableAcp?: boolean): Promise<void> {
  const agent = new Agent(enableAcp);
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

async function handleSlashCommand(input: string, agent: Agent, rl: ReturnType<typeof createInterface>, customQuestion?: (query: string) => Promise<string>): Promise<boolean> {
  const [cmd, ...args] = input.slice(1).split(' ');

  switch (cmd) {
    case 'exit':
    case 'quit':
      rl.close();
      return true;

    case 'help':
      console.log(chalk.bold('Commands:'));
      console.log('  /exit, /quit     - Exit the agent');
      console.log('  /session         - Show current session ID');
      console.log('  /cls             - Clear the screen (history preserved in session file)');
      console.log('  /clear           - Clear the current context');
      console.log('  /compact         - Compress current session history');
      console.log('  /new             - Compress history and start a new session');
      console.log('  /provider        - Show the current provider');
      console.log('  /model           - Show or switch the current model');
      console.log('  /rename <name>   - Rename the current session');
      console.log('  /resume          - Browse and resume a previous session');
      console.log('  /history [delete <ids>] - View/delete session history');
      console.log('  /tools           - List available tools');
      console.log('  /mcp             - List MCP server connections');
      console.log('  /skills          - List loaded skills/plugins');
      console.log('  /plugins         - Alias for /skills');
      console.log(chalk.gray('\nInput prefixes:'));
      console.log(chalk.gray('  !<cmd>          - Execute a bash command'));
      console.log(chalk.gray('  @<path>         - Inline file/directory content into prompt'));
      console.log(chalk.gray('                   (also: @"path with spaces", @file.ts#L10-20)'));
      console.log(chalk.gray('\nShortcuts:'));
      console.log(chalk.gray(' PageUp           - Browse to older prompt in this session'));
      console.log(chalk.gray('PageDown         - Browse to newer prompt (or back to draft)'));
      console.log(chalk.gray('  Ctrl+O          - Toggle detail mode (compact / full)'));
      console.log(chalk.gray('\nInput:'));
      console.log(chalk.gray('  Enter           - Submit prompt (ignored if empty)'));
      console.log(chalk.gray('  Ctrl+Enter      - Newline (continue input)'));
      console.log(chalk.gray('  Paste           - Auto-detected, Enter inserts newline'));
      return false;

    case 'session': {
      const sessionId = agent.getCurrentSessionId();
      const sessionInfo = sessionId ? agent.session.get(sessionId) : undefined;
      const sessionName = sessionInfo?.name || '(unnamed)';

      const msgs = agent.context.getMessages();
      let summary = '';
      for (const m of msgs) {
        if (m.role === 'system' && m.content.includes('[Previous conversation summary]')) {
          summary = m.content.replace('[Previous conversation summary]: ', '').slice(0, 20);
          break;
        }
        if (m.content.length > 20) {
          summary = m.content.slice(0, 20);
          break;
        }
      }

      console.log(`  Name:    ${sessionName}`);
      console.log(`  ID:      ${sessionId}`);
      console.log(`  Summary: ${summary || '(empty)'}`);
      return false;
    }

    case 'cls':
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
      return false;

    case 'rename':
      if (!args[0]) {
        console.log(chalk.yellow('Usage: /rename <new-session-name>'));
      } else {
        const newName = args.join(' ');
        agent.renameSession(newName);
        console.log(chalk.green(`Session renamed to: ${newName}`));
      }
      return false;

    case 'resume': {
      const sessions = agent.session.list();
      if (sessions.length === 0) {
        console.log(chalk.gray('No sessions found.'));
        return false;
      }

      const currentId = agent.getCurrentSessionId();
      const maxTokens = agent.config.getProvider().maxContextTokens || 8192;

      console.log(chalk.bold('Sessions:'));
      console.log(chalk.dim('  #   Name                       Model                Updated              Tokens'));
      console.log(chalk.dim('  --- ---------------------------- -------------------- -------------------- ------'));
      const rows: { id: string; name: string; model: string; updatedAt: string; tokens: number }[] = [];
      for (const s of sessions) {
        const tokens = agent.session.getTokenEstimate(s.id, agent.provider);
        const date = new Date(s.updatedAt).toLocaleString();
        const name = s.name.slice(0, 28).padEnd(28);
        const model = s.model.slice(0, 18).padEnd(18);
        const dateStr = date.slice(0, 18).padEnd(18);
        const current = s.id === currentId ? chalk.green(' <- current') : '';
        const warn = tokens > maxTokens ? chalk.yellow(' !') : '';
        console.log(`  ${String(rows.length + 1).padStart(3)} ${chalk.cyan(name)} ${model} ${dateStr} ${String(tokens).padStart(6)}${warn}${current}`);
        rows.push({ id: s.id, name: s.name, model: s.model, updatedAt: date, tokens });
      }

      console.log();
      const answer = await (customQuestion!)(chalk.cyan('Enter number (or Esc to cancel): '));

      const num = parseInt(answer.trim(), 10);
      if (isNaN(num) || num < 1 || num > rows.length) {
        console.log(chalk.gray('Cancelled.'));
        return false;
      }

      const selected = rows[num - 1]!;
      console.log(chalk.gray(`Resuming "${selected.name}" (${selected.tokens} tokens)...`));

      try {
        const result = await agent.resumeSession(selected.id);
        if (!result.restored) {
          console.log(chalk.red('Session not found.'));
        } else if (result.compressed) {
          console.log(chalk.yellow(`Session "${result.sessionName}" resumed (history compressed -- ${selected.tokens} tokens exceeded ${maxTokens} limit)`));
        } else {
          console.log(chalk.green(`Session "${result.sessionName}" resumed successfully.`));
        }
      } catch (err) {
        console.log(chalk.red(`Resume failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }

    case 'history': {
      const subCmd = args[0];

      // --- /history delete <ids> ---
      if (subCmd === 'delete') {
        const spec = args.slice(1).join(' ');
        const allSessions = agent.session.list();
        if (allSessions.length === 0) {
          console.log(chalk.gray('No sessions found.'));
          return false;
        }
        const currentId = agent.getCurrentSessionId();

        let toDelete: { id: string; name: string; index: number }[] = [];

        if (spec === '.') {
          toDelete = allSessions
            .map((s, i) => ({ id: s.id, name: s.name, index: i + 1 }))
            .filter(s => s.id !== currentId);
        } else {
          const ids = parseIdSpec(spec, allSessions.length);
          if (ids === null) return false;
          toDelete = ids.map(i => ({ id: allSessions[i - 1]!.id, name: allSessions[i - 1]!.name, index: i }));
        }

        if (toDelete.length === 0) {
          console.log(chalk.gray('No sessions to delete.'));
          return false;
        }

        const names = toDelete.map(s => s.name);
        console.log(chalk.yellow(`Delete ${toDelete.length} session(s): ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` ... +${names.length - 10} more` : ''}?`));

        const confirm = await (customQuestion!)(chalk.yellow('  Confirm? (y/N): '));

        if (confirm.trim().toLowerCase() !== 'y') {
          console.log(chalk.gray('Cancelled.'));
          return false;
        }

        for (const s of toDelete) {
          agent.session.delete(s.id);
        }
        console.log(chalk.green(`Deleted ${toDelete.length} session(s).`));
        return false;
      }

      // --- /history (list + interactive delete) ---
      let allSessions = agent.session.list();
      if (allSessions.length === 0) {
        console.log(chalk.gray('No sessions found.'));
        return false;
      }

      const currentId = agent.getCurrentSessionId();
      const MAX_SHOW = 20;
      let displaySessions = allSessions.slice(0, MAX_SHOW);

      const renderTable = () => {
        console.log(chalk.bold(`\nSession History (showing ${displaySessions.length}/${allSessions.length}):`));
        console.log(chalk.dim('  #    Name                       Model                Updated              Tokens'));
        console.log(chalk.dim('  ---- ---------------------------- -------------------- -------------------- ------'));
        for (let i = 0; i < displaySessions.length; i++) {
          const s = displaySessions[i]!;
          const tokens = agent.session.getTokenEstimate(s.id, agent.provider);
          const date = new Date(s.updatedAt).toLocaleString();
          const name = s.name.slice(0, 28).padEnd(28);
          const model = s.model.slice(0, 18).padEnd(18);
          const dateStr = date.slice(0, 18).padEnd(18);
          const current = s.id === currentId ? chalk.green(' <- current') : '';
          console.log(`  ${String(i + 1).padStart(4)} ${chalk.cyan(name)} ${model} ${dateStr} ${String(tokens).padStart(6)}${current}`);
        }
        if (allSessions.length > MAX_SHOW) {
          console.log(chalk.dim(`  ... and ${allSessions.length - MAX_SHOW} more older sessions`));
        }
        console.log(chalk.dim('\n  Enter session # to delete (comma-separated or range like 1-3), or Enter to exit:'));
      };

      renderTable();

      while (true) {
        const input = await (customQuestion!)(chalk.red('  delete> '));

        const trimmed = input.trim();
        if (!trimmed) {
          console.log(chalk.gray('Exited history.'));
          break;
        }

        const ids = parseIdSpec(trimmed, allSessions.length);
        if (ids === null) continue;

        const toDelete = ids.map(i => ({ id: allSessions[i - 1]!.id, name: allSessions[i - 1]!.name }));
        const names = toDelete.map(s => s.name);
        console.log(chalk.yellow(`  About to delete ${toDelete.length} session(s): ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` ... +${names.length - 10} more` : ''}`));

        const confirm = await (customQuestion!)(chalk.yellow('  Confirm? (y/N): '));

        if (confirm.trim().toLowerCase() !== 'y') {
          console.log(chalk.gray('  Cancelled.'));
        } else {
          for (const s of toDelete) {
            agent.session.delete(s.id);
          }
          console.log(chalk.green(`  Deleted ${toDelete.length} session(s).`));

          allSessions = agent.session.list();
          if (allSessions.length === 0) {
            console.log(chalk.gray('  No sessions remaining.'));
            break;
          }
          displaySessions = allSessions.slice(0, MAX_SHOW);
          renderTable();
        }
      }
      return false;
    }

    case 'clear':
      agent.context.clear();
      console.log(chalk.gray('Context cleared.'));
      return false;

    case 'compact': {
      const msgs = agent.context.getMessages();
      if (msgs.length < 4) {
        console.log(chalk.gray('Not enough history to compress.'));
        return false;
      }
      console.log(chalk.gray('Compressing history...'));
      try {
        await agent.context.compress();
        const after = agent.context.getMessages();
        console.log(chalk.green(`Compressed ${msgs.length} -> ${after.length} messages.`));
      } catch (err) {
        console.log(chalk.red(`Compression failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }

    case 'new': {
      const msgs = agent.context.getMessages();
      if (msgs.length >= 4) {
        console.log(chalk.gray('Compressing history before new session...'));
        try {
          await agent.context.compress();
          const after = agent.context.getMessages();
          console.log(chalk.green(`Compressed ${msgs.length} -> ${after.length} messages.`));
        } catch (err) {
          console.log(chalk.yellow(`Compression failed: ${err instanceof Error ? err.message : String(err)}, starting new session anyway.`));
        }
      }
      const id = await agent.startSession();
      console.log(chalk.green(`New session started: ${id}`));
      return false;
    }

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
        console.log(chalk.gray('No skills loaded. Place modules in ~/.nexus/skills/'));
      } else {
        console.log(chalk.bold(`Skills(${skills.length}):`));
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

function parseIdSpec(spec: string, maxId: number): number[] | null {
  const ids = new Set<number>();
  const parts = spec.split(/[,，]/);

  for (const part of parts) {
    const rangeMatch = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]!, 10);
      const to = parseInt(rangeMatch[2]!, 10);
      if (from > to || from < 1) {
        console.log(chalk.red(`  Invalid range: ${part.trim()}`));
        return null;
      }
      for (let i = from; i <= to; i++) ids.add(i);
    } else {
      const num = parseInt(part.trim(), 10);
      if (isNaN(num) || num < 1) {
        console.log(chalk.red(`  Invalid number: ${part.trim()}`));
        return null;
      }
      ids.add(num);
    }
  }

  const sorted = [...ids].sort((a, b) => a - b);
  const skipped = sorted.filter(i => i > maxId);
  const valid = sorted.filter(i => i <= maxId);

  if (skipped.length > 0) {
    console.log(chalk.yellow(`  Note: #${skipped.join(',#')} out of range (1-${maxId}), skipped`));
  }

  if (valid.length === 0) {
    console.log(chalk.gray('  No valid sessions to delete.'));
    return null;
  }

  return valid;
}
