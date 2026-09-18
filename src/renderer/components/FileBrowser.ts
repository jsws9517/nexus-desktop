/**
 * Right-panel file browser — lazy-loading directory tree for the active
 * project (mounted at the bottom of #right-sidebar).
 *
 * Conventions follow the sidebar pages (dependency-injected, framework-free
 * DOM, unit-testable under node --test with a fake container):
 *   - directories expand/collapse on click, loading their children lazily via
 *     the injected bridge (IPC to the main process — the renderer never reads
 *     the filesystem itself);
 *   - files open externally with the OS default app;
 *   - git badges show working-tree state per path (✓ committed / M modified /
 *     U untracked, plus an aggregate dot on directories), refreshed from
 *     `getGitStatus` on mount, session change, and debounced on task events;
 *   - a filter hides non-matching files (directories stay visible): each token
 *     is a filename keyword (case-insensitive substring), an extension
 *     (e.g. `.ts`), or a small glob pattern with `^`/`$` anchors and
 *     `*`/`?` wildcards (e.g. `^_*.py` selects underscore-prefixed py files);
 *   - hidden entries (dotfiles + common noise dirs) are folded away unless the
 *     "show hidden" toggle is on;
 *   - the panel starts collapsed and opens only on an explicit user click
 *     (no visual jolt at startup); once open it auto-collapses when active
 *     tasks need progress monitoring (ctx.isMonitorNeeded()), when the user
 *     clicks the collapse button, or after `idleMs` of user inactivity.
 *
 * The component owns its DOM entirely (container stays an empty placeholder),
 * so static/index.html only needs the target section.
 */

import type { AgentEvent } from '../../agent/types.js';
import { STR } from '../i18n.js';

export interface FileBrowserEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
}

/** Working-tree state of one path, keyed by absolute path. */
export type GitState = 'committed' | 'modified' | 'untracked';

/** Raw status reported by the engine; `ignored` paths get no badge. */
type GitFileState = GitState | 'ignored';

export interface GitStatusResult {
  ok: boolean;
  isRepo: boolean;
  branch?: string;
  statuses?: Array<{ path: string; state: GitFileState }>;
  error?: string;
}

/** Drag payload written by a file row and read by the chat drop zone. */
export const FILE_DRAG_MIME = 'application/x-nexus-path';

/** IPC surface (defaults to window.nexusDesktop; injected in tests). */
export interface FileBrowserBridge {
  listDirectory(
    root: string,
    path: string,
  ): Promise<{ ok: boolean; entries?: FileBrowserEntry[]; truncated?: boolean; error?: string }>;
  openExternalFile(path: string): Promise<{ ok: boolean; error?: string }>;
  /** Open a file in a text editor (notepad on Windows, the platform default
   *  elsewhere). Optional: absent on an older preload, in which case the caller
   *  falls back to `openExternalFile`. */
  openInEditor?(path: string): Promise<{ ok: boolean; error?: string }>;
  /** Absolute-path-indexed entries; a missing path means the working tree is
   *  clean. `ignored` entries are excluded from badges entirely. */
  getGitStatus(root: string): Promise<GitStatusResult>;
}

export interface FileBrowserContext {
  /** The current project directory ('' if none). May be async — the host
   *  resolves it from session metadata fresh on each request so a session
   *  switch is never served a stale cached dir. */
  getProjectDir(): string | Promise<string>;
  getUiLang(): string;
  subscribe(fn: (event: AgentEvent) => void): () => void;
  /** True while any task is running/pending (progress monitoring window). */
  isMonitorNeeded(): boolean;
  /** Host-owned hook that adds an absolute file path to the chat composer
   *  (as an attachment). Optional so the component stays standalone. */
  addFileToChat?(path: string): void;
}

export interface FileBrowserMountOptions {
  bridge?: FileBrowserBridge;
  /** Idle collapse delay. Defaults to 10s; overridden in tests. */
  idleMs?: number;
  /** Start collapsed; the tree only opens on an explicit user click (avoids
   *  a jarring flash of files at startup). Defaults to true. */
  defaultCollapsed?: boolean;
}

interface DirNode {
  path: string;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  error?: string;
  truncated?: boolean;
  entries?: FileBrowserEntry[];
}

