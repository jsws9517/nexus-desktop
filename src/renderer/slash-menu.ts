/**
 * Slash command autocomplete controller for the chat composer.
 *
 * Recognises a `/token` at the very start of the composer (leading whitespace
 * is allowed because the worker trims input before parsing) and offers the
 * commands this desktop client can actually execute. The list is a curated
 * static set: core registry commands that are served to desktop clients plus
 * the desktop-only commands handled by AgentService.handleDagCommand().
 * CLI-only core names that desktop does not take over are deliberately absent.
 *
 * Pure helpers (parseSlashToken / filterSlashCommands) are exported so token
 * parsing and filtering can be unit-tested with happy-dom without Electron.
 */

// ---------- public types ----------

export type SlashCategory = 'session' | 'model' | 'tools' | 'tasks' | 'other';

export interface SlashCommand {
  /** Canonical command name, without the leading slash. */
  name: string;
  /** Accepted aliases (desktop/core dispatch resolves them to this command). */
  aliases?: readonly string[];
  /** Short syntax hint shown on the right of a candidate. */
  usage: string;
  category: SlashCategory;
  /** Key into the renderer i18n table for the short description. */
  descKey: string;
}

export const DEFAULT_SLASH_CAP = 50;
export const MAX_SLASH_QUERY = 64;

/** All slash commands available in this desktop client, grouped by category.
 *  Order is significant: candidates are shown in this order when the query is
 *  empty, and category headers are emitted whenever the category changes. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  // Session
  { name: 'new', usage: '/new', category: 'session', descKey: 'slashDescNew' },
  { name: 'session', usage: '/session', category: 'session', descKey: 'slashDescSession' },
  { name: 'info', usage: '/info', category: 'session', descKey: 'slashDescInfo' },
  { name: 'rename', aliases: ['remark'], usage: '/rename <name>', category: 'session', descKey: 'slashDescRename' },
  { name: 'view', usage: '/view <id|#num>', category: 'session', descKey: 'slashDescView' },
  { name: 'resume', usage: '/resume <name|id>', category: 'session', descKey: 'slashDescResume' },
  { name: 'clear', usage: '/clear', category: 'session', descKey: 'slashDescClear' },
  { name: 'setdir', usage: '/setdir [path]', category: 'session', descKey: 'slashDescSetdir' },
  { name: 'chcwd', usage: '/chcwd [path]', category: 'session', descKey: 'slashDescChcwd' },
  { name: 'rename-project', usage: '/rename-project <name>', category: 'session', descKey: 'slashDescRenameProject' },
  // Model & permissions
  { name: 'model', aliases: ['models'], usage: '/model [set <id>]', category: 'model', descKey: 'slashDescModel' },
  { name: 'provider', aliases: ['providers'], usage: '/provider [switch] <name>', category: 'model', descKey: 'slashDescProvider' },
  { name: 'depth', usage: '/depth <level>', category: 'model', descKey: 'slashDescDepth' },
  { name: 'bypass', aliases: ['permissions', 'perm'], usage: '/bypass [auto|off|status]', category: 'model', descKey: 'slashDescBypass' },
  { name: 'billing', usage: '/billing [mode]', category: 'model', descKey: 'slashDescBilling' },
  // Tools
  { name: 'tools', usage: '/tools', category: 'tools', descKey: 'slashDescTools' },
  { name: 'mcp', usage: '/mcp', category: 'tools', descKey: 'slashDescMcp' },
  { name: 'plugins', usage: '/plugins', category: 'tools', descKey: 'slashDescPlugins' },
  { name: 'skills', usage: '/skills', category: 'tools', descKey: 'slashDescSkills' },
  // Tasks
  { name: 'plan', usage: '/plan <request>', category: 'tasks', descKey: 'slashDescPlan' },
  { name: 'go', usage: '/go [redo] [--loop=N]', category: 'tasks', descKey: 'slashDescGo' },
  { name: 'tasks', usage: '/tasks [id]', category: 'tasks', descKey: 'slashDescTasks' },
  { name: 'runs', usage: '/runs [id]', category: 'tasks', descKey: 'slashDescRuns' },
  { name: 'jobs', aliases: ['bg'], usage: '/jobs <action> [args]', category: 'tasks', descKey: 'slashDescJobs' },
  { name: 'revise', usage: '/revise [request]', category: 'tasks', descKey: 'slashDescRevise' },
  { name: 'commit', usage: '/commit', category: 'tasks', descKey: 'slashDescCommit' },
  // Other
  { name: 'memory', usage: '/memory', category: 'other', descKey: 'slashDescMemory' },
  { name: 'persona', usage: '/persona [path]', category: 'other', descKey: 'slashDescPersona' },
  { name: 'insight', usage: '/insight', category: 'other', descKey: 'slashDescInsight' },
  { name: 'theme', usage: '/theme', category: 'other', descKey: 'slashDescTheme' },
  { name: 'live', usage: '/live [on|off]', category: 'other', descKey: 'slashDescLive' },
  { name: 'manual', aliases: ['help'], usage: '/manual', category: 'other', descKey: 'slashDescManual' },
  { name: 'compact', usage: '/compact', category: 'other', descKey: 'slashDescCompact' },
];

export interface SlashToken {
  /** Index of the `/` in the textarea value. */
  start: number;
  /** Cursor position (end of the token). */
  end: number;
  query: string;
}

