/// <reference lib="dom" />

import { initFx } from './fx.js';
import { isWorkerBlockText } from '../shared/constants.js';
import { t, fmtNum, getUiLang, loadLanguage, localizeError } from './i18n.js';
import { renderBlocks, attachCodeCopy, hydrateImages } from './markdown.js';

interface SessionInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  created_at?: number;
  updated_at?: number;
}

interface ProviderInfo {
  name: string;
  type: string;
  model: string;
  baseUrl?: string;
  hasKey: boolean;
}

interface StatusInfo {
  cwd: string;
  busy: boolean;
  provider: string;
  model: string;
}

interface PermissionsInfo {
  mode: string;
  allowlist: string[];
  safePaths: string[];
  mcpAllowlist: string[];
  safetyRules?: {
    dbDeletion?: string;
    iterativeDelete?: string;
    batchWriteLimit?: number;
    requireGitCheckpoint?: boolean;
    autoCheckpoint?: boolean;
  };
}

interface McpServerStatus {
  name: string;
  toolCount: number;
  status: string;
}

interface SpeechProviderSettings {
  name: string;
  category: string;
  model: string;
  baseUrl: string;
  voice?: string;
  hasKey: boolean;
}

interface VisionProviderSettings {
  name: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}

interface SpeechVisionConfig {
  activeSpeech: string;
  activeTts: string;
  activeVision: string;
  speechProviders: SpeechProviderSettings[];
  visionProviders: VisionProviderSettings[];
}

interface SessionStats {
  tokenEstimate: number;
  messageCount: number;
}

/** A persisted message row returned by getMessages(). Only user/assistant rows
 *  are rendered for history; `content`/`thinking` may be absent. */
interface StoredMsg {
  id?: number;
  role: string;
  content?: string;
  thinking?: string;
}

/** A slash-command execution restored from the per-session log file. */
interface SlashLogEntry {
  ts: string;
  command: string;
  anchorId?: number;
  content: string;
}

type AgentEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call_start'; index: number; name: string; args: Record<string, unknown> }
  | { type: 'tool_call_end'; index: number; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; index: number; name: string; content: string; isError?: boolean }
  | { type: 'security_blocked'; toolName: string; rule: string; reason: string }
  | { type: 'file_ready'; path: string; mimeType: string; name: string }
  | { type: 'state_delta'; contextTokens: number; turn: number }
  | { type: 'turn_end'; stopReason: string; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'session_end' }
  | {
      type: 'task_graph';
      graphId: string;
      tasks: Array<{
        id: string;
        description: string;
        role: string;
        status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
        error?: string;
      }>;
    }
  | { type: 'task_started'; taskId: string; description: string; role: string }
  | { type: 'task_completed'; taskId: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'sessionRenamed'; sessionId: string; name: string }
  | { type: 'slash_start'; command: string; anchorId?: number }
  | { type: 'slash'; text: string }
  | { type: 'slash_end'; anchorId?: number; command: string };

declare global {
  interface Window {
    nexusDesktop: {
      chat(input: string, opts?: { sessionId?: string }): Promise<unknown>;
      abort(opts?: { sessionId?: string }): Promise<unknown>;
      startSession(name?: string, sessionId?: string): Promise<string>;
      listSessions(options?: { limit?: number; offset?: number; excludeMock?: boolean; excludeEmpty?: boolean; search?: string }): Promise<{ items: SessionInfo[]; total: number }>;
      getMessages(
        sessionId: string,
        options?: { last?: number; limit?: number; offset?: number },
      ): Promise<{ items: StoredMsg[]; total: number; userBefore: number }>;
      getSlashLog(sessionId: string): Promise<SlashLogEntry[]>;
      getSlashLogPath(sessionId: string): Promise<string>;
      deleteSession(id: string): Promise<unknown>;
      renameSession(id: string, name: string): Promise<unknown>;
      getConfig(): Promise<Record<string, unknown>>;
      getProviders(): Promise<ProviderInfo[]>;
      getStatus(opts?: { sessionId?: string }): Promise<StatusInfo>;
      getPermissions(): Promise<PermissionsInfo>;
      getLanguage(): Promise<string>;
      reloadConfig(): Promise<{ ok: boolean }>;
      getSpeechVisionConfig(): Promise<SpeechVisionConfig>;
      setActiveSpeechProvider(name: string): Promise<unknown>;
      setActiveTtsProvider(name: string): Promise<unknown>;
      setActiveVisionProvider(name: string): Promise<unknown>;
      saveSpeechProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      saveVisionProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      getSessionStats(sessionId: string): Promise<SessionStats>;
      switchProvider(name: string, opts?: { sessionId?: string }): Promise<unknown>;
      switchModel(modelId: string, opts?: { sessionId?: string }): Promise<unknown>;
      getModels(providerName?: string, opts?: { sessionId?: string }): Promise<string[]>;
      saveProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      openSession(sessionId: string, cwd?: string): Promise<{ ok: boolean; tab?: TabInfo; reason?: string }>;
      closeSession(sessionId: string): Promise<{ ok: boolean }>;
      getOpenTabs(): Promise<TabInfo[]>;
      getTabStatus(sessionId: string): Promise<TabInfo | null>;
      openConfigWeb(): Promise<{ ok: boolean; port?: number; error?: string }>;
      setCwd(cwd: string): Promise<unknown>;
      getDefaultProjectDir(): Promise<{ dir: string }>;
      getSessionMetadata(sessionId: string): Promise<Record<string, unknown>>;
      setSessionMetadata(sessionId: string, metadata: Record<string, unknown>): Promise<void>;
      openFolder(): Promise<{ canceled: boolean; path?: string }>;
      openFile(): Promise<{ canceled: boolean; paths: string[] }>;
      revealFile(path: string): Promise<{ ok: boolean }>;
      getFileInfos(paths: string[]): Promise<Array<{ path: string; name: string; size: number; isImage: boolean; preview?: string }>>;
      readImagePreview(path: string): Promise<string | undefined>;
      getPathForFile(file: File): string;
      regenerate(sessionId: string, userIndex: number): Promise<unknown>;
      withdraw(sessionId: string, userIndex: number): Promise<string>;
      respondPermission(id: string, answer: string, sessionId?: string): Promise<unknown>;
      setMcpEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      getMcpStatus(): Promise<{ enabled: boolean; servers: McpServerStatus[] }>;
      getMcpServers(): Promise<Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string; stderr?: string }>>;
      setMcpServer(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      getDeferMcp(): Promise<boolean>;
      setDeferMcp(enabled: boolean): Promise<{ ok: boolean }>;
      getPinned(): Promise<string[]>;
      setPinned(ids: string[]): Promise<{ ok: boolean }>;
      getMinimizeToTray(): Promise<boolean>;
      setMinimizeToTray(enabled: boolean): Promise<{ ok: boolean }>;
      getRestoreSessionOnLaunch(): Promise<boolean>;
      setRestoreSessionOnLaunch(enabled: boolean): Promise<{ ok: boolean }>;
      getLastOpenTabs(): Promise<string[]>;
      setLastOpenTabs(ids: string[]): Promise<{ ok: boolean }>;
      setDepthOverride(level: string): Promise<{ depth: string }>;
      getActiveDepth(): Promise<string>;
      setPermissionsOverride(mode: string): Promise<{ mode: string }>;
      getActiveMode(): Promise<string>;
      getInputRows(): Promise<number>;
      setInputRows(rows: number): Promise<{ ok: boolean }>;
      readRecentLogs(maxLines?: number): Promise<string[]>;
      getMaxTabs(): Promise<number>;
      setMaxTabs(n: number): Promise<{ ok: boolean }>;
      getMemThreshold(): Promise<number>;
      setMemThreshold(n: number): Promise<{ ok: boolean }>;
      getCpuThreshold(): Promise<number>;
      setCpuThreshold(n: number): Promise<{ ok: boolean }>;
      getMonitorEnabled(): Promise<boolean>;
      setMonitorEnabled(enabled: boolean): Promise<{ ok: boolean }>;
      getResourceState(): Promise<ResourceStateInfo>;
      getUpdateState(): Promise<Record<string, unknown>>;
      getCurrentVersion(): Promise<string>;
      checkForUpdate(): Promise<Record<string, unknown>>;
      downloadUpdate(): Promise<Record<string, unknown>>;
      installUpdate(): Promise<unknown>;
      onEvent(cb: (event: AgentEvent) => void): void;
      onEvents(cb: (events: AgentEvent[]) => void): void;
      onPermission(cb: (req: { id: string; question: string }) => void): void;
      onLog(cb: (log: { level: string; message: string }) => void): void;
      onConfigWindowClosed(cb: () => void): void;
      onWorkerRestarted(cb: () => void): void;
      onResourceState(cb: (state: ResourceStateInfo) => void): void;
      onTabEvent(cb: (payload: { sessionId: string; event: AgentEvent }) => void): void;
      onTabEvents(cb: (payloads: Array<{ sessionId: string; event: AgentEvent }>) => void): void;
      onTabsChanged(cb: (tabs: TabInfo[]) => void): void;
      onUpdateState(cb: (state: Record<string, unknown>) => void): void;
    };
  }
}

interface ResourceStateInfo {
  status: 'normal' | 'warning' | 'overloaded';
  running: boolean;
  memoryPct: number;
  cpuPct: number;
  atMax?: boolean;
  updatedAt: number;
}

/** An open multi-session tab: each maps to a per-session agent worker process. */
interface TabInfo {
  sessionId: string;
  provider: string;
  model: string;
  busy: boolean;
}

// ---------- element helpers ----------
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const messagesEl = $('#messages');
const inputEl = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#btn-send');
const stopBtn = $('#btn-stop');
const freezeBtn = $('#btn-freeze') as HTMLButtonElement;
const sessionListEl = $('#session-list');
const searchEl = $('#session-search') as HTMLInputElement;
const sessionPagerEl = $('#session-pager');
const sidebarEl = $('#sidebar') as HTMLElement;
const collapseBtn = $('#btn-collapse-sidebar') as HTMLButtonElement;
const pagerPrevEl = $('#pager-prev') as HTMLButtonElement;
const pagerNextEl = $('#pager-next') as HTMLButtonElement;
const pagerInfoEl = $('#pager-info');
const providerSelect = $('#provider-select') as HTMLSelectElement;
const modelSelect = $('#model-select') as HTMLSelectElement;
const themeSelect = $('#theme-select') as HTMLSelectElement;
const cwdLabel = $('#cwd-label');
const busyIndicator = $('#busy-indicator');
const inputStatus = $('#input-status');
const attachmentsEl = $('#attachments');
const attachBtn = $('#btn-attach');
const mcpToggle = $('#mcp-toggle input') as HTMLInputElement;
const mcpStatusEl = $('#mcp-status');
const mcpBoxEl = $('#mcp-box');
const mcpServersBtn = $('#mcp-servers-btn');
const mcpPopoverEl = $('#mcp-popover');
const mcpServersEl = $('#mcp-servers');

const rsideProvider = $('#rside-provider');
const rsideModel = $('#rside-model');
const rsidePerm = $('#rside-perm');
const rsideMcp = $('#rside-mcp');
const rsideResourceEl = $('#rside-resource') as HTMLElement;
const rsideToken = $('#rside-token');
const rsideSpeech = $('#rside-speech');
const rsideVision = $('#rside-vision');
const taskListEl = $('#task-list');
const taskEmptyEl = $('#task-empty');
const tabBarEl = $('#tab-bar') as HTMLElement;

// ---------- state ----------
let currentSessionId = '';
let busy = false;
let running = false;
let stopRequested = false;
// When frozen, auto-scroll is suppressed so the user can review earlier context
// while a turn is still streaming. New content keeps rendering normally below;
// only the viewport stays put (safe — no DOM/state is deferred).
let frozen = false;
const pendingQueue: string[] = [];
let attachments: string[] = [];
let providers: ProviderInfo[] = [];
let status: StatusInfo = { cwd: '', busy: false, provider: '', model: '' };

// Open multi-session tabs (each backed by a per-session worker process).
const tabs = new Map<string, TabInfo>();
let activeTabId = '';
// Session id → display name cache for tab chips (kept in sync with sidebar).
const tabNames = new Map<string, string>();

// 0-based sequence over the session's *displayable* user messages (worker
// blocks are skipped), kept in sync with AgentService.regenerate(userIndex).
let userMessageSeq = 0;

// Per-provider model list cache (filled from the provider API on demand).
const modelsCache = new Map<string, string[]>();

// Session sidebar pagination: 20 most recent non-ACP sessions per page.
const SESSION_PAGE_SIZE = 20;
let sessionPage = 0;
let sessionTotal = 0;

// Task lifecycle state (task_graph / task_started / task_completed / task_failed events)
interface TaskItem {
  id: string;
  description: string;
  role: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
}
const tasks = new Map<string, TaskItem>();

// per-turn DOM handles
let curAssistant: { bubble: HTMLElement; stream: HTMLElement; buffer: string; cleaned: boolean } | null = null;
let curThinking: { content: HTMLElement; buffer: string; cleaned: boolean } | null = null;
interface SlashCardRec {
  card: HTMLElement;
  body: HTMLElement;
  chevron: HTMLElement;
}
let curSlash: SlashCardRec | null = null;
interface ToolCardRec {
  card: HTMLElement;
  resultEl: HTMLElement | null;
  resultText: string;
}
const toolCards = new Map<number, ToolCardRec>();