interface RowItem {
  type: 'file' | 'directory';
  name: string;
  size: number;
  depth: number;
  path: string;
  node?: DirNode;
}

const DEFAULT_IDLE_MS = 10_000;
/** Debounce for re-fetching git status after task events that touch files. */
const GIT_REFRESH_DEBOUNCE_MS = 500;

/** Common build/dependency dirs that bloat a project tree; hidden by default. */
const HIDDEN_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'bin',
  'obj',
]);

function str(key: string, lang: string): string {
  return STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
}

function formatBytes(n: number): string {
  if (!n || n < 1024) return n ? `${n} B` : '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Normalize a filter input like "ts, .js ^_*.py index" → ['ts','js','^_*.py','index']. */
function parseFilter(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim().replace(/^\.+/, '').toLowerCase())
    .filter(Boolean);
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return '';
  return name.slice(i + 1).toLowerCase();
}

/**
 * Turn a small glob-like pattern into a RegExp. Only tokens containing at
 * least one of `^ $ * ?` are treated as patterns; a plain token keeps the
 * substring / extension rules (see matchesFilter). Semantics:
 *   ^  anchor to the start of the name
 *   $  anchor to the end of the name
 *   *  any run of characters (including none)
 *   ?  exactly one character
 * Without anchors the pattern matches anywhere in the name, so `*.py`
 * selects every .py file and `^_*.py` selects py names starting with `_`.
 *
 * A token containing `(?` (lookahead / lookbehind / atomic / non-capturing
 * group) is compiled as a FULL JavaScript regex instead, so negative and
 * positive assertions work: `^(?!_).*\.py$` hides py names starting with `_`.
 * Full-regex tokens are length-capped to keep catastrophic backtracking out.
 */
function patternToRegExp(raw: string): RegExp | null {
  // Full-regex mode: `(?` signals real JS regex syntax (e.g. `(?!_)`).
  if (raw.includes('(?') && raw.length <= 64) {
    try { return new RegExp(raw); } catch { /* invalid pattern -> fall through */ }
  }
  if (!/[*?^$]/.test(raw)) return null;
  let src = raw;
  let anchoredStart = false;
  let anchoredEnd = false;
  if (src[0] === '^') { anchoredStart = true; src = src.slice(1); }
  if (src.endsWith('$')) { anchoredEnd = true; src = src.slice(0, -1); }
  let out = '';
  for (const ch of src) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  if (anchoredStart) out = '^' + out;
  if (anchoredEnd) out += '$';
  return new RegExp(out);
}

function isHiddenEntry(e: FileBrowserEntry): boolean {
  if (e.name.startsWith('.')) return true;
  return e.type === 'directory' && HIDDEN_DIR_NAMES.has(e.name);
}

function matchesFilter(e: FileBrowserEntry, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  if (e.type === 'directory') return true;
  const name = e.name.toLowerCase();
  // OR semantics: any matching token (plain substring / extension / glob /
  // full regex with `(?`) keeps the file visible.
  return tokens.some((t) => {
    const re = patternToRegExp(t);
    if (re) return re.test(name);
    return name.includes(t) || fileExt(e.name) === t;
  });
}

/**
 * Mount the file browser into `container`. Returns a dispose function that
 * cancels timers, unsubscribes from the event bus and removes the DOM —
 * idempotent, guaranteed to run exactly once by the caller.
 */
