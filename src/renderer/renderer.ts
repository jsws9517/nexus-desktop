/// <reference lib="dom" />

import { initFx } from './fx.js';
import { isWorkerBlockText } from '../shared/constants.js';
import { t, fmtNum, getUiLang, loadLanguage, localizeError } from './i18n.js';
import { renderBlocks, attachCodeCopy, hydrateImages } from './markdown.js';
import { tryMountArtifact } from './artifacts/index.js';
import { ParallelExecutionCard } from './components/ParallelExecutionCard.js';
import type { SubTaskResult, SubTaskStatus } from '../agent/sub-agent/types.js';
import { SidebarRegistryImpl } from './sidebar/registry.js';
import type { SidebarContext, SidebarTabRegistration } from './sidebar/types.js';
import { SubAgentsPage, mountSubAgentsPage } from './sidebar/pages/sub-agents.js';
import { TerminalPage, mountTerminalPage } from './sidebar/pages/terminal.js';
import { SideChatPage, mountSideChatPage } from './sidebar/pages/side-chat.js';
import { GitPage, mountGitPage } from './sidebar/pages/git.js';

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
  toolCalls?: string;
  toolCallId?: string;
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
  | { type: 'cwdChanged'; sessionId: string; cwd: string }
  | { type: 'context_cleared'; sessionId: string }
  | { type: 'slash_start'; command: string; anchorId?: number }
  | { type: 'slash'; text: string }
  | { type: 'slash_end'; anchorId?: number; command: string }
  | { type: 'parallel_start'; sessionId: string; prompt: string; tasks?: Array<{ id: string; description: string; status: string }> }
  | { type: 'parallel_end'; sessionId: string; tasks: Array<{ taskId: string; status: SubTaskStatus; output: string; durationMs: number; error?: string; tokenUsage: { prompt: number; completion: number } }>; tokenUsage: { prompt: number; completion: number } }
  | { type: 'parallel_error'; sessionId: string; error: string };

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
      openNewSession(opts?: { cwd?: string; prevSessionId?: string }): Promise<{ ok: boolean; sessionId?: string; tab?: TabInfo; reason?: string }>;
      closeSession(sessionId: string): Promise<{ ok: boolean }>;
      getOpenTabs(): Promise<TabInfo[]>;
      getTabStatus(sessionId: string): Promise<TabInfo | null>;
      openConfigWeb(): Promise<{ ok: boolean; port?: number; error?: string }>;
      setCwd(cwd: string, opts?: { sessionId?: string }): Promise<unknown>;
      getDefaultProjectDir(): Promise<{ dir: string }>;
      getSessionMetadata(sessionId: string): Promise<Record<string, unknown>>;
      setSessionMetadata(sessionId: string, metadata: Record<string, unknown>): Promise<void>;
      openFolder(): Promise<{ canceled: boolean; path?: string }>;
      openFile(): Promise<{ canceled: boolean; paths: string[] }>;
      revealFile(path: string): Promise<{ ok: boolean }>;
      getFileInfos(paths: string[]): Promise<Array<{ path: string; name: string; size: number; isImage: boolean; preview?: string }>>;
      readImagePreview(path: string): Promise<string | undefined>;
      // Paste image from system clipboard (consistent with coder-core ALT+V).
      pasteImage(): Promise<{ path: string; preview: string } | null>;
      // Export an artifact payload (base64 bytes or text) via a save dialog.
      saveArtifact(defaultName: string, data: string, encoding?: 'base64' | 'text'): Promise<{ ok: boolean; path?: string; error?: string }>;
      getPathForFile(file: File): string;
      regenerate(sessionId: string, userIndex: number): Promise<unknown>;
      withdraw(sessionId: string, userIndex: number): Promise<string>;
      respondPermission(id: string, answer: string, sessionId?: string): Promise<unknown>;
      setMcpEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      getMcpStatus(): Promise<{ enabled: boolean; servers: McpServerStatus[] }>;
      getMcpServers(): Promise<Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string; stderr?: string; internal?: boolean }>>;
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
  processMemoryMb?: number;
  workerCount?: number;
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
const chatEmptyEl = $('#chat-empty');
const inputEl = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#btn-send');
const stopBtn = $('#btn-stop');
const freezeBtn = $('#btn-freeze') as HTMLButtonElement;
const sessionListEl = $('#session-list');
const searchEl = $('#session-search') as HTMLInputElement;
const sessionPagerEl = $('#session-pager');
const sidebarEl = $('#sidebar') as HTMLElement;
const collapseBtn = $('#btn-collapse-sidebar') as HTMLButtonElement;

// ---------- P1 sidebar extension registry (DSH Better SideBar port) ----------
const sidebarRegistry = new SidebarRegistryImpl();
const sidebarTabsEl = $('#sidebar-tabs') as HTMLElement;
const sidebarPageEl = $('#sidebar-page') as HTMLElement;
let activeSidebarTabId: string | null = null;
// Unsubscribe hook for the currently mounted sidebar page (registry tracks it;
// we keep the active id so switching tabs can re-mount when a tab re-opens).

/**
 * Render the sidebar tab bar from the registry, highlighting the active tab.
 * The page container stays empty until a tab is opened (click toggles).
 */
function renderSidebarTabs(): void {
  const regs = sidebarRegistry.list();
  sidebarTabsEl.replaceChildren();
  if (regs.length === 0) {
    sidebarTabsEl.classList.add('hidden');
    return;
  }
  sidebarTabsEl.classList.remove('hidden');
  for (const reg of regs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-tab' + (reg.id === activeSidebarTabId ? ' active' : '');
    btn.dataset.tabId = reg.id;
    btn.textContent = (reg.icon ? reg.icon + ' ' : '') + reg.title;
    btn.title = reg.title;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(reg.id === activeSidebarTabId));
    btn.addEventListener('click', () => toggleSidebarTab(reg.id));
    sidebarTabsEl.appendChild(btn);
  }
}

/** Build the SidebarContext handed to page mounts (live view of renderer state). */
function makeSidebarContext(sessionId: string): SidebarContext {
  return {
    sessionId,
    getParallelSessions: () => parallelSessions as ReadonlyMap<string, { sessionId: string; prompt: string; startTime: number; tasks: ReadonlyMap<string, { description?: string; status: string; output?: string; error?: string; durationMs?: number }> }>,
    subscribe: (fn) => {
      const wrapped = (event: AgentEvent) => fn(event);
      eventSubscribers.add(wrapped);
      return () => {
        eventSubscribers.delete(wrapped);
      };
    },
  };
}