/** Slash-log entries for the active session, re-inserted after every history
 *  re-render (resume / load-earlier) so collapsible cards track their anchor. */
let slashLog: SlashLogEntry[] = [];

// ---------- history windowing + cache ----------
// History is fetched in windows so a long session never renders every message
// at once. `msgItems` holds the loaded rows (oldest→newest), `msgOffset` is
// their global start index, and `msgUserBefore` is the count of user-role rows
// before msgItems[0] — the renderer uses it to rebuild the global regenerate()
// user index regardless of how much history has been loaded.
const MSG_WINDOW = 40;
let msgItems: StoredMsg[] = [];
let msgOffset = 0;
let msgTotal = 0;
let msgUserBefore = 0;
let msgWindowStart = 0;

// ---------- i18n ---------- (moved to i18n.ts; see imports above)

// ---------- theme ----------
const THEME_KEY = 'nexus.theme';
type ThemeName = 'dark' | 'warm';

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme === 'warm' ? 'warm' : 'dark';
  themeSelect.value = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
}

function loadTheme(): void {
  let theme: ThemeName = 'dark';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'warm') theme = 'warm';
  } catch {}
  applyTheme(theme);
}
themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value === 'warm' ? 'warm' : 'dark');
});

// ---------- markdown ---------- (moved to markdown.ts; see imports above)

// ---------- message rendering ----------
// Worker-block detection now uses the shared single-source markers
// (src/shared/constants.ts); the definition here was removed to avoid drift.

function addSystem(text: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function addUser(text: string, mid?: number): void {
  if (isWorkerBlockText(text)) return;
  const userIndex = userMessageSeq++;
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.dataset.userIndex = String(userIndex);
  if (mid != null) wrap.dataset.mid = String(mid);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  const actions = document.createElement('div');
  actions.className = 'user-actions';
  const undoBtn = document.createElement('button');
  undoBtn.className = 'btn ghost small regen-btn undo-btn';
  undoBtn.textContent = t('undo');
  undoBtn.title = t('undoHint');
  undoBtn.addEventListener('click', () => void undoAt(wrap, userIndex));
  const regenBtn = document.createElement('button');
  regenBtn.className = 'btn ghost small regen-btn';
  regenBtn.textContent = t('regenerate');
  regenBtn.title = text;
  regenBtn.addEventListener('click', () => void regenerateAt(wrap, userIndex));
  actions.appendChild(undoBtn);
  actions.appendChild(regenBtn);
  wrap.appendChild(actions);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function ensureAssistant(): { bubble: HTMLElement; stream: HTMLElement; buffer: string; cleaned: boolean } {
  if (!curAssistant) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const stream = document.createElement('div');
    stream.className = 'stream-text streaming';
    stream.style.whiteSpace = 'pre-wrap';
    bubble.appendChild(stream);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    curAssistant = { bubble, stream, buffer: '', cleaned: false };
  }
  return curAssistant;
}

function ensureThinking(): { content: HTMLElement; buffer: string } {
  if (!curThinking) {
    const wrap = document.createElement('div');
    wrap.className = 'thinking';
    const toggle = document.createElement('button');
    toggle.className = 'thinking-toggle';
    toggle.textContent = t('thinkingDot');
    const content = document.createElement('div');
    content.className = 'thinking-content hidden';
    content.style.whiteSpace = 'pre-wrap';
    wrap.appendChild(toggle);
    wrap.appendChild(content);
    messagesEl.appendChild(wrap);
    toggle.addEventListener('click', () => {
      if (content.classList.contains('hidden')) {
        // Lazy fill: the buffered thinking text is only written on first expand,
        // so a collapsed long deep-thinking stream never hydrates the DOM.
        if (!content.dataset.filled) {
          content.textContent = curThinking!.buffer;
          content.dataset.filled = '1';
        }
        content.classList.remove('hidden');
        toggle.textContent = t('collapseThinking');
      } else {
        content.classList.add('hidden');
        toggle.textContent = t('thinkingDot');
      }
    });
    curThinking = { content, buffer: '', cleaned: false };
  }
  return curThinking;
}

/** Append a standalone collapsible thinking block (used when restoring history).
 *  The full text is NOT written to the DOM until the block is first expanded —
 *  long deep-thinking sessions otherwise hydrate megabytes of hidden content. */
function addThinkingBlock(text: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'thinking';
  const toggle = document.createElement('button');
  toggle.className = 'thinking-toggle';
  toggle.textContent = t('thinkingDot');
  const content = document.createElement('div');
  content.className = 'thinking-content hidden';
  content.style.whiteSpace = 'pre-wrap';
  wrap.appendChild(toggle);
  wrap.appendChild(content);
  messagesEl.appendChild(wrap);
  let filled = false;
  toggle.addEventListener('click', () => {
    if (!filled) {
      content.textContent = text.replace(/^[\s\u00a0]+/, '');
      filled = true;
    }
    content.classList.toggle('hidden');
    toggle.textContent = content.classList.contains('hidden') ? t('thinkingDot') : t('collapseThinking');
  });
}

function addToolCard(event: Extract<AgentEvent, { type: 'tool_call_start' }>): void {
  const card = document.createElement('div');
  card.className = 'tool-card collapsed';
  const header = document.createElement('button');
  header.className = 'tool-header';
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.textContent = '▸';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = `🔧 ${event.name}`;
  header.appendChild(chevron);
  header.appendChild(name);
  const args = document.createElement('div');
  args.className = 'tool-args hidden';
  args.textContent = JSON.stringify(event.args ?? {}, null, 2);
  // result is built lazily on first expand (see tool_result)
  card.appendChild(header);
  card.appendChild(args);
  messagesEl.appendChild(card);
  const rec: ToolCardRec = { card, resultEl: null, resultText: '' };
  toolCards.set(event.index, rec);
  header.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    chevron.textContent = collapsed ? '▸' : '▾';
    args.classList.toggle('hidden', collapsed);
    if (rec.resultEl) rec.resultEl.classList.toggle('hidden', collapsed);
    // hydrate a deferred result the first time the card is expanded
    if (!collapsed && rec.resultText && (!rec.resultEl || !rec.resultEl.dataset.filled)) {
      const resultEl = rec.resultEl ?? document.createElement('div');
      resultEl.className = 'tool-result';
      resultEl.textContent = rec.resultText;
      resultEl.dataset.filled = '1';
      rec.card.appendChild(resultEl);
      rec.resultEl = resultEl;
    }
  });
  scrollToBottom();
}

function addFileChip(file: Extract<AgentEvent, { type: 'file_ready' }>): void {
  const chip = document.createElement('div');
  chip.className = 'file-chip';
  chip.textContent = `📄 ${file.name}`;
  chip.title = file.path;
  chip.addEventListener('click', () => {
    void window.nexusDesktop.revealFile(file.path);
  });
  messagesEl.appendChild(chip);
  scrollToBottom();
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'session_start':
      // Only reset the task progress list when the session ACTUALLY changed.
      // Re-entrant session_start events (parent chat, merged sub-agents) reuse
      // the same id and must not wipe the in-flight task list.
      if (event.sessionId !== currentSessionId) {
        tasks.clear();
        renderTasks();
      }
      currentSessionId = event.sessionId;
      void refreshSidebarSession();
      void refreshSessionStats();
      break;
    case 'turn_start':
      // Keep the task progress list across turns (a worker runs many turns per
      // task; clearing on every turn made the sidebar only flash).
      break;
    case 'task_graph':
      // Replace the whole list with every task from the graph so pending tasks
      // are visible alongside running/completed ones.
      tasks.clear();
      for (const t of event.tasks) {
        tasks.set(t.id, {
          id: t.id,
          description: t.description,
          role: t.role,
          status: t.status === 'in_progress' ? 'running' : t.status === 'assigned' ? 'pending' : t.status,
          error: t.error,
        });
      }
      renderTasks();
      break;
    case 'task_started':
    case 'task_completed':
    case 'task_failed':
      handleTaskEvent(event);
      break;
    case 'sessionRenamed':
      // Session was renamed (manually via /rename or auto-named on first message)
      if (event.sessionId && event.name) tabNames.set(event.sessionId, event.name);
      renderTabBar();
      void refreshSidebarSession();
      break;
    case 'text':
      if (event.text) {
        const asst = ensureAssistant();
        let delta = event.text;
        // The provider often emits newline-only `content` deltas before the
        // real text (e.g. one blank line per pending tool call).  Skip leading
        // whitespace until the first non-empty chunk so the bubble never opens
        // with a run of blank lines.
        if (!asst.cleaned) {
          const trimmed = delta.replace(/^[\s\u00a0]+/, '');
          if (!trimmed) break;
          delta = trimmed;
          asst.cleaned = true;
        }
        asst.buffer += delta;
        // Append only the delta text node instead of rewriting the whole buffer
        // per token; a debounced pass re-renders the buffer as markdown while
        // streaming (see scheduleStreamRender) and turn_end finalizes it.
        appendTextDelta(asst.stream, delta);
        scheduleStreamRender(asst);
        scrollToBottom();
      }
      break;
    case 'slash_start':
      // Open a single collapsible card for this command's output.
      if (curSlash) {
        // Defensive: close any dangling card before starting a new one.
        curSlash = null;
      }
      curSlash = makeSlashCardEl(event.command, '');
      messagesEl.appendChild(curSlash.card);
      scrollToBottom();
      break;
    case 'slash':
      if (event.text && curSlash) {
        curSlash.body.textContent += event.text;
        scrollToBottom();
      }
      break;
    case 'slash_end': {
      if (curSlash) {
        // Auto-collapse only when the accumulated content is actually large;
        // an empty card from a no-output command is simply removed.
        if (curSlash.body.textContent.trim().length === 0) {
          curSlash.card.remove();
        } else if (slashShouldCollapse(curSlash.body.textContent)) {
          curSlash.card.classList.add('collapsed');
          curSlash.chevron.textContent = '▸';
          curSlash.body.classList.add('hidden');
        }
        curSlash = null;
      }
      break;
    }
    case 'thinking':
      if (event.thinking) {
        let delta = event.thinking;
        // Strip leading whitespace exactly once (one blank line per pending
        // tool call), then preserve all real internal \n / \t formatting.
        if (!curThinking?.cleaned) {
          const noLead = delta.replace(/^[\s\u00a0]+/, '');
          if (!noLead) break;
          delta = noLead;
        }
        const t = ensureThinking();
        t.buffer += delta;
        if (!t.content.classList.contains('hidden')) appendTextDelta(t.content, delta);
        curThinking!.cleaned = true;
        scrollToBottom();
      }
      break;
    case 'tool_call_start':
      addToolCard(event);
      break;
    case 'tool_call_end':
      break;
    case 'tool_result': {
      const rec = toolCards.get(event.index);
      if (rec) {
        rec.resultText = event.isError
          ? `❌ ${event.content}`
          : event.content.length > 4000
            ? event.content.slice(0, 4000) + '\n… (truncated)'
            : event.content;
        rec.card.classList.toggle('error', !!event.isError);
        if (rec.card.classList.contains('collapsed')) {
          // Card still collapsed — defer the DOM write until first expand.
          scrollToBottom();
          break;
        }
        const resultEl = rec.resultEl ?? document.createElement('div');
        resultEl.className = 'tool-result';
        resultEl.textContent = rec.resultText;
        resultEl.dataset.filled = '1';
        rec.card.appendChild(resultEl);
        rec.resultEl = resultEl;
        scrollToBottom();
      }
      break;
    }
    case 'file_ready':
      addFileChip(event);
      break;
    case 'security_blocked': {
      // Unattended safety gate hard-blocked a dangerous operation — render a
      // prominent warning card (the block is also audited to the security log).
      const wrap = document.createElement('div');
      wrap.className = 'msg security-blocked';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const title = document.createElement('div');
      title.className = 'security-blocked-title';
      const zhB = getUiLang() === 'zh-CN';
      title.textContent = `🚫 ${zhB ? '已阻断危险操作' : 'Dangerous operation blocked'} (${event.rule})`;
      const body = document.createElement('div');
      body.className = 'security-blocked-body';
      body.textContent = event.reason;
      bubble.appendChild(title);
      bubble.appendChild(body);
      wrap.appendChild(bubble);
      messagesEl.appendChild(wrap);
      scrollToBottom();
      break;
    }
    case 'state_delta':
      break;
    case 'turn_end': {
      clearStreamRender();
      // finalize markdown rendering of accumulated text
      if (curAssistant && curAssistant.buffer) {
        curAssistant.buffer = curAssistant.buffer.replace(/^[\s\u00a0]+/, '');
        renderAssistantStream(curAssistant);
        curAssistant.stream.classList.remove('streaming');
      }
      if (curThinking) {
        const t2 = curThinking;
        // Single final write (bounded) — keep `filled` in sync so a later
        // expand doesn't rewrite.  Leading whitespace is already stripped
        // once at stream time, so the raw buffer can be written as-is.
        t2.content.textContent = t2.buffer;
        t2.content.dataset.filled = '1';
        const toggle = t2.content.parentElement?.querySelector('.thinking-toggle');
        if (toggle) toggle.textContent = t('thought');
      }
      // NOTE: Do NOT call setBusy(false) here.  The core's runLlmTurn loops
      // on tool calls — each intermediate turn emits turn_end, but busy stays
      // true until the outer finally block emits session_end.  Resetting busy
      // on turn_end causes a race where the renderer lets the user send a new
      // message while the core is still processing tool results.
      void refreshSessionStats();
      break;
    }
    case 'session_end':
      setBusy(false);
      break;
  }
}

