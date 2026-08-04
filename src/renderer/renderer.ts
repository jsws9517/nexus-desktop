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
  | { type: 'task_started'; taskId: string; description: string; role: string }
  | { type: 'task_completed'; taskId: string }
  | { type: 'task_failed'; taskId: string; error: string };

declare global {
  interface Window {
    nexusDesktop: {
      chat(input: string): Promise<unknown>;
      abort(): Promise<unknown>;
      startSession(name?: string, sessionId?: string): Promise<string>;
      listSessions(): Promise<SessionInfo[]>;
      getMessages(sessionId: string): Promise<Array<Record<string, unknown>>>;
      deleteSession(id: string): Promise<unknown>;
      renameSession(id: string, name: string): Promise<unknown>;
      getConfig(): Promise<Record<string, unknown>>;
      getProviders(): Promise<ProviderInfo[]>;
      getStatus(): Promise<StatusInfo>;
      getPermissions(): Promise<PermissionsInfo>;
      getLanguage(): Promise<string>;
      getSpeechVisionConfig(): Promise<SpeechVisionConfig>;
      setActiveSpeechProvider(name: string): Promise<unknown>;
      setActiveTtsProvider(name: string): Promise<unknown>;
      setActiveVisionProvider(name: string): Promise<unknown>;
      saveSpeechProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      saveVisionProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      getSessionStats(sessionId: string): Promise<SessionStats>;
      switchProvider(name: string): Promise<unknown>;
      switchModel(modelId: string): Promise<unknown>;
      saveProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      openConfigWeb(): Promise<{ ok: boolean; port?: number; error?: string }>;
      setCwd(cwd: string): Promise<unknown>;
      openFolder(): Promise<{ canceled: boolean; path?: string }>;
      openFile(): Promise<{ canceled: boolean; path?: string }>;
      respondPermission(id: string, answer: string): Promise<unknown>;
      setMcpEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      getMcpStatus(): Promise<{ enabled: boolean; servers: McpServerStatus[] }>;
      getMcpServers(): Promise<Array<{ name: string; autoStart: boolean; connected: boolean; toolCount: number; error?: string; stderr?: string }>>;
      setMcpServer(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
      onEvent(cb: (event: AgentEvent) => void): void;
      onPermission(cb: (req: { id: string; question: string }) => void): void;
      onLog(cb: (log: { level: string; message: string }) => void): void;
    };
  }
}

// ---------- element helpers ----------
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const messagesEl = $('#messages');
const inputEl = $('#input') as HTMLTextAreaElement;
const sendBtn = $('#btn-send');
const stopBtn = $('#btn-stop');
const sessionListEl = $('#session-list');
const providerSelect = $('#provider-select') as HTMLSelectElement;
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
const pendingQueue: string[] = [];
let attachments: string[] = [];
let providers: ProviderInfo[] = [];
let status: StatusInfo = { cwd: '', busy: false, provider: '', model: '' };

// Task lifecycle state (task_started / task_completed / task_failed events)
interface TaskItem {
  id: string;
  description: string;
  role: string;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}
const tasks = new Map<string, TaskItem>();

// per-turn DOM handles
let curAssistant: { bubble: HTMLElement; stream: HTMLElement; buffer: string } | null = null;
let curThinking: { content: HTMLElement; buffer: string } | null = null;
const toolCards = new Map<number, { card: HTMLElement; resultEl: HTMLElement | null }>();

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
  queued: { 'zh-CN': '⏳ 排队：{n} 条待发…', en: '⏳ Queued: {n} pending…' },
  rename: { 'zh-CN': '重命名', en: 'Rename' },
  delete: { 'zh-CN': '删除', en: 'Delete' },
  renameSession: { 'zh-CN': '重命名会话', en: 'Rename Session' },
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
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
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
      content.classList.toggle('hidden');
      toggle.textContent = content.classList.contains('hidden') ? t('thinkingDot') : t('collapseThinking');
    });
    curThinking = { content, buffer: '' };
  }
  return curThinking;
}

function addToolCard(event: Extract<AgentEvent, { type: 'tool_call_start' }>): void {
  const card = document.createElement('div');
  card.className = 'tool-card';
  const name = document.createElement('div');
  name.className = 'tool-name';
  name.textContent = `🔧 ${event.name}`;
  const args = document.createElement('div');
  args.className = 'tool-args';
  args.textContent = JSON.stringify(event.args ?? {}, null, 2);
  card.appendChild(name);
  card.appendChild(args);
  messagesEl.appendChild(card);
  toolCards.set(event.index, { card, resultEl: null });
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
      currentSessionId = event.sessionId;
      tasks.clear();
      renderTasks();
      void refreshSidebarSession();
      void refreshSessionStats();
      break;
    case 'turn_start':
      tasks.clear();
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
        asst.stream.textContent = asst.buffer;
        scrollToBottom();
      }
      break;
    case 'thinking':
      if (event.thinking) {
        const t = ensureThinking();
        t.buffer += event.thinking;
        t.content.textContent = t.buffer;
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
        const resultEl = document.createElement('div');
        resultEl.className = 'tool-result';
        resultEl.textContent = event.isError
          ? `❌ ${event.content}`
          : event.content.length > 4000
            ? event.content.slice(0, 4000) + '\n… (truncated)'
            : event.content;
        rec.card.classList.toggle('error', !!event.isError);
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
        t2.content.textContent = t2.buffer;
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
  if (value) inputStatus.textContent = t('runningEllipsis');
  else inputStatus.textContent = '';
}

