/**
 * P1 — Terminal sidebar page (DSH Better SideBar port).
 * See docs/dsh-plugin-adoption-plan.md §4.2 ("terminal → new").
 *
 * A read-mostly terminal/log surface: shows the most recent worker log lines
 * (via the desktop log channel) plus a light command input for the session.
 * Lives entirely in the sidebar container — the chat stream is untouched.
 *
 * Dependency-injected for unit tests (fake log source + fake exec).
 */

import type { SidebarContext } from '../types.js';

export interface TerminalPageOptions {
  /** Log source; default reads via window.nexusDesktop.readRecentLogs. */
  readLogs?: (maxLines?: number) => Promise<string[]>;
  /** Subscribe to live log lines; returns unsubscribe. */
  subscribeLogs?: (cb: (line: string) => void) => () => void;
  /** Execute a terminal-ish command for the session (default: no-op). */
  exec?: (command: string) => void;
  getUiLang?: () => string;
}

/** Default implementation bridged to the desktop preload API. */
function defaultReadLogs(maxLines = 200): Promise<string[]> {
  return window.nexusDesktop.readRecentLogs(maxLines).catch(() => []);
}

/**
 * Mount the terminal page into `container`. Returns a dispose function that
 * unsubscribes from the log source and removes every DOM node created here.
 */
export function mountTerminalPage(
  container: HTMLElement,
  _ctx: SidebarContext,
  opts: TerminalPageOptions = {},
): () => void {
  const readLogs = opts.readLogs ?? defaultReadLogs;
  const subscribeLogs =
    opts.subscribeLogs ??
    ((cb: (line: string) => void) => window.nexusDesktop.onLog((log) => cb(`[${log.level}] ${log.message}`)));
  const exec = opts.exec ?? (() => {});
  const getUiLang = opts.getUiLang ?? (() => 'zh-CN');

  container.classList.add('terminal-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'terminal-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'terminal-header';
  header.innerHTML = `
    <span class="terminal-title">${getUiLang() === 'zh-CN' ? '⌨ 终端 / 日志' : '⌨ Terminal / Logs'}</span>
    <span class="terminal-legend">${getUiLang() === 'zh-CN' ? '最近日志与命令，不阻塞聊天' : 'recent logs & commands, chat never blocks'}</span>
  `;
  root.appendChild(header);

  const output = document.createElement('pre');
  output.className = 'terminal-output';
  output.dataset.testid = 'terminal-output';
  root.appendChild(output);

  const inputRow = document.createElement('div');
  inputRow.className = 'terminal-input-row';
  root.appendChild(inputRow);

  const input = document.createElement('input');
  input.className = 'terminal-input';
  input.placeholder = getUiLang() === 'zh-CN' ? '输入命令并按回车…' : 'type a command and press Enter…';
  input.spellcheck = false;
  inputRow.appendChild(input);

  /** Bounded log buffer — never grows unbounded (no silent context bloat). */
  const maxLines = 500;
  let lines: string[] = [];
  const render = (): void => {
    output.textContent = lines.slice(-maxLines).join('\n');
    output.scrollTop = output.scrollHeight;
  };
  const push = (line: string): void => {
    lines.push(line);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    render();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const cmd = input.value.trim();
    lines.push(`> ${cmd}`);
    input.value = '';
    render();
    try {
      exec(cmd);
    } catch {
      // Command errors never break the terminal page.
    }
  });

  const unsubscribe = subscribeLogs(push);
  void readLogs(maxLines).then((logs) => {
    lines = logs.slice(-maxLines);
    render();
  });

  render();

  return () => {
    unsubscribe();
    container.classList.remove('terminal-page');
    container.innerHTML = '';
  };
}

/** Assistant binding: constructs the page with the real log bridge. */
export const TerminalPage = {
  id: 'terminal',
  title: 'Terminal',
  icon: '⌨',
  mount: mountTerminalPage,
} as const;