// ---------- status / busy ----------
function setBusy(value: boolean): void {
  busy = value;
  busyIndicator.classList.toggle('hidden', !value);
  sendBtn.classList.toggle('hidden', value);
  stopBtn.classList.toggle('hidden', !value);
  freezeBtn.classList.toggle('hidden', !value);
  // A turn ending (or being aborted) releases the freeze so the final result
  // is revealed; a fresh message/session resets it too (see sendMessage).
  if (!value) setFrozen(false);
  document.querySelectorAll('.regen-btn').forEach((b) => {
    (b as HTMLButtonElement).disabled = value;
  });
  if (value) {
    inputStatus.textContent = t('runningEllipsis');
  } else {
    // If a stop was requested, surface the completion feedback once — the core
    // always emits session_end in its chat() finally, so any path that leaves
    // busy state funnels through here and resets the stop request.
    if (stopRequested) inputStatus.textContent = t('stopped');
    else inputStatus.textContent = '';
  }
  if (!value) {
    stopRequested = false;
    (stopBtn as HTMLButtonElement).disabled = false;
  }
}

/** Toggle the viewport freeze (auto-scroll lock). Safe by design: content keeps
 *  streaming below, only the scroll position stays put. */
function setFrozen(value: boolean): void {
  if (frozen === value) return;
  frozen = value;
  freezeBtn.classList.toggle('active', value);
  freezeBtn.textContent = value ? t('unfreeze') : t('freeze');
  if (!value) scrollToBottom();
}

/** Request an interrupt of the current turn. Idempotent; busy is left to the
 *  core (session_end) to release so the UI never desyncs from the agent. */
function requestStop(): void {
  if (!busy || stopRequested) return;
  stopRequested = true;
  (stopBtn as HTMLButtonElement).disabled = true;
  inputStatus.textContent = t('stopping');
  void window.nexusDesktop.abort({ sessionId: currentSessionId || undefined });
}

/** Append `delta` to the last text node if possible, else create one — avoids
 *  both a full-content textContent rewrite and a node-per-token explosion. */
function appendTextDelta(el: HTMLElement, delta: string): void {
  const last = el.lastChild;
  if (last && last.nodeType === Node.TEXT_NODE) {
    last.textContent += delta;
  } else {
    el.appendChild(document.createTextNode(delta));
  }
}

function scrollToBottom(): void {
  if (frozen) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Localize a thrown value's message for display (common core/network errors). */
function errText(e: unknown): string {
  return localizeError(e instanceof Error ? e.message : String(e));
}

// ---------- streaming markdown preview ----------
// While a turn streams we append raw text deltas (fast), but every 300ms we
// opportunistically re-render the accumulated buffer as markdown so headings /
// lists / code appear progressively. Bounded to the first STREAM_MD_MAX chars —
// beyond that we fall back to raw streaming and finalize at turn_end.
let streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
const STREAM_MD_MAX = 12000;
function renderAssistantStream(asst: { stream: HTMLElement; buffer: string }): void {
  asst.stream.innerHTML = renderBlocks(asst.buffer);
  attachCodeCopy(asst.stream);
  hydrateImages(asst.stream);
}
function scheduleStreamRender(asst: { stream: HTMLElement; buffer: string }): void {
  if (streamRenderTimer) return;
  if (asst.buffer.length > STREAM_MD_MAX) return;
  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null;
    if (curAssistant === asst && asst.buffer) renderAssistantStream(asst);
  }, 300);
}
function clearStreamRender(): void {
  if (streamRenderTimer) {
    clearTimeout(streamRenderTimer);
    streamRenderTimer = null;
  }
}

// ---------- attachments ----------
interface AttachInfo {
  path: string;
  name: string;
  size: number;
  isImage: boolean;
  preview?: string;
}
const attachInfos = new Map<string, AttachInfo>();

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

function fmtFileSize(n: number): string {
  if (n < 1024) return t('fileSizeBytes', { n });
  if (n < 1024 * 1024) return t('fileSizeKb', { n: Math.round(n / 1024) });
  return t('fileSizeMb', { n: (n / (1024 * 1024)).toFixed(1) });
}

function renderAttachments(): void {
  attachmentsEl.innerHTML = '';
  attachmentsEl.classList.toggle('hidden', attachments.length === 0);
  for (const p of attachments) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    const info = attachInfos.get(p);
    if (info?.preview) {
      const img = document.createElement('img');
      img.className = 'attach-thumb';
      img.src = info.preview;
      img.alt = info.name;
      chip.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = info?.name ?? basename(p);
    name.title = p;
    chip.appendChild(name);
    if (info && info.size > 0) {
      const size = document.createElement('span');
      size.className = 'attach-size';
      size.textContent = fmtFileSize(info.size);
      chip.appendChild(size);
    }
    const rm = document.createElement('button');
    rm.className = 'chip-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      attachments = attachments.filter((x) => x !== p);
      attachInfos.delete(p);
      renderAttachments();
    });
    chip.appendChild(rm);
    chip.addEventListener('click', () => {
      void window.nexusDesktop.revealFile(p);
    });
    chip.title = t('revealFile');
    attachmentsEl.appendChild(chip);
  }
}

async function attachFiles(paths: string[]): Promise<void> {
  const added: string[] = [];
  for (const p of paths) {
    if (p && !attachments.includes(p)) {
      attachments.push(p);
      added.push(p);
    }
  }
  if (added.length > 0) {
    try {
      const infos = await window.nexusDesktop.getFileInfos(added);
      for (const info of infos) attachInfos.set(info.path, info);
    } catch {}
  }
  renderAttachments();
}

// ---------- sessions ----------
// Electron renderers don't implement window.prompt/confirm; provide modal ones.
function confirmDialog(msg: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const overlay = $('#confirm-overlay') as HTMLElement;
    const msgEl = $('#confirm-msg') as HTMLElement;
    msgEl.textContent = msg;
    overlay.classList.remove('hidden');
    const cleanup = (val: boolean) => {
      overlay.classList.add('hidden');
      overlay.querySelectorAll('button').forEach((b) => b.replaceWith(b.cloneNode(true)));
      resolve(val);
    };
    const ok = overlay.querySelector('#confirm-ok') as HTMLElement;
    const cancel = overlay.querySelector('#confirm-cancel') as HTMLElement;
    ok.addEventListener('click', () => cleanup(true));
    cancel.addEventListener('click', () => cleanup(false));
  });
}

function promptDialog(title: string, initial: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const overlay = $('#rename-overlay') as HTMLElement;
    const h3 = overlay.querySelector('h3') as HTMLElement;
    const input = $('#rename-input') as HTMLInputElement;
    h3.textContent = title;
    input.value = initial;
    overlay.classList.remove('hidden');
    input.focus();
    input.select();
    const cleanup = (val: string | null) => {
      overlay.classList.add('hidden');
      overlay.removeEventListener('click', onOverlay);
      overlay.querySelectorAll('button').forEach((b) => b.replaceWith(b.cloneNode(true)));
      resolve(val);
    };
    const ok = overlay.querySelector('#rename-ok') as HTMLElement;
    const cancel = overlay.querySelector('#rename-cancel') as HTMLElement;
    const onOk = () => cleanup(input.value.trim() || null);
    const onCancel = () => cleanup(null);
    const onOverlay = (ev: MouseEvent) => {
      if (ev.target === overlay) onCancel();
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') onOk();
      else if (ev.key === 'Escape') onCancel();
    });
    overlay.addEventListener('click', onOverlay);
  });
}

let searchQuery = '';
let pinnedIds: string[] = [];

async function togglePin(id: string): Promise<void> {
  pinnedIds = pinnedIds.filter((x) => x !== id);
  if (!pinnedIds.includes(id)) pinnedIds.push(id);
  try {
    await window.nexusDesktop.setPinned(pinnedIds);
  } catch {}
  await refreshSessions();
}

function addSessionRow(s: SessionInfo, pinned: boolean, activeId?: string): void {
  const li = document.createElement('li');
  li.classList.toggle('active', s.id === (activeId ?? currentSessionId));
  const name = document.createElement('span');
  name.className = 'session-name';
  name.textContent = s.name || s.id;
  name.addEventListener('click', () => void openTab(s.id, s.name));
  const meta = document.createElement('span');
  meta.className = 'session-meta';
  meta.textContent = `${s.provider} · ${s.model ?? ''}`;
  const actions = document.createElement('div');
  actions.className = 'session-actions';
  const pinBtn = document.createElement('button');
  pinBtn.className = pinned ? 'pin-btn active' : 'pin-btn';
  pinBtn.textContent = '📌';
  pinBtn.title = pinned ? t('unpin') : t('pin');
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void togglePin(s.id);
  });
  const renameBtn = document.createElement('button');
  renameBtn.textContent = t('rename');
  renameBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const newName = await promptDialog(t('renameSession'), s.name);
    if (newName) {
      await window.nexusDesktop.renameSession(s.id, newName);
      await refreshSessions();
    }
  });
  const delBtn = document.createElement('button');
  delBtn.textContent = t('delete');
  delBtn.style.color = 'var(--danger)';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog(t('deleteConfirm', { name: s.name }));
    if (!ok) return;
    await window.nexusDesktop.deleteSession(s.id);
    delete mcpPrefs[s.id];
    saveMcpPrefs();
    clearMsgCache(s.id);
    pinnedIds = pinnedIds.filter((x) => x !== s.id);
    if (currentSessionId === s.id) {
      // Deleting the active session must NOT create a new one. Clear the
      // view; the core agent's current session is unset by deleteSession,
      // so the next message lazily starts a fresh session (chat()).
      currentSessionId = '';
      messagesEl.innerHTML = '';
      toolCards.clear();
      tasks.clear();
      renderTasks();
      curAssistant = null;
      curThinking = null;
      msgItems = [];
      msgOffset = 0;
      msgTotal = 0;
      msgUserBefore = 0;
      msgWindowStart = 0;
      rsideToken.textContent = '—';
      rsideToken.title = '';
    }
    await refreshSessions();
    if (currentSessionId === '') await refreshSidebarSession();
  });
  actions.appendChild(pinBtn);
  actions.appendChild(renameBtn);
  actions.appendChild(delBtn);
  li.appendChild(name);
  li.appendChild(meta);
  li.appendChild(actions);
  sessionListEl.appendChild(li);
}

async function refreshSessions(activeId?: string): Promise<void> {
  try {
    pinnedIds = await window.nexusDesktop.getPinned();
  } catch {}
  const opts = { excludeMock: true, search: searchQuery || undefined };
  const pinnedSet = new Set(pinnedIds);
  let pinnedItems: SessionInfo[] = [];
  try {
    const res = await window.nexusDesktop.listSessions({ limit: 500, ...opts });
    pinnedItems = res.items.filter((s) => pinnedSet.has(s.id));
  } catch {}
  const { items: sessions, total } = await window.nexusDesktop.listSessions({
    limit: SESSION_PAGE_SIZE,
    offset: sessionPage * SESSION_PAGE_SIZE,
    ...opts,
  });
  sessionTotal = total;
  for (const s of [...pinnedItems, ...sessions]) {
    if (s.name) tabNames.set(s.id, s.name);
  }
  sessionListEl.innerHTML = '';
  if (pinnedItems.length > 0) {
    const grp = document.createElement('li');
    grp.className = 'session-group';
    grp.textContent = t('pinnedSessions');
    sessionListEl.appendChild(grp);
    for (const s of pinnedItems) addSessionRow(s, true, activeId);
  }
  const rest = sessions.filter((s) => !pinnedSet.has(s.id));
  if (rest.length === 0 && pinnedItems.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'session-empty';
    empty.textContent = searchQuery ? t('noSearchResults') : '—';
    sessionListEl.appendChild(empty);
  } else {
    for (const s of rest) addSessionRow(s, false, activeId);
  }
  const pages = Math.max(1, Math.ceil(total / SESSION_PAGE_SIZE));
  if (sessionPage >= pages) sessionPage = pages - 1;
  pagerPrevEl.disabled = sessionPage <= 0;
  pagerNextEl.disabled = sessionPage >= pages - 1;
  pagerInfoEl.textContent = t('pagerInfo', { page: sessionPage + 1, pages, total });
  sessionPagerEl.classList.toggle('hidden', total === 0);
}

// ---------- history windowing + cache helpers ----------
/** Displayable user rows only — worker blocks are skipped everywhere so the
 *  regenerate() user index matches AgentService (same markers). */
function countUserRows(rows: StoredMsg[]): number {
  return rows.filter((r) => r.role === 'user' && !isWorkerBlockText(String(r.content ?? ''))).length;
}

/** Render one persisted message row into the history view. */
function renderHistoryRow(m: StoredMsg): void {
  if (m.role === 'user') {
    addUser(String(m.content ?? ''), m.id);
  } else if (m.role === 'assistant') {
    if (m.thinking) addThinkingBlock(String(m.thinking));
    if (m.content) {
      const asst = ensureAssistant();
      asst.buffer = String(m.content).replace(/^[\s\u00a0]+/, '');
      renderAssistantStream(asst);
      asst.stream.classList.remove('streaming');
      curAssistant = null;
    }
  } else if (m.role === 'tool' && m.content) {
    addToolResultBlock(String(m.content));
  }
}

