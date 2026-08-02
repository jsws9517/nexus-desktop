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
  | { type: 'session_end' };

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
      switchProvider(name: string): Promise<unknown>;
      switchModel(modelId: string): Promise<unknown>;
      saveProvider(name: string, fields: Record<string, unknown>): Promise<unknown>;
      openConfigWeb(): Promise<{ ok: boolean; port?: number; error?: string }>;
      setCwd(cwd: string): Promise<unknown>;
      openFolder(): Promise<{ canceled: boolean; path?: string }>;
      respondPermission(id: string, answer: string): Promise<unknown>;
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

// ---------- state ----------
let currentSessionId = '';
let busy = false;
let running = false;
const pendingQueue: string[] = [];
let providers: ProviderInfo[] = [];
let status: StatusInfo = { cwd: '', busy: false, provider: '', model: '' };

// per-turn DOM handles
let curAssistant: { bubble: HTMLElement; stream: HTMLElement; buffer: string } | null = null;
let curThinking: { content: HTMLElement; buffer: string } | null = null;
const toolCards = new Map<number, { card: HTMLElement; resultEl: HTMLElement | null }>();

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
    toggle.textContent = '💭 思考中…';
    const content = document.createElement('div');
    content.className = 'thinking-content hidden';
    content.style.whiteSpace = 'pre-wrap';
    wrap.appendChild(toggle);
    wrap.appendChild(content);
    messagesEl.appendChild(wrap);
    toggle.addEventListener('click', () => {
      content.classList.toggle('hidden');
      toggle.textContent = content.classList.contains('hidden') ? '💭 思考中…' : '💭 收起思考';
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
      break;
    case 'turn_start':
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
        const t = curThinking;
        t.content.textContent = t.buffer;
        const toggle = t.content.parentElement?.querySelector('.thinking-toggle');
        if (toggle) toggle.textContent = '💭 思考';
      }
      setBusy(false);
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
  if (value) inputStatus.textContent = '运行中…';
  else inputStatus.textContent = '';
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- sessions ----------
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
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = prompt('会话名称:', s.name);
      if (newName) {
        await window.nexusDesktop.renameSession(s.id, newName);
        await refreshSessions();
      }
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.style.color = 'var(--danger)';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除会话 "${s.name}"?`)) return;
      await window.nexusDesktop.deleteSession(s.id);
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
  addSystem('已恢复会话');
  await refreshSessions(id);
}

async function startNewSession(): Promise<void> {
  if (busy) return;
  messagesEl.innerHTML = '';
  toolCards.clear();
  curAssistant = null;
  curThinking = null;
  currentSessionId = await window.nexusDesktop.startSession();
  addSystem('新会话已创建。发送消息开始对话。');
  await refreshSessions();
}

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
    if (pendingQueue.length > 0) inputStatus.textContent = `⏳ 排队：${pendingQueue.length} 条待发…`;
    return;
  }
  const t = pendingQueue.shift();
  if (t === undefined) {
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
      await window.nexusDesktop.chat(t);
      await refreshSessions(currentSessionId);
    } catch (err) {
      addSystem(`⚠️ 错误: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      drain();
    }
  })();
}

async function sendMessage(): Promise<void> {
  enqueue(inputEl.value.trim());
}

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

function buildSettings(providersList: ProviderInfo[]): void {
  settingsBody.innerHTML = '';
  for (const p of providersList) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.dataset.name = p.name;
    const head = document.createElement('div');
    head.className = 'row-head';
    const title = document.createElement('b');
    title.textContent = `${p.name} (${p.type})`;
    const active = document.createElement('span');
    active.style.color = p.name === status.provider ? 'var(--ok)' : 'var(--text-dim)';
    active.textContent = p.name === status.provider ? '● 当前' : '';
    head.appendChild(title);
    head.appendChild(active);
    row.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'row-grid';

    const apiKeyField = document.createElement('input');
    apiKeyField.placeholder = p.hasKey ? '••••••••••••（留空保持不变）' : '输入 API Key';
    apiKeyField.dataset.field = 'apiKey';
    const apiKeyLbl = document.createElement('label');
    apiKeyLbl.textContent = 'API Key';
    apiKeyLbl.appendChild(apiKeyField);
    grid.appendChild(apiKeyLbl);

    const modelField = document.createElement('input');
    modelField.value = p.model;
    modelField.dataset.field = 'model';
    const modelLbl = document.createElement('label');
    modelLbl.textContent = '模型';
    modelLbl.appendChild(modelField);
    grid.appendChild(modelLbl);

    const baseUrlField = document.createElement('input');
    baseUrlField.value = p.baseUrl ?? '';
    baseUrlField.placeholder = 'https://api.example.com/v1';
    baseUrlField.dataset.field = 'baseUrl';
    const baseUrlLbl = document.createElement('label');
    baseUrlLbl.textContent = 'Base URL（可选）';
    baseUrlLbl.appendChild(baseUrlField);
    grid.appendChild(baseUrlLbl);

    const typeField = document.createElement('input');
    typeField.value = p.type;
    typeField.dataset.field = 'type';
    const typeLbl = document.createElement('label');
    typeLbl.textContent = '类型';
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
}

function openSettings(): void {
  window.nexusDesktop.openConfigWeb().then((r) => {
    if (!r.ok) inputStatus.textContent = `⚠️ 设置打开失败：${r.error ?? '未知错误'}`;
  }).catch((err) => {
    inputStatus.textContent = `⚠️ 设置打开失败：${err?.message ?? err}`;
  });
}

$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

$('#settings-save').addEventListener('click', async () => {
  const rows = settingsBody.querySelectorAll<HTMLElement>('.provider-row');
  for (const row of rows) {
    const name = row.dataset.name!;
    const fields: Record<string, string> = {};
    row.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((input) => {
      fields[input.dataset.field!] = input.value;
    });
    await window.nexusDesktop.saveProvider(name, fields);
  }
  providers = await window.nexusDesktop.getProviders();
  status = await window.nexusDesktop.getStatus();
  refreshProviderSelect();
  settingsMsg.textContent = '已保存';
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
  addSystem(`已切换到 Provider: ${name}（${status.model}）`);
  await refreshSessions();
});

$('#btn-open-folder').addEventListener('click', async () => {
  const res = await window.nexusDesktop.openFolder();
  if (res.canceled || !res.path) return;
  await window.nexusDesktop.setCwd(res.path);
  status = await window.nexusDesktop.getStatus();
  cwdLabel.textContent = status.cwd;
  cwdLabel.title = status.cwd;
  addSystem(`📁 项目目录: ${status.cwd}`);
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
    status = await window.nexusDesktop.getStatus();
    providers = await window.nexusDesktop.getProviders();
    if (providers.length === 0) {
      addSystem('未配置 Provider。点击右上角 ⚙️ 设置填写 API Key。');
      openSettings();
    }
    refreshProviderSelect();
    cwdLabel.textContent = status.cwd || '未选择项目';
    cwdLabel.title = status.cwd;
    await startNewSession();
    await refreshSessions();
  } catch (err) {
    addSystem(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  }
})();