/** Toggle a sidebar tab on/off (click again to close — registry disposes page). */
function toggleSidebarTab(id: string): void {
  if (activeSidebarTabId === id) {
    sidebarRegistry.mountDispose(id);
    activeSidebarTabId = null;
    sidebarPageEl.hidden = true;
    sidebarPageEl.replaceChildren();
    renderSidebarTabs();
    return;
  }
  const reg = sidebarRegistry.get(id);
  if (!reg) return;
  const ctx = makeSidebarContext(currentSessionId);
  sidebarPageEl.hidden = false;
  const route = () => {
    sidebarRegistry.mount(id, sidebarPageEl, makeSidebarContext(currentSessionId));
  };
  // Mount fresh every toggle; sidebarRegistry.mount disposes any earlier mount.
  activeSidebarTabId = id;
  route();
  renderSidebarTabs();
}

/** Every AgentEvent also fans out to sidebar pages (in addition to handleEvent). */
const eventSubscribers = new Set<(event: AgentEvent) => void>();
function notifySidebarSubscribers(event: AgentEvent): void {
  for (const fn of [...eventSubscribers]) {
    try { fn(event); } catch { /* page errors never break the core loop */ }
  }
}
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
const rsideSessionId = $('#rside-session-id');
const rsideCwd = $('#rside-cwd');
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
// only the viewport stays put (safe — no DOM/state is deferred). The lock is
// session-scoped: it persists across turns/messages until the user unfreezes,
// and resets when switching to another session (see resetViewState).
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

// ---------- parallel execution state ----------
interface ParallelSession {
  sessionId: string;
  prompt: string;
  startTime: number;
  tasks: Map<string, { description?: string; status: string; output?: string; error?: string; durationMs?: number }>;
}
const parallelSessions = new Map<string, ParallelSession>();
let parallelCardEl: HTMLElement | null = null;

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

// ---------- Accessibility & UX utilities ----------

/** Trap focus within a modal dialog for keyboard navigation */
function trapFocus(modal: HTMLElement): void {
  const focusableElements = modal.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const firstFocusable = focusableElements[0];
  const lastFocusable = focusableElements[focusableElements.length - 1];

  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      if (document.activeElement === firstFocusable) {
        lastFocusable?.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === lastFocusable) {
        firstFocusable?.focus();
        e.preventDefault();
      }
    }
  });

  firstFocusable?.focus();
}

/** Create a skeleton loader element */
function createSkeleton(type: 'text' | 'session' | 'avatar' = 'text'): HTMLElement {
  const el = document.createElement('div');
  el.className = type === 'session' ? 'session-skeleton' : `skeleton skeleton-${type}`;
  el.setAttribute('aria-hidden', 'true');
  if (type === 'session') {
    el.innerHTML = '<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div>';
  }
  return el;
}

/** Add skip link for background animation */
function addSkipLink(): void {
  const skipLink = document.createElement('a');
  skipLink.href = '#input';
  skipLink.className = 'skip-link';
  skipLink.textContent = '跳转到输入框';
  skipLink.setAttribute('data-i18n', 'skipToInput');
  document.body.insertBefore(skipLink, document.body.firstChild);
}

/** Show onboarding overlay for first-time users */
const ONBOARDING_KEY = 'nexus.onboarding.completed';
function showOnboarding(): void {
  const completed = localStorage.getItem(ONBOARDING_KEY);
  if (completed) return;

  const overlay = document.createElement('div');
  overlay.className = 'overlay onboarding-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '新手引导');

  const modal = document.createElement('div');
  modal.className = 'modal onboarding-modal';

  const steps = [
    { icon: '💬', title: '开始对话', desc: '在下方输入框输入消息，按 Enter 发送' },
    { icon: '📁', title: '打开项目', desc: '点击左上角「打开项目」选择工作目录' },
    { icon: '⚙️', title: '配置模型', desc: '点击右上角「设置」配置 AI 模型和 API Key' },
    { icon: '🔑', title: '权限控制', desc: '工具执行前会请求权限，可选择「始终允许」' },
  ];

  let currentStep = 0;

  const renderStep = () => {
    modal.innerHTML = '';
    const step = steps[currentStep];

    const icon = document.createElement('div');
    icon.className = 'onboarding-icon';
    icon.textContent = step.icon;

    const title = document.createElement('h3');
    title.textContent = step.title;

    const desc = document.createElement('p');
    desc.textContent = step.desc;

    const progress = document.createElement('div');
    progress.className = 'onboarding-progress';
    progress.textContent = `${currentStep + 1} / ${steps.length}`;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    if (currentStep > 0) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'btn ghost';
      prevBtn.textContent = '上一步';
      prevBtn.addEventListener('click', () => { currentStep--; renderStep(); });
      actions.appendChild(prevBtn);
    }

    if (currentStep < steps.length - 1) {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'btn primary';
      nextBtn.textContent = '下一步';
      nextBtn.addEventListener('click', () => { currentStep++; renderStep(); });
      actions.appendChild(nextBtn);
    } else {
      const finishBtn = document.createElement('button');
      finishBtn.className = 'btn primary';
      finishBtn.textContent = '开始使用';
      finishBtn.addEventListener('click', () => { overlay.remove(); localStorage.setItem(ONBOARDING_KEY, 'true'); });
      actions.appendChild(finishBtn);
    }

    const skipBtn = document.createElement('button');
    skipBtn.className = 'btn ghost';
    skipBtn.textContent = '跳过引导';
    skipBtn.addEventListener('click', () => { overlay.remove(); localStorage.setItem(ONBOARDING_KEY, 'true'); });

    modal.appendChild(icon);
    modal.appendChild(title);
    modal.appendChild(desc);
    modal.appendChild(progress);
    modal.appendChild(actions);
    modal.appendChild(skipBtn);
  };

  renderStep();
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  trapFocus(modal);
}

// ---------- i18n ---------- (moved to i18n.ts; see imports above)

// ---------- theme ----------
const THEME_KEY = 'nexus.theme';
type ThemeName = 'system' | 'dark' | 'warm' | 'light' | 'cartoon' | 'tech';

const VALID_THEMES: ThemeName[] = ['system', 'dark', 'warm', 'light', 'cartoon', 'tech'];

/** Resolve the effective CSS theme name from a saved preference. */
function resolveTheme(preference: ThemeName): 'dark' | 'warm' | 'light' | 'cartoon' | 'tech' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: ThemeName): void {
  const effective = resolveTheme(theme);
  document.documentElement.dataset.theme = effective;
  themeSelect.value = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
  syncSystemThemeListener(theme);
}

function loadTheme(): ThemeName {
  let theme: ThemeName = 'dark';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && VALID_THEMES.includes(saved as ThemeName)) {
      theme = saved as ThemeName;
    }
  } catch {}
  applyTheme(theme);
  return theme;
}

/** Listen / unlisten to OS dark-mode changes when theme is "system". */
let systemMql: MediaQueryList | null = null;
let systemMqlHandler: (() => void) | null = null;

function syncSystemThemeListener(theme: ThemeName): void {
  if (theme === 'system') {
    if (systemMql) return; // already listening
    systemMql = window.matchMedia('(prefers-color-scheme: dark)');
    systemMqlHandler = () => {
      const effective = resolveTheme('system');
      document.documentElement.dataset.theme = effective;
    };
    systemMql.addEventListener('change', systemMqlHandler);
  } else if (systemMql && systemMqlHandler) {
    systemMql.removeEventListener('change', systemMqlHandler);
    systemMql = null;
    systemMqlHandler = null;
  }
}