/** Collapsed tool-result card for restored history rows (name isn't persisted
 *  on tool rows, so label them generically). Content hydrates on first expand. */
function addToolResultBlock(content: string): void {
  const card = document.createElement('div');
  card.className = 'tool-card collapsed';
  const header = document.createElement('button');
  header.className = 'tool-header';
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.textContent = '▸';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = '🔧 tool result';
  header.appendChild(chevron);
  header.appendChild(name);
  const result = document.createElement('div');
  result.className = 'tool-result hidden';
  card.appendChild(header);
  card.appendChild(result);
  messagesEl.appendChild(card);
  let filled = false;
  header.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    chevron.textContent = collapsed ? '▸' : '▾';
    if (!collapsed) {
      if (!filled) {
        result.textContent = content;
        filled = true;
      }
      result.classList.remove('hidden');
    } else {
      result.classList.add('hidden');
    }
  });
}

/** Largeness threshold: above this we render the slash card collapsed by default
 *  so a huge /plan or /tasks dump doesn't dominate the screen. */
const SLASH_AUTO_COLLAPSE_CHARS = 2000;
const SLASH_AUTO_COLLAPSE_LINES = 50;

function slashShouldCollapse(content: string): boolean {
  return content.length > SLASH_AUTO_COLLAPSE_CHARS || content.split('\n').length > SLASH_AUTO_COLLAPSE_LINES;
}

/** Build a collapsible slash-output card DOM. Returns the card plus its body
 *  and chevron so live streaming can append to `body` and toggle collapse. */
function makeSlashCardEl(command: string, content: string): SlashCardRec {
  const card = document.createElement('div');
  card.className = 'slash-card';
  const header = document.createElement('button');
  header.className = 'slash-header';
  const chevron = document.createElement('span');
  chevron.className = 'slash-chevron';
  const name = document.createElement('span');
  name.className = 'slash-name';
  name.textContent = `⌨ ${command}`;
  header.appendChild(chevron);
  header.appendChild(name);

  const openBtn = document.createElement('button');
  openBtn.className = 'slash-open-btn';
  openBtn.textContent = '📄';
  openBtn.title = t('openLog');
  openBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void window.nexusDesktop.getSlashLogPath(currentSessionId).then((p) => {
      if (p) void window.nexusDesktop.revealFile(p);
    }).catch(() => {});
  });
  header.appendChild(openBtn);

  const body = document.createElement('div');
  body.className = 'slash-body hidden';
  body.textContent = content;

  const setCollapsed = (collapsed: boolean) => {
    card.classList.toggle('collapsed', collapsed);
    chevron.textContent = collapsed ? '▸' : '▾';
    body.classList.toggle('hidden', collapsed);
  };
  header.addEventListener('click', () => setCollapsed(!card.classList.contains('collapsed')));

  card.appendChild(header);
  card.appendChild(body);
  // Start collapsed only when the content is already known to be large (history
  // cards). Live cards start empty → expanded so streaming is visible; the
  // slash_end handler collapses them once if they grow large.
  setCollapsed(slashShouldCollapse(content));
  return { card, body, chevron };
}

/** Re-insert all cached slash cards into the current history DOM, anchored
 *  after their slash-input message (matched by data-mid). Cards whose anchor
 *  isn't in the visible window are placed at the correct chronological position
 *  relative to visible messages (not dumped at the end). Call after any
 *  renderMessageWindow() so reloads / load-earlier don't drop them. */
function insertSlashCards(): void {
  if (slashLog.length === 0) return;
  // Collect all visible elements with data-mid in DOM order for position lookups.
  const visibleMids: Array<{ mid: number; el: Element }> = [];
  for (const el of messagesEl.querySelectorAll('[data-mid]')) {
    const mid = Number((el as HTMLElement).dataset.mid);
    if (!isNaN(mid)) visibleMids.push({ mid, el });
  }
  for (const e of slashLog) {
    const rec = makeSlashCardEl(e.command, e.content);
    if (e.anchorId != null) {
      // Fast path: exact anchor in the visible DOM → insert right after it.
      const anchor = messagesEl.querySelector(`[data-mid="${e.anchorId}"]`);
      if (anchor) {
        if (anchor.nextSibling) messagesEl.insertBefore(rec.card, anchor.nextSibling);
        else messagesEl.appendChild(rec.card);
        continue;
      }
      // Slow path: anchor is outside the loaded message window. Find the first
      // visible element whose mid is greater than the anchorId and insert before
      // it so the card lands at the correct chronological position.
      let insertBefore: Element | null = null;
      for (const v of visibleMids) {
        if (v.mid > e.anchorId) { insertBefore = v.el; break; }
      }
      if (insertBefore) {
        messagesEl.insertBefore(rec.card, insertBefore);
      } else {
        messagesEl.appendChild(rec.card);
      }
      continue;
    }
    // No anchorId at all (legacy entry): append at end as last resort.
    messagesEl.appendChild(rec.card);
  }
}

/** Fetch the session's slash log from disk and re-insert its cards. */
async function refreshSlashLog(sessionId: string): Promise<void> {
  try {
    slashLog = await window.nexusDesktop.getSlashLog(sessionId);
  } catch {
    slashLog = [];
  }
  insertSlashCards();
}

/** Rebuild the visible history window from the loaded rows. `scroll=false`
 *  preserves the caller's scroll position (used when prepending older rows). */
function renderMessageWindow(scroll = true): void {
  messagesEl.innerHTML = '';
  toolCards.clear();
  tasks.clear();
  renderTasks();
  curAssistant = null;
  curThinking = null;
  userMessageSeq = msgUserBefore + countUserRows(msgItems.slice(0, msgWindowStart));
  // Show the "load earlier" button whenever there are unloaded older rows
  // (msgOffset > 0), regardless of where the current window starts.
  if (msgOffset > 0) {
    const bar = document.createElement('div');
    bar.className = 'load-earlier';
    const btn = document.createElement('button');
    btn.className = 'btn ghost small';
    btn.textContent = t('loadEarlier');
    btn.addEventListener('click', () => void loadEarlier());
    bar.appendChild(btn);
    messagesEl.appendChild(bar);
  }
  for (let i = msgWindowStart; i < msgItems.length; i++) renderHistoryRow(msgItems[i]);
  if (scroll) scrollToBottom();
}

/** Load the previous window of history above the currently visible region. */
async function loadEarlier(): Promise<void> {
  if (msgOffset <= 0 || busy) return;
  const prev = await window.nexusDesktop.getMessages(currentSessionId, {
    limit: MSG_WINDOW,
    offset: Math.max(0, msgOffset - MSG_WINDOW),
  });
  const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop;
  msgItems = [...prev.items, ...msgItems];
  msgOffset = Math.max(0, msgOffset - MSG_WINDOW);
  msgUserBefore = prev.userBefore;
  msgWindowStart = 0;
  renderMessageWindow(false);
  insertSlashCards();
  messagesEl.scrollTop = messagesEl.scrollHeight - distFromBottom;
}

// localStorage cache of the latest loaded history window, so resuming a session
// paints instantly and reconciles with fresh data in the background.
const MAX_MSG_CACHE_SESSIONS = 5;
interface MsgCache {
  items: StoredMsg[];
  total: number;
  userBefore: number;
  ts: number;
}
function msgCacheKey(id: string): string {
  return `nexus.msgCache.${id}`;
}
function loadMsgCache(id: string): MsgCache | null {
  try {
    const raw = localStorage.getItem(msgCacheKey(id));
    if (!raw) return null;
    const c = JSON.parse(raw) as MsgCache;
    if (!Array.isArray(c.items) || typeof c.total !== 'number') return null;
    return c;
  } catch {
    return null;
  }
}
function saveMsgCache(id: string, fresh: { items: StoredMsg[]; total: number; userBefore: number }): void {
  try {
    localStorage.setItem(
      msgCacheKey(id),
      JSON.stringify({ items: fresh.items, total: fresh.total, userBefore: fresh.userBefore, ts: Date.now() }),
    );
    // Prune stale entries so the cache never grows unbounded.
    const keys: Array<{ key: string; ts: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (key.startsWith('nexus.msgCache.')) {
        let ts = 0;
        try {
          ts = (JSON.parse(localStorage.getItem(key) ?? '{}') as MsgCache).ts ?? 0;
        } catch {}
        keys.push({ key, ts });
      }
    }
    keys.sort((a, b) => b.ts - a.ts);
    for (const k of keys.slice(MAX_MSG_CACHE_SESSIONS)) localStorage.removeItem(k.key);
  } catch {}
}
function clearMsgCache(id: string): void {
  try {
    localStorage.removeItem(msgCacheKey(id));
  } catch {}
}
function sameTail(a: StoredMsg[], b: StoredMsg[]): boolean {
  if (a.length !== b.length) return false;
  const la = a[a.length - 1];
  const lb = b[b.length - 1];
  if (!la || !lb) return a.length === b.length;
  return la.content === lb.content && (la.thinking ?? '') === (lb.thinking ?? '');
}

function applyMsgWindow(fresh: { items: StoredMsg[]; total: number; userBefore: number }): void {
  msgItems = fresh.items;
  msgTotal = fresh.total;
  msgOffset = fresh.total - fresh.items.length;
  msgUserBefore = fresh.userBefore;
  msgWindowStart = 0;
}

/** Refetch the session's latest window into msgItems + cache (no re-render). */
async function syncMsgCache(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    const fresh = await window.nexusDesktop.getMessages(sessionId, { last: MSG_WINDOW });
    applyMsgWindow(fresh);
    saveMsgCache(sessionId, fresh);
  } catch {}
}

async function startNewSession(): Promise<void> {
  if (busy) return;
  messagesEl.innerHTML = '';
  toolCards.clear();
  tasks.clear();
  renderTasks();
  curAssistant = null;
  curThinking = null;
  await openNewTab();
}

async function startOrResumeLatestSession(): Promise<void> {
  // Resume the latest session that actually has content — empty-context
  // sessions (CLI scratch / AI-intermediary noise) are excluded, and inner-test
  // sessions (model contains "mock") never surface at all.
  const { items: sessions } = await window.nexusDesktop.listSessions({
    limit: SESSION_PAGE_SIZE,
    offset: 0,
    excludeMock: true,
    excludeEmpty: true,
  });
  const latest = sessions[0];
  if (latest) {
    // Open as a tab (session worker) so it doesn't share the global worker.
    await openTab(latest.id, latest.name);
    return;
  }
  await startNewSession();
}

// ---------- multi-tab: per-session worker tabs ----------
// Each open tab maps to an independent agent worker process (main-side
// SessionWorkers). Chat/abort/provider/model calls are routed to the active
// tab's session id; events stream in on the tab channel and are only rendered
// when they belong to the currently visible tab, so a background tab can keep
// running without corrupting the focused conversation.

function resetViewState(): void {
  if (curAssistant) curAssistant.stream.classList.remove('streaming');
  messagesEl.innerHTML = '';
  toolCards.clear();
  tasks.clear();
  renderTasks();
  curAssistant = null;
  curThinking = null;
  curSlash = null;
  slashLog = [];
  userMessageSeq = 0;
  msgItems = [];
  msgOffset = 0;
  msgTotal = 0;
  msgUserBefore = 0;
  msgWindowStart = 0;
  running = false;
}

function tabName(sessionId: string): string {
  return tabNames.get(sessionId) || sessionId.slice(0, 14);
}

function tabAddButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'tab-add';
  btn.textContent = '＋';
  btn.title = t('tabsAddHint');
  btn.addEventListener('click', () => void openNewTab());
  return btn;
}

function tabChip(tab: TabInfo): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'tab' + (tab.sessionId === activeTabId ? ' active' : '');
  const busy = document.createElement('span');
  busy.className = 'tab-busy' + (tab.busy ? ' on' : '');
  busy.title = tab.busy ? t('tabsBusy') : '';
  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = tabName(tab.sessionId);
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '✕';
  close.title = t('tabsCloseHint');
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    void closeTab(tab.sessionId);
  });
  chip.append(busy, name, close);
  chip.addEventListener('click', () => void switchTab(tab.sessionId));
  chip.title = tab.sessionId;
  return chip;
}

function renderTabBar(): void {
  tabBarEl.innerHTML = '';
  if (tabs.size === 0) {
    const empty = document.createElement('span');
    empty.className = 'tab-bar-empty';
    empty.textContent = t('tabsEmpty');
    empty.title = t('tabsAddHint');
    tabBarEl.append(empty, tabAddButton());
    return;
  }
  for (const tab of tabs.values()) tabBarEl.appendChild(tabChip(tab));
  tabBarEl.appendChild(tabAddButton());
}

/** Create a fresh session and open it in its own tab/worker. */
async function openNewTab(): Promise<void> {
  if (busy && activeTabId) {
    // A new tab is still fine while another tab streams — don't block on busy.
  }
  let sid = '';
  try {
    sid = await window.nexusDesktop.startSession();
  } catch (err) {
    addSystem(`${t('tabsOpenFailed')}${errText(err)}`);
    return;
  }
  tabNames.set(sid, sid);
  await openTab(sid);
}