function scrollToBottom(): void {
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
  const sessions = await window.nexusDesktop.listSessions();
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
      if (currentSessionId === s.id) {
        currentSessionId = '';
        messagesEl.innerHTML = '';
        await startNewSession();
      }
      await refreshSessions();
    });
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(actions);
    sessionListEl.appendChild(li);
  }
}

async function resumeSession(id: string): Promise<void> {
  if (busy) return;
  messagesEl.innerHTML = '';
  toolCards.clear();
  curAssistant = null;
  curThinking = null;
  currentSessionId = await window.nexusDesktop.startSession(undefined, id);
  const msgs = await window.nexusDesktop.getMessages(id);
  for (const m of msgs) {
    if (m.role === 'user') addUser(String(m.content));
    else if (m.role === 'assistant' && m.content) {
      const asst = ensureAssistant();
      asst.buffer = String(m.content);
      asst.stream.innerHTML = renderBlocks(asst.buffer);
      curAssistant = null;
    }
  }
  addSystem(t('sessionRestored'));
  await applyMcpPref(currentSessionId);
  await refreshSessions(id);
  await refreshSidebarSession();
  await refreshSessionStats();
}

async function startNewSession(): Promise<void> {
  if (busy) return;
  messagesEl.innerHTML = '';
  toolCards.clear();
  curAssistant = null;
  curThinking = null;
  currentSessionId = await window.nexusDesktop.startSession();
  addSystem(t('sessionCreated'));
  await applyMcpPref(currentSessionId);
  await refreshSessions();
  await refreshSidebarSession();
  await refreshSessionStats();
}

async function startOrResumeLatestSession(): Promise<void> {
  const sessions = await window.nexusDesktop.listSessions();
  const latest = sessions[0];
  if (latest) {
    const msgs = await window.nexusDesktop.getMessages(latest.id);
    if (msgs.length === 0) {
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
    badge.textContent = item.status === 'running' ? '⏳' : item.status === 'completed' ? '✓' : '✗';
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
        : t('failed', { error: item.error ?? '' });
    body.appendChild(title);
    body.appendChild(meta);
    li.appendChild(badge);
    li.appendChild(body);
    taskListEl.appendChild(li);
  }
}

function handleTaskEvent(event: Extract<AgentEvent, { type: `task_${string}` }>): void {
  if (event.type === 'task_started') {
    tasks.set(event.taskId, { id: event.taskId, description: event.description, role: event.role, status: 'running' });
  } else if (event.type === 'task_completed') {
    const t = tasks.get(event.taskId);
    if (t) t.status = 'completed';
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
  const attrs = attachments;
  attachments = [];
  renderAttachments();
  const composed = attrs.map((p) => `@${p}`).concat(text ? [text] : []).join('\n');
  enqueue(composed);
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

providerSelect.addEventListener('change', async () => {
  const name = providerSelect.value;
  if (!name || name === status.provider) return;
  await window.nexusDesktop.switchProvider(name);
  status = await window.nexusDesktop.getStatus();
  addSystem(t('switchedProvider', { name, model: status.model }));
  await refreshSessions();
  await refreshSidebarSession();
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
sendBtn.addEventListener('click', () => void sendMessage());
stopBtn.addEventListener('click', () => {
  void window.nexusDesktop.abort();
  setBusy(false);
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

// ---------- wire events ----------
window.nexusDesktop.onEvent(handleEvent);
window.nexusDesktop.onPermission(showPermission);
window.nexusDesktop.onLog((log) => {
  if (log.level === 'error') inputStatus.textContent = `⚠️ ${log.message}`;
});

// ---------- boot ----------
(async function boot(): Promise<void> {
  try {
    await loadLanguage();
    status = await window.nexusDesktop.getStatus();
    providers = await window.nexusDesktop.getProviders();
    if (providers.length === 0) {
      addSystem(t('noProviderConfigured'));
      void openSettings();
    }
    refreshProviderSelect();
    cwdLabel.textContent = status.cwd || t('noProject');
    cwdLabel.title = status.cwd;
    await startOrResumeLatestSession();
    await refreshSessions();
    await refreshSidebarSession();
  } catch (err) {
    addSystem(`${t('startFailed')}${err instanceof Error ? err.message : String(err)}`);
  }
})();
