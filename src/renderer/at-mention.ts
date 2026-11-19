/**
 * `@` mention controller for the composer (T1-2).
 *
 * Recognises an `@token` left of the caret and offers three candidate kinds:
 *   - files / directories under the current tab's cwd (`nexus:listDirectory`)
 *   - project rule files (`nexus:listProjectRules`, T1-2/FR-2.3)
 *
 * Everything that picks a path funnels through the existing `attachments`
 * array in renderer.ts — no new send-protocol field. Selecting a directory
 * expands its DIRECT child files only (cap 50); selecting a rule attaches its
 * path so the core reads the full text from the resulting `@path` line.
 *
 * Pure helpers (parseAtToken / filterDirectoryEntries / pickFolderFiles /
 * filterRuleEntries) are exported so token parsing and the cap/filter rules
 * can be unit-tested with happy-dom without an Electron main process.
 */

// ---------- public types ----------

export const MAX_MENTION_DEPTH = 2;
export const DEFAULT_MENTION_CAP = 50;

export interface RawDirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

/** A directory entry enriched with its absolute path (built by the adapter). */
export interface MentionDirEntry extends RawDirectoryEntry {
  path: string;
}

export interface MentionRuleEntry {
  name: string;
  path: string;
  size: number;
}

/** Raw IPC result from `nexus:listDirectory` (no absolute paths yet). */
export interface RawDirResult {
  ok: boolean;
  entries: RawDirectoryEntry[];
  error?: string;
}

/** Enriched result after the controller adds absolute paths to each entry. */
export interface DirResult {
  ok: boolean;
  entries: MentionDirEntry[];
  error?: string;
}

export interface RulesResult {
  ok: boolean;
  files: MentionRuleEntry[];
  error?: string;
}

export interface MentionLabels {
  file: string;
  directory: string;
  rule: string;
  invalidPath: string;
  genericError: string;
}

export interface AtMentionOptions {
  input: HTMLTextAreaElement;
  panel: HTMLElement;
  getCwd: () => string;
  listDirectory: (root: string, path: string) => Promise<RawDirResult>;
  listProjectRules: (cwd: string) => Promise<RulesResult>;
  /** Attach the picked absolute path(s) via the existing attachments bridge. */
  onPick: (paths: string[]) => void;
  /** Folder expansion hit the cap: (cap, totalFound). */
  onFolderOverflow: (cap: number, total: number) => void;
  onError: (message: string) => void;
  labels: MentionLabels;
  cap?: number;
  debounceMs?: number;
}

export interface AtToken {
  /** Index of the `@` in the textarea value. */
  start: number;
  /** Cursor position (end of the token). */
  end: number;
  query: string;
  kind: 'file' | 'rule';
}

export interface MentionCandidate {
  type: 'file' | 'directory' | 'rule';
  label: string;
  path: string;
  size: number;
}

// ---------- pure helpers ----------

/**
 * Parse the `@token` immediately before the caret. Returns null for ordinary
 * text, emails (`a@b.com`) and bare `@` preceded by a word character — so
 * typing never hijacks normal input or slash commands.
 */
export function parseAtToken(value: string, cursor: number): AtToken | null {
  const end = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, end);
  let at = -1;
  for (let i = end - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === '@') {
      at = i;
      break;
    }
    if (/\s/.test(ch)) break;
  }
  if (at < 0) return null;
  const prev = at > 0 ? before[at - 1] : '';
  // `@` must start a token (line start, whitespace, or an opening/phrase mark).
  if (prev && !/[\s(（【,，。、：:]/.test(prev)) return null;
  const query = before.slice(at + 1, end);
  if (query.length > 200 || /[\s]/.test(query)) return null;
  const isRule = /^(?:Rule|rule|RULE|规则)/.test(query);
  return { start: at, end, query, kind: isRule ? 'rule' : 'file' };
}

/** Strip the `@Rule` / `@规则` prefix, leaving the rule-name filter. */
export function ruleFilter(query: string): string {
  return query.replace(/^(?:Rule|rule|RULE|规则)/, '');
}

function isIgnored(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules' || name === '.git';
}

/** Split an @query into relative directory segments + the name filter. */
export function splitQueryPath(query: string): { dirs: string[]; namePart: string } {
  const parts = query.replace(/\\/g, '/').split('/');
  const namePart = parts.pop() ?? '';
  return { dirs: parts.filter((s) => s.length > 0), namePart };
}

/** Build an absolute path under `cwd` from trusted query segments, or null on
 *  traversal / absolute-path attempts. Renderer-side guard only — the main
 *  process repeats it with realpath + authorized roots. */
export function joinUnder(cwd: string, segments: readonly string[]): string | null {
  const sep = cwd.includes('\\') ? '\\' : '/';
  let out = cwd.replace(/[\\/]+$/, '');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s.includes(':')) return null;
    out += sep + s;
  }
  return out;
}