const savedTheme = loadTheme();
themeSelect.addEventListener('change', () => {
  const val = themeSelect.value as ThemeName;
  applyTheme(VALID_THEMES.includes(val) ? val : 'dark');
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
  const copyBtn = makeMsgCopyBtn(text);
  actions.appendChild(undoBtn);
  actions.appendChild(regenBtn);
  actions.appendChild(copyBtn);
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
    const copyBtn = makeMsgCopyBtn(() => stream.textContent ?? '');
    wrap.appendChild(copyBtn);
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
        // Restore parallel execution state from session metadata
        void restoreParallelState(event.sessionId);
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
    case 'context_cleared':
      // /clear wiped the in-memory context; the token counter reset to ~0 so
      // refresh the sidebar immediately (no turn_end fires for slash output).
      if (event.sessionId === currentSessionId) {
        void refreshSessionStats();
      }
      break;
    case 'cwdChanged':
      // Session's working directory changed (e.g. /setdir or /chcwd): refresh
      // the status label + sidebar so the UI reflects where the agent operates.
      // projectDir persistence happens in the service (/setdir only); /chcwd is
      // transient and never touches metadata.
      if (event.sessionId === currentSessionId) {
        status = { ...status, cwd: event.cwd };
        cwdLabel.textContent = event.cwd;
        cwdLabel.title = event.cwd;
        void refreshSidebarSession();
      }
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
        // Artifact skills return an envelope — mount the preview card directly
        // (no truncation, no collapse) so the product is visible immediately.
        if (!event.isError) {
          const artifactEl = tryMountArtifact(event.content);
          if (artifactEl) {
            rec.card.classList.remove('collapsed');
            const chevronEl = rec.card.querySelector('.tool-chevron');
            if (chevronEl) chevronEl.textContent = '▾';
            const argsEl = rec.card.querySelector('.tool-args');
            if (argsEl) argsEl.classList.remove('hidden');
            const resultEl = rec.resultEl ?? document.createElement('div');
            resultEl.className = 'tool-result';
            resultEl.appendChild(artifactEl);
            rec.card.appendChild(resultEl);
            rec.resultEl = resultEl;
            scrollToBottom();
            break;
          }
        }
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
    case 'parallel_start':
      handleParallelStart(event.sessionId, event.prompt, event.tasks);
      break;
    case 'parallel_end':
      handleParallelEnd(event.sessionId, event.tasks);
      break;
    case 'parallel_error':
      handleParallelError(event.sessionId, event.error);
      break;
  }
}

// ---------- status / busy ----------
function setBusy(value: boolean): void {
  busy = value;
  busyIndicator.classList.toggle('hidden', !value);
  sendBtn.classList.toggle('hidden', value);
  stopBtn.classList.toggle('hidden', !value);
  document.querySelectorAll('.regen-btn').forEach((b) => {
    (b as HTMLButtonElement).disabled = value;
  });
  if (value) {
    inputStatus.textContent = t('runningEllipsis');
    inputStatus.classList.add('running');
  } else {
    inputStatus.classList.remove('running');
    inputStatus.classList.remove('stopping');
    // If a stop was requested, surface the completion feedback once — the core
    // always emits session_end in its chat() finally, so any path that leaves
    // busy state funnels through here and resets the stop request.
    if (stopRequested) {
      inputStatus.textContent = t('stopped');
      inputStatus.classList.add('stopped');
    } else {
      inputStatus.textContent = '';
      inputStatus.classList.remove('stopped');
    }
  }
  if (!value) {
    stopRequested = false;
    (stopBtn as HTMLButtonElement).disabled = false;
  }
}

/** Toggle the viewport freeze (auto-scroll lock). Safe by design: content keeps
 *  streaming below, only the scroll position stays put. The lock spans the whole
 *  session — turn end / new messages don't release it; only the user (or a
 *  session switch) does. */
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
  inputStatus.classList.add('stopping');
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

let _scrollRafPending = false;
function scrollToBottom(): void {
  if (frozen) return;
  if (_scrollRafPending) return;
  _scrollRafPending = true;
  requestAnimationFrame(() => {
    _scrollRafPending = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
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
  try {
    asst.stream.innerHTML = renderBlocks(asst.buffer);
    attachCodeCopy(asst.stream);
    hydrateImages(asst.stream);
  } catch (err) {
    console.error('Markdown render error:', err);
    asst.stream.textContent = asst.buffer;
    showToast('渲染出错，已切换到纯文本模式', 'warning');
  }
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
    trapFocus(overlay.querySelector('.modal')!);
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
    trapFocus(overlay.querySelector('.modal')!);
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
    try {
      await window.nexusDesktop.deleteSession(s.id);
      delete mcpPrefs[s.id];
      saveMcpPrefs();
      clearMsgCache(s.id);
      pinnedIds = pinnedIds.filter((x) => x !== s.id);
      showToast(`会话「${s.name}」已删除`, 'success');
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
    } catch (err) {
      showToast('删除会话失败', 'error');
      console.error('Delete session error:', err);
    }
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
  // Show skeleton loading state
  sessionListEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    sessionListEl.appendChild(createSkeleton('session'));
  }

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
let _curUserRowsRef: StoredMsg[] | null = null;
let _curUserRowsCount = 0;
function countUserRows(rows: StoredMsg[]): number {
  if (rows === _curUserRowsRef) return _curUserRowsCount;
  _curUserRowsRef = rows;
  _curUserRowsCount = rows.filter((r) => r.role === 'user' && !isWorkerBlockText(String(r.content ?? ''))).length;
  return _curUserRowsCount;
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Parse toolCalls JSON from an assistant row into id→name→args triples. */
function parseToolCalls(json: string | undefined): ToolCallInfo[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((tc: any) => tc?.id && (tc?.function?.name || tc?.name))
      .map((tc: any) => {
        const rawArgs = tc.function?.args ?? tc.input ?? {};
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        return {
          id: tc.id,
          name: tc.function?.name ?? tc.name ?? 'unknown',
          args: args ?? {}
        };
      });
  } catch {
    return [];
  }
}

/** Render one persisted message row into the history view. */
function renderHistoryRow(m: StoredMsg, toolCallInfoMap?: Map<string, ToolCallInfo>): void {
  if (m.role === 'user') {
    addUser(String(m.content ?? ''), m.id);
  } else if (m.role === 'assistant') {
    if (m.thinking) addThinkingBlock(String(m.thinking));
    const toolCalls = parseToolCalls(m.toolCalls);
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const card = document.createElement('div');
        card.className = 'tool-card collapsed';
        card.dataset.toolCallId = tc.id;
        const header = document.createElement('button');
        header.className = 'tool-header';
        const chevron = document.createElement('span');
        chevron.className = 'tool-chevron';
        chevron.textContent = '▸';
        const name = document.createElement('span');
        name.className = 'tool-name';
        name.textContent = `🔧 ${tc.name}`;
        header.appendChild(chevron);
        header.appendChild(name);
        const args = document.createElement('div');
        args.className = 'tool-args hidden';
        args.textContent = JSON.stringify(tc.args ?? {}, null, 2);
        card.appendChild(header);
        card.appendChild(args);
        messagesEl.appendChild(card);
        header.addEventListener('click', () => {
          const collapsed = card.classList.toggle('collapsed');
          chevron.textContent = collapsed ? '▸' : '▾';
          args.classList.toggle('hidden', collapsed);
          const resultEl = card.querySelector('.tool-result');
          if (resultEl) resultEl.classList.toggle('hidden', collapsed);
        });
      }
    }
    if (m.content) {
      const asst = ensureAssistant();
      asst.buffer = String(m.content).replace(/^[\s\u00a0]+/, '');
      renderAssistantStream(asst);
      asst.stream.classList.remove('streaming');
      curAssistant = null;
    }
  } else if (m.role === 'tool' && m.content) {
    const tcId = String(m.toolCallId ?? '');
    const existingCard = tcId ? messagesEl.querySelector(`[data-tool-call-id="${tcId}"]`) : null;
    if (existingCard) {
      const resultEl = document.createElement('div');
      resultEl.className = 'tool-result hidden';
      resultEl.textContent = String(m.content);
      existingCard.appendChild(resultEl);
    } else {
      const tcInfo = toolCallInfoMap?.get(tcId);
      addToolResultBlock(String(m.content), tcInfo?.name);
    }
  }
}