export function mountFileBrowser(
  container: HTMLElement,
  ctx: FileBrowserContext,
  opts: FileBrowserMountOptions = {},
): () => void {
  const bridge: FileBrowserBridge = opts.bridge ?? (window as unknown as { nexusDesktop?: FileBrowserBridge }).nexusDesktop ?? { listDirectory: async () => ({ ok: false, error: 'bridge missing' }), openExternalFile: async () => ({ ok: false, error: 'bridge missing' }), openInEditor: async () => ({ ok: false, error: 'bridge missing' }), getGitStatus: async () => ({ ok: false, isRepo: false, error: 'bridge missing' }) };
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const getLang = () => ctx.getUiLang() || 'zh-CN';

  container.className = 'rside-section file-browser';
  container.replaceChildren();

  const head = document.createElement('div');
  head.className = 'filebrowser-head';

  const titleEl = document.createElement('span');
  titleEl.className = 'rside-title';
  head.appendChild(titleEl);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn ghost small filebrowser-toggle';
  head.appendChild(toggleBtn);

  const body = document.createElement('div');
  body.className = 'filebrowser-body';

  const tools = document.createElement('div');
  tools.className = 'filebrowser-tools';

  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'filebrowser-filter';
  filterInput.spellcheck = false;
  filterInput.autocomplete = 'off';
  tools.appendChild(filterInput);

  const hiddenLabel = document.createElement('label');
  hiddenLabel.className = 'filebrowser-hidden';
  const hiddenCheck = document.createElement('input');
  hiddenCheck.type = 'checkbox';
  hiddenLabel.appendChild(hiddenCheck);
  const hiddenSpan = document.createElement('span');
  hiddenLabel.appendChild(hiddenSpan);

  const untrackedLabel = document.createElement('label');
  untrackedLabel.className = 'filebrowser-hide-untracked';
  const untrackedCheck = document.createElement('input');
  untrackedCheck.type = 'checkbox';
  untrackedLabel.appendChild(untrackedCheck);
  const untrackedSpan = document.createElement('span');
  untrackedLabel.appendChild(untrackedSpan);

  const toggles = document.createElement('div');
  toggles.className = 'filebrowser-toggles';
  toggles.appendChild(hiddenLabel);
  toggles.appendChild(untrackedLabel);
  tools.appendChild(toggles);

  const tree = document.createElement('div');
  tree.className = 'filebrowser-tree';

  container.appendChild(head);
  container.appendChild(body);
  body.appendChild(tools);
  body.appendChild(tree);

  // ---- state ----
  const nodes = new Map<string, DirNode>();
  const gitStatus = new Map<string, GitFileState>();
  let gitIsRepo = false;
  let gitBranch = '';
  let gitTimer: ReturnType<typeof setTimeout> | null = null;
  let collapsed = false;
  let showHidden = false;
  let hideUntracked = false;
  let filterExts: string[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Pointer/focus inside the panel pauses the idle countdown (re-armed on leave).
  let interacting = false;
  // Open row context menu (pauses the countdown while shown).
  let contextMenu: HTMLElement | null = null;
  // Non-git roots are probed exactly once — no further git requests until the
  // project directory actually changes.
  let gitProbedDir = '';
  let disposed = false;
  let projectDir = '';

  const rootNode = (): DirNode => {
    let n = nodes.get(projectDir);
    if (!n) {
      n = { path: projectDir, expanded: false, loaded: false, loading: false };
      nodes.set(projectDir, n);
    }
    return n;
  };

  const childNode = (dirPath: string): DirNode => {
    let n = nodes.get(dirPath);
    if (!n) {
      n = { path: dirPath, expanded: false, loaded: false, loading: false };
      nodes.set(dirPath, n);
    }
    return n;
  };

  // ---- collapse / idle ----
  function setCollapsed(value: boolean): void {
    if (disposed || collapsed === value) return;
    collapsed = value;
    container.classList.toggle('collapsed', value);
    toggleBtn.textContent = value ? '▸' : '▾';
    toggleBtn.title = str(value ? 'fbExpand' : 'fbCollapse', getLang());
    toggleBtn.setAttribute('aria-expanded', String(!value));
    if (value) {
      cancelIdle();
    } else {
      armIdle();
    }
  }

  function cancelIdle(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle(): void {
    cancelIdle();
    // Pointer/focus inside the panel (or an open menu) suspends the countdown.
    if (disposed || collapsed || interacting || contextMenu) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!disposed && !collapsed && !interacting && !contextMenu) setCollapsed(true);
    }, idleMs);
  }

  // ---- loading ----
  async function loadDir(node: DirNode): Promise<void> {
    if (disposed || node.loaded || node.loading || !node.path) return;
    node.loading = true;
    renderTree();
    const res = await bridge.listDirectory(projectDir, node.path);
    if (disposed) return;
    node.loading = false;
    if (res.ok) {
      node.loaded = true;
      node.entries = res.entries ?? [];
      node.truncated = res.truncated;
      node.error = undefined;
    } else {
      node.loaded = true;
      node.entries = [];
      node.error = res.error ?? str('fbLoadFailed', getLang());
    }
    renderTree();
    armIdle();
  }

  // ---- rendering ----
  /** True when `path` is itself untracked/ignored (or sits inside such a dir). */
  function isUntrackedPath(path: string): boolean {
    if (!gitIsRepo || !hideUntracked) return false;
    const state = ancestorState(path);
    return state === 'untracked' || state === 'ignored';
  }

  function visibleEntries(entries: FileBrowserEntry[], basePath: string): FileBrowserEntry[] {
    return entries.filter((e) => {
      if (!showHidden && isHiddenEntry(e)) return false;
      if (isUntrackedPath(joinPath(basePath, e.name))) return false;
      return matchesFilter(e, filterExts);
    });
  }

  function collectRows(node: DirNode, depth: number, out: RowItem[]): void {
    if (!node.entries) return;
    for (const e of visibleEntries(node.entries, node.path)) {
      if (e.type === 'directory') {
        const child = childNode(joinPath(node.path, e.name));
        out.push({ type: 'directory', name: e.name, size: 0, depth, path: child.path, node: child });
        if (child.expanded) collectRows(child, depth + 1, out);
      } else {
        out.push({ type: 'file', name: e.name, size: e.size, depth, path: joinPath(node.path, e.name) });
      }
    }
  }

  function renderTree(): void {
    if (disposed) return;
    const scrollTop = tree.scrollTop;
    tree.replaceChildren();

    const labels = {
      title: str('fileBrowser', getLang()),
      filterPlaceholder: str('fbFilterPlaceholder', getLang()),
      hidden: str('fbShowHidden', getLang()),
      hideUntracked: str('fbHideUntracked', getLang()),
    };
    titleEl.textContent = labels.title;
    filterInput.placeholder = labels.filterPlaceholder;
    hiddenSpan.textContent = labels.hidden;
    untrackedSpan.textContent = labels.hideUntracked;

    const rows: RowItem[] = [];
    if (!projectDir) {
      const empty = document.createElement('div');
      empty.className = 'filebrowser-empty';
      empty.textContent = str('fbNoProject', getLang());
      tree.appendChild(empty);
      return;
    }

    const root = rootNode();
    if (!root.loaded && !root.loading) {
      void loadDir(root);
    }
    collectRows(root, 0, rows);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'filebrowser-empty';
      empty.textContent =
        root.error ? str('fbLoadFailed', getLang())
          : root.loading ? str('fbLoading', getLang())
            : filterExts.length > 0 ? str('fbEmptyFilter', getLang())
              : str('fbEmpty', getLang());
      tree.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      for (const row of rows) {
        const el = document.createElement('div');
        el.className = `filebrowser-row fb-${row.type}`;
        el.dataset.path = row.path;
        el.style.paddingLeft = `${8 + row.depth * 14}px`;
        el.title = row.path;

        if (row.type === 'directory') {
          const arrow = document.createElement('span');
          arrow.className = 'filebrowser-arrow';
          arrow.textContent = row.node!.expanded ? '▾' : '▸';
          const name = document.createElement('span');
          name.className = 'filebrowser-name fb-dir-name';
          name.textContent = `${row.node!.loading ? '⏳ ' : ''}${row.node!.expanded ? '📂' : '📁'} ${row.name}`;
          el.appendChild(arrow);
          el.appendChild(name);
          const dirState = gitStateOf(row);
          if (dirState) renderGitBadge(el, dirState, false);
          el.addEventListener('click', () => {
            onClickDir(row.node!);
          });
        } else {
          const name = document.createElement('span');
          name.className = 'filebrowser-name';
          name.textContent = `📄 ${row.name}`;
          const size = document.createElement('span');
          size.className = 'filebrowser-size';
          size.textContent = formatBytes(row.size);
          el.appendChild(name);
          const fileState = gitStateOf(row);
          if (fileState) renderGitBadge(el, fileState, true);
          el.appendChild(size);
          el.addEventListener('click', () => {
            void onClickFile(row.path);
          });
          el.draggable = true;
          el.addEventListener('dragstart', (ev: DragEvent) => {
            const dt = ev.dataTransfer;
            if (!dt) return;
            dt.setData(FILE_DRAG_MIME, row.path);
            dt.setData('text/plain', row.path);
            dt.effectAllowed = 'copy';
          });
          el.addEventListener('contextmenu', (ev: MouseEvent) => {
            openContextMenu(row.path, ev);
          });
        }
        frag.appendChild(el);
      }
      if (root.truncated) {
        const note = document.createElement('div');
        note.className = 'filebrowser-note';
        note.textContent = str('fbTruncated', getLang());
        frag.appendChild(note);
      }
      tree.appendChild(frag);
    }
    tree.scrollTop = scrollTop;
  }

  async function onClickDir(node: DirNode): Promise<void> {
    if (!node.loaded && !node.loading) {
      await loadDir(node);
    }
    if (!node.error) node.expanded = !node.expanded;
    renderTree();
    armIdle();
  }

  async function onClickFile(path: string): Promise<void> {
    const res = await bridge.openExternalFile(path);
    if (!res.ok) showToast(`${str('fbOpenFailed', getLang())}: ${res.error ?? ''}`);
    armIdle();
  }

  /** Open a file in an editor (context menu). Any failure — missing IPC handler
   *  or editor launch error — falls back to the OS default app so the action
   *  never ends silently; only a double failure surfaces a toast. */
  function openFileInEditor(path: string): void {
    const fail = (msg: string) => showToast(`${str('fbOpenFailed', getLang())}: ${msg}`);
    const fallback = () => {
      void bridge.openExternalFile(path)
        .then((res) => { if (!res.ok) fail(res.error ?? ''); })
        .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
    };
    if (typeof bridge.openInEditor !== 'function') {
      fallback();
      return;
    }
    void bridge.openInEditor(path)
      .then((res) => { if (!res.ok) fallback(); })
      .catch(() => fallback());
  }

  // ---- row context menu ----
  // Dismissal listeners live only while the menu is open and are attached on
  // the next tick — the opening gesture must not dismiss the menu (pointerdown
  // vs. contextmenu ordering differs by platform/input device).
  let menuTeardown: (() => void) | null = null;

  function onDocPointerDown(ev: Event): void {
    if (!contextMenu) return;
    const target = ev.target as Node | null;
    if (target && typeof contextMenu.contains === 'function' && contextMenu.contains(target)) return;
    closeContextMenu();
  }
  function onDocKeyDown(ev: KeyboardEvent): void {
    if (contextMenu && ev.key === 'Escape') {
      ev.preventDefault?.();
      closeContextMenu();
    }
  }
  function onDocContextMenu(ev: Event): void {
    if (!contextMenu) return;
    const target = ev.target as Node | null;
    if (target && typeof contextMenu.contains === 'function' && contextMenu.contains(target)) return;
    closeContextMenu();
  }

  function closeContextMenu(): void {
    if (menuTeardown) {
      menuTeardown();
      menuTeardown = null;
    }
    if (!contextMenu) return;
    contextMenu.remove();
    contextMenu = null;
    if (!interacting) armIdle();
  }

  function contextMenuItem(label: string, onSelect: () => void): HTMLElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'fb-context-item';
    item.textContent = label;
    item.addEventListener('click', () => {
      closeContextMenu();
      onSelect();
    });
    return item;
  }

  function openContextMenu(path: string, ev: MouseEvent): void {
    ev.preventDefault?.();
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'fb-context-menu';
    menu.style.left = `${Math.max(0, ev.clientX ?? 0)}px`;
    menu.style.top = `${Math.max(0, ev.clientY ?? 0)}px`;
    menu.appendChild(contextMenuItem(str('fbAddToChat', getLang()), () => ctx.addFileToChat?.(path)));
    menu.appendChild(contextMenuItem(str('fbOpenInEditor', getLang()), () => openFileInEditor(path)));
    // Mount at the document root so panel overflow / re-renders can't clip it.
    (document.body ?? container).appendChild(menu);
    contextMenu = menu;
    // Keep the fixed-position menu inside the viewport near the bottom/right.
    const view = container.ownerDocument?.defaultView;
    if (view && typeof menu.getBoundingClientRect === 'function') {
      const rect = menu.getBoundingClientRect();
      const left = Math.max(0, Math.min(ev.clientX ?? 0, view.innerWidth - rect.width - 4));
      const top = Math.max(0, Math.min(ev.clientY ?? 0, view.innerHeight - rect.height - 4));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
    const doc = document;
    menuTeardown = () => {
      doc.removeEventListener('pointerdown', onDocPointerDown, true);
      doc.removeEventListener('keydown', onDocKeyDown, true);
      doc.removeEventListener('contextmenu', onDocContextMenu, true);
    };
    setTimeout(() => {
      if (!contextMenu) return;
      doc.addEventListener('pointerdown', onDocPointerDown, true);
      doc.addEventListener('keydown', onDocKeyDown, true);
      doc.addEventListener('contextmenu', onDocContextMenu, true);
    }, 0);
    cancelIdle();
  }

  function showToast(message: string): void {
    const el = document.createElement('div');
    el.className = 'filebrowser-toast';
    el.textContent = message;
    body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  // ---- events ----
  async function refreshProjectDir(): Promise<void> {
    const dir = normPath(await ctx.getProjectDir());
    if (disposed) return;
    if (dir !== projectDir) {
      projectDir = dir;
      nodes.clear();
      gitStatus.clear();
      gitIsRepo = false;
      gitBranch = '';
      renderTree();
      if (projectDir) void loadDir(rootNode());
      void refreshGitStatus();
    }
  }

  // ---- git status ----
  function stateLabel(state: GitState): string {
    return state === 'modified' ? str('fbGitModified', getLang())
      : state === 'untracked' ? str('fbGitUntracked', getLang())
        : str('fbGitCommitted', getLang());
  }

  /** Nearest own-or-ancestor status: git collapses untracked and ignored
   *  directories to a single entry, so every child inside one inherits it. */
  function ancestorState(path: string): GitFileState | null {
    let p = path;
    while (p) {
      const s = gitStatus.get(p);
      if (s) return s;
      const cut = p.lastIndexOf('/');
      if (cut <= 0) return null;
      p = p.slice(0, cut);
    }
    return null;
  }

  /** Strongest state among a directory's own entry and its descendants.
   *  Ignored paths are excluded — they never contribute a badge. */
  function descendantState(path: string): GitState | null {
    const prefix = path.endsWith('/') ? path : path + '/';
    let untracked = false;
    for (const [p, state] of gitStatus) {
      if (state === 'ignored') continue;
      if (p !== path && !p.startsWith(prefix)) continue;
      if (state === 'modified') return 'modified';
      untracked = true;
    }
    return untracked ? 'untracked' : null;
  }

  function gitStateOf(row: RowItem): GitState | null {
    if (!gitIsRepo) return null;
    const inherited = ancestorState(row.path);
    // Ignored paths (and everything under an ignored directory) are unbadged.
    if (inherited === 'ignored') return null;
    if (row.type === 'file') return inherited ?? 'committed';
    const descendant = descendantState(row.path);
    if (descendant === 'modified' || inherited === 'modified') return 'modified';
    if (descendant === 'untracked' || inherited === 'untracked') return 'untracked';
    return 'committed';
  }

  function renderGitBadge(el: HTMLElement, state: GitState, file: boolean): void {
    const badge = document.createElement('span');
    if (file) {
      badge.className = `fb-git-tag git-${state}`;
      badge.textContent = state === 'committed' ? '✓' : state === 'modified' ? 'M' : 'U';
    } else {
      badge.className = `fb-git-dot git-${state}`;
      badge.textContent = '';
    }
    badge.title = stateLabel(state);
    el.appendChild(badge);
  }

  async function refreshGitStatus(): Promise<void> {
    const dir = normPath(await ctx.getProjectDir());
    if (disposed || !dir || dir !== projectDir) return;
    // Non-git roots are detected once: no further git requests until the
    // project directory actually changes.
    if (dir === gitProbedDir && !gitIsRepo) return;
    gitProbedDir = dir;
    const res = await bridge.getGitStatus(dir);
    if (disposed || projectDir !== dir) return;
    gitStatus.clear();
    if (res.ok && res.isRepo) {
      gitIsRepo = true;
      gitBranch = res.branch ?? '';
      for (const s of res.statuses ?? []) {
        if (s && s.path && (s.state === 'untracked' || s.state === 'modified' || s.state === 'ignored')) {
          gitStatus.set(normPath(s.path), s.state);
        }
      }
    } else {
      gitIsRepo = false;
      gitBranch = '';
    }
    renderTree();
  }

  /** Debounced re-fetch after task events that may have touched files. */
  function scheduleGitRefresh(): void {
    if (disposed || !gitIsRepo) return;
    if (gitTimer !== null) clearTimeout(gitTimer);
    gitTimer = setTimeout(() => {
      gitTimer = null;
      void refreshGitStatus();
    }, GIT_REFRESH_DEBOUNCE_MS);
  }

  function onEvent(event: AgentEvent): void {
    if (disposed) return;
    if (event.type === 'language_changed') {
      renderTree();
      return;
    }
    if (event.type === 'session_changed') {
      void refreshProjectDir();
      return;
    }
    // Task events commonly rewrite files — refresh the status badges.
    if (event.type.startsWith('task')) scheduleGitRefresh();
    // Any task activity that needs progress monitoring collapses the browser.
    if (ctx.isMonitorNeeded()) setCollapsed(true);
  }

  // ---- init ----
  function resetUi(): void {
    filterExts = [];
    filterInput.value = '';
    showHidden = false;
    hiddenCheck.checked = false;
    hideUntracked = false;
    untrackedCheck.checked = false;
    interacting = false;
    gitProbedDir = '';
    setCollapsed(opts.defaultCollapsed ?? true);
    renderTree();
    if (!collapsed) armIdle();
  }

  filterInput.addEventListener('input', () => {
    filterExts = parseFilter(filterInput.value);
    renderTree();
    armIdle();
  });
  hiddenCheck.addEventListener('change', () => {
    showHidden = hiddenCheck.checked;
    renderTree();
    armIdle();
  });
  untrackedCheck.addEventListener('change', () => {
    hideUntracked = untrackedCheck.checked;
    renderTree();
    armIdle();
  });
  toggleBtn.addEventListener('click', (ev) => {
    ev?.stopPropagation?.();
    setCollapsed(!collapsed);
  });
  head.addEventListener('click', () => setCollapsed(!collapsed));

  const onPointerDown = () => armIdle();
  const onPointerMove = () => armIdle();
  const onWheel = () => {
    armIdle();
    closeContextMenu();
  };
  const onScroll = () => closeContextMenu();
  // Suspended countdown while the user is working inside the panel.
  const onEnter = () => { interacting = true; cancelIdle(); };
  const onLeave = () => { interacting = false; armIdle(); };
  const onFocusIn = () => { interacting = true; cancelIdle(); };
  const onFocusOut = () => { interacting = false; armIdle(); };
  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('pointermove', onPointerMove, true);
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('pointerenter', onEnter);
  container.addEventListener('pointerleave', onLeave);
  container.addEventListener('focusin', onFocusIn);
  container.addEventListener('focusout', onFocusOut);
  tree.addEventListener('scroll', onScroll);

  const unsubscribe = ctx.subscribe(onEvent);
  resetUi();
  void refreshProjectDir();

  return () => {
    if (disposed) return;
    disposed = true;
    closeContextMenu();
    cancelIdle();
    if (gitTimer !== null) {
      clearTimeout(gitTimer);
      gitTimer = null;
    }
    unsubscribe();
    container.removeEventListener('pointerdown', onPointerDown, true);
    container.removeEventListener('pointermove', onPointerMove, true);
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('pointerenter', onEnter);
    container.removeEventListener('pointerleave', onLeave);
    container.removeEventListener('focusin', onFocusIn);
    container.removeEventListener('focusout', onFocusOut);
    tree.removeEventListener('scroll', onScroll);
    container.classList.remove('collapsed');
    container.replaceChildren();
  };
}

/** Normalize separators + trailing slashes so Windows roots compare/key
 *  against git's paths and repeated `getProjectDir` calls stay stable. */
function normPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:$/.test(s)) return s + '/';
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** Single accessor for path building (kept atomic for test hostability). */
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const trailing = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
  return dir + trailing + name;
}