export interface SlashCandidate {
  /** Canonical command (used for description + category lookup). */
  command: SlashCommand;
  /** Name inserted after `/` — canonical name or the matched alias. */
  insert: string;
  /** True when `insert` is an alias rather than the canonical name. */
  isAlias: boolean;
}

export interface SlashMenuLabels {
  panelAria: string;
  hint: string;
  categories: Record<SlashCategory, string>;
  /** Resolve an i18n key from `SlashCommand.descKey`. */
  desc: (descKey: string) => string;
}

export interface SlashMenuOptions {
  input: HTMLTextAreaElement;
  panel: HTMLElement;
  labels: SlashMenuLabels;
  commands?: readonly SlashCommand[];
  cap?: number;
}

// ---------- pure helpers ----------

/**
 * Parse the `/token` immediately before the caret. Only a command at the very
 * start of the message counts (the worker parses only `input.trim().startsWith('/')`),
 * so `http://`, `and/or`, mid-sentence slashes and commands that already have
 * arguments never open the menu.
 */
export function parseSlashToken(value: string, cursor: number): SlashToken | null {
  const end = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, end);
  const match = /^(\s*)(\/[A-Za-z0-9_-]*)$/.exec(before);
  if (!match) return null;
  const query = match[2].slice(1);
  if (query.length > MAX_SLASH_QUERY) return null;
  // Do not hijack an existing command line while the caret is moved into it.
  if (value.slice(end).trim() !== '') return null;
  const start = match[1].length;
  return { start, end, query };
}