/** Collapsed tool-result card for restored history rows.
 *  Content hydrates on first expand.
 *  Artifact envelopes skip the collapse entirely and render the preview card. */
function addToolResultBlock(content: string, toolName?: string): void {
  const artifactEl = tryMountArtifact(content);
  if (artifactEl) {
    messagesEl.appendChild(artifactEl);
    return;
  }
  const card = document.createElement('div');
  card.className = 'tool-card collapsed';
  const header = document.createElement('button');
  header.className = 'tool-header';
  const chevron = document.createElement('span');
  chevron.className = 'tool-chevron';
  chevron.textContent = '▸';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = toolName ? `🔧 ${toolName}` : '🔧 tool result';
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
    // /clear entries have no anchorId and must never render as a card — they
    // are pure state mutations. Old log files may still contain them; skip them
    // here to avoid the "append at end" fallback dumping them at the conversation tail.
    if (/^\/clear(?:\s|$)/i.test(e.command)) continue;
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
  const toolCallInfoMap = new Map<string, ToolCallInfo>();
  for (const row of msgItems) {
    if (row.role === 'assistant') {
      for (const tc of parseToolCalls(row.toolCalls)) {
        toolCallInfoMap.set(tc.id, tc);
      }
    }
  }
  for (let i = msgWindowStart; i < msgItems.length; i++) renderHistoryRow(msgItems[i], toolCallInfoMap);
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
  return la.content === lb.content && (la.thinking ?? '') === (lb.thinking ?? '') && (la.toolCalls ?? '') === (lb.toolCalls ?? '');
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

/** Show the blank-slate hint when no session/tab is active (no auto-create). */
function showChatEmpty(): void {
  chatEmptyEl.textContent = t('chatEmptyHint');
  chatEmptyEl.classList.remove('hidden');
  // No session → nothing to freeze; hide the lock and release any stale one.
  freezeBtn.classList.add('hidden');
  setFrozen(false);
}

function hideChatEmpty(): void {
  chatEmptyEl.classList.add('hidden');
  freezeBtn.classList.remove('hidden');
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
  showChatEmpty();
}

// ---------- multi-tab: per-session worker tabs ----------
// Each open tab maps to an independent agent worker process (main-side
// SessionWorkers). Chat/abort/provider/model calls are routed to the active
// tab's session id; events stream in on the tab channel and are only rendered
// when they belong to the currently visible tab, so a background tab can keep
// running without corrupting the focused conversation.

function resetViewState(): void {
  setFrozen(false); // the per-session freeze lives and dies with the session
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

/** Resolve the project directory a tab's worker process should run in: ONLY the
 *  session's recorded projectDir is authoritative. A session WITHOUT a project
 *  binding gets the default project dir — it must never silently inherit another
 *  session's project folder (before, status.cwd leaked the parent project in). */
async function resolveProjectDir(sessionId?: string): Promise<string | undefined> {
  let cwd: string | undefined;
  if (sessionId) {
    try {
      const meta = (await window.nexusDesktop.getSessionMetadata(sessionId)) as Record<string, unknown>;
      const projectDir = (meta.projectDir ?? '') as string;
      if (projectDir) cwd = projectDir;
    } catch {}
  }
  if (!cwd) {
    try {
      const def = (await window.nexusDesktop.getDefaultProjectDir()) as { dir?: string };
      if (def && def.dir) cwd = def.dir;
    } catch {}
  }
  return cwd;
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
    // Bind the session's recorded project directory to its worker process so a
    // tab's chat runs in the session's project dir. For sessions without a
    // saved project dir (e.g. a brand-new tab), inherit the currently-open
    // folder as the worker cwd so the agent can run; but do NOT persist it as
    // projectDir — a new session stays projectDir-less until the user
    // explicitly sets one via Open Project or /setdir.
    let cwd = await resolveProjectDir(sessionId);
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

/** Refresh the "打开项目" cwd label next to the open-folder button. It reflects
 *  ONLY the active session's persisted projectDir (canonical per-session project
 *  field); a session without a binding shows "无项目" instead of inheriting the
 *  live worker cwd / default dir, so a brand-new session is visibly project-less. */
async function syncCwdLabel(): Promise<void> {
  let dir = '';
  if (currentSessionId) {
    try {
      const meta = (await window.nexusDesktop.getSessionMetadata(currentSessionId)) as Record<string, unknown>;
      dir = (meta.projectDir ?? '') as string;
    } catch {}
  }
  cwdLabel.textContent = dir || t('noProject');
  cwdLabel.title = dir || '';
}

/** Activate `sessionId`, rendering its transcript as the visible conversation. */
async function switchTab(sessionId: string): Promise<void> {
  activeTabId = sessionId;
  currentSessionId = sessionId;
  hideChatEmpty();
  resetViewState();
  try {
    const fresh = await window.nexusDesktop.getMessages(sessionId, { last: MSG_WINDOW });
    applyMsgWindow(fresh);
    renderMessageWindow();
    saveMsgCache(sessionId, fresh);
  } catch {}
  await refreshSlashLog(sessionId);
  // Restore parallel execution state from session metadata
  await restoreParallelState(sessionId);
  const tab = tabs.get(sessionId);
  if (tab) {
    status = { cwd: status.cwd, busy: tab.busy, provider: tab.provider, model: tab.model };
  } else {
    try {
      status = await window.nexusDesktop.getStatus({ sessionId });
    } catch {}
  }
  setBusy(Boolean(tab?.busy));
  await syncCwdLabel();
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
      messagesEl.innerHTML = '';
      toolCards.clear();
      tasks.clear();
      renderTasks();
      curAssistant = null;
      curThinking = null;
      showChatEmpty();
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
function truncateId(id: string, maxLen = 8): string {
  return id.length > maxLen ? id.slice(0, maxLen) + '…' : id;
}

function abbreviatePath(p: string, segments = 2): string {
  if (!p) return '';
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= segments) return p;
  return '…' + sep + parts.slice(-segments).join(sep);
}

let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(msg: string, type?: 'success' | 'error' | 'warning', duration = 3000): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'nexus-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.className = 'nexus-toast';
  if (type) toastEl.classList.add(type);
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove('show');
  }, duration);
}

