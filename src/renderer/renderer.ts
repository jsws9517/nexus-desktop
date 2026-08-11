/// <reference lib="dom" />

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
  role: string;
  content?: string;
  thinking?: string;
}

type AgentEvent =
  | { type: 'session_start'; sessionId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_call_start'; index: number; name: string; args: Record<string, unknown> }
  | { type: 'tool_call_end'; index: number; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; index: number; name: string; content: string; isError?: boolean }
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
  | { type: 'task_failed'; taskId: string; error: string };

declare global {
  interface Window {
    nexusDesktop: {
      chat(input: string): Promise<unknown>;
      abort(): Promise<unknown>;
      startSession(name?: string, sessionId?: string): Promise<string>;
      listSessions(options?: { limit?: number; offset?: number }): Promise<{ items: SessionInfo[]; total: number }>;
      getMessages(
        sessionId: string,
        options?: { last?: number; limit?: number; offset?: number },
      ): Promise<{ items: StoredMsg[]; total: number; userBefore: number }>;
      deleteSession(id: string): Promise<unknown>;
      renameSession(id: string, name: string): Promise<unknown>;
      getConfig(): Promise<Record<string, unknown>>;
      getProviders(): Promise<ProviderInfo[]>;
      getStatus(): Promise<StatusInfo>;
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
      switchProvider(name: string): Promise<unknown>;
      switchModel(modelId: string): Promise<unknown>;
      getModels(providerName?: string): Promise<string[]>;
      saveProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      openConfigWeb(): Promise<{ ok: boolean; port?: number; error?: string }>;
      setCwd(cwd: string): Promise<unknown>;
      openFolder(): Promise<{ canceled: boolean; path?: string }>;
      openFile(): Promise<{ canceled: boolean; path?: string }>;
      regenerate(sessionId: string, userIndex: number): Promise<unknown>;
      withdraw(sessionId: string, userIndex: number): Promise<string>;
      respondPermission(id: string, answer: string): Promise<unknown>;
      setMcpEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      getMcpStatus(): Promise<{ enabled: boolean; servers: McpServerStatus[] }>;
      getMcpServers(): Promise<Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string; stderr?: string }>>;
      setMcpServer(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      getDeferMcp(): Promise<boolean>;
      setDeferMcp(enabled: boolean): Promise<{ ok: boolean }>;
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
      onUpdateState(cb: (state: Record<string, unknown>) => void): void;
    };
  }
}

// ---------- element helpers ----------
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const messagesEl = $('#messages');
const inputEl = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#btn-send');
const stopBtn = $('#btn-stop');
const freezeBtn = $('#btn-freeze') as HTMLButtonElement;
const sessionListEl = $('#session-list');
const sessionPagerEl = $('#session-pager');
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
const rsideToken = $('#rside-token');
const rsideSpeech = $('#rside-speech');
const rsideVision = $('#rside-vision');
const taskListEl = $('#task-list');
const taskEmptyEl = $('#task-empty');

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
let curAssistant: { bubble: HTMLElement; stream: HTMLElement; buffer: string } | null = null;
let curThinking: { content: HTMLElement; buffer: string } | null = null;
interface ToolCardRec {
  card: HTMLElement;
  resultEl: HTMLElement | null;
  resultText: string;
}
const toolCards = new Map<number, ToolCardRec>();

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

// ---------- i18n (syncs with core config language) ----------
type Lang = 'en' | 'zh-CN';
let uiLang: Lang = 'zh-CN';

const STR: Record<string, { 'zh-CN': string; en: string }> = {
  openProject: { 'zh-CN': '📁 打开项目', en: '📁 Open Project' },
  noProject: { 'zh-CN': '未选择项目', en: 'No project selected' },
  settings: { 'zh-CN': '⚙️ 设置', en: '⚙️ Settings' },
  sessions: { 'zh-CN': '会话', en: 'Sessions' },
  newSession: { 'zh-CN': '＋ 新建', en: '＋ New' },
  attach: { 'zh-CN': '📎', en: '📎' },
  attachTitle: { 'zh-CN': '添加附件', en: 'Attach files' },
  mcpMasterTitle: { 'zh-CN': '主开关：启用/禁用全部 MCP 工具', en: 'Master switch: enable/disable all MCP tools' },
  mcpPickTitle: { 'zh-CN': '选择 MCP 服务器工具', en: 'Select MCP server tools' },
  mcpPopoverTitle: { 'zh-CN': 'MCP 服务器工具（当前会话）', en: 'MCP server tools (current session)' },
  inputPlaceholder: { 'zh-CN': '输入消息，Enter 发送，Shift+Enter 换行…', en: 'Type a message, Enter to send…' },
  send: { 'zh-CN': '发送', en: 'Send' },
  stop: { 'zh-CN': '停止', en: 'Stop' },
  regenerate: { 'zh-CN': '重新生成', en: 'Regenerate' },
  stopped: { 'zh-CN': '已停止', en: 'Stopped' },
  stopping: { 'zh-CN': '正在停止…', en: 'Stopping…' },
  sessionInfo: { 'zh-CN': '会话信息', en: 'Session Info' },
  permMode: { 'zh-CN': '权限模式', en: 'Permission' },
  activeMcp: { 'zh-CN': '活跃 MCP', en: 'Active MCP' },
  tokenUsage: { 'zh-CN': 'Token 用量', en: 'Token Usage' },
  speechModel: { 'zh-CN': '语音模型', en: 'Speech' },
  visionModel: { 'zh-CN': '视觉模型', en: 'Vision' },
  none: { 'zh-CN': '无', en: 'None' },
  toolsCount: { 'zh-CN': '{n} 工具', en: '{n} tools' },
  mcpDisabled: { 'zh-CN': '关闭', en: 'Disabled' },
  mcpCount: { 'zh-CN': '{n} 台', en: '{n}' },
  taskProgress: { 'zh-CN': '任务进展', en: 'Task Progress' },
  noTasks: { 'zh-CN': '暂无任务', en: 'No tasks' },
  running: { 'zh-CN': '进行中 · {role}', en: 'Running · {role}' },
  pending: { 'zh-CN': '待处理', en: 'Pending' },
  cancelled: { 'zh-CN': '已取消', en: 'Cancelled' },
  completed: { 'zh-CN': '已完成', en: 'Completed' },
  failed: { 'zh-CN': '失败：{error}', en: 'Failed: {error}' },
  thinkingDot: { 'zh-CN': '💭 思考中…', en: '💭 Thinking…' },
  collapseThinking: { 'zh-CN': '💭 收起思考', en: '💭 Collapse' },
  thought: { 'zh-CN': '💭 思考', en: '💭 Thought' },
  noMcpServers: { 'zh-CN': '未配置 MCP 服务器', en: 'No MCP servers configured' },
  mcpLoadFailed: { 'zh-CN': '加载失败', en: 'Failed to load' },
  mcpFailed: { 'zh-CN': '失败', en: 'Failed' },
  mcpNotConnected: { 'zh-CN': '未连接', en: 'Not connected' },
  sessionCreated: { 'zh-CN': '新会话已创建。发送消息开始对话。', en: 'New session created. Send a message to start.' },
  sessionRestored: { 'zh-CN': '已恢复会话', en: 'Session restored' },
  noProviderConfigured: { 'zh-CN': '未配置 Provider。点击右上角 ⚙️ 设置填写 API Key。', en: 'No provider configured. Click ⚙️ Settings to add an API key.' },
  startFailed: { 'zh-CN': '启动失败: ', en: 'Failed to start: ' },
  error: { 'zh-CN': '⚠️ 错误: ', en: '⚠️ Error: ' },
  attachFailed: { 'zh-CN': '⚠️ 附件失败: ', en: '⚠️ Attach failed: ' },
  runningEllipsis: { 'zh-CN': '运行中…', en: 'Running…' },
  freeze: { 'zh-CN': '❄ 冻结视图', en: '❄ Freeze' },
  unfreeze: { 'zh-CN': '▶ 恢复视图', en: '▶ Resume' },
  queued: { 'zh-CN': '⏳ 排队：{n} 条待发…', en: '⏳ Queued: {n} pending…' },
  rename: { 'zh-CN': '重命名', en: 'Rename' },
  delete: { 'zh-CN': '删除', en: 'Delete' },
  renameSession: { 'zh-CN': '重命名会话', en: 'Rename Session' },
  pagerPrev: { 'zh-CN': '‹ 上一页', en: '‹ Prev' },
  pagerNext: { 'zh-CN': '下一页 ›', en: 'Next ›' },
  loadEarlier: { 'zh-CN': '↑ 加载更早的消息', en: '↑ Load earlier messages' },
  undo: { 'zh-CN': '撤回', en: 'Undo' },
  undoHint: {
    'zh-CN': '撤回该消息及其后的上下文，并把原文贴回输入框修改',
    en: 'Withdraw this message and everything after it, then edit & resubmit',
  },
  undoAsk: {
    'zh-CN': '撤回该消息及其后的上下文？原文会贴回输入框供你修改。',
    en: 'Withdraw this message and everything after it? The text will be put back in the input box for editing.',
  },
  themeLabel: { 'zh-CN': '主题', en: 'Theme' },
  themeDark: { 'zh-CN': '深色', en: 'Dark' },
  themeWarm: { 'zh-CN': '暖色护眼', en: 'Warm' },
  pagerInfo: { 'zh-CN': '{page} / {pages} 页（共 {total}）', en: 'Page {page}/{pages} of {total}' },
  sessionNamePh: { 'zh-CN': '会话名称', en: 'Session name' },
  deleteConfirm: { 'zh-CN': '删除会话 "{name}"?', en: 'Delete session "{name}"?' },
  confirm: { 'zh-CN': '确认', en: 'Confirm' },
  cancel: { 'zh-CN': '取消', en: 'Cancel' },
  ok: { 'zh-CN': '确定', en: 'OK' },
  permRequired: { 'zh-CN': '权限确认', en: 'Permission Required' },
  allow: { 'zh-CN': '允许', en: 'Allow' },
  deny: { 'zh-CN': '拒绝', en: 'Deny' },
  saved: { 'zh-CN': '已保存', en: 'Saved' },
  save: { 'zh-CN': '保存', en: 'Save' },
  apiKey: { 'zh-CN': 'API Key', en: 'API Key' },
  model: { 'zh-CN': '模型', en: 'Model' },
  baseUrlOptional: { 'zh-CN': 'Base URL（可选）', en: 'Base URL (optional)' },
  type: { 'zh-CN': '类型', en: 'Type' },
  apiKeyKeep: { 'zh-CN': '••••••••••••（留空保持不变）', en: '•••••••••••• (leave blank to keep)' },
  apiKeyEnter: { 'zh-CN': '输入 API Key', en: 'Enter API Key' },
  activeNow: { 'zh-CN': '● 当前', en: '● Active' },
  switchedProvider: { 'zh-CN': '已切换到 Provider: {name}（{model}）', en: 'Switched to Provider: {name} ({model})' },
  modelLabel: { 'zh-CN': 'Model', en: 'Model' },
  switchedModel: { 'zh-CN': '已切换到模型: {name}（{from} → {to}）', en: 'Switched model: {name} ({from} → {to})' },
  projectDir: { 'zh-CN': '📁 项目目录: {cwd}', en: '📁 Project directory: {cwd}' },
  advancedConfig: { 'zh-CN': '打开完整配置', en: 'Open full config' },
  speechSection: { 'zh-CN': '语音模型 Speech', en: 'Speech Models' },
  visionSection: { 'zh-CN': '视觉模型 Vision', en: 'Vision Models' },
  sttLabel: { 'zh-CN': '语音识别 STT', en: 'Speech-to-Text (STT)' },
  ttsLabel: { 'zh-CN': '语音合成 TTS', en: 'Text-to-Speech (TTS)' },
  visionLabel: { 'zh-CN': '视觉分析', en: 'Vision Analysis' },
  active: { 'zh-CN': '当前激活', en: 'Active' },
  tokenEstimated: { 'zh-CN': '{n}（估算）', en: '{n} (est.)' },
  tokenMsgHint: { 'zh-CN': '约 {n} 条消息', en: '~{n} messages' },
  languageLabel: { 'zh-CN': '界面语言', en: 'Language' },
  updateSection: { 'zh-CN': '软件更新', en: 'App Updates' },
  updateVersion: { 'zh-CN': '当前版本：v{version}', en: 'Current version: v{version}' },
  updateCheck: { 'zh-CN': '检查更新', en: 'Check for Updates' },
  updateChecking: { 'zh-CN': '检查中…', en: 'Checking…' },
  updateAvailable: { 'zh-CN': '发现新版本 v{version}', en: 'Update available: v{version}' },
  updateNotAvailable: { 'zh-CN': '已是最新版本', en: 'You are up to date' },
  updateDownload: { 'zh-CN': '下载更新', en: 'Download' },
  updateDownloading: { 'zh-CN': '下载中 {percent}%', en: 'Downloading {percent}%' },
  updateReady: { 'zh-CN': '更新已就绪，重启安装', en: 'Ready to install' },
  updateInstall: { 'zh-CN': '重启并安装', en: 'Restart & Install' },
  updateError: { 'zh-CN': '更新失败：{message}', en: 'Update failed: {message}' },
  updateUnavailable: { 'zh-CN': '仅安装版支持自动更新', en: 'Auto-update is only available in the installed app' },
  startupSection: { 'zh-CN': '启动选项', en: 'Startup' },
  deferMcpLabel: { 'zh-CN': '延迟 MCP 连接', en: 'Defer MCP connection' },
  deferMcpHint: {
    'zh-CN': 'MCP 服务器在后台并行连接，界面与聊天更早可用（MCP 启动慢时推荐开启）',
    en: 'Connect MCP servers in the background so the UI and chat are usable sooner (recommended when MCP servers start slowly)',
  },
  deferMcpEnabled: { 'zh-CN': '已开启（下次启动生效）', en: 'Enabled (takes effect on next launch)' },
  deferMcpDisabled: { 'zh-CN': '已关闭（下次启动生效）', en: 'Disabled (takes effect on next launch)' },
};

function t(key: string, vars?: Record<string, string | number>): string {
  const entry = STR[key]?.[uiLang] ?? STR[key]?.['zh-CN'] ?? key;
  if (!vars) return entry;
  return entry.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

function fmtNum(n: number): string {
  return n.toLocaleString(uiLang === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function applyI18n(): void {
  document.documentElement.lang = uiLang;
  document.title = 'Nexus Desktop';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
}

async function loadLanguage(): Promise<void> {
  try {
    const lang = await window.nexusDesktop.getLanguage();
    uiLang = lang === 'en' ? 'en' : 'zh-CN';
  } catch {
    uiLang = 'zh-CN';
  }
  applyI18n();
}

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

// ---------- markdown-ish rendering ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(s: string): string {
  return esc(s);
}

function renderInline(src: string): string {
  return src
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function renderBlocks(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  let fenceLang = '';
  let code: string[] = [];

  const flushCode = () => {
    if (code.length > 0) {
      const joined = code.join('\n');
      if (fenceLang === 'diff') {
        out.push(renderDiff(joined));
      } else {
        out.push(`<pre><code>${escapeHtml(joined)}</code></pre>`);
      }
      code = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([\w+-]*)\s*$/.exec(line.trim());
    if (fence) {
      if (inFence) {
        flushCode();
        inFence = false;
        fenceLang = '';
      } else {
        inFence = true;
        fenceLang = fence[1];
      }
      i++;
      continue;
    }
    if (inFence) {
      code.push(line);
      i++;
      continue;
    }
    if (/^###\s/.test(line)) out.push(`<h3>${renderInline(line.replace(/^###\s/, ''))}</h3>`);
    else if (/^##\s/.test(line)) out.push(`<h2>${renderInline(line.replace(/^##\s/, ''))}</h2>`);
    else if (/^#\s/.test(line)) out.push(`<h1>${renderInline(line.replace(/^#\s/, ''))}</h1>`);
    else if (/^\s*[-*]\s/.test(line)) out.push(`• ${renderInline(line.replace(/^\s*[-*]\s/, ''))}`);
    else if (/^\s*\d+\.\s/.test(line)) out.push(`&nbsp;&nbsp;${renderInline(line)}`);
    else if (/^---+\s*$/.test(line)) out.push('<hr>');
    else if (line.trim() === '') out.push('');
    else out.push(renderInline(escapeHtml(line)));
    i++;
  }
  flushCode();
  return out.join('\n');
}

function renderDiff(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+')
        ? 'style="color:#7bc96f"'
        : line.startsWith('-')
          ? 'style="color:#e05a5a"'
          : line.startsWith('@@')
            ? 'style="color:#4f8cff"'
            : '';
      return cls ? `<div ${cls}>${escapeHtml(line)}</div>` : escapeHtml(line);
    })
    .join('\n');
}

// ---------- message rendering ----------
// ---------- message rendering ----------
/** Mirrors core resumeMessages(): worker blocks (sub-agent dispatch) start with
 *  these markers. Skipped from display and from the regenerate index so the
 *  UI ordering matches AgentService.regenerate(userIndex). */
const WORKER_MARKERS = ['[Project Directory]', '[Original Request]', '[Prior Task Results]', '[Role:'];
function isWorkerBlock(text: string): boolean {
  const head = text.slice(0, 200);
  return WORKER_MARKERS.some((mk) => head.includes(mk));
}

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

function addUser(text: string): void {
  if (isWorkerBlock(text)) return;
  const userIndex = userMessageSeq++;
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.dataset.userIndex = String(userIndex);
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

function ensureAssistant(): { bubble: HTMLElement; stream: HTMLElement; buffer: string } {
  if (!curAssistant) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const stream = document.createElement('div');
    stream.className = 'stream-text';
    stream.style.whiteSpace = 'pre-wrap';
    bubble.appendChild(stream);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    curAssistant = { bubble, stream, buffer: '' };
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
    curThinking = { content, buffer: '' };
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
      content.textContent = text;
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
    void window.nexusDesktop.setCwd(''); // placeholder; full file-open handled later
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
    case 'text':
      if (event.text) {
        const asst = ensureAssistant();
        asst.buffer += event.text;
        // Append only the delta text node instead of rewriting the whole buffer
        // per token; the full buffer is re-rendered to markdown at turn_end.
        appendTextDelta(asst.stream, event.text);
        scrollToBottom();
      }
      break;
    case 'thinking':
      if (event.thinking) {
        const t = ensureThinking();
        t.buffer += event.thinking;
        // Only write the DOM when the block is expanded; collapsed thinking is
        // buffered and filled lazily on first expand.
        if (!t.content.classList.contains('hidden')) appendTextDelta(t.content, event.thinking);
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
    case 'state_delta':
      break;
    case 'turn_end': {
      // finalize markdown rendering of accumulated text
      if (curAssistant && curAssistant.buffer) {
        curAssistant.stream.innerHTML = renderBlocks(curAssistant.buffer);
      }
      if (curThinking) {
        const t2 = curThinking;
        // Single final write (bounded) — keep `filled` in sync so a later
        // expand doesn't rewrite.
        t2.content.textContent = t2.buffer;
        t2.content.dataset.filled = '1';
        const toggle = t2.content.parentElement?.querySelector('.thinking-toggle');
        if (toggle) toggle.textContent = t('thought');
      }
      setBusy(false);
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
  void window.nexusDesktop.abort();
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

// ---------- attachments ----------
function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

function renderAttachments(): void {
  attachmentsEl.innerHTML = '';
  attachmentsEl.classList.toggle('hidden', attachments.length === 0);
  for (const p of attachments) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.textContent = basename(p);
    chip.title = p;
    const rm = document.createElement('button');
    rm.className = 'chip-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => {
      attachments = attachments.filter((x) => x !== p);
      renderAttachments();
    });
    chip.appendChild(rm);
    attachmentsEl.appendChild(chip);
  }
}

function attachFiles(paths: string[]): void {
  for (const p of paths) {
    if (p && !attachments.includes(p)) attachments.push(p);
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

async function refreshSessions(activeId?: string): Promise<void> {
  const { items: sessions, total } = await window.nexusDesktop.listSessions({
    limit: SESSION_PAGE_SIZE,
    offset: sessionPage * SESSION_PAGE_SIZE,
  });
  sessionTotal = total;
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.classList.toggle('active', s.id === (activeId ?? currentSessionId));
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = s.name || s.id;
    name.addEventListener('click', () => resumeSession(s.id));
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${s.provider} · ${s.model ?? ''}`;
    const actions = document.createElement('div');
    actions.className = 'session-actions';
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
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(actions);
    sessionListEl.appendChild(li);
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
  return rows.filter((r) => r.role === 'user' && !isWorkerBlock(String(r.content ?? ''))).length;
}

/** Render one persisted message row into the history view. */
function renderHistoryRow(m: StoredMsg): void {
  if (m.role === 'user') {
    addUser(String(m.content ?? ''));
  } else if (m.role === 'assistant') {
    if (m.thinking) addThinkingBlock(String(m.thinking));
    if (m.content) {
      const asst = ensureAssistant();
      asst.buffer = String(m.content);
      asst.stream.innerHTML = renderBlocks(asst.buffer);
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

async function resumeSession(id: string): Promise<void> {
  if (busy) return;
  currentSessionId = await window.nexusDesktop.startSession(undefined, id);
  const cached = loadMsgCache(id);
  if (cached) {
    // Instant paint from cache while the fresh window is fetched in the background.
    applyMsgWindow(cached);
    renderMessageWindow();
  }
  const fresh = await window.nexusDesktop.getMessages(id, { last: MSG_WINDOW });
  const changed = !cached || cached.total !== fresh.total || !sameTail(cached.items, fresh.items);
  if (changed) {
    applyMsgWindow(fresh);
    renderMessageWindow();
  }
  saveMsgCache(id, fresh);
  addSystem(t('sessionRestored'));
  // Non-blocking: applies the session's MCP toggles once core init finishes,
  // so opening a session never waits on the MCP connect phase.
  void applyMcpPref(currentSessionId);
  await refreshSessions(id);
  await refreshSidebarSession();
  await refreshSessionStats();
}

async function startNewSession(): Promise<void> {
  if (busy) return;
  messagesEl.innerHTML = '';
  toolCards.clear();
  tasks.clear();
  renderTasks();
  curAssistant = null;
  curThinking = null;
  userMessageSeq = 0;
  msgItems = [];
  msgOffset = 0;
  msgTotal = 0;
  msgUserBefore = 0;
  msgWindowStart = 0;
  currentSessionId = await window.nexusDesktop.startSession();
  addSystem(t('sessionCreated'));
  void applyMcpPref(currentSessionId);
  await refreshSessions();
  await refreshSidebarSession();
  await refreshSessionStats();
}

async function startOrResumeLatestSession(): Promise<void> {
  const { items: sessions } = await window.nexusDesktop.listSessions({
    limit: SESSION_PAGE_SIZE,
    offset: 0,
  });
  const latest = sessions[0];
  if (latest) {
    const { total } = await window.nexusDesktop.getMessages(latest.id, { last: 1 });
    if (total === 0) {
      // The most recent historical session is still empty (no messages/tokens).
      // Continue it instead of creating another empty session on every launch.
      await resumeSession(latest.id);
      return;
    }
  }
  await startNewSession();
}

// ---------- right sidebar: session info + task progress ----------
function permLabel(mode: string): string {
  if (mode === 'auto') return uiLang === 'zh-CN' ? 'auto（自动放行）' : 'auto (auto-approve)';
  if (mode === 'prompt') return uiLang === 'zh-CN' ? 'prompt（每次询问）' : 'prompt (ask each time)';
  return mode || '—';
}

async function refreshSidebarSession(): Promise<void> {
  const [st, perms, mcp] = await Promise.all([
    window.nexusDesktop.getStatus(),
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
    addSystem(`⚠️ MCP: ${err instanceof Error ? err.message : String(err)}`);
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
      await window.nexusDesktop.chat(text);
      await refreshSessions(currentSessionId);
      await syncMsgCache(currentSessionId);
    } catch (err) {
      addSystem(`${t('error')}${err instanceof Error ? err.message : String(err)}`);
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
    addSystem(`${t('error')}${err instanceof Error ? err.message : String(err)}`);
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
    addSystem(`${t('error')}${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    drain();
  }
}

attachBtn.addEventListener('click', async () => {
  try {
    const res = await window.nexusDesktop.openFile();
    if (!res.canceled && res.path) attachFiles([res.path]);
  } catch (err) {
    inputStatus.textContent = `${t('attachFailed')}${err instanceof Error ? err.message : String(err)}`;
  }
});

// ---------- permission modal ----------
let pendingPermissionId: string | null = null;
const permOverlay = $('#perm-overlay');
const permQuestion = $('#perm-question');

function showPermission(req: { id: string; question: string }): void {
  pendingPermissionId = req.id;
  permQuestion.textContent = req.question;
  console.log(`showPermission id=${req.id}`);
  permOverlay.classList.remove('hidden');
}

async function answerPermission(answer: string): Promise<void> {
  if (!pendingPermissionId) {
    console.warn('answerPermission: no pendingPermissionId');
    return;
  }
  const id = pendingPermissionId;
  pendingPermissionId = null;
  permOverlay.classList.add('hidden');
  console.log(`answerPermission id=${id} answer=${answer}`);
  try {
    await window.nexusDesktop.respondPermission(id, answer);
  } catch (e) {
    console.error(`respondPermission failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

$('#perm-allow').addEventListener('click', () => void answerPermission('y'));
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
  buildUpdateSection();
}

function buildStartupSection(): void {
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = t('startupSection');
  settingsBody.appendChild(title);

  const row = document.createElement('div');
  row.className = 'startup-row';
  const label = document.createElement('label');
  label.className = 'startup-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  const text = document.createElement('span');
  text.textContent = t('deferMcpLabel');
  const hint = document.createElement('div');
  hint.className = 'startup-hint';
  hint.textContent = t('deferMcpHint');
  void window.nexusDesktop.getDeferMcp().then((v: boolean) => {
    cb.checked = v === true;
  }).catch(() => {});
  cb.addEventListener('change', () => {
    const v = cb.checked;
    cb.disabled = true;
    void window.nexusDesktop.setDeferMcp(v)
      .then(() => {
        settingsMsg.textContent = v ? t('deferMcpEnabled') : t('deferMcpDisabled');
      })
      .catch((err: unknown) => {
        settingsMsg.textContent = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
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
    renderUpdateStatus({ status: 'error', message: err instanceof Error ? err.message : String(err) });
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
    settingsMsg.textContent = err instanceof Error ? err.message : String(err);
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
      const models = await window.nexusDesktop.getModels(active);
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
  await window.nexusDesktop.switchProvider(name);
  status = await window.nexusDesktop.getStatus();
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
    await window.nexusDesktop.switchModel(modelId);
    status = await window.nexusDesktop.getStatus();
    addSystem(t('switchedModel', { name: providerName, from, to: status.model }));
    await refreshSessions();
    await refreshSidebarSession();
  } catch (err) {
    addSystem(`${t('error')}${err instanceof Error ? err.message : String(err)}`);
    refreshModelSelect();
  }
});

$('#btn-open-folder').addEventListener('click', async () => {
  const res = await window.nexusDesktop.openFolder();
  if (res.canceled || !res.path) return;
  await window.nexusDesktop.setCwd(res.path);
  status = await window.nexusDesktop.getStatus();
  cwdLabel.textContent = status.cwd;
  cwdLabel.title = status.cwd;
  addSystem(t('projectDir', { cwd: status.cwd }));
});

$('#btn-new-session').addEventListener('click', () => void startNewSession());
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

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

// ---------- wire events ----------
window.nexusDesktop.onEvent(handleEvent);
window.nexusDesktop.onEvents((events) => {
  for (const e of events) handleEvent(e);
});
window.nexusDesktop.onPermission(showPermission);
window.nexusDesktop.onLog((log) => {
  if (log.level === 'error') inputStatus.textContent = `⚠️ ${log.message}`;
});

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

// ---------- boot ----------
(async function boot(): Promise<void> {
  try {
    loadTheme();
    await loadLanguage();
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
    await startOrResumeLatestSession();
    await refreshSessions();
    await refreshSidebarSession();
  } catch (err) {
    addSystem(`${t('startFailed')}${err instanceof Error ? err.message : String(err)}`);
  }
})();