/**
 * Filter by canonical name prefix; aliases are used only when the canonical
 * name does not already match (so an empty query shows one row per command).
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  cap: number = DEFAULT_SLASH_CAP,
): SlashCandidate[] {
  const needle = query.toLowerCase();
  const out: SlashCandidate[] = [];
  for (const command of commands) {
    if (command.name.toLowerCase().startsWith(needle)) {
      out.push({ command, insert: command.name, isAlias: false });
    } else if (needle) {
      const alias = (command.aliases ?? []).find((a) => a.toLowerCase().startsWith(needle));
      if (alias) out.push({ command, insert: alias, isAlias: true });
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

// ---------- controller ----------

export class SlashMenuController {
  private readonly input: HTMLTextAreaElement;
  private readonly panel: HTMLElement;
  private readonly commands: readonly SlashCommand[];
  private readonly labels: SlashMenuLabels;
  private readonly cap: number;

  private token: SlashToken | null = null;
  private candidates: SlashCandidate[] = [];
  private active = 0;
  private openState = false;
  /** Set right before a synthetic `input` event so the menu stays closed. */
  private suppressInput = false;

  private readonly onInput = (): void => this.handleInput();
  private readonly onKeyDown = (e: KeyboardEvent): boolean => this.handleKeydown(e);
  private readonly onPanelMouseDown = (e: Event): void => {
    // Keep the textarea focused while clicking an option.
    e.preventDefault();
  };
  private readonly onPanelClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    const el = target?.closest<HTMLElement>('[data-slash-index]');
    if (!el) return;
    const candidate = this.candidates[Number(el.dataset.slashIndex)];
    if (candidate) this.select(candidate);
  };
  private readonly onDocMouseDown = (e: Event): void => {
    const target = e.target as Node | null;
    if (target && !this.panel.contains(target) && !this.input.contains(target)) this.close();
  };

  constructor(options: SlashMenuOptions) {
    this.input = options.input;
    this.panel = options.panel;
    this.commands = options.commands ?? SLASH_COMMANDS;
    this.labels = options.labels;
    this.cap = options.cap ?? DEFAULT_SLASH_CAP;
    this.input.addEventListener('input', this.onInput);
    this.input.addEventListener('keydown', this.onKeyDown);
    this.panel.addEventListener('mousedown', this.onPanelMouseDown);
    this.panel.addEventListener('click', this.onPanelClick);
    document.addEventListener('mousedown', this.onDocMouseDown);
  }

  dispose(): void {
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onKeyDown);
    this.panel.removeEventListener('mousedown', this.onPanelMouseDown);
    this.panel.removeEventListener('click', this.onPanelClick);
    document.removeEventListener('mousedown', this.onDocMouseDown);
    this.close();
  }

  /** True while the menu is visible; the composer's Enter-to-send guard uses it. */
  isOpen(): boolean {
    return this.openState;
  }

  /** Rebuild an open panel after a runtime language switch. */
  applyLanguage(): void {
    if (this.openState) this.renderPanel();
  }

  private handleInput(): void {
    if (this.suppressInput) {
      this.suppressInput = false;
      return;
    }
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const token = parseSlashToken(this.input.value, cursor);
    if (!token) {
      this.close();
      return;
    }
    this.token = token;
    this.candidates = filterSlashCommands(this.commands, token.query, this.cap);
    this.active = 0;
    if (this.candidates.length === 0) {
      this.close();
      return;
    }
    this.openState = true;
    this.renderPanel();
  }

  private renderPanel(): void {
    this.panel.innerHTML = '';
    this.panel.setAttribute('aria-label', this.labels.panelAria);
    let lastCategory: SlashCategory | null = null;
    this.candidates.forEach((candidate, index) => {
      const { command } = candidate;
      if (command.category !== lastCategory) {
        lastCategory = command.category;
        const group = document.createElement('div');
        group.className = 'slash-menu-group';
        group.textContent = this.labels.categories[command.category];
        group.setAttribute('role', 'presentation');
        this.panel.appendChild(group);
      }
      const opt = document.createElement('div');
      opt.className = 'slash-menu-option' + (index === this.active ? ' active' : '');
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', index === this.active ? 'true' : 'false');
      opt.dataset.slashIndex = String(index);
      const name = document.createElement('span');
      name.className = 'slash-menu-name';
      name.textContent = '/' + candidate.insert;
      const desc = document.createElement('span');
      desc.className = 'slash-menu-desc';
      desc.textContent = this.labels.desc(command.descKey);
      const usage = document.createElement('span');
      usage.className = 'slash-menu-usage';
      usage.textContent = command.usage;
      opt.append(name, desc, usage);
      this.panel.appendChild(opt);
    });
    const hint = document.createElement('div');
    hint.className = 'slash-menu-hint';
    hint.textContent = this.labels.hint;
    hint.setAttribute('role', 'presentation');
    this.panel.appendChild(hint);
    this.panel.classList.remove('hidden');
  }

  private setActive(index: number): void {
    const len = this.candidates.length;
    if (len === 0) return;
    this.active = ((index % len) + len) % len;
    this.renderPanel();
    const activeEl = this.panel.querySelector<HTMLElement>('.slash-menu-option.active');
    // DOM shims (tests) do not always implement scrollIntoView.
    if (typeof activeEl?.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Handle keyboard input while the menu is open. Returns true when the event
   * was consumed — `stopImmediatePropagation` also keeps the composer's
   * Enter-to-send and the document's Escape-to-stop handlers from firing.
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.openState) return false;
    const consume = (): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    switch (e.key) {
      case 'Escape':
        consume();
        this.close();
        return true;
      case 'ArrowDown':
        consume();
        this.setActive(this.active + 1);
        return true;
      case 'ArrowUp':
        consume();
        this.setActive(this.active - 1);
        return true;
      case 'Enter':
      case 'Tab': {
        consume();
        const candidate = this.candidates[this.active];
        if (candidate) this.select(candidate);
        return true;
      }
      default:
        return false;
    }
  }

  private select(candidate: SlashCandidate): void {
    const token = this.token;
    this.close();
    if (!token) return;
    const value = this.input.value;
    if (token.start < 0 || token.end > value.length || value[token.start] !== '/') return;
    const insert = '/' + candidate.insert + ' ';
    this.input.value = value.slice(0, token.start) + insert + value.slice(token.end);
    const caret = token.start + insert.length;
    try {
      this.input.setSelectionRange(caret, caret);
    } catch {
      /* some DOM shims do not implement selection ranges */
    }
    this.suppressInput = true;
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private close(): void {
    this.openState = false;
    this.candidates = [];
    this.active = 0;
    this.token = null;
    this.panel.innerHTML = '';
    this.panel.classList.add('hidden');
  }
}
