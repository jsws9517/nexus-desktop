import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface, emitKeypressEvents } from 'readline';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { Agent } from '../agent.js';
import { showWelcomeScreen, BorderMode } from './logo.js';
import { t as i18nTr, tf as i18nTf } from '../i18n/index.js';
import { ThemeManager } from '../theme/manager.js';
import { authorizePath, setPermissionPrompter } from '../security/path-authorizer.js';
import { isDangerousBash } from '../security/audit.js';
import { translateCommand } from '../mcp/cmd-alias.js';
import { executeTaskTool } from '../task/task-tools.js';

const execAsync = promisify(exec);

const _themeMgr = new ThemeManager();
function t() { return _themeMgr.token; }

// ---- Gradient separator line ----

function hexLerp(c1: string, c2: string, t: number): string {
  const parse = (h: string) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r1,g1,b1] = parse(c1);
  const [r2,g2,b2] = parse(c2);
  const r = Math.round(r1 + (r2-r1)*t);
  const g = Math.round(g1 + (g2-g1)*t);
  const b = Math.round(b1 + (b2-b1)*t);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function renderSepLine(): string {
  const termWidth = process.stdout.columns || 120;
  const w = Math.floor(Math.max(termWidth * 0.96, 82));
  const accent = _themeMgr.getColor('borderAccent') || '#06b6d4';
  const bg = _themeMgr.getColor('background') || (_themeMgr.currentThemeName === 'light' ? '#fafafa' : '#1a1a2e');
  const parts: string[] = [];
  for (let i = 0; i < w; i++) {
    const opacity = 0.2 + 0.8 * (1 - i / w);
    const color = hexLerp(bg, accent, opacity);
    parts.push(chalk.hex(color)('━'));
  }
  return parts.join('');
}

function sepWidth(): number {
  return Math.floor(Math.max((process.stdout.columns || 120) * 0.96, 82));
}

// ---- Streaming word-wrap (wraps text to fixed width across chunk boundaries) ----

class StreamWrap {
  private width: number;
  private pending = '';
  constructor(width: number) { this.width = width; }
  private stripAnsi(s: string): string { return s.replace(/\x1B\[[0-9;]*[a-z]/gi, ''); }
  push(chunk: string): string {
    const combined = this.pending + chunk;
    this.pending = '';
    const out: string[] = [];
    const paragraphs = combined.split('\n');
    for (let i = 0; i < paragraphs.length; i++) {
      if (i > 0) out.push('\n');
      const para = paragraphs[i]!;
      const plainLen = this.stripAnsi(para).length;
      if (plainLen <= this.width) { out.push(para); continue; }
      let line = '';
      for (const ch of para) {
        const test = line + ch;
        if (this.stripAnsi(test).length > this.width && line.length > 0) { out.push(line, '\n'); line = ch; }
        else line = test;
      }
      out.push(line);
    }
    const raw = out.join('');
    const lastNl = raw.lastIndexOf('\n');
    if (lastNl >= 0) { this.pending = raw.slice(lastNl + 1); return raw.slice(0, lastNl + 1); }
    this.pending = raw;
    return '';
  }
  flush(): string { const r = this.pending; this.pending = ''; return r; }
}

// ---- @file/@directory expansion ----

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

    // Prompt user for permission via the shared prompter (customQuestion with isQuestionMode)
    // so the interaction is visible and doesn't conflict with the main readline.
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
    } else {
      // Do NOT inject file content into the prompt — that is invisible to the user
      // and gives the LLM a false "the user pasted this" impression.
      // The LLM should use read_text_file / file_read tool (visible tool call) if needed.
      const sizeInfo = stat.size > MAX_FILE_SIZE ? ` (${Math.round(stat.size / 1024)}KB, limit ${MAX_FILE_SIZE / 1024}KB)` : '';
      context += `\n\n[Referenced file: ${rawPath}${sizeInfo}]`;
    }
  }

  if (context) {
    return `${input}\n${context}`;
  }
  return input;
}

// ---- Security confirmation ----

let _dangerousCmdPrompter: ((question: string) => Promise<string>) | null = null;

function setDangerousCmdPrompter(fn: (question: string) => Promise<string>): void {
  _dangerousCmdPrompter = fn;
}