function wireCopy(el: HTMLElement, getText: () => string, msg: () => string): void {
  el.addEventListener('click', async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(msg());
    } catch { /* ignore */ }
  });
}

function makeMsgCopyBtn(getText: string | (() => string)): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'msg-copy-btn';
  btn.type = 'button';
  btn.title = t('copy');
  btn.textContent = t('copy');
  btn.addEventListener('click', async () => {
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = t('copied');
      showToast('已复制到剪贴板');
      setTimeout(() => { btn.textContent = t('copy'); }, 1200);
    } catch {
      showToast('复制失败');
    }
  });
  return btn;
}

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
  rsideSessionId.textContent = currentSessionId ? truncateId(currentSessionId) : '—';
  rsideSessionId.title = currentSessionId || '';
  // Project Directory row reflects the session's recorded projectDir (the
  // canonical project field), left blank when the session has none.
  let projDir = '';
  try {
    const meta = (await window.nexusDesktop.getSessionMetadata(currentSessionId)) as Record<string, unknown>;
    projDir = (meta.projectDir ?? '') as string;
  } catch {
    projDir = '';
  }
  rsideCwd.textContent = projDir ? abbreviatePath(projDir) : '';
  rsideCwd.title = projDir || '';
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

wireCopy(rsideSessionId, () => currentSessionId, () => t('copiedSessionId'));
wireCopy(rsideCwd, () => rsideCwd.title || '', () => t('copiedProjectDir'));

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
  if (!hasTasks) {
    taskListEl.innerHTML = '';
    return;
  }

  // Incremental update: reuse existing DOM nodes where possible
  const existing = taskListEl.querySelectorAll('.task-item');
  const existingMap = new Map<string, HTMLDivElement>();
  for (let i = 0; i < existing.length; i++) {
    const el = existing[i] as HTMLDivElement;
    if (el.dataset.taskId) existingMap.set(el.dataset.taskId, el);
  }

  const fragment = document.createDocumentFragment();
  const usedIds = new Set<string>();

  for (const item of items) {
    usedIds.add(item.id);
    let li = existingMap.get(item.id);

    if (!li) {
      // New task: create node structure
      li = document.createElement('div');
      li.className = 'task-item';
      li.dataset.taskId = item.id;
      const badge = document.createElement('span');
      badge.className = 'task-badge';
      const body = document.createElement('div');
      body.className = 'task-body';
      const title = document.createElement('div');
      title.className = 'task-title';
      const meta = document.createElement('div');
      meta.className = 'task-meta';
      body.appendChild(title);
      body.appendChild(meta);
      li.appendChild(badge);
      li.appendChild(body);
    }

    // Update content (always, since status may change)
    const badge = li.querySelector('.task-badge')!;
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

    const title = li.querySelector('.task-title') as HTMLDivElement;
    title.textContent = item.description || item.id;
    title.title = item.description || '';

    const meta = li.querySelector('.task-meta') as HTMLDivElement;
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

    fragment.appendChild(li);
  }

  // Remove tasks that no longer exist
  for (const [id, el] of existingMap) {
    if (!usedIds.has(id)) el.remove();
  }

  taskListEl.innerHTML = '';
  taskListEl.appendChild(fragment);
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

// ---------- parallel execution rendering ----------
function renderParallelCard(session: ParallelSession): void {
  if (!parallelCardEl) {
    parallelCardEl = document.createElement('div');
    parallelCardEl.className = 'parallel-execution-card';
    parallelCardEl.style.cssText = `
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px;
      margin: 8px 0;
      background-color: #f9fafb;
    `;
    messagesEl.appendChild(parallelCardEl);
  }

  const header = document.createElement('div');
  header.style.cssText = `
    font-weight: bold;
    margin-bottom: 12px;
    color: #374151;
  `;
  header.textContent = `🔄 ${getUiLang() === 'zh-CN' ? '并行执行中...' : 'Parallel execution...'}`;
  parallelCardEl.appendChild(header);

  const tasksContainer = document.createElement('div');
  tasksContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
  
  for (const [taskId, taskData] of session.tasks) {
    const card = document.createElement('div');
    card.innerHTML = ParallelExecutionCard({
      taskId,
      description: taskData.description,
      status: taskData.status as any,
      output: taskData.output,
      durationMs: taskData.durationMs,
      error: taskData.error,
    });
    tasksContainer.appendChild(card.firstElementChild!);
  }

  parallelCardEl.appendChild(tasksContainer);
  scrollToBottom();
}

/**
 * Restore parallel execution state from session metadata.
 * Called when switching to a session that has an in-progress parallel execution.
 */
async function restoreParallelState(sessionId: string): Promise<void> {
  try {
    const meta = (await window.nexusDesktop.getSessionMetadata(sessionId)) as Record<string, unknown>;
    const parallelState = meta.parallelExecution as {
      prompt: string;
      tasks: Array<{ id: string; description: string; status: string; prompt: string }>;
      startTime: number;
    } | undefined;
    
    if (parallelState?.tasks && parallelState.tasks.length > 0) {
      // Create a parallel session from metadata
      const session: ParallelSession = {
        sessionId,
        prompt: parallelState.prompt,
        startTime: parallelState.startTime,
        tasks: new Map(),
      };
      
      for (const task of parallelState.tasks) {
        session.tasks.set(task.id, {
          description: task.description,
          status: task.status,
        });
      }
      
      parallelSessions.set(sessionId, session);
      renderParallelCard(session);
    }
  } catch (err) {
    // Ignore metadata read errors
  }
}

function handleParallelStart(
  sessionId: string, 
  prompt: string, 
  taskList?: Array<{ id: string; description: string; status: string }>
): void {
  const session: ParallelSession = {
    sessionId,
    prompt,
    startTime: Date.now(),
    tasks: new Map(),
  };
  
  // Store task descriptions if provided
  if (taskList) {
    for (const task of taskList) {
      session.tasks.set(task.id, {
        description: task.description,
        status: task.status,
      });
    }
  }
  
  parallelSessions.set(sessionId, session);
  renderParallelCard(session);
}

