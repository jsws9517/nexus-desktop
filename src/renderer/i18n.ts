/**
 * Renderer i18n: dictionary + helpers, extracted from renderer.ts so the string
 * table is a standalone (unit-testable) module. Language syncs with the core
 * config.json `language` value via getLanguage().
 */

export type Lang = 'en' | 'zh-CN';

let uiLang: Lang = 'zh-CN';

export const STR: Record<string, { 'zh-CN': string; en: string }> = {
  openProject: { 'zh-CN': '📁 打开项目', en: '📁 Open Project' },
  noProject: { 'zh-CN': '未选择项目', en: 'No project selected' },
  settings: { 'zh-CN': '⚙️ 设置', en: '⚙️ Settings' },
  sessions: { 'zh-CN': '会话', en: 'Sessions' },
  newSession: { 'zh-CN': '＋ 新建', en: '＋ New' },
  chatEmptyHint: { 'zh-CN': '点击「＋ 新建」或输入 /new 开始新会话，也可以直接输入第一条消息', en: 'Start with "＋ New" or /new, or just type your first message' },
  collapseSidebar: { 'zh-CN': '折叠侧栏', en: 'Collapse sidebar' },
  expandSidebar: { 'zh-CN': '展开侧栏', en: 'Expand sidebar' },
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
  sessionId: { 'zh-CN': '会话 ID', en: 'Session ID' },
  projectDirLabel: { 'zh-CN': '项目目录', en: 'Project Dir' },
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
  openLog: { 'zh-CN': '打开日志文件', en: 'Open log file' },
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
  allowAlways: { 'zh-CN': '始终允许', en: 'Always Allow' },
  allowAlwaysHint: {
    'zh-CN': '记住本次授权（路径级持久），不再弹窗',
    en: 'Remember this grant (persisted per path), no more prompts',
  },
  deny: { 'zh-CN': '拒绝', en: 'Deny' },
  permBatchTitle: { 'zh-CN': '批量权限确认', en: 'Bulk Permission' },
  permBatchPrompt: { 'zh-CN': '将允许 {count} 个操作。最后一条请求：', en: 'Allow {count} operations. Last one:' },
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
  // ---- A2 / E1 / E2 / E3 / E4 additions ----
  revealFile: { 'zh-CN': '在文件夹中显示', en: 'Reveal in folder' },
  fileSizeBytes: { 'zh-CN': '{n} B', en: '{n} B' },
  fileSizeKb: { 'zh-CN': '{n} KB', en: '{n} KB' },
  fileSizeMb: { 'zh-CN': '{n} MB', en: '{n} MB' },
  dropHint: { 'zh-CN': '拖拽文件到此处，或 📎 选择', en: 'Drop files here or use 📎 to attach' },
  copied: { 'zh-CN': '已复制', en: 'Copied' },
  copiedSessionId: { 'zh-CN': '会话 ID 已复制', en: 'Session ID copied' },
  copiedProjectDir: { 'zh-CN': '项目目录已复制', en: 'Project dir copied' },
  copy: { 'zh-CN': '复制', en: 'Copy' },
  searchSessions: { 'zh-CN': '搜索会话（名称 / ID / graphId / 项目名）…', en: 'Search sessions (name / ID / graphId / project)…' },
  pinnedSessions: { 'zh-CN': '置顶', en: 'Pinned' },
  pin: { 'zh-CN': '置顶', en: 'Pin' },
  unpin: { 'zh-CN': '取消置顶', en: 'Unpin' },
  noSearchResults: { 'zh-CN': '无匹配会话', en: 'No matching sessions' },
  workerRestarted: { 'zh-CN': '核心已重启，正在恢复会话…', en: 'Core restarted, restoring session…' },
  minimizeToTrayLabel: { 'zh-CN': '关闭窗口时最小化到托盘', en: 'Minimize to tray on close' },
  minimizeToTrayHint: { 'zh-CN': '关闭主窗口后应用驻留系统托盘，从托盘菜单退出', en: 'Keep the app in the system tray when the window closes; quit from the tray menu' },
  restoreSessionLabel: { 'zh-CN': '启动时恢复上次会话', en: 'Restore last session on launch' },
  restoreSessionHint: { 'zh-CN': '开启后启动时自动恢复所有上次打开的 tab；关闭则启动时保持空白', en: 'Automatically restore all previously open tabs on launch; when off, starts blank' },
  restoreSessionEnabled: { 'zh-CN': '已开启（下次启动生效）', en: 'Enabled (takes effect on next launch)' },
  restoreSessionDisabled: { 'zh-CN': '已关闭（下次启动生效）', en: 'Disabled (takes effect on next launch)' },
  logSection: { 'zh-CN': '日志', en: 'Logs' },
  viewLogs: { 'zh-CN': '查看最近日志', en: 'View recent logs' },
  logsEmpty: { 'zh-CN': '暂无日志', en: 'No logs yet' },
  refreshLogs: { 'zh-CN': '刷新', en: 'Refresh' },
  appearanceSection: { 'zh-CN': '外观', en: 'Appearance' },
  inputRowsLabel: { 'zh-CN': '输入框行数', en: 'Input box rows' },
  inputRowsHint: { 'zh-CN': '输入框的默认可见行数（1–20）', en: 'Default visible rows for the input box (1–20)' },
  resourceSection: { 'zh-CN': '资源与会话', en: 'Resources & Sessions' },
  resourcePanelTitle: { 'zh-CN': '系统资源', en: 'Resources' },
  resourceStateTitle: { 'zh-CN': '系统资源占用', en: 'System load' },
  resourceStateValue: { 'zh-CN': '内存 {mem}% · CPU {cpu}%', en: 'Memory {mem}% · CPU {cpu}%' },
  resourceMemoryLabel: { 'zh-CN': '内存', en: 'Memory' },
  resourceCpuLabel: { 'zh-CN': 'CPU', en: 'CPU' },
  resourceStateUnavailable: { 'zh-CN': '不可用（采样中…）', en: 'Unavailable (sampling…)' },
  resourceStatusNormal: { 'zh-CN': '正常', en: 'Normal' },
  resourceStatusWarning: { 'zh-CN': '占用升高', en: 'Elevated' },
  resourceStatusOverloaded: { 'zh-CN': '过载，已暂停新建', en: 'Overloaded, new tabs paused' },
  resourceStatusPaused: { 'zh-CN': '监控已关闭', en: 'Monitoring disabled' },
  maxTabsLabel: { 'zh-CN': '并发会话上限', en: 'Concurrent session limit' },
  maxTabsHint: { 'zh-CN': '同时在线会话（标签页）的最大数量（1–20）', en: 'Max sessions (tabs) online at once (1–20)' },
  memThresholdLabel: { 'zh-CN': '内存阈值 (%)', en: 'Memory threshold (%)' },
  memThresholdHint: { 'zh-CN': '系统内存占用超过此值且持续偏高时，暂停创建新会话', en: 'Pause new sessions when system memory stays above this level' },
  cpuThresholdLabel: { 'zh-CN': 'CPU 阈值 (%)', en: 'CPU threshold (%)' },
  cpuThresholdHint: { 'zh-CN': '系统 CPU 占用超过此值且持续偏高时，暂停创建新会话', en: 'Pause new sessions when system CPU stays above this level' },
  monitorEnabledLabel: { 'zh-CN': '启用资源监控', en: 'Enable resource monitoring' },
  monitorEnabledHint: { 'zh-CN': '高内存/CPU 时提前干预，暂停新建会话以保护系统', en: 'Proactively pause new sessions when memory/CPU load is high' },

  // Multi-tab (per-session worker) UI.
  tabsEmpty: { 'zh-CN': '无打开的会话标签', en: 'No open session tabs' },
  tabsAddHint: { 'zh-CN': '新建会话标签', en: 'New session tab' },
  tabsCloseHint: { 'zh-CN': '关闭此标签', en: 'Close this tab' },
  tabsBusy: { 'zh-CN': '正在运行', en: 'Running' },
  tabsMaxReached: { 'zh-CN': '已达并发会话上限，无法新建标签', en: 'Concurrent session limit reached; cannot open another tab' },
  tabsOverloaded: { 'zh-CN': '系统资源过高，已暂停新建会话', en: 'System overloaded; new sessions paused' },
  tabsOpenFailed: { 'zh-CN': '无法打开会话标签：', en: 'Failed to open session tab: ' },
};