/** Open `sessionId` in its own worker process (or focus it if already open). */
async function openTab(sessionId: string, name?: string): Promise<void> {
  if (name) tabNames.set(sessionId, name);
  if (tabs.has(sessionId)) {
    await switchTab(sessionId);
    return;
  }
  let res: { ok: boolean; tab?: TabInfo; reason?: string };
  try {
    // Bind the session's saved working directory to its worker process so a
    // tab's chat runs in the session's project dir.
    let cwd: string | undefined;
    try {
      const meta = (await window.nexusDesktop.getSessionMetadata(sessionId)) as Record<string, unknown>;
      const metaCwd = (meta.projectDir ?? meta.cwd ?? '') as string;
      if (metaCwd) cwd = metaCwd;
    } catch {}
    res = await window.nexusDesktop.openSession(sessionId, cwd);
  } catch (err) {
    addSystem(`${t('tabsOpenFailed')}${errText(err)}`);
    return;
  }
  if (!res.ok) {
    if (res.reason === 'max-tabs') addSystem(t('tabsMaxReached'));
    else if (res.reason === 'overloaded') addSystem(t('tabsOverloaded'));
    else addSystem(`${t('tabsOpenFailed')}${res.reason ?? ''}`);
    return;
  }
  const tinfo = res.tab!;
  tabs.set(sessionId, { sessionId, provider: tinfo.provider, model: tinfo.model, busy: tinfo.busy });
  renderTabBar();
  await switchTab(sessionId);
}

/** Activate `sessionId`, rendering its transcript as the visible conversation. */
async function switchTab(sessionId: string): Promise<void> {
  activeTabId = sessionId;
  currentSessionId = sessionId;
  resetViewState();
  try {
    const fresh = await window.nexusDesktop.getMessages(sessionId, { last: MSG_WINDOW });
    applyMsgWindow(fresh);
    renderMessageWindow();
    saveMsgCache(sessionId, fresh);
  } catch {}
  await refreshSlashLog(sessionId);
  const tab = tabs.get(sessionId);
  if (tab) {
    status = { cwd: status.cwd, busy: tab.busy, provider: tab.provider, model: tab.model };
  } else {
    try {
      status = await window.nexusDesktop.getStatus({ sessionId });
    } catch {}
  }
  setBusy(Boolean(tab?.busy));
  loadDraft(sessionId);
  refreshProviderSelect();
  refreshModelSelect();
  renderTabBar();
  void refreshSidebarSession();
  void refreshSessionStats();
  void refreshSessions(sessionId);
}

/** Close a tab/worker and fall back to another tab or a fresh session. */
async function closeTab(sessionId: string): Promise<void> {
  if (!tabs.has(sessionId)) return;
  tabs.delete(sessionId);
  try {
    await window.nexusDesktop.closeSession(sessionId);
  } catch {}
  if (activeTabId === sessionId) {
    activeTabId = '';
    if (tabs.size > 0) {
      const next = [...tabs.keys()][tabs.size - 1];
      await switchTab(next);
    } else {
      currentSessionId = '';
      await startNewSession();
    }
  } else {
    renderTabBar();
  }
}

/** Keep the tab's busy indicator + status in sync from worker events. */
function applyTabEvent(sessionId: string, event: AgentEvent): void {
  const tab = tabs.get(sessionId);
  if (!tab) return;
  if (event.type === 'turn_start') tab.busy = true;
  else if (event.type === 'session_end') tab.busy = false;
  if (sessionId === activeTabId) {
    handleEvent(event);
  } else if (event.type === 'turn_start' || event.type === 'session_end') {
    renderTabBar();
  }
}

/** Restore the tab bar from any workers that are still open (e.g. renderer
 *  reloaded while the main-process session workers kept running). */
async function syncOpenTabs(): Promise<void> {
  let open: TabInfo[] = [];
  try {
    open = await window.nexusDesktop.getOpenTabs();
  } catch {}
  tabs.clear();
  for (const t of open) if (t.sessionId) tabs.set(t.sessionId, t);
  if (currentSessionId && tabs.has(currentSessionId)) activeTabId = currentSessionId;
  renderTabBar();
}

// ---------- right sidebar: session info + task progress ----------
function permLabel(mode: string): string {
  const zh = getUiLang() === 'zh-CN';
  if (mode === 'auto') return zh ? 'auto（自动放行）' : 'auto (auto-approve)';
  if (mode === 'unattended') return zh ? 'unattended（无人值守·安全门）' : 'unattended (auto + guard)';
  if (mode === 'prompt') return zh ? 'prompt（每次询问）' : 'prompt (ask each time)';
  return mode || '—';
}

async function refreshSidebarSession(): Promise<void> {
  const [st, perms, mcp] = await Promise.all([
    window.nexusDesktop.getStatus({ sessionId: currentSessionId || undefined }),
    window.nexusDesktop.getPermissions(),
    window.nexusDesktop.getMcpStatus(),
  ]);
  status = st;
  rsideProvider.textContent = st.provider || '—';
  rsideModel.textContent = st.model || '—';
  rsidePerm.textContent = permLabel(perms.mode);
  const connected = mcp.servers.filter((s) => s.status !== 'disconnected');
  rsideMcp.innerHTML = '';
  if (connected.length === 0) {
    rsideMcp.textContent = t('none');
  } else {
    for (const s of connected) {
      const row = document.createElement('div');
      row.className = 'mcp-line';
      const nm = document.createElement('span');
      nm.className = 'mcp-line-name';
      nm.textContent = s.name;
      nm.title = s.name;
      const cnt = document.createElement('span');
      cnt.className = 'mcp-line-count';
      cnt.textContent = t('toolsCount', { n: s.toolCount });
      row.appendChild(nm);
      row.appendChild(cnt);
      rsideMcp.appendChild(row);
    }
  }
  await refreshSidebarModels();
}

let svConfig: SpeechVisionConfig = {
  activeSpeech: '',
  activeTts: '',
  activeVision: '',
  speechProviders: [],
  visionProviders: [],
};

async function refreshSidebarModels(): Promise<void> {
  try {
    svConfig = await window.nexusDesktop.getSpeechVisionConfig();
  } catch {
    svConfig = { activeSpeech: '', activeTts: '', activeVision: '', speechProviders: [], visionProviders: [] };
  }
  const sp = svConfig.speechProviders.find((p) => p.name === svConfig.activeSpeech);
  const tts = svConfig.speechProviders.find((p) => p.name === svConfig.activeTts);
  const vp = svConfig.visionProviders.find((p) => p.name === svConfig.activeVision);
  rsideSpeech.textContent = sp
    ? `${sp.name} · ${sp.model}`
    : `${tts ? tts.name : ''}${tts ? ' · ' + tts.model : ''}` || t('none');
  rsideSpeech.title = [sp && sp.category === 'stt' ? `STT: ${sp.name} (${sp.model})` : '', tts ? `TTS: ${tts.name} (${tts.model})` : ''].filter(Boolean).join('\n');
  rsideVision.textContent = vp ? `${vp.name} · ${vp.model}` : t('none');
  rsideVision.title = vp ? `${vp.name} (${vp.model})` : '';
}

async function refreshSessionStats(): Promise<void> {
  if (!currentSessionId) return;
  try {
    const stats = await window.nexusDesktop.getSessionStats(currentSessionId);
    rsideToken.textContent = t('tokenEstimated', { n: fmtNum(stats.tokenEstimate) });
    rsideToken.title = t('tokenMsgHint', { n: stats.messageCount });
  } catch {
    rsideToken.textContent = '—';
  }
}

function renderTasks(): void {
  const items = [...tasks.values()];
  const hasTasks = items.length > 0;
  taskEmptyEl.classList.toggle('hidden', hasTasks);
  taskListEl.innerHTML = '';
  if (!hasTasks) return;
  for (const item of items) {
    const li = document.createElement('div');
    li.className = 'task-item';
    const badge = document.createElement('span');
    badge.className = `task-badge ${item.status}`;
    badge.textContent = item.status === 'running'
      ? '⏳'
      : item.status === 'completed'
        ? '✓'
        : item.status === 'failed'
          ? '✗'
          : item.status === 'cancelled'
            ? '−'
            : '○';
    const body = document.createElement('div');
    body.className = 'task-body';
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = item.description || item.id;
    title.title = item.description || '';
    const meta = document.createElement('div');
    meta.className = `task-meta ${item.status}`;
    meta.textContent = item.status === 'running'
      ? t('running', { role: item.role })
      : item.status === 'completed'
        ? t('completed')
        : item.status === 'failed'
          ? t('failed', { error: item.error ?? '' })
          : item.status === 'cancelled'
            ? t('cancelled')
            : t('pending');
    body.appendChild(title);
    body.appendChild(meta);
    li.appendChild(badge);
    li.appendChild(body);
    taskListEl.appendChild(li);
  }
}

function handleTaskEvent(event: Extract<AgentEvent, { type: `task_${string}` }>): void {
  if (event.type === 'task_started') {
    // Full-list resets are now handled by task_graph; here we only flip the
    // individual task to running (and backfill it if the graph event never
    // arrived, e.g. an older core build).
    tasks.set(event.taskId, {
      id: event.taskId,
      description: event.description,
      role: event.role,
      status: 'running',
    });
  } else if (event.type === 'task_completed') {
    const t = tasks.get(event.taskId);
    if (t) {
      t.status = 'completed';
      t.error = undefined;
    }
  } else if (event.type === 'task_failed') {
    const t = tasks.get(event.taskId);
    if (t) {
      t.status = 'failed';
      t.error = event.error;
    }
  }
  renderTasks();
}

// ---------- MCP per-session toggle ----------
// Prefs shape: { [sessionId]: { __master?: boolean, [serverName]: boolean } }
const mcpPrefs: Record<string, Record<string, boolean>> = loadMcpPrefs();
function loadMcpPrefs(): Record<string, Record<string, boolean>> {
  try {
    return JSON.parse(localStorage.getItem('nexus.mcpPrefs') ?? '{}') as Record<
      string,
      Record<string, boolean>
    >;
  } catch {
    return {};
  }
}
function saveMcpPrefs(): void {
  try {
    localStorage.setItem('nexus.mcpPrefs', JSON.stringify(mcpPrefs));
  } catch {}
}
function sessionPrefs(sessionId: string): Record<string, boolean> {
  if (!mcpPrefs[sessionId]) mcpPrefs[sessionId] = { __master: true };
  return mcpPrefs[sessionId];
}
async function applyMcpPref(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const prefs = sessionPrefs(sessionId);
  const master = prefs.__master ?? true;
  mcpToggle.checked = master;
  mcpToggle.disabled = true;
  try {
    if (!master) {
      await window.nexusDesktop.setMcpEnabled(false);
    } else {
      await applyServerPrefs(prefs);
    }
  } catch {
    mcpStatusEl.textContent = '✗';
  } finally {
    mcpToggle.disabled = false;
  }
  await refreshMcpStatus();
  await loadMcpServersList();
}
async function applyServerPrefs(prefs: Record<string, boolean>): Promise<void> {
  const servers = await window.nexusDesktop.getMcpServers();
  for (const s of servers) {
    const target = prefs[s.name] ?? s.autoStart;
    const res = await window.nexusDesktop.setMcpServer(s.name, target);
    if (res && res.ok === false) addSystem(`⚠️ MCP "${s.name}": ${res.error}`);
  }
}
async function refreshMcpStatus(): Promise<void> {
  try {
    const s = await window.nexusDesktop.getMcpStatus();
    mcpStatusEl.textContent = s.enabled ? t('mcpCount', { n: s.servers.length }) : t('mcpDisabled');
    const label = $('#mcp-toggle');
    label.classList.toggle('on', s.enabled);
    label.classList.toggle('off', !s.enabled);
  } catch {}
}
function mcpPopoverOpen(): boolean {
  return !mcpPopoverEl.classList.contains('hidden');
}
function setMcpPopover(open: boolean): void {
  mcpPopoverEl.classList.toggle('hidden', !open);
  mcpServersBtn.textContent = open ? '▴' : '▾';
}
async function loadMcpServersList(): Promise<void> {
  try {
    const servers = await window.nexusDesktop.getMcpServers();
    const prefs = currentSessionId ? sessionPrefs(currentSessionId) : {};
    if (servers.length === 0) {
      mcpServersEl.innerHTML = `<div class="mcp-empty">${t('noMcpServers')}</div>`;
      return;
    }
    mcpServersEl.innerHTML = '';
    for (const s of servers) {
      const row = document.createElement('label');
      row.className = 'mcp-server-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = prefs[s.name] ?? s.autoStart;
      cb.addEventListener('change', async () => {
        prefs[s.name] = cb.checked;
        saveMcpPrefs();
        const res = await window.nexusDesktop.setMcpServer(s.name, cb.checked);
        if (res && res.ok === false) {
          addSystem(`⚠️ MCP "${s.name}": ${res.error}`);
          cb.checked = !cb.checked;
        }
        await refreshMcpStatus();
        await loadMcpServersList();
        void refreshSidebarSession();
      });
      const name = document.createElement('span');
      name.className = 'mcp-server-name';
      name.textContent = s.name;
      const meta = document.createElement('span');
      meta.className = 'mcp-server-meta';
      if (s.connected) {
        meta.textContent = t('toolsCount', { n: s.toolCount });
      } else if (s.error) {
        meta.textContent = t('mcpFailed');
        meta.style.color = 'var(--danger)';
        meta.title = `${s.error}${s.stderr ? `\n${s.stderr}` : ''}`;
      } else {
        meta.textContent = t('mcpNotConnected');
      }
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(meta);
      mcpServersEl.appendChild(row);
    }
  } catch {
    mcpServersEl.innerHTML = `<div class="mcp-loading">${t('mcpLoadFailed')}</div>`;
  }
}
mcpServersBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMcpPopover(!mcpPopoverOpen());
  if (mcpPopoverOpen()) void loadMcpServersList();
});
mcpToggle.addEventListener('change', async () => {
  const enabled = mcpToggle.checked;
  const prefs = sessionPrefs(currentSessionId);
  prefs.__master = enabled;
  saveMcpPrefs();
  mcpToggle.disabled = true;
  try {
    if (enabled) {
      await applyServerPrefs(prefs);
      setMcpPopover(true); // unfold the server list when enabling
      await loadMcpServersList();
    } else {
      await window.nexusDesktop.setMcpEnabled(false);
    }
  } catch (err) {
    addSystem(`⚠️ MCP: ${errText(err)}`);
  } finally {
    mcpToggle.disabled = false;
  }
  await refreshMcpStatus();
  void refreshSidebarSession();
});
document.addEventListener('click', (e) => {
  if (mcpPopoverOpen() && !mcpBoxEl.contains(e.target as Node)) setMcpPopover(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mcpPopoverOpen()) setMcpPopover(false);
});