function handleParallelEnd(sessionId: string, tasks: SubTaskResult[]): void {
  const session = parallelSessions.get(sessionId);
  if (!session) return;

  for (const task of tasks) {
    session.tasks.set(task.taskId, {
      status: task.status,
      output: task.output,
      error: task.error,
      durationMs: task.durationMs,
    });
  }

  // Update the card with final results
  if (parallelCardEl) {
    parallelCardEl.innerHTML = '';
    const header = document.createElement('div');
    header.style.cssText = `
      font-weight: bold;
      margin-bottom: 12px;
      color: #10b981;
    `;
    header.textContent = `✅ ${getUiLang() === 'zh-CN' ? '并行执行完成' : 'Parallel execution completed'}`;
    parallelCardEl.appendChild(header);

    const tasksContainer = document.createElement('div');
    tasksContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
    
    for (const task of tasks) {
      const card = document.createElement('div');
      card.innerHTML = ParallelExecutionCard({
        taskId: task.taskId,
        status: task.status,
        output: task.output,
        durationMs: task.durationMs,
        error: task.error,
      });
      tasksContainer.appendChild(card.firstElementChild!);
    }

    parallelCardEl.appendChild(tasksContainer);
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = getUiLang() === 'zh-CN' ? '关闭' : 'Close';
    closeBtn.style.cssText = `
      margin-top: 12px;
      padding: 6px 12px;
      background-color: #e5e7eb;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    closeBtn.addEventListener('click', () => {
      parallelCardEl?.remove();
      parallelCardEl = null;
      parallelSessions.delete(sessionId);
    });
    parallelCardEl.appendChild(closeBtn);
  }
}

function handleParallelError(sessionId: string, error: string): void {
  const session = parallelSessions.get(sessionId);
  if (!session) return;

  if (parallelCardEl) {
    parallelCardEl.innerHTML = '';
    const header = document.createElement('div');
    header.style.cssText = `
      font-weight: bold;
      margin-bottom: 12px;
      color: #ef4444;
    `;
    header.textContent = `❌ ${getUiLang() === 'zh-CN' ? '并行执行失败' : 'Parallel execution failed'}`;
    parallelCardEl.appendChild(header);

    const errorMsg = document.createElement('div');
    errorMsg.style.cssText = 'color: #dc2626; margin-bottom: 12px;';
    errorMsg.textContent = error;
    parallelCardEl.appendChild(errorMsg);
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = getUiLang() === 'zh-CN' ? '关闭' : 'Close';
    closeBtn.style.cssText = `
      padding: 6px 12px;
      background-color: #e5e7eb;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    `;
    closeBtn.addEventListener('click', () => {
      parallelCardEl?.remove();
      parallelCardEl = null;
      parallelSessions.delete(sessionId);
    });
    parallelCardEl.appendChild(closeBtn);
  }
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
    if (servers.length === 0) {
      mcpServersEl.innerHTML = `<div class="mcp-empty">${t('noMcpServers')}</div>`;
      return;
    }
    mcpServersEl.innerHTML = '';
    // Built-in (in-process) servers are grouped into their own area so they
    // read as one coherent block instead of being scattered among external ones.
    const builtin = servers.filter((s) => s.internal === true).sort((a, b) => a.name.localeCompare(b.name));
    const external = servers.filter((s) => s.internal !== true).sort((a, b) => a.name.localeCompare(b.name));
    const renderSection = (label: string, list: typeof servers, maybeBg = false) => {
      if (list.length === 0) return;
      const head = document.createElement('div');
      head.className = 'mcp-section' + (maybeBg ? ' mcp-section--shaded' : '');
      head.textContent = label;
      mcpServersEl.appendChild(head);
      for (const s of list) mcpServersEl.appendChild(renderMcpServerRow(s));
    };
    renderSection(t('builtinMcp'), builtin);
    renderSection(t('mcpSection'), external, true);
  } catch {
    mcpServersEl.innerHTML = `<div class="mcp-loading">${t('mcpLoadFailed')}</div>`;
  }
}

function renderMcpServerRow(s: NonNullable<Awaited<ReturnType<typeof window.nexusDesktop.getMcpServers>>>[number]): HTMLElement {
  const internal = s.internal === true;
  const prefs = currentSessionId ? sessionPrefs(currentSessionId) : {};
  const row = document.createElement('label');
  row.className = 'mcp-server-row' + (internal ? ' mcp-server-row--internal' : '');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = internal ? true : prefs[s.name] ?? s.autoStart;
  // Built-in servers are always active and cannot be disabled; render them
  // as a permanently-checked, non-interactive row.
  cb.disabled = internal;
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
  if (internal) {
    const badge = document.createElement('span');
    badge.className = 'mcp-badge';
    badge.textContent = t('builtinMcp');
    name.appendChild(badge);
  }
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
  return row;
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
      // Defer drain() to the next microtask so that session_end events
      // (which arrive via IPC in the same tick) have a chance to call
      // setBusy(false) first. Without this, drain() fires synchronously
      // and can reset busy before the session_end handler runs, causing
      // the send button to reappear while the agent is still streaming.
      void Promise.resolve().then(() => drain());
    }
  })();
}

async function sendMessage(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text && attachments.length === 0) return;
  // /new — desktop shortcut equal to the core command: open a brand-new empty
  // tab that inherits the current session's project dir + project memory.
  // Intercepted locally so the fresh session gets its own worker/tab and the
  // tab ceiling is checked before anything is created (CLI /new is untouched).
  if (/^\/new\s*$/i.test(text)) {
    inputEl.value = '';
    if (currentSessionId) clearDraft(currentSessionId);
    attachments = [];
    renderAttachments();
    await handleNewCommand();
    return;
  }
  // With no active session/tab (blank slate), the user's first message starts a
  // real session — creation is still user-triggered, never automatic on boot/close.
  if (!currentSessionId || tabs.size === 0) {
    await startNewSession();
    if (!currentSessionId) return;
  }
  const attrs = attachments;
  attachments = [];
  renderAttachments();
  const composed = attrs.map((p) => `@${p}`).concat(text ? [text] : []).join('\n');
  clearDraft(currentSessionId);
  enqueue(composed);
}

/** Desktop handling for "/new": create a brand-new session in its own worker via
 *  openNewSession (which inherits the current session's projectDir + project
 *  memory in the new worker process), then open it as a fresh tab. When the tab
 *  ceiling is reached, tell the user to close idle tabs instead of creating. */
