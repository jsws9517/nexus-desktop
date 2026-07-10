import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface, emitKeypressEvents } from 'readline';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, extname } from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { Agent } from '../agent.js';
import { showWelcomeScreen, BorderMode } from './logo.js';
import { authorizePath } from '../security/path-authorizer.js';
import { isDangerousBash } from '../security/audit.js';
import { translateCommand } from '../mcp/cmd-alias.js';

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

async function expandAtMentions(input: string, cwd: string): Promise<string> {
  const paths = extractAtPaths(input);
  if (paths.length === 0) return input;

  let context = '';
  for (const rawPath of paths) {
    const absPath = resolve(cwd, rawPath);
    if (!existsSync(absPath)) {
      context += `\n\n[File/Directory not found: ${rawPath}]`;
      continue;
    }

    const authorized = await authorizePath(absPath);
    if (!authorized) {
      context += `\n\n[Access denied: ${rawPath} — outside allowed paths and access was rejected]`;
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

// ---- Security confirmation ----

async function confirmDangerousCommand(cmd: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>(resolve => {
    rl.question(chalk.red(`\n⚠ Dangerous command detected:\n  $ ${cmd}\n  Allow? (y/N): `), answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ---- !bash command ----

async function executeBashCommand(cmd: string): Promise<string> {
  try {
    const actualCmd = process.platform === 'win32' ? `chcp 65001 >NUL && ${translateCommand(cmd)}` : cmd;
    const { stdout, stderr } = await execAsync(actualCmd, {
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
  let agent: Agent;
  try {
    agent = new Agent(enableAcp);
    agent.onEvent = (event) => {
      // Phase 1: event stream infrastructure established.
      // Actual event-driven rendering migration is Phase 2.
      // For now events are a no-op — stdout rendering remains.
    };
    await agent.init();
  } catch (err) {
    console.error(chalk.red(`\n${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

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

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan(`${promptName}> `),
  });

  // Set console to UTF-8 on Windows to avoid garbled Chinese output
  if (process.platform === 'win32') {
    try { execSync('@chcp 65001>nul', { stdio: 'pipe' }); } catch {}
  }

  emitKeypressEvents(process.stdin, rl);

  // Enable bracketed paste mode for reliable paste detection
  process.stdout.write('\x1b[?2004h');

  // ---- Input handling ----
  // Note: Node 25+ uses Symbol(_ttyWrite) internally, but its getter
  // returns this._ttyWrite — setting the string property is sufficient.
  const originalTtyWrite = (rl as any)._ttyWrite.bind(rl);
  const setTtyWrite = (handler: Function) => {
    (rl as any)._ttyWrite = handler;
  };
  let isMultiLine = false;

  // Windows Enter sends \r\n; after \r triggers backslash continuation,
  // consume the trailing \n so it doesn't immediately append/submit.
  let skipNextNl = false;

  // Shared main _ttyWrite: used both for initial setup and after multi-line exit
  function makeMainTtyWrite() {
    return function (s: string, key: { name?: string; ctrl?: boolean; alt?: boolean; shift?: boolean }) {
      if (!key) return originalTtyWrite(s, key);

      // Consume \n that follows backslash-continuation \r only if immediate
      if (skipNextNl) {
        skipNextNl = false;
        if (s === '\n') return;
      }

      if (isQuestionMode) {
        if (key.name === 'pageup' || key.name === 'pagedown' || (key.ctrl && key.name === 'o')) return;
        return originalTtyWrite(s, key);
      }

      if (key.name === 'pageup' || key.name === 'pagedown' || (key.ctrl && key.name === 'o')) return;

      // === Multi-line triggers: Ctrl+J, Shift+Enter, Ctrl+Enter ===
      if (isNewLineKey(s, key)) {
        enterMultiLine();
        return;
      }

      // === ENTER/Return handling ===
      if (key.name === 'enter' || key.name === 'return') {
        // 1) Backslash continuation: \ + Enter → strip \, enter multi-line
        const line = (rl as any).line || '';
        if (line.endsWith('\\')) {
          (rl as any).line = line.slice(0, -1);
          skipNextNl = true;
          enterMultiLine();
          return;
        }
        // 2) Already in multi-line mode: submit
        if (isMultiLine) {
          isPasteMode = false;
          multiLineSubmit();
          return;
        }
        // 3) Paste Enter → newline (bracketed paste or timing fallback)
        if (isBracketedPaste || (isPasteMode && isInPasteBurst())) {
          enterMultiLine();
          return;
        }
        // 4) Plain Enter → let readline submit
        return originalTtyWrite(s, key);
      }

      return originalTtyWrite(s, key);
    };
  }

  setTtyWrite(makeMainTtyWrite());

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

  // ---- Paste detection ----
  const PASTE_MS = 80;
  const PASTE_MIN_KEYS = 3;
  let lastKeypressTime = 0;
  let pasteKeyCount = 0;
  let isPasteMode = false;

  function isInPasteBurst(): boolean {
    return (Date.now() - lastKeypressTime) < PASTE_MS;
  }

  // ---- Multi-line key detection (used across all _ttyWrite) ----
  function isNewLineKey(s: string, key: { name?: string; shift?: boolean; ctrl?: boolean; alt?: boolean }): boolean {
    if ((key.name === 'enter' || key.name === 'return') && (key.shift || key.ctrl || key.alt)) return true;
    if (s === '\x0a' || s === '\n') return true; // Ctrl+J / linefeed (universally reliable)
    return false;
  }

  // ---- Interactive question mode (for /resume, /history delete) ----
  let isQuestionMode = false;
  let isBracketedPaste = false;

  async function customQuestion(query: string): Promise<string> {
    return new Promise<string>((resolve) => {
      isQuestionMode = true;
      process.stdout.write(query);

      const lineHandler = (line: string) => {
        cleanup();
        resolve(line);
      };

      const escHandler = (_s: string, k: any) => {
        if (k && k.name === 'escape') {
          cleanup();
          (rl as any).line = '';
          process.stdout.write('\n');
          resolve('');
        }
      };

      function cleanup() {
        rl.removeListener('line', lineHandler);
        process.stdin.removeListener('keypress', escHandler);
        isQuestionMode = false;
      }

      rl.on('line', lineHandler);
      process.stdin.on('keypress', escHandler);
    });
  }

  // ---- Multi-line mode state & handlers ----
  const INDENT = promptName.length + 2;
  const promptLabel = () => chalk.cyan(`${promptName}> `);
  let multiLineBuffer: string[] = [];

  function enterMultiLine(): void {
    const firstLine = rl.line;
    multiLineBuffer = firstLine !== undefined && firstLine !== '' ? [firstLine] : [''];
    isMultiLine = true;
    // Show continuation indent on a new line (no redraw)
    process.stdout.write('\n' + ' '.repeat(INDENT));

    setTtyWrite(function (s: string, key: { name?: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }) {
      if (!key) return;

      // Consume \n that follows backslash-continuation \r only if immediate
      if (skipNextNl) {
        skipNextNl = false;
        if (s === '\n') return;
      }

      if (isQuestionMode) {
        return originalTtyWrite(s, key);
      }

      // Ctrl+C
      if (key.ctrl && key.name === 'c') {
        rl.close();
        return;
      }

      // ESC: cancel multi-line
      if (key.name === 'escape') {
        exitMultiLine(false);
        return;
      }

      // Ctrl+O: toggle detail
      if (key.ctrl && key.name === 'o') {
        const mode = agent.toggleDetailMode();
        const label = mode ? chalk.green('FULL') : chalk.yellow('COMPACT');
        if (agent.isBusy()) return;
        process.stdout.write('\n');
        console.log(`[Detail mode: ${label}]`);
        for (let i = 0; i < multiLineBuffer.length; i++) {
          if (i === 0) process.stdout.write(promptLabel() + multiLineBuffer[i] + '\n');
          else process.stdout.write(' '.repeat(INDENT) + multiLineBuffer[i] + '\n');
        }
        process.stdout.write(' '.repeat(INDENT));
        lastDetailMode = mode;
        return;
      }

      // === Multi-line triggers: Ctrl+J, Shift+Enter, Ctrl+Enter → append line ===
      if (isNewLineKey(s, key)) {
        multiLineAppendLine();
        return;
      }

      // === ENTER/Return handling ===
      if (key.name === 'enter' || key.name === 'return') {
        // Paste Enter → append line (bracketed paste or timing fallback)
        if (isBracketedPaste || (isPasteMode && isInPasteBurst())) {
          multiLineAppendLine();
          return;
        }
        // Plain Enter → submit
        multiLineSubmit();
        return;
      }

      // Backspace
      if (key.name === 'backspace') {
        if (multiLineBuffer.length === 0) return;
        const idx = multiLineBuffer.length - 1;
        const last = multiLineBuffer[idx] || '';
        if (last.length > 0) {
          multiLineBuffer[idx] = last.slice(0, -1);
          process.stdout.write('\b \b');
        }
        // When at start of a line, do nothing (ignore backspace-join for simplicity)
        return;
      }

      // Tab: 2 spaces
      if (key.name === 'tab') {
        if (multiLineBuffer.length === 0) multiLineBuffer.push('');
        const idx = multiLineBuffer.length - 1;
        multiLineBuffer[idx] = (multiLineBuffer[idx] || '') + '  ';
        process.stdout.write('  ');
        return;
      }

      // Printable characters
      if (s && s.length === 1 && !key.ctrl && !key.meta) {
        if (multiLineBuffer.length === 0) multiLineBuffer.push('');
        const idx = multiLineBuffer.length - 1;
        multiLineBuffer[idx] = (multiLineBuffer[idx] || '') + s;
        process.stdout.write(s);
        return;
      }
    });
  }

  function multiLineAppendLine(): void {
    multiLineBuffer.push('');
    process.stdout.write('\n' + ' '.repeat(INDENT));
  }

  function multiLineSubmit(): void {
    const fullInput = multiLineBuffer.join('\n');
    exitMultiLine(true, fullInput);
  }

  function exitMultiLine(submit: boolean, fullInput?: string): void {
    isMultiLine = false;
    multiLineBuffer = [];

    setTtyWrite(makeMainTtyWrite());
    (rl as any).line = '';

    if (submit && fullInput) {
      process.stdout.write('\n');
      rl.emit('line', fullInput);
    } else {
      process.stdout.write('\n');
      rl.prompt();
    }
  }

  process.stdin.on('keypress', async (s, key) => {
    if (!key) return;
    if (isQuestionMode) return;

    // Bracketed paste mode
    if (s === '\x1b[200~') { isBracketedPaste = true; isPasteMode = true; return; }
    if (s === '\x1b[201~') { isBracketedPaste = false; isPasteMode = false; return; }

    // Paste detection: counts consecutive fast non-enter keypresses
    const now = Date.now();
    const inPasteBurst = (now - lastKeypressTime) < PASTE_MS;
    lastKeypressTime = now;
    if (inPasteBurst && key.name !== 'enter' && key.name !== 'return' && s !== '\x0a') {
      pasteKeyCount++;
      if (pasteKeyCount >= PASTE_MIN_KEYS) isPasteMode = true;
    } else if (!inPasteBurst) {
      pasteKeyCount = 0;
      if (!isBracketedPaste) isPasteMode = false;
    }

    if (isMultiLine) return; // multi-line mode handles its own keys

    if (key.ctrl && key.name === 'o') {
      const mode = agent.toggleDetailMode();
      const label = mode ? chalk.green('FULL') : chalk.yellow('COMPACT');
      if (agent.isBusy()) return;
      console.log(`\n[Detail mode: ${label}]`);
      rl.prompt();
      lastDetailMode = mode;
      return;
    }

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

  const handleLine = async (line: string): Promise<void> => {
    if (agent.isBusy()) return;

    const input = line.trim();
    promptHistoryIndex = -1;
    draftInput = '';
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const handled = await handleSlashCommand(input, agent, rl, customQuestion);
      if (!handled) {
        rl.prompt();
      }
      return;
    }

    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) {
        rl.prompt();
        return;
      }
      if (isDangerousBash(cmd)) {
        const approved = await confirmDangerousCommand(cmd);
        if (!approved) {
          console.log(chalk.red('Command denied.'));
          rl.prompt();
          return;
        }
      }
      console.log(chalk.gray(`$ ${cmd}`));
      const output = await executeBashCommand(cmd);
      console.log(output);
      rl.prompt();
      return;
    }

    const expandedInput = await expandAtMentions(input, process.cwd());
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
  };

  rl.on('line', async (line) => {
    if (isQuestionMode) return;
    await handleLine(line);
  });

  rl.on('close', async () => {
    process.stdout.write('\x1b[?2004l');
    console.log(chalk.gray('\nGoodbye!'));
    await agent.shutdown();
    process.exit(0);
  });
}

async function runSingleMessage(message: string, sessionId?: string, enableAcp?: boolean): Promise<void> {
  let agent: Agent;
  try {
    agent = new Agent(enableAcp);
    await agent.init();
  } catch (err) {
    console.error(chalk.red(`\n${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
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

async function handleSlashCommand(
  input: string,
  agent: Agent,
  rl: ReturnType<typeof createInterface>,
  customQuestion?: (query: string) => Promise<string>,
): Promise<boolean> {
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
      console.log('  /cls             - Clear the screen');
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
      console.log(chalk.gray('  Ctrl+Enter      - Newline(Major), Alternative: Ctrl+J | \\ + Enter'));
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
      rl.prompt();
      return true;

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
          console.log(chalk.yellow(`Compression failed, starting new session anyway.`));
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
  const valid = sorted.filter(i => i <= maxId);
  const skipped = sorted.filter(i => i > maxId);

  if (skipped.length > 0) {
    console.log(chalk.yellow(`  Note: #${skipped.join(',#')} out of range (1-${maxId}), skipped`));
  }

  if (valid.length === 0) {
    console.log(chalk.gray('  No valid sessions to delete.'));
    return null;
  }

  return valid;
}