export function setUiLang(lang: Lang): void {
  uiLang = lang;
}

export function getUiLang(): Lang {
  return uiLang;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = STR[key]?.[uiLang] ?? STR[key]?.['zh-CN'] ?? key;
  if (!vars) return entry;
  return entry.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

export function fmtNum(n: number): string {
  return n.toLocaleString(uiLang === 'zh-CN' ? 'zh-CN' : 'en-US');
}

export function applyI18n(): void {
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

export async function loadLanguage(): Promise<void> {
  try {
    const lang = await window.nexusDesktop.getLanguage();
    setUiLang(lang === 'en' ? 'en' : 'zh-CN');
  } catch {
    setUiLang('zh-CN');
  }
  applyI18n();
}

// ---- light localization of common core/network error messages (D4) ----
const CORE_ERROR_HINTS: Array<[RegExp, string]> = [
  [/no provider configured/i, '未配置 Provider，请先在设置中填写 API Key'],
  [/no api key|api key.*(invalid|missing)|invalid.*api key/i, 'API Key 无效或缺失'],
  [/401|unauthorized|authentication failed/i, '认证失败（401），请检查 API Key'],
  [/403|forbidden/i, '访问被拒绝（403）'],
  [/429|rate limit/i, '请求过于频繁（429），请稍后重试'],
  [/timeout|timed out|deadline/i, '请求超时，请重试'],
  [/econnreset|econnrefused|fetch failed|socket hang up|network/i, '网络连接失败'],
  [/worker|core process/i, '核心进程异常'],
];

/** Map common English core/network errors to a localized hint; pass through otherwise. */
export function localizeError(msg: string): string {
  for (const [re, zh] of CORE_ERROR_HINTS) {
    if (re.test(msg)) return zh;
  }
  return msg;
}