// ---------- send ----------
// Serial scheduler: while a chat is in flight (`running`), further messages are
// queued and auto-submitted after the current context completes. This replaces
// the old single "pending flag" that fired on the turn_end event — which raced
// the worker (chat() had not resolved yet) and could crash it with a concurrent
// dispatch.
function enqueue(text: string): void {
  if (!text) return;
  addUser(text);
  inputEl.value = '';
  pendingQueue.push(text);
  drain();
}

function drain(): void {
  if (running) {
    setBusy(true);
    if (pendingQueue.length > 0) inputStatus.textContent = t('queued', { n: pendingQueue.length });
    return;
  }
  const text = pendingQueue.shift();
  if (text === undefined) {
    setBusy(false);
    return;
  }
  running = true;
  setBusy(true);
  curAssistant = null;
  curThinking = null;
  toolCards.clear();
  void (async () => {
    try {
      await window.nexusDesktop.chat(text, { sessionId: currentSessionId || undefined });
      await refreshSessions(currentSessionId);
      await syncMsgCache(currentSessionId);
    } catch (err) {
      addSystem(`${t('error')}${errText(err)}`);
    } finally {
      running = false;
      drain();
    }
  })();
}

async function sendMessage(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text && attachments.length === 0) return;
  setFrozen(false);
  const attrs = attachments;
  attachments = [];
  renderAttachments();
  const composed = attrs.map((p) => `@${p}`).concat(text ? [text] : []).join('\n');
  clearDraft(currentSessionId);
  enqueue(composed);
}

/** Undo a past user message: delete it and everything after it from the core
 *  context (no re-run), then paste the original prompt back into the input box
 *  so the user can fix typos/homophones and resubmit manually. */
async function undoAt(wrap: HTMLElement, userIndex: number): Promise<void> {
  if (busy) return;
  const ok = await confirmDialog(t('undoAsk'));
  if (!ok) return;
  try {
    const text = await window.nexusDesktop.withdraw(currentSessionId, userIndex);
    // Rebuild the history window from the truncated DB so the regenerate/undo
    // user indices and message ordering stay consistent.
    await syncMsgCache(currentSessionId);
    renderMessageWindow();
    inputEl.value = text;
    inputEl.focus();
    await refreshSessions(currentSessionId);
    await refreshSessionStats();
  } catch (err) {
    addSystem(`${t('error')}${errText(err)}`);
  }
}

/** Re-run the assistant turn that follows a past user message. Pure desktop:
 *  drops the target user message and everything after it, then asks the core to
 *  re-run that prompt (AgentService.regenerate reloads context from the DB).
 *  Runs through the same busy/serial scheduler as a normal send so Stop works
 *  and the queue stays consistent. */
async function regenerateAt(wrap: HTMLElement, userIndex: number): Promise<void> {
  if (busy) return;
  // Remove the stale assistant/thinking/tool cards after the target message.
  let el = wrap.nextElementSibling;
  while (el) {
    const next = el.nextElementSibling;
    el.remove();
    el = next;
  }
  curAssistant = null;
  curThinking = null;
  toolCards.clear();
  running = true;
  setBusy(true);
  try {
    await window.nexusDesktop.regenerate(currentSessionId, userIndex);
    await refreshSessions(currentSessionId);
    await syncMsgCache(currentSessionId);
  } catch (err) {
    addSystem(`${t('error')}${errText(err)}`);
  } finally {
    running = false;
    drain();
  }
}

attachBtn.addEventListener('click', async () => {
  try {
    const res = await window.nexusDesktop.openFile();
    if (!res.canceled && res.paths) attachFiles(res.paths);
  } catch (err) {
    inputStatus.textContent = `${t('attachFailed')}${errText(err)}`;
  }
});

// ---------- permission modal (batch coalescing) ----------
const BATCH_WINDOW_MS = 300;
const permOverlay = $('#perm-overlay');
const permCount = $('#perm-count');
const permQuestion = $('#perm-question');
const permBatch: { id: string; question: string; sessionId?: string }[] = [];
let permTimer: ReturnType<typeof setTimeout> | null = null;

function showPermission(req: { id: string; question: string; sessionId?: string }): void {
  permBatch.push(req);
  if (permOverlay.classList.contains('hidden')) {
    permOverlay.classList.remove('hidden');
  }
  if (permTimer !== null) clearTimeout(permTimer);
  permTimer = setTimeout(flushPermBatch, BATCH_WINDOW_MS);
}

function flushPermBatch(): void {
  if (permTimer !== null) { clearTimeout(permTimer); permTimer = null; }
  if (permBatch.length === 0) return;
  const count = permBatch.length;
  if (count > 1) {
    permCount.classList.remove('hidden');
    permCount.textContent = t('permBatchTitle') + ` (${count})`;
    permQuestion.textContent = t('permBatchPrompt', { count }) + '\n' + permBatch[permBatch.length - 1].question;
  } else {
    permCount.classList.add('hidden');
    permQuestion.textContent = permBatch[0].question;
  }
  console.log(`flushPermBatch: ${count} pending request(s)`);
}