async function handleNewCommand(): Promise<void> {
  let max = 5;
  try {
    max = await window.nexusDesktop.getMaxTabs();
  } catch {}
  if (tabs.size >= max) {
    addSystem(t('tabsMaxReachedCloseIdle', { max }));
    return;
  }
  const prevSessionId = currentSessionId || undefined;
  const cwd = await resolveProjectDir(prevSessionId);
  let res: { ok: boolean; sessionId?: string; reason?: string };
  try {
    res = await window.nexusDesktop.openNewSession({ cwd, prevSessionId });
  } catch (err) {
    addSystem(`${t('tabsOpenFailed')}${errText(err)}`);
    return;
  }
  if (!res.ok || !res.sessionId) {
    if (res.reason === 'max-tabs') addSystem(t('tabsMaxReachedCloseIdle', { max }));
    else if (res.reason === 'overloaded') addSystem(t('tabsOverloaded'));
    else addSystem(`${t('tabsOpenFailed')}${res.reason ?? ''}`);
    return;
  }
  // openTab resolves the new session to the worker that openNewSession just
  // bound, so no second worker is spawned — it just focuses the new tab.
  tabNames.set(res.sessionId, res.sessionId);
  await openTab(res.sessionId);
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
    // Same deferred drain as in drain() — wait for session_end to arrive.
    void Promise.resolve().then(() => drain());
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
    trapFocus(permOverlay.querySelector('.modal')!);
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
  container?: HTMLElement;
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
  (opts.container || settingsBody).appendChild(row);
}

function buildSettings(providersList: ProviderInfo[]): void {
  settingsBody.innerHTML = '';

  // Create settings navigation tabs
  const nav = document.createElement('div');
  nav.className = 'settings-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', '设置导航');

  const sections = [
    { id: 'providers', label: t('providers') || '模型' },
    { id: 'speech', label: t('speechSection') || '语音' },
    { id: 'vision', label: t('visionSection') || '视觉' },
    { id: 'startup', label: t('startupSection') || '启动' },
    { id: 'resource', label: t('resourceSection') || '资源' },
    { id: 'appearance', label: t('appearanceSection') || '外观' },
    { id: 'update', label: t('updateSection') || '更新' },
  ];

  const contentArea = document.createElement('div');
  contentArea.className = 'settings-content';
  contentArea.style.flex = '1';

  const sectionElements: Record<string, HTMLElement> = {};

  sections.forEach((section, index) => {
    const navItem = document.createElement('button');
    navItem.className = `settings-nav-item ${index === 0 ? 'active' : ''}`;
    navItem.textContent = section.label;
    navItem.setAttribute('role', 'tab');
    navItem.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    navItem.dataset.section = section.id;

    const sectionEl = document.createElement('div');
    sectionEl.className = 'settings-section';
    sectionEl.id = `settings-section-${section.id}`;
    sectionEl.setAttribute('role', 'tabpanel');
    sectionEl.style.display = index === 0 ? 'block' : 'none';
    sectionElements[section.id] = sectionEl;

    navItem.addEventListener('click', () => {
      Object.values(sectionElements).forEach((el) => (el.style.display = 'none'));
      nav.querySelectorAll('.settings-nav-item').forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
      });
      navItem.classList.add('active');
      navItem.setAttribute('aria-selected', 'true');
      sectionEl.style.display = 'block';
    });

    nav.appendChild(navItem);
    contentArea.appendChild(sectionEl);
  });

  settingsBody.appendChild(nav);
  settingsBody.appendChild(contentArea);

  // Build providers section
  const providersSection = sectionElements['providers'];
  for (const p of providersList) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.dataset.kind = p.name;
    const title = document.createElement('div');
    title.className = 'provider-title';
    title.textContent = p.name;
    row.appendChild(title);
    const fields = document.createElement('div');
    fields.className = 'provider-fields';

    const baseUrlLabel = document.createElement('label');
    baseUrlLabel.textContent = 'Base URL';
    const baseUrlInput = document.createElement('input');
    baseUrlInput.type = 'text';
    baseUrlInput.className = 'provider-field';
    baseUrlInput.dataset.field = 'baseUrl';
    baseUrlInput.value = p.baseUrl || '';
    baseUrlInput.placeholder = 'https://api.example.com/v1';

    const apiKeyLabel = document.createElement('label');
    apiKeyLabel.textContent = 'API Key';
    const apiKeyInput = document.createElement('input');
    apiKeyInput.type = 'password';
    apiKeyInput.className = 'provider-field';
    apiKeyInput.dataset.field = 'apiKey';
    apiKeyInput.value = p.hasKey ? '••••••••' : '';
    apiKeyInput.placeholder = p.hasKey ? '已设置' : '输入 API Key';

    fields.appendChild(baseUrlLabel);
    fields.appendChild(baseUrlInput);
    fields.appendChild(apiKeyLabel);
    fields.appendChild(apiKeyInput);
    row.appendChild(fields);
    providersSection.appendChild(row);
  }

  // Build speech section
  const speechSection = sectionElements['speech'];
  const speechTitle = document.createElement('div');
  speechTitle.className = 'settings-section-title';
  speechTitle.textContent = t('speechSection');
  speechSection.appendChild(speechTitle);

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
      container: speechSection,
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
      container: speechSection,
    });
  }

  // Build vision section
  const visionSection = sectionElements['vision'];
  const visionTitle = document.createElement('div');
  visionTitle.className = 'settings-section-title';
  visionTitle.textContent = t('visionSection');
  visionSection.appendChild(visionTitle);
  if (svConfig.visionProviders.length > 0) {
    buildModelRow({
      className: 'vision-row',
      dataKind: 'vision',
      dataRole: 'vision',
      title: t('visionLabel'),
      providers: svConfig.visionProviders,
      activeName: svConfig.activeVision,
      container: visionSection,
    });
  }

  // Build startup section
  const startupSection = sectionElements['startup'];
  buildStartupSection(startupSection);

  // Build resource section
  const resourceSection = sectionElements['resource'];
  buildResourceSection(resourceSection);

  // Build appearance section
  const appearanceSection = sectionElements['appearance'];
  buildAppearanceSection(appearanceSection);

  // Build update section
  const updateSection = sectionElements['update'];
  buildUpdateSection(updateSection);
}

function buildStartupSection(container?: HTMLElement): void {
  const target = container || settingsBody;
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('startupSection');
  target.appendChild(title);

  buildToggle(t('deferMcpLabel'), t('deferMcpHint'), window.nexusDesktop.getDeferMcp(), (v) => {
    settingsMsg.textContent = v ? t('deferMcpEnabled') : t('deferMcpDisabled');
    return window.nexusDesktop.setDeferMcp(v);
  }, target);
  buildToggle(t('minimizeToTrayLabel'), t('minimizeToTrayHint'), window.nexusDesktop.getMinimizeToTray(), (v) => {
    return window.nexusDesktop.setMinimizeToTray(v);
  }, target);
  buildToggle(t('restoreSessionLabel'), t('restoreSessionHint'), window.nexusDesktop.getRestoreSessionOnLaunch(), (v) => {
    settingsMsg.textContent = v ? t('restoreSessionEnabled') : t('restoreSessionDisabled');
    return window.nexusDesktop.setRestoreSessionOnLaunch(v);
  }, target);
}