async function confirmDangerousCommand(cmd: string): Promise<boolean> {
  const question = t().error(`\n⚠ Dangerous command detected:\n  $ ${cmd}\n  Allow? (y/N): `);
  const answer = _dangerousCmdPrompter
    ? await _dangerousCmdPrompter(question)
    : await new Promise<string>(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, resolve);
        rl.on('close', () => resolve(''));
      });
  return answer.trim().toLowerCase() === 'y';
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
    console.error(t().error(`\n${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

  // Set console to UTF-8 before any output to avoid garbled Chinese on Windows
  if (process.platform === 'win32') {
    try { execSync('@chcp 65001>nul', { stdio: 'pipe' }); } catch {}
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
    prompt: t().prompt(`${promptName}> `),
  });



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
          if (key.name === 'pageup' || key.name === 'pagedown' || key.name === 'up' || key.name === 'down' || (key.ctrl && key.name === 'o')) return;
          return originalTtyWrite(s, key);
        }

        if (key.name === 'pageup' || key.name === 'pagedown' || key.name === 'up' || key.name === 'down' || (key.ctrl && key.name === 'o')) return;

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

  function debugLog(...args: unknown[]): void {
    if (process.env.DEBUG?.includes('pageup') || process.env.LLMA_DEBUG) {
      process.stderr.write(`[pageup] ${args.map(a => String(a)).join(' ')}\n`);
    }
  }

  function getUserMessages(): string[] {
    const sessionId = agent.getCurrentSessionId();
    if (!sessionId) return [];

    try {
      const stored = agent.session.getMessages(sessionId);
      return stored
        .filter((m) => m.role === 'user')
        .map((m) => m.content);
    } catch (e) {
      debugLog(`store error: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
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

  // ---- Interactive question mode (for /resume, /delete) ----
  let isQuestionMode = false;
  let isSingleKeyMode = false;
  let isBracketedPaste = false;

  // Keep a direct reference to the real stdout.write so permission prompts
  // are never swallowed by StreamWrap (which buffers non-newline-terminated text).
  const _rawStdoutWrite = process.stdout.write.bind(process.stdout);

  async function customQuestion(query: string, singleKey?: boolean): Promise<string> {
    return new Promise<string>((resolve) => {
      isQuestionMode = true;
      isSingleKeyMode = !!singleKey;
      // Flush any pending StreamWrap buffer (e.g. "agent> " prefix) so the
      // question prompt appears in correct display order rather than interleaved.
      // Only needed when streamWrap is active (process.stdout.write is overridden).
      if (process.stdout.write !== _rawStdoutWrite) {
        process.stdout.write('\n');
      }
      _rawStdoutWrite(query);

      const lineHandler = (line: string) => {
        cleanup();
        resolve(line);
      };

      const escHandler = (_s: string, k: any) => {
        if (k && k.name === 'escape') {
          cleanup();
          (rl as any).line = '';
          _rawStdoutWrite('\n');
          resolve('');
        }
      };

      const keyHandler = (_s: string, k: any) => {
        if (!singleKey || !k) return;
        if ((_s === 'y' || _s === 'a' || _s === 'n' || _s === 'Y' || _s === 'A' || _s === 'N') && !k.ctrl && !k.meta && !k.shift) {
          const answer = _s.toLowerCase();
          (rl as any).line = '';
          _rawStdoutWrite(answer + '\n');
          cleanup();
          resolve(answer);
        }
      };

      function cleanup() {
        rl.removeListener('line', lineHandler);
        process.stdin.removeListener('keypress', escHandler);
        process.stdin.removeListener('keypress', keyHandler);
        isQuestionMode = false;
        isSingleKeyMode = false;
      }

      rl.on('line', lineHandler);
      process.stdin.on('keypress', escHandler);
      if (singleKey) {
        process.stdin.on('keypress', keyHandler);
      }
    });
  }

  // Wire audit confirmations to reuse main readline (avoids double-echo / readline conflict)
  agent.audit.setAskUser((q) => customQuestion(q, true));

  // Wire path-authorizer permission prompts to reuse main readline too (with single-key auto-submit)
  setPermissionPrompter((q) => customQuestion(q, true));

  // Wire dangerous command confirmation to reuse main readline too
  setDangerousCmdPrompter((q) => customQuestion(q, true));

  // Wire askUser (from tools/skills) to display question text in terminal
  agent.onOutput = (text) => { process.stdout.write(text); };

  // ---- Multi-line mode state & handlers ----
  const INDENT = promptName.length + 2;
  const promptLabel = () => t().prompt(`${promptName}> `);
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
        // In singleKey mode, suppress echo for y/a/n — keyHandler writes its own output
        if (isSingleKeyMode && (s === 'y' || s === 'a' || s === 'n' || s === 'Y' || s === 'A' || s === 'N')) return;
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
        const label = mode ? t().success('FULL') : t().warning('COMPACT');
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
      const label = mode ? t().success('FULL') : t().warning('COMPACT');
      if (agent.isBusy()) return;
      console.log(`\n[Detail mode: ${label}]`);
      rl.prompt();
      lastDetailMode = mode;
      return;
    }

    if (key.ctrl && key.name === 't') {
      if (agent.isBusy()) return;
      const metrics = agent.getSessionMetrics();
      const currentThinkingVisible = process.env.LLMA_SHOW_THINKING !== '0';
      const newVal = currentThinkingVisible ? '0' : '1';
      process.env.LLMA_SHOW_THINKING = newVal;
      console.log(`\n${t().textDim(`Thinking: ${newVal === '1' ? 'visible' : 'hidden'}`)}`);
      rl.prompt();
      return;
    }

    if (key.ctrl && key.name === 'e') {
      if (agent.isBusy()) return;
      const metrics = agent.getSessionMetrics();
      if (metrics.length === 0) {
        console.log(`\n${t().textDim('No turns yet.')}`);
      } else {
        const last = metrics[metrics.length - 1];
        console.log(`\n${t().heading(`Turn ${last.turnNumber} Metrics`)}`);
        console.log(`  ${t().textDim('LLM:')}    ${(last.llmCallTime / 1000).toFixed(1)}s`);
        console.log(`  ${t().textDim('Tools:')}  ${last.toolCount} (${(last.toolExecTime / 1000).toFixed(1)}s)`);
        console.log(`  ${t().textDim('Ctx:')}    ${last.contextTokensAfter.toLocaleString()} tokens`);
        if (last.compactStrategy) {
          console.log(`  ${t().textDim('Cmpt:')}  ${last.compactStrategy}`);
        }
      }
      rl.prompt();
      return;
    }

    if (key.name === 'escape') {
      if (agent.isBusy()) {
        agent.abort();
        console.log(t().warning('\n[Interrupted]'));
        rl.prompt();
      }
      return;
    }

    if (key.name === 'pageup' || key.name === 'up') {
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
    } else if (key.name === 'pagedown' || key.name === 'down') {
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

  let bashOutputBuffer: { cmd: string; output: string }[] = [];

  const handleLine = async (line: string): Promise<void> => {
    // First: resolve any pending askUser (called from tools/skills during agent.chat).
    // Must check BEFORE isBusy() or the answer is swallowed and the task hangs forever.
    if (agent.resolvePendingAsk(line)) return;

    const input = line.trim();
    promptHistoryIndex = -1;
    draftInput = '';
    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands are safe during busy state (e.g. /btw sets a flag, /help is read-only)
    if (input.startsWith('/')) {
      const sid = agent.getCurrentSessionId();
      if (sid) {
        agent.session.addMessage(sid, { role: 'user', content: input });
      }
      const handled = await handleSlashCommand(input, agent, rl, customQuestion);
      if (!handled) {
        rl.prompt();
      }
      return;
    }

    if (agent.isBusy()) return;

    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) {
        rl.prompt();
        return;
      }
      if (isDangerousBash(cmd)) {
        const approved = await confirmDangerousCommand(cmd);
        if (!approved) {
          console.log(t().error('Command denied.'));
          rl.prompt();
          return;
        }
      }
      console.log(t().textDim(`$ ${cmd}`));
      const output = await executeBashCommand(cmd);
      console.log(output);
      bashOutputBuffer.push({ cmd, output });
      rl.prompt();
      return;
    }

    const expandedInput = await expandAtMentions(input, process.cwd());

    // Separator line between user and agent messages
    process.stdout.write(renderSepLine() + '\n');

    // Wrap agent output to separator width
    const sw = new StreamWrap(sepWidth());
    const origWrite: typeof process.stdout.write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...args: any[]) => {
      const flushed = sw.push(String(chunk));
      if (flushed) origWrite(flushed, ...args);
      return true;
    }) as typeof process.stdout.write;

    // Inject buffered bash command outputs into session context
    if (bashOutputBuffer.length > 0) {
      const bufContent = bashOutputBuffer.map(
        b => i18nTf('bash_injection')(b.cmd, b.output)
      ).join('\n\n');
      const sid = agent.getCurrentSessionId();
      if (sid) {
        agent.session.addMessage(sid, { role: 'system', content: i18nTf('bash_section')(bufContent) });
      }
      bashOutputBuffer = [];
    }

    process.stdout.write(t().entityName('agent> '));
    try {
      await agent.chat(expandedInput);
    } catch (err) {
      console.error(t().error(`Error: ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      process.stdout.write = origWrite;
      const rest = sw.flush();
      if (rest) {
        // Ensure rest ends with newline so separator goes on its own line
        origWrite(rest.endsWith('\n') ? rest : rest + '\n');
      }
    }

    // Separator line for next turn
    process.stdout.write(renderSepLine() + '\n');

    if (lastDetailMode !== agent.detailMode) {
      const label = agent.detailMode ? t().success('FULL') : t().warning('COMPACT');
      console.log(t().textDim(`[Detail mode: ${label}]`));
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
    console.log(t().textDim('\nGoodbye!'));
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
    console.error(t().error(`\n${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }
  await agent.startSession(undefined, sessionId);

  try {
    await agent.chat(message);
  } catch (err) {
    console.error(t().error(`Error: ${err instanceof Error ? err.message : String(err)}`));
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
  const delSession = (s: { id: string }) => { agent.session.delete(s.id); agent.sessionMemory.remove(s.id); };

  switch (cmd) {
    case 'exit':
    case 'quit':
      rl.close();
      return true;

    case 'help':
      console.log(t().heading(i18nTr('h_session')));
      console.log(`  /session         - ${i18nTr('h_session_info')}`);
      console.log(`  /resume          - ${i18nTr('h_resume')}`);
      console.log(`  /delete          - ${i18nTr('h_delete')}`);
      console.log(`  /view [id|#]     - ${i18nTr('h_view')}`);
      console.log(`  /memory          - ${i18nTr('h_memory')}`);
      console.log(`  /insight         - ${i18nTr('h_insight')}`);
      console.log(`  /rename <name>   - ${i18nTr('h_rename')}`);

      console.log(t().heading(i18nTr('h_model')));
      console.log(`  /model           - ${i18nTr('h_model_switch')}`);
      console.log(`  /provider        - ${i18nTr('h_provider')}`);
      console.log(`  /compact         - ${i18nTr('h_compact')}`);
      console.log(`  /new             - ${i18nTr('h_new')}`);
      console.log(`  /clear           - ${i18nTr('h_clear')}`);

      console.log(t().heading(i18nTr('h_task')));
      console.log(`  /plan <request>  - ${i18nTr('h_plan')}`);
      console.log(`  /go              - ${i18nTr('h_go')}`);
      console.log(`  /tasks [-step <id>] - ${i18nTr('h_tasks')}`);

      console.log(t().heading(i18nTr('h_tools')));
      console.log(`  /tools           - ${i18nTr('h_tools_list')}`);
      console.log(`  /mcp             - ${i18nTr('h_mcp')}`);
      console.log(`  /skills          - ${i18nTr('h_skills')}`);
      console.log(`  /plugins         - ${i18nTr('h_plugins')}`);
      console.log(`  /btw <info>      - ${i18nTr('h_btw')}`);
      console.log(`  /theme           - ${i18nTr('h_theme')}`);

      console.log(t().heading(i18nTr('h_terminal')));
      console.log(`  /flush           - ${i18nTr('h_flush')}`);
      console.log(`  /exit, /quit     - ${i18nTr('h_exit')}`);
      console.log(t().textDim(`\n${i18nTr('h_prefixes')}:`));
      console.log(t().textDim(`  !<cmd>          - ${i18nTr('h_bash')}`));
      console.log(t().textDim(`  @<path>         - ${i18nTr('h_file')}`));
      console.log(t().textDim(`                   ${i18nTr('h_file_detail')}`));
      console.log(t().textDim(`\n${i18nTr('h_shortcuts')}:`));
      console.log(t().textDim(` ↑/PageUp         - ${i18nTr('h_hist_up')}`));
      console.log(t().textDim(` ↓/PageDown       - ${i18nTr('h_hist_down')}`));
      console.log(t().textDim(`  Ctrl+O          - ${i18nTr('h_detail')}`));
      console.log(t().textDim(`  Ctrl+T          - ${i18nTr('h_thinking')}`));
      console.log(t().textDim(`  Ctrl+E          - ${i18nTr('h_metrics')}`));
      console.log(t().textDim(`\n${i18nTr('h_input')}:`));
      console.log(t().textDim(`  Enter           - ${i18nTr('h_submit')}`));
      console.log(t().textDim(`  Ctrl+Enter      - ${i18nTr('h_newline')}`));
      console.log(t().textDim(`  Paste           - ${i18nTr('h_paste')}`));
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

    case 'flush':
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
      rl.prompt();
      return true;

    case 'rename':
      if (!args[0]) {
        console.log(t().warning('Usage: /rename <new-session-name>'));
      } else {
        const newName = args.join(' ');
        agent.renameSession(newName);
        console.log(t().success(`Session renamed to: ${newName}`));
      }
      return false;

    case 'resume': {
      const sessions = agent.session.list();
      if (sessions.length === 0) {
        console.log(t().textDim('No sessions found.'));
        return false;
      }

      const currentId = agent.getCurrentSessionId();
      const maxTokens = agent.config.getProvider().maxContextTokens || 8192;
      const mode = args[0];
      const param = args.slice(1).join(' ');

      // -ssid <session-uuid>
      if (mode === '-ssid' && param) {
        const session = sessions.find(s => s.id === param);
        if (!session) {
          console.log(t().error(`Session not found: ${param}`));
          return false;
        }
        return doResume(agent, session, currentId, maxTokens, customQuestion);
      }

      // -name <session name> (auto-resume first match, i.e. most recently updated)
      if (mode === '-name' && param) {
        const matched = sessions.filter(s => s.name.toLowerCase().includes(param.toLowerCase()));
        if (matched.length === 0) {
          console.log(t().error(`No session found matching name "${param}".`));
          return false;
        }
        return doResume(agent, matched[0]!, currentId, maxTokens, customQuestion);
      }

      // -id <number> or default (interactive list)
      const numArg = mode === '-id' ? parseInt(param, 10) : NaN;
      if (mode === '-id' && !isNaN(numArg) && numArg >= 1 && numArg <= sessions.length) {
        return doResume(agent, sessions[numArg - 1]!, currentId, maxTokens, customQuestion);
      }

      // Default: show all sessions and prompt for number
      return doResumeList(agent, sessions, sessions, currentId, maxTokens, customQuestion);
    }

    case 'delete': {
      const allSessions = agent.session.list();
      if (allSessions.length === 0) {
        console.log(t().textDim('No sessions found.'));
        return false;
      }
      const currentId = agent.getCurrentSessionId();

      let filterStr: string | null = null;
      let sizeThreshold: number | null = null;
      let daysValue: number | null = null;
      let idsSpec: string | null = null;

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-ids') {
          idsSpec = args[++i] || '';
        } else if (args[i] === '-filter') {
          filterStr = args[++i] || '';
        } else if (args[i] === '-size') {
          const next = args[i + 1];
          if (next && !next.startsWith('-')) { sizeThreshold = parseInt(next, 10); i++; }
          else { sizeThreshold = 0; }
        } else if (args[i] === '-days') {
          const next = args[i + 1];
          if (next && !next.startsWith('-')) { daysValue = parseInt(next, 10); i++; }
          else { daysValue = 7; }
        } else {
          console.log(t().warning(`Unknown flag: ${args[i]}`));
          console.log(t().warning('Usage: /delete -ids <n,n,n> | -filter <str> | -size <N> | -days <N>'));
          return false;
        }
      }

      let toDelete: typeof allSessions = [];

      // -ids: delete by session index
      if (idsSpec !== null) {
        const ids = parseIdSpec(idsSpec, allSessions.length);
        if (ids === null) return false;
        toDelete = ids.filter(i => allSessions[i - 1]!.id !== currentId).map(i => allSessions[i - 1]!);
      }

      // -filter: filter by name
      if (filterStr !== null) {
        toDelete = allSessions.filter(s => s.id !== currentId && s.name.toLowerCase().includes(filterStr!.toLowerCase()));
      }

      // -size / -days: filter by token count or age
      if (sizeThreshold !== null || daysValue !== null) {
        const now = Date.now();
        toDelete = allSessions.filter(s => {
          if (s.id === currentId) return false;
          if (sizeThreshold !== null) {
            const tokens = agent.session.getTokenEstimate(s.id, agent.provider);
            if (sizeThreshold === 0 ? tokens !== 0 : tokens >= sizeThreshold) return false;
          }
          if (daysValue !== null) {
            if (s.updatedAt >= now - daysValue * 86400000) return false;
          }
          return true;
        });
      }

      if (toDelete.length === 0) {
        console.log(t().textDim('No sessions to delete.'));
        return false;
      }

      // Show summary
      console.log(t().heading(`Sessions to delete (${toDelete.length}):`));
      for (const s of toDelete) {
        const tokens = agent.session.getTokenEstimate(s.id, agent.provider);
        const date = new Date(s.updatedAt).toLocaleString();
        console.log(`  ${t().entityName(s.name)} (${t().textDim(date)}, ${tokens} tokens)`);
      }

      const confirm = await (customQuestion!)(t().warning('\nConfirm? (y/N): '));
      if (confirm.trim().toLowerCase() !== 'y') {
        console.log(t().textDim('Cancelled.'));
        return false;
      }
      for (const s of toDelete) delSession(s);
      console.log(t().success(`Deleted ${toDelete.length} session(s).`));
      return false;
    }

    case 'view': {
      const arg = args[0];
      let sessionId: string | undefined;
      if (arg && /^\d+$/.test(arg)) {
        const sessions = agent.session.list();
        const idx = parseInt(arg, 10) - 1;
        sessionId = sessions[idx]?.id;
        if (!sessionId) {
          console.log(t().error(`Session #${arg} not found.`));
          return false;
        }
      } else {
        sessionId = arg || agent.getCurrentSessionId();
      }
      if (!sessionId) {
        console.log(t().warning('No active session. Specify a session ID or number: /view <id|#>'));
        return false;
      }
      let messages;
      try {
        messages = agent.session.getMessages(sessionId);
      } catch {
        console.log(t().error(`Session not found: ${sessionId}`));
        return false;
      }
      if (!messages || messages.length === 0) {
        console.log(t().textDim('No messages in this session.'));
        return false;
      }
      console.log(t().heading(`\nSession: ${sessionId} (${messages.length} messages total)\n`));
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        const preview = m.content.slice(0, 120).replace(/\n/g, '\\n');
        const roleTag = m.role === 'assistant' ? t().entityName(m.role) : t().entityName(m.role);
        const tokens = m.toolCalls ? ` [${m.toolCalls.length} tool calls]` : '';
        console.log(`  ${String(i + 1).padStart(3)}. ${roleTag}: ${t().textDim(preview)}${tokens}`);
      }
      console.log(t().textDim(`\nTip: Use /resume to switch to a session, then the context will have the full history.\n`));
      return false;
    }

    case 'memory': {
      const memSessionId = agent.getCurrentSessionId();
      if (!memSessionId) {
        console.log(t().warning('No active session.'));
        return false;
      }
      const mem = agent.sessionMemory.load(memSessionId);
      if (!mem) {
        console.log(t().textDim('No memory for this session yet. Memories are built automatically as you chat.'));
      } else {
        console.log(t().heading(`\nSession Memory:\n`));
        // Strip internal sessionId comment from display
        const display = mem.replace(/<!-- sessionId: [a-f0-9-]+ -->\n?/g, '').trim();
        console.log(display);
      }
      return false;
    }

    case 'insight': {
      const aggregated = agent.sessionMemory.aggregateAll();
      if (aggregated === '(no session memories yet)') {
        console.log(t().textDim('No session memories found. Memories build automatically as you chat.'));
        return false;
      }
      console.log(t().textDim('Analyzing across all sessions...'));
      try {
        const result = await agent.provider.complete([{
          role: 'user',
          content: i18nTf('session_analysis')(aggregated),
        }]);
        console.log(t().heading(`\nCross-Session Analysis:\n`));
        console.log(result);
      } catch (err) {
        console.log(t().error(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }



    case 'clear':
      agent.context.clear();
      console.log(t().textDim('Context cleared.'));
      return false;

    case 'compact': {
      const msgs = agent.context.getMessages();
      if (msgs.length < 4) {
        console.log(t().textDim('Not enough history to compress.'));
        return false;
      }
      console.log(t().textDim('Compressing history...'));
      try {
        await agent.context.compress();
        const after = agent.context.getMessages();
        console.log(t().success(`Compressed ${msgs.length} -> ${after.length} messages.`));
      } catch (err) {
        console.log(t().error(`Compression failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }

    case 'new': {
      const msgs = agent.context.getMessages();
      if (msgs.length >= 4) {
        console.log(t().textDim('Compressing history before new session...'));
        try {
          await agent.context.compress();
          const after = agent.context.getMessages();
          console.log(t().success(`Compressed ${msgs.length} -> ${after.length} messages.`));
        } catch (err) {
          console.log(t().warning(`Compression failed, starting new session anyway.`));
        }
      }
      const id = await agent.startSession();
      console.log(t().success(`New session started: ${id}`));
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
        console.log(t().success(`Model switched: ${change}`));
      }
      return false;

    case 'tools':
      const tools = [...agent.mcp.getAllTools(), ...agent.skills.getTools()];
      console.log(t().heading(`Available tools (${tools.length}):`));
      for (const tool of tools) {
        console.log(`  ${t().toolCallName(tool.name)} - ${tool.description}`);
      }
      return false;

    case 'mcp':
      const conns = agent.mcp.listConnections();
      if (conns.length === 0) {
        console.log(t().textDim('No external MCP servers connected.'));
      } else {
        console.log(t().heading(`MCP Servers (${conns.length}):`));
        for (const c of conns) {
          console.log(`  ${t().entityName(c.name)} - ${c.toolCount} tools [${c.status}]`);
        }
      }
      return false;

    case 'skills': {
      const allSkills = agent.skills.list();
      const skills = allSkills.filter(s => s.source !== 'plugins');
      if (skills.length === 0) {
        console.log(t().textDim('No skills loaded. Place modules in ~/.nexus/skills/'));
      } else {
        console.log(t().heading(`Skills (${skills.length}):`));
        for (const s of skills) {
          const src = s.source === 'claude' ? ' [claude]' : '';
          console.log(`  ${t().entityName(s.name)} v${s.version}${src}${s.description ? ' - ' + s.description : ''}`);
        }
      }
      return false;
    }

    case 'plugins': {
      const allPlugins = agent.skills.list();
      const plugins = allPlugins.filter(s => s.source === 'plugins');
      if (plugins.length === 0) {
        console.log(t().textDim('No plugins loaded. Install via: nexus config native install <name>'));
      } else {
        console.log(t().heading(`Plugins (${plugins.length}):`));
        for (const s of plugins) {
          console.log(`  ${t().entityName(s.name)} v${s.version}${s.description ? ' - ' + s.description : ''}`);
        }
      }
      return false;
    }

    case 'btw': {
      const btwInfo = args.join(' ');
      if (!btwInfo) {
        console.log(t().textDim('Usage: /btw <info>  —  Inject context for the LLM to keep in mind'));
        return false;
      }
      agent.pendingBtw = btwInfo;
      console.log(t().textDim(`✓ Context noted: "${btwInfo.slice(0, 80)}${btwInfo.length > 80 ? '...' : ''}"`));
      console.log(t().textDim('  Will be injected before the next LLM turn.'));
      return false;
    }

    case 'theme':
      if (!args[0]) {
        const current = _themeMgr.currentThemeName;
        const allThemes = _themeMgr.listThemes();
        console.log(t().heading(`Current theme: ${current}`));
        console.log(t().textDim('\nAvailable themes:'));
        for (const name of allThemes) {
          const marker = name === current ? t().success(' *') : '';
          console.log(`  ${t().entityName(name)}${marker}`);
        }
        console.log(t().textDim('\nUsage: /theme <name>'));
      } else {
        const ok = _themeMgr.switch(args[0]);
        if (ok) {
          console.log(t().success(`Theme switched to: ${args[0]}`));
        } else {
          console.log(t().error(`Theme not found: ${args[0]}`));
        }
      }
      return false;

    case 'plan': {
      const request = args.join(' ');
      if (!request) {
        // No args → export development requirements document
        const plan = (agent as any).currentPlan;
        if (!plan) {
          console.log(t().warning('No plan to export. Use /plan <request> first.'));
          return false;
        }
        const { mkdirSync, writeFileSync } = await import('fs');
        const projectName = plan.projectName || `plan-${Date.now()}`;
        const dir = join(homedir(), '.nexus', 'tasks', 'project', projectName);
        mkdirSync(dir, { recursive: true });

        // Save graph.json
        writeFileSync(
          join(dir, 'graph.json'),
          JSON.stringify(plan, null, 2),
          'utf-8',
        );

        // Generate and save REQUIREMENTS.md
        const tasksMd = plan.nodes.map((n: any) =>
          `### ${n.id}: ${n.description}\n` +
          `- **Status**: ${n.status}\n` +
          (n.dependencies?.length ? `- **Depends on**: ${n.dependencies.join(', ')}\n` : '') +
          (n.result ? `- **Result**: ${n.result}\n` : '') +
          (n.error ? `- **Error**: ${n.error}\n` : '')
        ).join('\n');

        const reqMd =
          `# ${plan.rootRequest}\n\n` +
          `**Project**: ${projectName}\n` +
          `**Generated**: ${new Date().toISOString()}\n` +
          `**Tasks**: ${plan.nodes?.length || 0}\n\n` +
          `---\n\n${tasksMd}`;

        writeFileSync(join(dir, 'REQUIREMENTS.md'), reqMd, 'utf-8');

        console.log(t().success(`Requirements exported to ~/.nexus/tasks/project/${projectName}/`));
        console.log(t().textDim(`  ├── graph.json`));
        console.log(t().textDim(`  └── REQUIREMENTS.md`));
        return false;
      }

      // Has request → decompose
      console.log(t().textDim('Analyzing and generating plan...'));
      try {
        const decomposeResult = await executeTaskTool('decompose_task', { request }, {
          agent: agent as any,
          tracker: (agent as any).tracker,
          sessionId: agent.getCurrentSessionId(),
        });

        let graph: any = null;
        if (decomposeResult && !decomposeResult.isError) {
          try {
            graph = JSON.parse(decomposeResult.content);
            const graphId = graph.graphId;
            const storedGraph = (agent as any).tracker.getGraph(graphId);
            if (storedGraph) {
              (agent as any).currentPlan = storedGraph;
            } else if (graphId && graph.nodes) {
              // Fallback: reconstruct from decompose data
              (agent as any).currentPlan = {
                id: graphId,
                sessionId: agent.getCurrentSessionId() || 'unknown',
                rootRequest: request,
                projectName: graph.projectName,
                nodes: graph.nodes.map((n: any, i: number) => {
                  const now = Date.now();
                  return {
                    id: n.id || `t${i + 1}`,
                    description: n.description || '',
                    dependencies: n.dependencies || [],
                    status: 'pending',
                    retryCount: 0,
                    maxRetries: 2,
                    createdAt: now,
                    updatedAt: now,
                  };
                }),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
            }
          } catch {
            // Parse failed, continue with LLM plan only
          }
        }

        // Get detailed plan from LLM
        const planText = await agent.plan(request);
        console.log(t().heading('\n=== Implementation Plan ===\n'));
        console.log(planText);

        const storedGraph = (agent as any).currentPlan;
        const proj = storedGraph?.projectName ? ` [project: ${storedGraph.projectName}]` : '';
        if (graph?.nodes) {
          console.log(t().textDim(`\nDetected ${graph.nodes.length} subtasks.${proj} Use /go to execute, /plan to export.`));
        } else {
          console.log(t().textDim('\nUse /go to start execution.'));
        }
      } catch (err) {
        console.log(t().error(`Plan failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }

    case 'go': {
      const redo = args.includes('redo');
      let plan = (agent as any).currentPlan;
      if (!plan) {
        const sid = agent.getCurrentSessionId();
        if (sid) {
          plan = (agent as any).tracker.getGraphBySession(sid);
          if (plan) (agent as any).currentPlan = plan;
        }
      } else if (!redo) {
        // If currentPlan has no remaining work, try newest graph from session
        const hasWork = plan.nodes.some((n: any) =>
          n.status !== 'completed' && n.status !== 'cancelled');
        if (!hasWork) {
          const sid = agent.getCurrentSessionId();
          if (sid) {
            const sessionGraph = (agent as any).tracker.getGraphBySession(sid);
            if (sessionGraph && sessionGraph.id !== plan.id) {
              plan = sessionGraph;
              (agent as any).currentPlan = sessionGraph;
            }
          }
        }
      }
      if (!plan) {
        console.log(t().warning('No plan found. Use /plan <request> first.'));
        return false;
      }
      if (redo) {
        const total = plan.nodes.length;
        for (const n of plan.nodes) {
          n.status = 'pending';
          n.result = undefined;
          n.error = undefined;
          n.retryCount = 0;
          n.updatedAt = Date.now();
        }
        (agent as any).tracker.updateGraph(plan);
        console.log(t().warning(`Reset ${total} tasks to pending for redo.`));
      }
      const completed = plan.nodes.filter((n: any) => n.status === 'completed').length;
      const failed = plan.nodes.filter((n: any) => n.status === 'failed').length;
      const pending = plan.nodes.filter((n: any) => n.status === 'pending' || n.status === 'in_progress').length;
      if (completed > 0) {
        console.log(t().textDim(`Resuming — ${completed} done, ${failed} failed, ${pending} remaining. Skipping completed tasks.`));
      }
      console.log(t().textDim('Executing plan...'));
      try {
        const result = await agent.executePlan();
        console.log(t().success(result));
      } catch (err) {
        console.log(t().error(`Execution failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }

    case 'tasks': {
      // /tasks -step <id> — show detail for a specific task
      if (args[0] === '-step' && args[1]) {
        const taskId = args[1];
        const sid = agent.getCurrentSessionId();
        if (!sid) {
          console.log(t().textDim('No active session.'));
          return false;
        }
        const graph = (agent as any).tracker.getGraphBySession(sid);
        if (!graph) {
          console.log(t().textDim('No task graph found.'));
          return false;
        }
        const node = graph.nodes.find((n: any) => n.id === taskId);
        if (!node) {
          console.log(t().error(`Task not found: ${taskId}`));
          return false;
        }
        console.log(t().heading(`Task: ${node.id}\n`));
        console.log(`  Description: ${node.description}`);
        console.log(`  Status: ${node.status}`);
        console.log(`  Dependencies: ${node.dependencies.join(', ') || '(none)'}`);
        console.log(`  Retries: ${node.retryCount}/${node.maxRetries}`);
        if (node.result) console.log(`  Result: ${node.result.slice(0, 500)}${node.result.length > 500 ? '...' : ''}`);
        if (node.error) console.log(t().error(`  Error: ${node.error}`));
        return false;
      }

      // /tasks [graphId] — show task graph
      const graphId = args[0] || '';
      let graph: any;
      if (graphId) {
        graph = (agent as any).tracker.getGraph(graphId);
      } else {
        // Prefer currentPlan if it has nodes, otherwise load newest from session
        graph = (agent as any).currentPlan;
        if (!graph || graph.nodes.length === 0) {
          const sid = agent.getCurrentSessionId();
          if (sid) graph = (agent as any).tracker.getGraphBySession(sid);
        }
      }
      if (!graph) {
        console.log(t().textDim('No task graph found. Use /plan first.'));
        return false;
      }

      console.log(t().heading(`Task Graph: ${graph.rootRequest}\n`));
      for (const node of graph.nodes) {
        const icon = node.status === 'completed' ? t().success('✓')
          : node.status === 'in_progress' ? t().warning('▶')
          : node.status === 'failed' ? t().error('✗')
          : node.status === 'cancelled' ? t().textDim('−')
          : t().textDim('○');
        const depInfo = node.dependencies.length > 0 ? t().textDim(` [depends: ${node.dependencies.join(', ')}]`) : '';
        const resultInfo = node.result ? t().textDim(`\n       result: ${node.result.slice(0, 80)}${node.result.length > 80 ? '...' : ''}`) : '';
        const errInfo = node.error ? t().error(`\n       error: ${node.error}`) : '';
        console.log(`  ${icon} ${t().entityName(node.id)}: ${node.description}${depInfo}${resultInfo}${errInfo}`);
      }
      console.log(t().textDim(`\nGraph ID: ${graph.id}`));
      return false;
    }

    default:
      console.log(t().warning(`Unknown command: /${cmd}`));
      return false;
  }
}

async function doResume(
  agent: Agent,
  session: { id: string; name: string },
  currentId: string | undefined,
  maxTokens: number,
  customQuestion?: (q: string, singleKey?: boolean) => Promise<string>
): Promise<boolean> {
  const tokens = agent.session.getTokenEstimate(session.id, agent.provider);
  console.log(t().textDim(`Resuming "${session.name}" (${tokens} tokens)...`));
  try {
    const result = await agent.resumeSession(session.id);
    if (!result.restored) {
      console.log(t().error('Session not found.'));
    } else if (result.compressed) {
      console.log(t().warning(`Session "${result.sessionName}" resumed (history compressed — ${tokens} tokens exceeded ${maxTokens} limit)`));
    } else {
      console.log(t().success(`Session "${result.sessionName}" resumed successfully.`));
    }
  } catch (err) {
    console.log(t().error(`Resume failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return false;
}

async function doResumeList(
  agent: Agent,
  allSessions: { id: string; name: string; model: string; updatedAt: number }[],
  displaySessions: { id: string; name: string; model: string; updatedAt: number }[],
  currentId: string | undefined,
  maxTokens: number,
  customQuestion?: (q: string, singleKey?: boolean) => Promise<string>
): Promise<boolean> {
  const rows: { id: string; name: string; model: string; updatedAt: string; tokens: number }[] = [];
  console.log(t().heading('Sessions:'));
  console.log(t().textDim('  #   Name                       Model                Updated              Tokens  Session ID'));
  console.log(t().textDim('  --- ---------------------------- -------------------- -------------------- ------ ------------------------------------'));
  for (const s of displaySessions) {
    const tokens = agent.session.getTokenEstimate(s.id, agent.provider);
    const date = new Date(s.updatedAt).toLocaleString();
    const name = s.name.slice(0, 28).padEnd(28);
    const model = s.model.slice(0, 18).padEnd(18);
    const dateStr = date.slice(0, 18).padEnd(18);
    const current = s.id === currentId ? t().success(' <- current') : '';
    const warn = tokens > maxTokens ? t().warning(' !') : '';
    console.log(`  ${String(rows.length + 1).padStart(3)} ${t().entityName(name)} ${model} ${dateStr} ${String(tokens).padStart(6)}${warn}${current}  ${t().textDim(s.id)}`);
    rows.push({ id: s.id, name: s.name, model: s.model, updatedAt: date, tokens });
  }

  console.log();
  const answer = await customQuestion!(t().prompt('Enter number (or Esc to cancel): '));
  const num = parseInt(answer.trim(), 10);
  if (isNaN(num) || num < 1 || num > rows.length) {
    console.log(t().textDim('Cancelled.'));
    return false;
  }
  const selected = rows[num - 1]!;
  console.log(t().textDim(`Resuming "${selected.name}" (${selected.tokens} tokens)...`));
  try {
    const result = await agent.resumeSession(selected.id);
    if (!result.restored) {
      console.log(t().error('Session not found.'));
    } else if (result.compressed) {
      console.log(t().warning(`Session "${result.sessionName}" resumed (history compressed — ${selected.tokens} tokens exceeded ${maxTokens} limit)`));
    } else {
      console.log(t().success(`Session "${result.sessionName}" resumed successfully.`));
    }
  } catch (err) {
    console.log(t().error(`Resume failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return false;
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
        console.log(t().error(`  Invalid range: ${part.trim()}`));
        return null;
      }
      for (let i = from; i <= to; i++) ids.add(i);
    } else {
      const num = parseInt(part.trim(), 10);
      if (isNaN(num) || num < 1) {
        console.log(t().error(`  Invalid number: ${part.trim()}`));
        return null;
      }
      ids.add(num);
    }
  }

  const sorted = [...ids].sort((a, b) => a - b);
  const valid = sorted.filter(i => i <= maxId);
  const skipped = sorted.filter(i => i > maxId);

  if (skipped.length > 0) {
    console.log(t().warning(`  Note: #${skipped.join(',#')} out of range (1-${maxId}), skipped`));
  }

  if (valid.length === 0) {
    console.log(t().textDim('  No valid sessions to delete.'));
    return null;
  }

  return valid;
}