async function answerPermission(answer: string): Promise<void> {
  if (permTimer !== null) { clearTimeout(permTimer); permTimer = null; }
  if (permBatch.length === 0) {
    console.warn('answerPermission: no pending permission');
    return;
  }
  const batch = permBatch.splice(0);
  permOverlay.classList.add('hidden');
  console.log(`answerPermission: batch of ${batch.length} id(s) answer=${answer}`);
  for (const p of batch) {
    try {
      await window.nexusDesktop.respondPermission(p.id, answer, p.sessionId);
    } catch (e) {
      console.error(`respondPermission id=${p.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

$('#perm-allow').addEventListener('click', () => void answerPermission('y'));
$('#perm-always').addEventListener('click', () => void answerPermission('a'));
$('#perm-deny').addEventListener('click', () => void answerPermission('n'));

// ---------- settings modal ----------
const settingsOverlay = $('#settings-overlay');
const settingsBody = $('#settings-body');
const settingsMsg = $('#settings-msg');
let settingsDirty = false;

function buildProviderRow(p: ProviderInfo): void {
  const row = document.createElement('div');
  row.className = 'provider-row';
  row.dataset.name = p.name;
  const head = document.createElement('div');
  head.className = 'row-head';
  const title = document.createElement('b');
  title.textContent = `${p.name} (${p.type})`;
  const active = document.createElement('span');
  active.style.color = p.name === status.provider ? 'var(--ok)' : 'var(--text-dim)';
  active.textContent = p.name === status.provider ? t('activeNow') : '';
  head.appendChild(title);
  head.appendChild(active);
  row.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'row-grid';

  const apiKeyField = document.createElement('input');
  apiKeyField.placeholder = p.hasKey ? t('apiKeyKeep') : t('apiKeyEnter');
  apiKeyField.dataset.field = 'apiKey';
  const apiKeyLbl = document.createElement('label');
  apiKeyLbl.textContent = t('apiKey');
  apiKeyLbl.appendChild(apiKeyField);
  grid.appendChild(apiKeyLbl);

  const modelField = document.createElement('input');
  modelField.value = p.model;
  modelField.dataset.field = 'model';
  const modelLbl = document.createElement('label');
  modelLbl.textContent = t('model');
  modelLbl.appendChild(modelField);
  grid.appendChild(modelLbl);

  const baseUrlField = document.createElement('input');
  baseUrlField.value = p.baseUrl ?? '';
  baseUrlField.placeholder = 'https://api.example.com/v1';
  baseUrlField.dataset.field = 'baseUrl';
  const baseUrlLbl = document.createElement('label');
  baseUrlLbl.textContent = t('baseUrlOptional');
  baseUrlLbl.appendChild(baseUrlField);
  grid.appendChild(baseUrlLbl);

  const typeField = document.createElement('input');
  typeField.value = p.type;
  typeField.dataset.field = 'type';
  const typeLbl = document.createElement('label');
  typeLbl.textContent = t('type');
  typeLbl.appendChild(typeField);
  grid.appendChild(typeLbl);

  row.appendChild(grid);
  grid.querySelectorAll('input').forEach((el) => {
    el.addEventListener('input', () => {
      settingsDirty = true;
      settingsMsg.textContent = '';
    });
  });
  settingsBody.appendChild(row);
}

interface ModelRowOptions {
  className: string;
  dataKind: string;
  dataRole: string;
  title: string;
  providers: Array<{ name: string; model: string; baseUrl: string; hasKey: boolean }>;
  activeName: string;
  showCategory?: boolean;
}

function buildModelRow(opts: ModelRowOptions): void {
  const row = document.createElement('div');
  row.className = `provider-row ${opts.className}`;
  row.dataset.kind = opts.dataKind;
  row.dataset.role = opts.dataRole;

  const head = document.createElement('div');
  head.className = 'row-head';
  const title = document.createElement('b');
  title.textContent = opts.title;
  const active = document.createElement('span');
  active.className = 'active-tag';
  active.style.color = 'var(--ok)';
  active.textContent = opts.activeName ? t('activeNow') : '';
  head.appendChild(title);
  head.appendChild(active);
  row.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'row-grid';

  const sel = document.createElement('select');
  sel.dataset.field = 'provider';
  for (const p of opts.providers) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    opt.selected = p.name === opts.activeName;
    sel.appendChild(opt);
  }
  if (opts.providers.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '—';
    sel.appendChild(opt);
  }
  const selLbl = document.createElement('label');
  selLbl.textContent = t('active');
  selLbl.appendChild(sel);
  grid.appendChild(selLbl);

  const current = opts.providers.find((p) => p.name === opts.activeName);
  const modelField = document.createElement('input');
  modelField.value = current?.model ?? '';
  modelField.dataset.field = 'model';
  const modelLbl = document.createElement('label');
  modelLbl.textContent = t('model');
  modelLbl.appendChild(modelField);
  grid.appendChild(modelLbl);

  const baseUrlField = document.createElement('input');
  baseUrlField.value = current?.baseUrl ?? '';
  baseUrlField.placeholder = 'https://api.example.com/v1';
  baseUrlField.dataset.field = 'baseUrl';
  const baseUrlLbl = document.createElement('label');
  baseUrlLbl.textContent = t('baseUrlOptional');
  baseUrlLbl.appendChild(baseUrlField);
  grid.appendChild(baseUrlLbl);

  const apiKeyField = document.createElement('input');
  apiKeyField.placeholder = current?.hasKey ? t('apiKeyKeep') : t('apiKeyEnter');
  apiKeyField.dataset.field = 'apiKey';
  const apiKeyLbl = document.createElement('label');
  apiKeyLbl.textContent = t('apiKey');
  apiKeyLbl.appendChild(apiKeyField);
  grid.appendChild(apiKeyLbl);

  if (opts.showCategory) {
    const catField = document.createElement('input');
    catField.value = opts.dataRole === 'stt' ? 'stt' : 'tts';
    catField.dataset.field = 'category';
    const catLbl = document.createElement('label');
    catLbl.textContent = t('type');
    catLbl.appendChild(catField);
    grid.appendChild(catLbl);
  }

  row.appendChild(grid);

  const fill = (name: string): void => {
    const p = opts.providers.find((x) => x.name === name);
    modelField.value = p?.model ?? '';
    baseUrlField.value = p?.baseUrl ?? '';
    apiKeyField.value = '';
    apiKeyField.placeholder = p?.hasKey ? t('apiKeyKeep') : t('apiKeyEnter');
    active.textContent = name === opts.activeName ? t('activeNow') : '';
  };
  sel.addEventListener('change', () => fill(sel.value));
  grid.querySelectorAll('input').forEach((el) => {
    el.addEventListener('input', () => {
      settingsDirty = true;
      settingsMsg.textContent = '';
    });
  });
  settingsBody.appendChild(row);
}

function buildSettings(providersList: ProviderInfo[]): void {
  settingsBody.innerHTML = '';
  for (const p of providersList) {
    buildProviderRow(p);
  }

  const speechTitle = document.createElement('div');
  speechTitle.className = 'settings-section-title';
  speechTitle.textContent = t('speechSection');
  settingsBody.appendChild(speechTitle);
  const sttProviders = svConfig.speechProviders.filter((p) => p.category === 'stt');
  const ttsProviders = svConfig.speechProviders.filter((p) => p.category === 'tts');
  if (sttProviders.length > 0) {
    buildModelRow({
      className: 'speech-row',
      dataKind: 'speech',
      dataRole: 'stt',
      title: t('sttLabel'),
      providers: sttProviders,
      activeName: svConfig.activeSpeech,
      showCategory: true,
    });
  }
  if (ttsProviders.length > 0) {
    buildModelRow({
      className: 'speech-row',
      dataKind: 'speech',
      dataRole: 'tts',
      title: t('ttsLabel'),
      providers: ttsProviders,
      activeName: svConfig.activeTts,
      showCategory: true,
    });
  }

  const visionTitle = document.createElement('div');
  visionTitle.className = 'settings-section-title';
  visionTitle.textContent = t('visionSection');
  settingsBody.appendChild(visionTitle);
  if (svConfig.visionProviders.length > 0) {
    buildModelRow({
      className: 'vision-row',
      dataKind: 'vision',
      dataRole: 'vision',
      title: t('visionLabel'),
      providers: svConfig.visionProviders,
      activeName: svConfig.activeVision,
    });
  }

  buildStartupSection();
  buildAppearanceSection();
  buildUpdateSection();
  buildLogSection();
}

function buildStartupSection(): void {
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('startupSection');
  settingsBody.appendChild(title);

  buildToggle(t('deferMcpLabel'), t('deferMcpHint'), window.nexusDesktop.getDeferMcp(), (v) => {
    settingsMsg.textContent = v ? t('deferMcpEnabled') : t('deferMcpDisabled');
    return window.nexusDesktop.setDeferMcp(v);
  });
  buildToggle(t('minimizeToTrayLabel'), t('minimizeToTrayHint'), window.nexusDesktop.getMinimizeToTray(), (v) => {
    return window.nexusDesktop.setMinimizeToTray(v);
  });
  buildToggle(t('restoreSessionLabel'), t('restoreSessionHint'), window.nexusDesktop.getRestoreSessionOnLaunch(), (v) => {
    settingsMsg.textContent = v ? t('restoreSessionEnabled') : t('restoreSessionDisabled');
    return window.nexusDesktop.setRestoreSessionOnLaunch(v);
  });
}

/** Render a labeled checkbox settings row that persists immediately on change. */
function buildToggle(
  labelText: string,
  hintText: string,
  initial: Promise<boolean> | boolean,
  onToggle: (v: boolean) => Promise<unknown> | void,
): void {
  const row = document.createElement('div');
  row.className = 'startup-row';
  const label = document.createElement('label');
  label.className = 'startup-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  const text = document.createElement('span');
  text.textContent = labelText;
  const hint = document.createElement('div');
  hint.className = 'startup-hint';
  hint.textContent = hintText;
  Promise.resolve(initial).then((v) => {
    cb.checked = v === true;
  }).catch(() => {});
  cb.addEventListener('change', () => {
    const v = cb.checked;
    cb.disabled = true;
    Promise.resolve(onToggle(v))
      .then(() => {
        settingsMsg.textContent = '';
      })
      .catch((err: unknown) => {
        settingsMsg.textContent = `⚠️ ${errText(err)}`;
        cb.checked = !v;
      })
      .finally(() => {
        cb.disabled = false;
      });
  });
  label.appendChild(cb);
  label.appendChild(text);
  row.appendChild(label);
  row.appendChild(hint);
  settingsBody.appendChild(row);
}

/** Resource & session governance (desktop.json — see main/index.ts). Values are
 *  applied immediately on change (like deferMcp/inputRows), not on Save. */

/** Status text + class suffix for the live readout; also computes a load color
 *  that shifts mem/cpu value tints toward warning/danger when overloaded. */
function resourceStatusInfo(s: ResourceStateInfo): { key: string; cls: 'paused' | 'normal' | 'warning' | 'overloaded' } {
  if (!s.running) return { key: 'resourceStatusPaused', cls: 'paused' };
  if (s.status === 'overloaded') return { key: 'resourceStatusOverloaded', cls: 'overloaded' };
  if (s.status === 'warning') return { key: 'resourceStatusWarning', cls: 'warning' };
  return { key: 'resourceStatusNormal', cls: 'normal' };
}

/**
 * Render the live memory/CPU readout into an element (shared by settings + right
 * panel). Labels are dim-neutral; the Memory value is tinted accent (blue), the
 * CPU value ok (green), and the status shifts to warn/danger when load is high.
 * Built with createElement/textContent (no innerHTML) to stay injection-safe.
 */
function renderResourceInto(el: HTMLElement, s: ResourceStateInfo): void {
  const mem = Math.round(s.memoryPct * 100);
  const cpu = Math.round(s.cpuPct * 100);
  const hasValues = Number.isFinite(mem) && Number.isFinite(cpu);
  const status = resourceStatusInfo(s);
  const loadCls = status.cls === 'overloaded' ? 'is-overloaded' : status.cls === 'warning' ? 'is-warning' : '';

  el.textContent = '';
  el.style.color = '';

  const span = (cls: string, text: string): HTMLSpanElement => {
    const sEl = document.createElement('span');
    sEl.className = cls;
    sEl.textContent = text;
    return sEl;
  };

  if (hasValues) {
    const memLabel = span('rres-label', t('resourceMemoryLabel'));
    const memVal = span(`rres-val rres-val-mem ${loadCls}`, `${Math.max(0, Math.min(100, mem))}%`);
    const cpuLabel = span('rres-label', t('resourceCpuLabel'));
    const cpuVal = span(`rres-val rres-val-cpu ${loadCls}`, `${Math.max(0, Math.min(100, cpu))}%`);
    const sep = span('rres-sep', '·');
    el.append(memLabel, memVal, sep, cpuLabel, cpuVal);
  } else {
    el.append(span('rres-val rres-invalid', t('resourceStateUnavailable')));
  }

  const statusEl = span(`rres-status ${status.cls}`, t(status.key));
  el.append(span('rres-sep', '·'), statusEl);
}

function renderResourcePanel(s: ResourceStateInfo): void {
  if (rsideResourceEl) renderResourceInto(rsideResourceEl, s);
}

/** Build a labeled number-input settings row that persists immediately on change. */
function buildNumberRow(
  labelText: string,
  hintText: string,
  min: number,
  max: number,
  initial: Promise<number>,
  onCommit: (v: number) => Promise<unknown>,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'startup-row';
  const label = document.createElement('label');
  label.className = 'startup-toggle';
  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.min = String(min);
  numInput.max = String(max);
  const text = document.createElement('span');
  text.textContent = labelText;
  const hint = document.createElement('div');
  hint.className = 'startup-hint';
  hint.textContent = hintText;
  initial.then((v) => { numInput.value = String(v); }).catch(() => {});
  numInput.addEventListener('change', () => {
    const val = parseInt(numInput.value, 10);
    if (isNaN(val)) return;
    numInput.disabled = true;
    onCommit(val)
      .then(() => { settingsMsg.textContent = ''; })
      .catch((err: unknown) => { settingsMsg.textContent = `⚠️ ${errText(err)}`; })
      .finally(() => { numInput.disabled = false; });
  });
  label.appendChild(numInput);
  label.appendChild(text);
  row.appendChild(label);
  row.appendChild(hint);
  return row;
}

function applyInputRows(rows: number): void {
  const clamped = Math.max(1, Math.min(20, Math.round(rows)));
  inputEl.rows = clamped;
  const lineHeight = 20;
  const padding = 22;
  inputEl.style.setProperty('--input-min-h', `${clamped * lineHeight + padding}px`);
}

function buildAppearanceSection(): void {
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('appearanceSection');
  settingsBody.appendChild(title);

  const row = document.createElement('div');
  row.className = 'startup-row';
  const label = document.createElement('label');
  label.className = 'startup-toggle';
  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.min = '1';
  numInput.max = '20';
  const text = document.createElement('span');
  text.textContent = t('inputRowsLabel');
  const hint = document.createElement('div');
  hint.className = 'startup-hint';
  hint.textContent = t('inputRowsHint');

  void window.nexusDesktop.getInputRows().then((v) => {
    numInput.value = String(v);
    applyInputRows(v);
  }).catch(() => {});

  numInput.addEventListener('change', () => {
    const val = parseInt(numInput.value, 10);
    if (isNaN(val)) return;
    numInput.disabled = true;
    void window.nexusDesktop.setInputRows(val)
      .then(() => {
        settingsMsg.textContent = '';
        applyInputRows(val);
      })
      .catch((err: unknown) => {
        settingsMsg.textContent = `⚠️ ${errText(err)}`;
      })
      .finally(() => {
        numInput.disabled = false;
      });
  });

  label.appendChild(numInput);
  label.appendChild(text);
  row.appendChild(label);
  row.appendChild(hint);
  settingsBody.appendChild(row);
}

function buildLogSection(): void {
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('logSection');
  settingsBody.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'log-row';
  const pre = document.createElement('pre');
  pre.className = 'log-viewer hidden';
  pre.textContent = t('logsEmpty');
  const btn = document.createElement('button');
  btn.className = 'btn ghost small';
  btn.textContent = t('viewLogs');
  const load = async () => {
    btn.disabled = true;
    try {
      const lines = await window.nexusDesktop.readRecentLogs(300);
      if (lines.length === 0) {
        pre.textContent = t('logsEmpty');
      } else {
        pre.textContent = lines.join('\n');
      }
      pre.classList.remove('hidden');
    } catch {
      pre.textContent = t('logsEmpty');
      pre.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', () => {
    void load();
  });
  wrap.appendChild(btn);
  wrap.appendChild(pre);
  settingsBody.appendChild(wrap);
}

type UpdateStateType =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version?: string; releaseNotes?: string }
  | { status: 'not-available'; version?: string }
  | { status: 'downloading'; percent?: number }
  | { status: 'downloaded'; version?: string }
  | { status: 'error'; message?: string };

let updateVersion = '';
function buildUpdateSection(): void {
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('updateSection');
  settingsBody.appendChild(title);

  const wrap = document.createElement('div');
  wrap.className = 'update-row';
  const info = document.createElement('span');
  info.className = 'update-info';
  updateVersion = '';
  info.textContent = t('updateVersion', { version: '…' });
  void window.nexusDesktop.getCurrentVersion().then((v: string) => {
    updateVersion = String(v).replace(/^v/i, '');
    info.textContent = t('updateVersion', { version: updateVersion });
  }).catch(() => {
    info.textContent = t('updateVersion', { version: '?' });
  });
  const btn = document.createElement('button');
  btn.className = 'btn ghost small';
  btn.textContent = t('updateCheck');
  btn.addEventListener('click', () => void runUpdateCheck(btn));
  wrap.appendChild(info);
  wrap.appendChild(btn);
  settingsBody.appendChild(wrap);
  renderUpdateStatus({ status: 'idle' });
}

function renderUpdateStatus(state: UpdateStateType): void {
  const existing = settingsBody.querySelector<HTMLElement>('.update-status');
  if (existing) existing.remove();
  if (state.status === 'idle' || state.status === 'not-available') {
    if (state.status === 'not-available') showUpdateMsg(t('updateNotAvailable'));
    return;
  }
  const line = document.createElement('div');
  line.className = 'update-status';
  if (state.status === 'checking') {
    line.textContent = t('updateChecking');
  } else if (state.status === 'available') {
    line.textContent = t('updateAvailable', { version: state.version ?? '' });
    const dl = document.createElement('button');
    dl.className = 'btn primary small';
    dl.textContent = t('updateDownload');
    dl.addEventListener('click', () => void window.nexusDesktop.downloadUpdate());
    line.appendChild(dl);
  } else if (state.status === 'downloading') {
    line.textContent = t('updateDownloading', { percent: state.percent ?? 0 });
  } else if (state.status === 'downloaded') {
    line.textContent = t('updateReady');
    const inst = document.createElement('button');
    inst.className = 'btn primary small';
    inst.textContent = t('updateInstall');
    inst.addEventListener('click', () => void window.nexusDesktop.installUpdate());
    line.appendChild(inst);
  } else if (state.status === 'error') {
    line.textContent = t('updateError', { message: state.message ?? '' });
  }
  settingsBody.appendChild(line);
}

function showUpdateMsg(msg: string): void {
  const existing = settingsBody.querySelector<HTMLElement>('.update-status');
  if (existing) existing.remove();
  const line = document.createElement('div');
  line.className = 'update-status';
  line.textContent = msg;
  settingsBody.appendChild(line);
}

async function runUpdateCheck(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  renderUpdateStatus({ status: 'checking' });
  try {
    const state = await window.nexusDesktop.checkForUpdate();
    renderUpdateStatus(state as UpdateStateType);
  } catch (err) {
    renderUpdateStatus({ status: 'error', message: errText(err) });
  } finally {
    btn.disabled = false;
  }
}

async function openSettings(): Promise<void> {
  settingsOverlay.classList.remove('hidden');
  settingsMsg.textContent = '';
  try {
    providers = await window.nexusDesktop.getProviders();
    svConfig = await window.nexusDesktop.getSpeechVisionConfig();
    buildSettings(providers);
  } catch (err) {
    settingsMsg.textContent = errText(err);
  }
}

function makeFieldValues(row: HTMLElement): Record<string, string> {
  const fields: Record<string, string> = {};
  row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((el) => {
    fields[el.dataset.field!] = el.value;
  });
  return fields;
}

$('#btn-settings').addEventListener('click', () => void openSettings());
$('#settings-close').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

// Live-update the settings update section from main-process events (progress,
// downloaded, errors) without re-opening the modal.
window.nexusDesktop.onUpdateState((state) => {
  if (settingsOverlay.classList.contains('hidden')) return;
  renderUpdateStatus(state as UpdateStateType);
});

$('#settings-web').addEventListener('click', () => {
  window.nexusDesktop.openConfigWeb().then((r) => {
    if (!r.ok) inputStatus.textContent = `⚠️ ${r.error ?? ''}`;
  }).catch((err) => {
    inputStatus.textContent = `⚠️ ${err?.message ?? err}`;
  });
});

$('#settings-save').addEventListener('click', async () => {
  const rows = settingsBody.querySelectorAll<HTMLElement>('.provider-row');
  for (const row of rows) {
    const kind = row.dataset.kind;
    if (!kind) {
      const name = row.dataset.name!;
      const fields: Record<string, string> = {};
      row.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((input) => {
        fields[input.dataset.field!] = input.value;
      });
      await window.nexusDesktop.saveProvider(name, fields);
      continue;
    }
    const fields = makeFieldValues(row);
    const providerName = fields.provider;
    if (!providerName) continue;
    const role = row.dataset.role!;
    if (kind === 'speech') {
      await window.nexusDesktop.saveSpeechProvider(providerName, fields);
      if (role === 'stt') await window.nexusDesktop.setActiveSpeechProvider(providerName);
      else if (role === 'tts') await window.nexusDesktop.setActiveTtsProvider(providerName);
    } else if (kind === 'vision') {
      await window.nexusDesktop.saveVisionProvider(providerName, fields);
      await window.nexusDesktop.setActiveVisionProvider(providerName);
    }
  }
  providers = await window.nexusDesktop.getProviders();
  status = await window.nexusDesktop.getStatus();
  refreshProviderSelect();
  modelsCache.clear();
  refreshModelSelect();
  await refreshSidebarModels();
  await refreshSidebarSession();
  settingsMsg.textContent = t('saved');
  settingsMsg.style.color = 'var(--ok)';
  settingsDirty = false;
});

// ---------- toolbar ----------
function refreshProviderSelect(): void {
  providerSelect.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = `${p.name} · ${p.model}`;
    opt.selected = p.name === status.provider;
    providerSelect.appendChild(opt);
  }
}

/**
 * Populate the model dropdown for the active provider. Seeds with the current
 * model immediately, then asynchronously loads the provider's /models list
 * (cached per provider) and fills in the rest without disturbing the
 * selection.
 */
function refreshModelSelect(): void {
  const active = status.provider;
  const current = status.model;
  modelSelect.disabled = !active || !current;
  const seed = () => {
    modelSelect.innerHTML = '';
    if (current) {
      const opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current;
      opt.selected = true;
      modelSelect.appendChild(opt);
    }
  };
  seed();
  const cached = modelsCache.get(active);
  if (cached && cached.length > 0) {
    populateModelOptions(cached, current);
    return;
  }
  void (async () => {
    try {
      const models = await window.nexusDesktop.getModels(active, { sessionId: currentSessionId || undefined });
      if (!active || active !== status.provider) return;
      modelsCache.set(active, models);
      if (models.length > 0) populateModelOptions(models, current);
    } catch {
      // keep the seeded current-model option
    }
  })();
}

function populateModelOptions(models: string[], current: string): void {
  const selected = current || models[0] || '';
  modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    opt.selected = m === selected;
    modelSelect.appendChild(opt);
  }
}

providerSelect.addEventListener('change', async () => {
  const name = providerSelect.value;
  if (!name || name === status.provider) return;
  await window.nexusDesktop.switchProvider(name, { sessionId: currentSessionId || undefined });
  status = await window.nexusDesktop.getStatus({ sessionId: currentSessionId || undefined });
  addSystem(t('switchedProvider', { name, model: status.model }));
  refreshModelSelect();
  await refreshSessions();
  await refreshSidebarSession();
});

modelSelect.addEventListener('change', async () => {
  const modelId = modelSelect.value;
  if (!modelId || modelId === status.model) return;
  const from = status.model;
  const providerName = status.provider;
  try {
    await window.nexusDesktop.switchModel(modelId, { sessionId: currentSessionId || undefined });
    status = await window.nexusDesktop.getStatus({ sessionId: currentSessionId || undefined });
    addSystem(t('switchedModel', { name: providerName, from, to: status.model }));
    await refreshSessions();
    await refreshSidebarSession();
  } catch (err) {
    addSystem(`${t('error')}${errText(err)}`);
    refreshModelSelect();
  }
});

$('#btn-open-folder').addEventListener('click', async () => {
  const res = await window.nexusDesktop.openFolder();
  if (res.canceled || !res.path) return;
  await window.nexusDesktop.setCwd(res.path);
  // Persist to session metadata so future resume switches cwd.
  if (currentSessionId) {
    try {
      await window.nexusDesktop.setSessionMetadata(currentSessionId, { projectDir: res.path, cwd: res.path });
    } catch {}
  }
  status = await window.nexusDesktop.getStatus();
  cwdLabel.textContent = status.cwd;
  cwdLabel.title = status.cwd;
  addSystem(t('projectDir', { cwd: status.cwd }));
});

$('#btn-new-session').addEventListener('click', () => void openNewTab());

// ---------- sidebar collapse/expand ----------
const SIDEBAR_COLLAPSED_KEY = 'nexus.sidebar.collapsed';
function loadSidebarState(): void {
  try {
    const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== '0';
    if (collapsed) sidebarEl.classList.add('collapsed');
  } catch {}
}
function saveSidebarState(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {}
}
collapseBtn.addEventListener('click', () => {
  const isCollapsed = sidebarEl.classList.toggle('collapsed');
  saveSidebarState(isCollapsed);
  collapseBtn.textContent = isCollapsed ? '▶' : '◀';
});
loadSidebarState();
collapseBtn.textContent = sidebarEl.classList.contains('collapsed') ? '▶' : '◀';
pagerPrevEl.addEventListener('click', () => {
  if (sessionPage <= 0) return;
  sessionPage--;
  void refreshSessions();
});
pagerNextEl.addEventListener('click', () => {
  if (sessionPage >= Math.ceil(sessionTotal / SESSION_PAGE_SIZE) - 1) return;
  sessionPage++;
  void refreshSessions();
});
sendBtn.addEventListener('click', () => void sendMessage());
stopBtn.addEventListener('click', () => requestStop());
freezeBtn.addEventListener('click', () => setFrozen(!frozen));

// Ctrl+. toggles the viewport freeze while a turn is streaming (Ctrl+Space is
// taken by IMEs, so avoid it).
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '.') {
    e.preventDefault();
    if (busy) setFrozen(!frozen);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy && !stopRequested) requestStop();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

// ---------- session search (E3) ----------
let searchTimer: ReturnType<typeof setTimeout> | null = null;
searchEl.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchEl.value.trim();
    sessionPage = 0;
    void refreshSessions();
  }, 250);
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchEl.value = '';
    searchQuery = '';
    sessionPage = 0;
    void refreshSessions();
  }
});

// ---------- input draft persistence (E1) ----------
const draftKey = (id: string): string => `nexus.draft.${id}`;
function saveDraft(): void {
  try {
    if (currentSessionId) localStorage.setItem(draftKey(currentSessionId), inputEl.value);
  } catch {}
}
function loadDraft(id: string): void {
  try {
    const d = localStorage.getItem(draftKey(id));
    inputEl.value = d ?? '';
  } catch {}
}
function clearDraft(id: string): void {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {}
}
let draftTimer: ReturnType<typeof setTimeout> | null = null;
inputEl.addEventListener('input', () => {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
});

// ---------- drag & drop / paste attachments (E3) ----------
const dropZone = $('#input-area');
['dragover', 'dragenter'].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer?.files ?? []);
  const paths = files.map((f) => window.nexusDesktop.getPathForFile(f)).filter(Boolean);
  if (paths.length > 0) void attachFiles(paths);
});
inputEl.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (files.length === 0) return;
  e.preventDefault();
  const paths = files.map((f) => window.nexusDesktop.getPathForFile(f)).filter(Boolean);
  if (paths.length > 0) void attachFiles(paths);
});

// ---------- wire events ----------
window.nexusDesktop.onEvent(handleEvent);
window.nexusDesktop.onEvents((events) => {
  for (const e of events) handleEvent(e);
});
window.nexusDesktop.onPermission(showPermission);
window.nexusDesktop.onLog((log) => {
  if (log.level === 'error') inputStatus.textContent = `⚠️ ${errText(log.message)}`;
});

// Right-side "Resources" panel: surface the live memory/CPU readout pushed by
// the main-process watchdog. Subscribe to the stream for continuous updates and
// pull once now so the panel has a value immediately (no 5s sampling lag).
// These must run after loadLanguage() so the first render uses the correct lang.
async function initResourcePanel(): Promise<void> {
  window.nexusDesktop.onResourceState((s) => renderResourcePanel(s as ResourceStateInfo));
  try {
    const s = await window.nexusDesktop.getResourceState();
    renderResourcePanel(s);
  } catch {}
}

// When the full config Web UI closes it may have rewritten config.json
// (language, providers, MCP, ...). Reload the core config so the long-lived
// in-memory copy matches disk, then re-apply i18n / sidebar state.
window.nexusDesktop.onConfigWindowClosed(async () => {
  await window.nexusDesktop.reloadConfig();
  await loadLanguage();
  await refreshSidebarSession();
  const provs = await window.nexusDesktop.getProviders();
  if (provs.length > 0) {
    providers = provs;
    refreshProviderSelect();
  }
  modelsCache.clear();
  refreshModelSelect();
});

// The core worker crashed and auto-restarted: refresh state and re-attach the
// current session so the UI is usable again without a manual app restart.
window.nexusDesktop.onWorkerRestarted(async () => {
  addSystem(t('workerRestarted'));
  currentSessionId = '';
  msgItems = [];
  await startOrResumeLatestSession();
  await refreshSessions();
  await refreshSidebarSession();
});

// Per-session tab events: route to the focused tab's transcript, or just the
// busy badge for background tabs (they keep streaming in their own worker).
window.nexusDesktop.onTabEvent((payload) => applyTabEvent(payload.sessionId, payload.event));
window.nexusDesktop.onTabEvents((payloads) => {
  for (const p of payloads) applyTabEvent(p.sessionId, p.event);
});
// Main-side tab registry changed (open/close/exit): mirror it in the tab bar.
window.nexusDesktop.onTabsChanged((open) => {
  const keep = new Set(open.map((t) => t.sessionId));
  for (const sid of [...tabs.keys()]) if (!keep.has(sid)) tabs.delete(sid);
  for (const t of open) if (t.sessionId) tabs.set(t.sessionId, t);
  renderTabBar();
});

// ---------- boot ----------
(async function boot(): Promise<void> {
  try {
    loadTheme();
    initFx();
    await loadLanguage();
    void window.nexusDesktop.getInputRows().then((r) => applyInputRows(r)).catch(() => {});
    status = await window.nexusDesktop.getStatus();
    providers = await window.nexusDesktop.getProviders();
    if (providers.length === 0) {
      addSystem(t('noProviderConfigured'));
      void openSettings();
    }
    refreshProviderSelect();
    refreshModelSelect();
    cwdLabel.textContent = status.cwd || t('noProject');
    cwdLabel.title = status.cwd;
    const shouldRestore = await window.nexusDesktop.getRestoreSessionOnLaunch();
    if (shouldRestore) {
      const savedTabs = await window.nexusDesktop.getLastOpenTabs();
      if (savedTabs.length > 0) {
        // Check if global permissions is unattended — if so, inherit on all restored tabs.
        let globalMode = '';
        try { globalMode = (await window.nexusDesktop.getPermissions()).mode ?? ''; } catch {}
        for (let i = 0; i < savedTabs.length; i++) {
          await openTab(savedTabs[i]).catch(() => {});
        }
        const lastSid = savedTabs[savedTabs.length - 1];
        if (lastSid && tabs.has(lastSid)) await switchTab(lastSid);
        if (globalMode === 'unattended') {
          for (const sid of savedTabs) {
            try { await window.nexusDesktop.setPermissionsOverride('unattended'); } catch {}
          }
        }
      } else {
        await startNewSession();
      }
    }
    // When shouldRestore is false, stay on blank slate — no session created.
    await refreshSessions();
    await refreshSidebarSession();
    await syncOpenTabs();
    await initResourcePanel();
    // Open the resumed session in its own tab so it runs in a per-session worker.
    if (currentSessionId && !tabs.has(currentSessionId)) await openTab(currentSessionId);
    renderTabBar();
  } catch (err) {
    addSystem(`${t('startFailed')}${errText(err)}`);
  }
})();