/** Render a labeled checkbox settings row that persists immediately on change. */
function buildToggle(
  labelText: string,
  hintText: string,
  initial: Promise<boolean> | boolean,
  onToggle: (v: boolean) => Promise<unknown> | void,
  container?: HTMLElement,
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
  (container || settingsBody).appendChild(row);
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

function buildResourceSection(container?: HTMLElement): void {
  const target = container || settingsBody;
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('resourceSection');
  target.appendChild(title);

  buildToggle(t('monitorEnabledLabel'), t('monitorEnabledHint'), window.nexusDesktop.getMonitorEnabled(), (v) => {
    return window.nexusDesktop.setMonitorEnabled(v);
  }, target);
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

    // Process-level metrics (optional)
    if (typeof s.processMemoryMb === 'number' && s.processMemoryMb > 0) {
      const procLabel = span('rres-label', 'Proc');
      const procVal = span('rres-val', `${s.processMemoryMb} MB`);
      el.append(span('rres-sep', '·'), procLabel, procVal);
    }
    if (typeof s.workerCount === 'number' && s.workerCount > 1) {
      const workerLabel = span('rres-label', 'Workers');
      const workerVal = span('rres-val', String(s.workerCount));
      el.append(span('rres-sep', '·'), workerLabel, workerVal);
    }
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

function buildAppearanceSection(container?: HTMLElement): void {
  const target = container || settingsBody;
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('appearanceSection');
  target.appendChild(title);

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
  target.appendChild(row);
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
function buildUpdateSection(container?: HTMLElement): void {
  const target = container || settingsBody;
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('updateSection');
  target.appendChild(title);

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
  target.appendChild(wrap);
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
  trapFocus(settingsOverlay.querySelector('.modal')!);
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
  // Apply to the active session's worker (not just the global worker) so the
  // agent's cwd immediately matches the opened project dir for the next turn.
  await window.nexusDesktop.setCwd(res.path, { sessionId: currentSessionId || undefined });
  // Persist the user-selected folder as the session's projectDir — but ONLY for
  // sessions that have no project binding yet. Once projectDir is set, the only
  // way to rebind is the explicit /setdir <path> command; a folder pick here
  // still switches the worker cwd now, but must not silently clobber the
  // session's canonical project binding.
  if (currentSessionId) {
    try {
      const meta = (await window.nexusDesktop.getSessionMetadata(currentSessionId)) as Record<string, unknown>;
      if (!meta.projectDir) {
        await window.nexusDesktop.setSessionMetadata(currentSessionId, { projectDir: res.path });
      }
    } catch {}
  }
  status = await window.nexusDesktop.getStatus({ sessionId: currentSessionId || undefined });
  cwdLabel.textContent = status.cwd;
  cwdLabel.title = status.cwd;
  addSystem(t('projectDir', { cwd: status.cwd }));
  // Force the right-side panel (project row rsideCwd) to refresh immediately;
  // without this the newly-bound projectDir only shows after switching workers.
  void refreshSidebarSession();
  void syncCwdLabel();
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

// Ctrl+. toggles the viewport freeze (Ctrl+Space is taken by IMEs, so avoid
// it). Works across the whole session — while streaming or idle, and the lock
// survives new messages/turns until toggled off or the session is switched.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '.') {
    e.preventDefault();
    if (currentSessionId) setFrozen(!frozen);
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

// Alt+V (matches coder-core): paste the system clipboard image as an attachment.
// A keyboard shortcut — NOT a DOM paste event — so it needs its own keydown hook.
let lastImagePasteAt = 0;
const IMAGE_PASTE_DEBOUNCE_MS = 1500;

inputEl.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'v' || !e.altKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  const now = Date.now();
  if (now - lastImagePasteAt < IMAGE_PASTE_DEBOUNCE_MS) return;
  lastImagePasteAt = now;
  void window.nexusDesktop
    .pasteImage()
    .then((result) => {
      if (result) {
        void attachFiles([result.path]);
        showToast(t('clipboardImageAdded'));
      } else {
        showToast(t('clipboardImageMissing'));
      }
    })
    .catch(() => {});
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
  if (files.length > 0) {
    e.preventDefault();
    const paths = files.map((f) => window.nexusDesktop.getPathForFile(f)).filter(Boolean);
    if (paths.length > 0) void attachFiles(paths);
    return;
  }
  // Native clipboard image (e.g. screenshots via Win+Shift+S) isn't exposed as
  // clipboardData.files, so poll the clipboard via the main process. Matches
  // coder-core's ALT+V behavior. No preventDefault: an image-only clipboard has
  // no text to insert anyway, and a text paste must keep its default flow.
  const types = Array.from(e.clipboardData?.types ?? []);
  const looksLikeImage = types.length === 0 || types.some((t) => t.startsWith('image/'));
  if (looksLikeImage) {
    void window.nexusDesktop
      .pasteImage()
      .then((result) => {
        if (result) void attachFiles([result.path]);
      })
      .catch(() => {});
  }
});

// ---------- wire events ----------
window.nexusDesktop.onEvent((event) => {
  handleEvent(event);
  notifySidebarSubscribers(event);
});
window.nexusDesktop.onEvents((events) => {
  for (const e of events) {
    handleEvent(e);
    notifySidebarSubscribers(e);
  }
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
  providers = provs;
  refreshProviderSelect();
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
    addSkipLink();
    await loadLanguage();
    showOnboarding();
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
      }
    }
    // When no session/tab was restored or created (restore off, or on with no
    // saved tabs), show the blank-slate hint — never auto-create a session here.
    if (!currentSessionId || tabs.size === 0) showChatEmpty();
    // When shouldRestore is false, stay on blank slate — no session created.
    await refreshSessions();
    await refreshSidebarSession();
    await syncOpenTabs();
    // P1: register built-in sidebar tabs (Sub-Agents flagship + terminal,
    // side-chat, Git) and render the tab bar. The registry is the single
    // extension surface; third-party tabs attach the same way.
    sidebarRegistry.register({
      id: SubAgentsPage.id,
      title: SubAgentsPage.title,
      icon: SubAgentsPage.icon,
      mount: mountSubAgentsPage,
    });
    sidebarRegistry.register({
      id: TerminalPage.id,
      title: TerminalPage.title,
      icon: TerminalPage.icon,
      mount: mountTerminalPage,
    });
    sidebarRegistry.register({
      id: SideChatPage.id,
      title: SideChatPage.title,
      icon: SideChatPage.icon,
      mount: mountSideChatPage,
    });
    sidebarRegistry.register({
      id: GitPage.id,
      title: GitPage.title,
      icon: GitPage.icon,
      mount: mountGitPage,
    });
    renderSidebarTabs();
    await initResourcePanel();
    // Open the resumed session in its own tab so it runs in a per-session worker.
    if (currentSessionId && !tabs.has(currentSessionId)) await openTab(currentSessionId);
    renderTabBar();
  } catch (err) {
    addSystem(`${t('startFailed')}${errText(err)}`);
  }
})();
