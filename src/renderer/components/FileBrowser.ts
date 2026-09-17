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
 *   - a filter hides non-matching files (directories stay visible): each token
 *     matches by filename keyword (case-insensitive substring) or by extension;
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

/** IPC surface (defaults to window.nexusDesktop; injected in tests). */
export interface FileBrowserBridge {
  listDirectory(
    root: string,
    path: string,
  ): Promise<{ ok: boolean; entries?: FileBrowserEntry[]; truncated?: boolean; error?: string }>;
  openExternalFile(path: string): Promise<{ ok: boolean; error?: string }>;
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

/** Normalize a filter input like "ts, .js index" → ['ts','js','index']. */
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

function isHiddenEntry(e: FileBrowserEntry): boolean {
  if (e.name.startsWith('.')) return true;
  return e.type === 'directory' && HIDDEN_DIR_NAMES.has(e.name);
}

function matchesFilter(e: FileBrowserEntry, exts: string[]): boolean {
  if (exts.length === 0) return true;
  if (e.type === 'directory') return true;
  const name = e.name.toLowerCase();
  return exts.some((t) => name.includes(t) || fileExt(e.name) === t);
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
  const bridge: FileBrowserBridge = opts.bridge ?? (window as unknown as { nexusDesktop?: FileBrowserBridge }).nexusDesktop ?? { listDirectory: async () => ({ ok: false, error: 'bridge missing' }), openExternalFile: async () => ({ ok: false, error: 'bridge missing' }) };
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
  tools.appendChild(hiddenLabel);

  const tree = document.createElement('div');
  tree.className = 'filebrowser-tree';

  container.appendChild(head);
  container.appendChild(body);
  body.appendChild(tools);
  body.appendChild(tree);

  // ---- state ----
  const nodes = new Map<string, DirNode>();
  let collapsed = false;
  let showHidden = false;
  let filterExts: string[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (disposed || collapsed) return;
    cancelIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!disposed && !collapsed) setCollapsed(true);
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
  function visibleEntries(entries: FileBrowserEntry[]): FileBrowserEntry[] {
    return entries.filter((e) => (showHidden || !isHiddenEntry(e)) && matchesFilter(e, filterExts));
  }

  function collectRows(node: DirNode, depth: number, out: RowItem[]): void {
    if (!node.entries) return;
    for (const e of visibleEntries(node.entries)) {
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
    };
    titleEl.textContent = labels.title;
    filterInput.placeholder = labels.filterPlaceholder;
    hiddenSpan.textContent = labels.hidden;

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
          el.appendChild(size);
          el.addEventListener('click', () => {
            void onClickFile(row.path);
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
    if (!res.ok) {
      const empty = document.createElement('div');
      empty.className = 'filebrowser-toast';
      empty.textContent = `${str('fbOpenFailed', getLang())}: ${res.error ?? ''}`;
      body.appendChild(empty);
      setTimeout(() => empty.remove(), 2500);
    }
    armIdle();
  }

  // ---- events ----
  async function refreshProjectDir(): Promise<void> {
    const dir = await ctx.getProjectDir();
    if (disposed) return;
    if (dir !== projectDir) {
      projectDir = dir;
      nodes.clear();
      renderTree();
      if (projectDir) void loadDir(rootNode());
    }
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
    // Any task activity that needs progress monitoring collapses the browser.
    if (ctx.isMonitorNeeded()) setCollapsed(true);
  }

  // ---- init ----
  function resetUi(): void {
    filterExts = [];
    filterInput.value = '';
    showHidden = false;
    hiddenCheck.checked = false;
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
  toggleBtn.addEventListener('click', (ev) => {
    ev?.stopPropagation?.();
    setCollapsed(!collapsed);
  });
  head.addEventListener('click', () => setCollapsed(!collapsed));

  const onPointerDown = () => armIdle();
  const onPointerMove = () => armIdle();
  const onWheel = () => armIdle();
  const onKeyDown = () => armIdle();
  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('pointermove', onPointerMove, true);
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('keydown', onKeyDown, true);

  const unsubscribe = ctx.subscribe(onEvent);
  resetUi();
  void refreshProjectDir();

  return () => {
    if (disposed) return;
    disposed = true;
    cancelIdle();
    unsubscribe();
    container.removeEventListener('pointerdown', onPointerDown, true);
    container.removeEventListener('pointermove', onPointerMove, true);
    container.removeEventListener('wheel', onWheel);
    container.removeEventListener('keydown', onKeyDown, true);
    container.classList.remove('collapsed');
    container.replaceChildren();
  };
}

/** Single accessor for path building (kept atomic for test hostability). */
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const trailing = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
  return dir + trailing + name;
}