export function stripTrailingSep(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** Filter + sort one directory level: directories first, capped at `cap`. */
export function filterDirectoryEntries(
  entries: readonly MentionDirEntry[],
  query: string,
  cap: number,
): MentionCandidate[] {
  const needle = query.toLowerCase();
  const matched = entries.filter((e) =>
    !isIgnored(e.name) && e.name.toLowerCase().startsWith(needle),
  );
  matched.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return matched.slice(0, cap).map((e) => ({
    type: e.type,
    label: e.type === 'directory' ? e.name + '/' : e.name,
    path: e.path,
    size: e.size,
  }));
}

/** Direct child FILES of a folder, hidden/ignored entries dropped, capped.
 *  `total` reports the un-capped count so the UI can warn about truncation. */
export function pickFolderFiles(
  entries: readonly MentionDirEntry[],
  cap: number,
): { files: MentionDirEntry[]; total: number } {
  const files = entries.filter((e) => e.type === 'file' && !isIgnored(e.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files: files.slice(0, cap), total: files.length };
}

/** Project rule files matching the free-text part after `@Rule`. */
export function filterRuleEntries(
  entries: readonly MentionRuleEntry[],
  query: string,
  cap: number,
): MentionCandidate[] {
  const needle = ruleFilter(query).toLowerCase();
  return entries
    .filter((e) => e.name.toLowerCase().includes(needle))
    .slice(0, cap)
    .map((e) => ({ type: 'rule' as const, label: e.name, path: e.path, size: e.size }));
}

// ---------- controller ----------

export class AtMentionController {
  private readonly input: HTMLTextAreaElement;
  private readonly panel: HTMLElement;
  private readonly opts: AtMentionOptions;
  private readonly cap: number;
  private readonly debounceMs: number;
  private readonly cache = new Map<string, Promise<DirResult>>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private token: AtToken | null = null;
  private candidates: MentionCandidate[] = [];
  private active = 0;
  private openState = false;
  /** Set right before a synthetic `input` event after removing the token. */
  private suppressInput = false;

  private readonly onInput = (): void => this.handleInput();
  private readonly onKeyDown = (e: KeyboardEvent): boolean => this.handleKeydown(e);
  private readonly onPanelMouseDown = (e: Event): void => {
    // Keep the textarea focused while clicking an option.
    e.preventDefault();
  };
  private readonly onPanelClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    const el = target?.closest<HTMLElement>('[data-mention-index]');
    if (!el) return;
    const idx = Number(el.dataset.mentionIndex);
    const candidate = this.candidates[idx];
    if (candidate) void this.select(candidate);
  };
  private readonly onDocMouseDown = (e: Event): void => {
    const target = e.target as Node | null;
    if (target && !this.panel.contains(target) && !this.input.contains(target)) this.close();
  };

  constructor(options: AtMentionOptions) {
    this.opts = options;
    this.input = options.input;
    this.panel = options.panel;
    this.cap = options.cap ?? DEFAULT_MENTION_CAP;
    this.debounceMs = options.debounceMs ?? 120;
    this.input.addEventListener('input', this.onInput);
    this.input.addEventListener('keydown', this.onKeyDown);
    this.panel.addEventListener('mousedown', this.onPanelMouseDown);
    this.panel.addEventListener('click', this.onPanelClick);
    document.addEventListener('mousedown', this.onDocMouseDown);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('keydown', this.onKeyDown);
    this.panel.removeEventListener('mousedown', this.onPanelMouseDown);
    this.panel.removeEventListener('click', this.onPanelClick);
    document.removeEventListener('mousedown', this.onDocMouseDown);
    this.close();
  }

  /** True while the candidate menu is visible — the composer's Enter-to-send
   *  handler checks this so AC-7 ("Enter selects, never sends") holds. */
  isOpen(): boolean {
    return this.openState;
  }

  private handleInput(): void {
    if (this.suppressInput) {
      this.suppressInput = false;
      return;
    }
    const cursor = this.input.selectionStart ?? this.input.value.length;
    const token = parseAtToken(this.input.value, cursor);
    if (!token) {
      this.close();
      return;
    }
    this.token = token;
    if (this.timer) clearTimeout(this.timer);
    const gen = ++this.generation;
    this.timer = setTimeout(() => void this.refresh(gen), this.debounceMs);
  }

  private async refresh(gen: number): Promise<void> {
    if (gen !== this.generation || !this.token) return;
    const token = this.token;
    const cwd = this.opts.getCwd();
    if (!cwd) {
      this.close();
      return;
    }
    try {
      let candidates: MentionCandidate[] = [];
      if (token.kind === 'rule') {
        const res = await this.opts.listProjectRules(cwd);
        if (gen !== this.generation) return;
        if (!res.ok) {
          this.close();
          if (res.error) this.opts.onError(res.error);
          return;
        }
        candidates = filterRuleEntries(res.files, token.query, this.cap);
      } else {
        const { dirs, namePart } = splitQueryPath(token.query);
        if (dirs.length > MAX_MENTION_DEPTH) {
          this.close();
          return;
        }
        const dirAbs = joinUnder(cwd, dirs);
        if (!dirAbs) {
          this.close();
          this.opts.onError(this.opts.labels.invalidPath);
          return;
        }
        const res = await this.listDir(cwd, dirAbs);
        if (gen !== this.generation) return;
        if (!res.ok) {
          this.close();
          if (res.error) this.opts.onError(res.error);
          return;
        }
        candidates = filterDirectoryEntries(res.entries, namePart, this.cap);
      }
      if (gen !== this.generation) return;
      if (candidates.length === 0) {
        this.close(); // FR-2.7: no candidates → silent close
        return;
      }
      this.candidates = candidates;
      this.active = 0;
      this.openState = true;
      this.renderPanel();
    } catch {
      this.close();
    }
  }

  private listDir(root: string, path: string): Promise<DirResult> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const req = this.opts.listDirectory(root, path).then((res) => {
      const entries: MentionDirEntry[] = (res.entries ?? []).map((e) => ({
        ...e,
        path: stripTrailingSep(path) + (path.includes('\\') ? '\\' : '/') + e.name,
      }));
      return { ok: res.ok, entries, error: res.error } as DirResult;
    });
    // Cache successful listings only; a failure (e.g. transient) can retry.
    const tracked = req.then((res) => {
      if (!res.ok) this.cache.delete(path);
      return res;
    }).catch((e) => {
      this.cache.delete(path);
      throw e;
    });
    this.cache.set(path, tracked);
    return tracked;
  }

  private renderPanel(): void {
    this.panel.innerHTML = '';
    this.candidates.forEach((c, i) => {
      const opt = document.createElement('div');
      opt.className = 'at-mention-option' + (i === this.active ? ' active' : '');
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', i === this.active ? 'true' : 'false');
      opt.dataset.mentionIndex = String(i);
      const label = document.createElement('span');
      label.className = 'at-mention-label';
      label.textContent = c.label;
      opt.appendChild(label);
      const badge = document.createElement('span');
      badge.className = 'at-mention-badge';
      badge.textContent = c.type === 'rule'
        ? this.opts.labels.rule
        : c.type === 'directory'
          ? this.opts.labels.directory
          : this.opts.labels.file;
      opt.appendChild(badge);
      this.panel.appendChild(opt);
    });
    this.panel.classList.remove('hidden');
  }

  private setActive(index: number): void {
    const len = this.candidates.length;
    if (len === 0) return;
    this.active = ((index % len) + len) % len;
    this.renderPanel();
    const activeEl = this.panel.querySelector<HTMLElement>('.at-mention-option.active');
    // DOM shims (tests) do not always implement scrollIntoView.
    if (typeof activeEl?.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Handle keyboard input while the menu is open. Returns true when the event
   * was consumed (caller must not run its own Enter-to-send logic).
   */
  handleKeydown(e: KeyboardEvent): boolean {
    if (!this.openState) return false;
    // Only the keys the menu owns are consumed. Regular typing must still
    // reach the textarea so the user can refine `@src/ut` while the menu is up.
    // `stopImmediatePropagation` also keeps the document's Escape-to-stop
    // handler from firing when Escape is just closing this menu.
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
        if (candidate) void this.select(candidate);
        return true;
      }
      default:
        return false;
    }
  }

  private async select(candidate: MentionCandidate): Promise<void> {
    const token = this.token;
    const cwd = this.opts.getCwd();
    this.close();

    // Remove the consumed `@token` from the composer so the sent message does
    // not contain both the raw mention and the `@path` line from attachments.
    if (token) {
      const value = this.input.value;
      if (value.startsWith('@', token.start) && token.end <= value.length) {
        const next = value.slice(0, token.start) + value.slice(token.end);
        this.input.value = next;
        try {
          this.input.setSelectionRange(token.start, token.start);
        } catch {
          /* some DOM shims do not implement selection ranges */
        }
        this.suppressInput = true;
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    try {
      if (candidate.type === 'directory') {
        const res = await this.listDir(cwd, stripTrailingSep(candidate.path));
        if (!res.ok) {
          if (res.error) this.opts.onError(res.error);
          return;
        }
        const { files, total } = pickFolderFiles(res.entries, this.cap);
        if (files.length > 0) this.opts.onPick(files.map((f) => f.path));
        if (total > files.length) this.opts.onFolderOverflow(this.cap, total);
      } else {
        this.opts.onPick([candidate.path]);
      }
    } catch {
      this.opts.onError(this.opts.labels.genericError);
    }
  }

  private close(): void {
    this.openState = false;
    this.candidates = [];
    this.active = 0;
    this.token = null;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.panel.innerHTML = '';
    this.panel.classList.add('hidden');
  }
}
