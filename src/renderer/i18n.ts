/**
 * Renderer i18n: dictionary + helpers, extracted from renderer.ts so the string
 * table is a standalone (unit-testable) module. Language syncs with the core
 * config.json `language` value via getLanguage().
 */

export type Lang = 'en' | 'zh-CN';

let uiLang: Lang = 'zh-CN';

export const STR: Record<string, { 'zh-CN': string; en: string }> = {
  openProject: { 'zh-CN': '打开项目', en: 'Open Project' },
  noProject: { 'zh-CN': '未选择项目', en: 'No project selected' },
  settings: { 'zh-CN': '设置', en: 'Settings' },
  sessions: { 'zh-CN': '会话', en: 'Sessions' },
  newSession: { 'zh-CN': '新建', en: 'New' },
  chatEmptyHint: { 'zh-CN': '点击「新建」或输入 /new 开始新会话，也可以直接输入第一条消息', en: 'Start with "New" or /new, or just type your first message' },
  collapseSidebar: { 'zh-CN': '折叠侧栏', en: 'Collapse sidebar' },
  expandSidebar: { 'zh-CN': '展开侧栏', en: 'Expand sidebar' },
  attach: { 'zh-CN': '📎', en: '📎' },
  attachTitle: { 'zh-CN': '添加附件', en: 'Attach files' },
  // One-time attachment RAG (independent from the `+` attach flow).
  ragAttachTitle: { 'zh-CN': '添加 RAG 附件（入检索库，不进对话）', en: 'Add RAG attachment (indexed, not inlined)' },
  ragRemove: { 'zh-CN': '移除 RAG 附件', en: 'Remove RAG attachment' },
  ragIngestFailed: { 'zh-CN': '部分附件未能入检索库', en: 'Some attachments could not be indexed' },
ragClear: { 'zh-CN': '清空检索库', en: 'Clear RAG store' },
ragClearConfirm: { 'zh-CN': '清空本会话的 RAG 附件？', en: 'Clear this session\'s RAG attachments?' },
ragAutoInjectOff: { 'zh-CN': '内容过多 · 改由模型按需检索', en: 'Too large · model retrieves on demand' },
ragAutoInjectOffTitle: {
    'zh-CN': '已超过自动注入上限，模型将通过 attachments_search 工具按需检索这些附件',
    en: 'Past the auto-inject cap; the model retrieves these via the attachments_search tool',
  },
ragReasonUnsupported: { 'zh-CN': '需安装扩展包', en: 'needs extractor package' },
  ragReasonUnsupportedPkg: { 'zh-CN': '需安装 {pkg} 扩展包', en: 'needs the {pkg} package' },
  ragInstallExtractor: { 'zh-CN': '在设置中安装 {pkg} 以启用 PDF / Word / Excel / PPT', en: 'Install {pkg} in Settings to enable PDF / Word / Excel / PPT' },
ragReasonBinary: { 'zh-CN': '二进制文件', en: 'binary file' },
ragReasonEmpty: { 'zh-CN': '无文本内容', en: 'no text content' },
ragReasonNotAllowed: { 'zh-CN': '不在白名单内', en: 'extension not allowed' },
ragReasonError: { 'zh-CN': '提取失败', en: 'extraction failed' },
  mcpMasterTitle: { 'zh-CN': '主开关：启用/禁用全部 MCP 工具', en: 'Master switch: enable/disable all MCP tools' },
  mcpPickTitle: { 'zh-CN': '选择 MCP 服务器工具', en: 'Select MCP server tools' },
  mcpPopoverTitle: { 'zh-CN': 'MCP 服务器工具（当前会话）', en: 'MCP server tools (current session)' },
  inputPlaceholder: { 'zh-CN': '输入消息，Enter 发送，Shift+Enter 换行…', en: 'Type a message, Enter to send…' },
  composerHint: { 'zh-CN': 'Enter 发送 · Shift+Enter 换行', en: 'Enter to send · Shift+Enter for newline' },
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
  fileBrowser: { 'zh-CN': '文件浏览器', en: 'File Browser' },
  fbCollapse: { 'zh-CN': '折叠文件浏览器', en: 'Collapse file browser' },
  fbExpand: { 'zh-CN': '展开文件浏览器', en: 'Expand file browser' },
  fbFilterPlaceholder: { 'zh-CN': '搜索文件名，支持 * ? ^ $，如 ^_*.py', en: 'Filter by name; supports * ? ^ $, e.g. ^_*.py' },
  fbShowHidden: { 'zh-CN': '显示隐藏', en: 'Show hidden' },
  fbHideUntracked: { 'zh-CN': '隐藏未跟踪', en: 'Hide untracked' },
  fbEmpty: { 'zh-CN': '暂无文件', en: 'No files' },
  fbEmptyFilter: { 'zh-CN': '无匹配文件', en: 'No matching files' },
  fbNoProject: { 'zh-CN': '请先打开项目目录', en: 'Open a project folder first' },
  fbLoadFailed: { 'zh-CN': '加载目录失败', en: 'Failed to load directory' },
  fbLoading: { 'zh-CN': '加载中…', en: 'Loading…' },
  fbTruncated: { 'zh-CN': '条目过多，已截断', en: 'Too many entries, truncated' },
  fbOpenFailed: { 'zh-CN': '打开文件失败', en: 'Failed to open file' },
  fbAddToChat: { 'zh-CN': '添加到对话', en: 'Add to chat' },
  fbOpenInEditor: { 'zh-CN': '用编辑器打开', en: 'Open in editor' },
  fbGitCommitted: { 'zh-CN': '已提交', en: 'Committed' },
  fbGitModified: { 'zh-CN': '已修改', en: 'Modified' },
  fbGitUntracked: { 'zh-CN': '未跟踪', en: 'Untracked' },
  running: { 'zh-CN': '进行中 · {role}', en: 'Running · {role}' },
  pending: { 'zh-CN': '待处理', en: 'Pending' },
  cancelled: { 'zh-CN': '已取消', en: 'Cancelled' },
  completed: { 'zh-CN': '已完成', en: 'Completed' },
  failed: { 'zh-CN': '失败：{error}', en: 'Failed: {error}' },
  thinkingDot: { 'zh-CN': '💭 思考中…', en: '💭 Thinking…' },
  collapseThinking: { 'zh-CN': '💭 收起思考', en: '💭 Collapse' },
  thought: { 'zh-CN': '💭 思考', en: '💭 Thought' },
  thinkingStallWarn: {
    'zh-CN': '模型持续产出思考但无实际进展（约 {n} token）。若反复出现，建议降低思维深度或更换模型。',
    en: 'The model keeps producing thinking with no real progress (~{n} tokens). If this recurs, consider lowering the reasoning depth or switching models.',
  },
  thinkingStallAbort: {
    'zh-CN': '模型重复同一段思考（约 {n} token）陷入空转，已自动中断本轮以止损。',
    en: 'The model repeated the same thinking block (~{n} tokens) — the turn was auto-interrupted to stop the token burn.',
  },
  compressNoticeSummarize: {
    'zh-CN': '🔄 上下文已触发压缩（摘要 · 第 {round} 轮），会话暂停片刻以整理历史消息…',
    en: '🔄 Context compression triggered (Summarize · round {round}) — the session is pausing to consolidate history…',
  },
  compressNoticeTruncate: {
    'zh-CN': '✂️ 上下文已触发压缩（截断 · 第 {round} 轮），会话暂停片刻以裁剪超出上下文窗口的内容。',
    en: '✂️ Context compression triggered (Truncate · round {round}) — the session is pausing to trim overflow…',
  },
  compressNoticeSnapshot: {
    'zh-CN': '📦 上下文已触发压缩（快照 · 第 {round} 轮），会话暂停片刻以归档关键信息。',
    en: '📦 Context compression triggered (Snapshot · round {round}) — the session is pausing to archive key info…',
  },
  noMcpServers: { 'zh-CN': '未配置 MCP 服务器', en: 'No MCP servers configured' },
  mcpLoadFailed: { 'zh-CN': '加载失败', en: 'Failed to load' },
  mcpFailed: { 'zh-CN': '失败', en: 'Failed' },
  mcpNotConnected: { 'zh-CN': '未连接', en: 'Not connected' },
  builtinMcp: { 'zh-CN': '内置', en: 'built-in' },
  mcpSection: { 'zh-CN': 'MCP 服务器', en: 'MCP servers' },
  sessionCreated: { 'zh-CN': '新会话已创建。发送消息开始对话。', en: 'New session created. Send a message to start.' },
  sessionRestored: { 'zh-CN': '已恢复会话', en: 'Session restored' },
  noProviderConfigured: { 'zh-CN': '未配置 Provider。点击右上角 ⚙️ 设置填写 API Key。', en: 'No provider configured. Click ⚙️ Settings to add an API key.' },
  startFailed: { 'zh-CN': '启动失败: ', en: 'Failed to start: ' },
  error: { 'zh-CN': '⚠️ 错误: ', en: '⚠️ Error: ' },
  attachFailed: { 'zh-CN': '⚠️ 附件失败: ', en: '⚠️ Attach failed: ' },
  clipboardImageAdded: { 'zh-CN': '已添加剪切板图片', en: 'Clipboard image added' },
  clipboardImageMissing: { 'zh-CN': '剪切板没有图片', en: 'No image on clipboard' },
  runningEllipsis: { 'zh-CN': '运行中', en: 'Running' },
  freeze: { 'zh-CN': '冻结视图', en: 'Freeze' },
  unfreeze: { 'zh-CN': '恢复视图', en: 'Resume' },
  queued: { 'zh-CN': '⏳ 排队：{n} 条待发…', en: '⏳ Queued: {n} pending…' },
  steered: { 'zh-CN': '↪ 已并入当前轮…', en: '↪ Merged into the running turn…' },
  rollbackBtn: { 'zh-CN': '作废上一条并重发', en: 'Void last turn & resend' },
  rollbackBtnTitle: {
    'zh-CN': '发送时丢弃上一条指令已产出的内容，用这条消息重新开始（破坏性，先备份）',
    en: 'On send, discard what the previous instruction produced and restart from this message (destructive; backed up first)',
  },
  rollbackAsk: {
    'zh-CN': '作废上一条指令已产出的全部内容？该内容会先备份到 ~/.nexus/trash/rollback/，之后可从对话记录一键恢复。',
    en: 'Discard everything the previous instruction produced? It is backed up to ~/.nexus/trash/rollback/ first and can be restored from the transcript.',
  },
  rollbackArmed: {
    'zh-CN': '↺ 已标记：发送后将作废上一条指令的产出',
    en: '↺ Armed: sending will discard the previous instruction\'s output',
  },
  rolledBack: {
    'zh-CN': '↺ 已回滚：丢弃 {n} 条上下文消息',
    en: '↺ Rolled back: discarded {n} context messages',
  },
  rollbackNoBackup: {
    'zh-CN': '（备份写入失败，无法恢复）',
    en: ' (backup could not be written — not recoverable)',
  },
  rollbackRestore: { 'zh-CN': '点击恢复', en: 'Restore' },
  rollbackRestored: { 'zh-CN': '↩ 已恢复 {n} 条消息', en: '↩ Restored {n} messages' },
  rollbackRestoreFailed: { 'zh-CN': '恢复失败：备份不可用', en: 'Restore failed: backup unavailable' },
  rename: { 'zh-CN': '重命名', en: 'Rename' },
  delete: { 'zh-CN': '删除', en: 'Delete' },
  renameSession: { 'zh-CN': '重命名会话', en: 'Rename Session' },
  pagerPrev: { 'zh-CN': '上一页', en: 'Prev' },
  pagerNext: { 'zh-CN': '下一页', en: 'Next' },
  loadEarlier: { 'zh-CN': '↑ 加载更早的消息', en: '↑ Load earlier messages' },
  loadEarlierHint: {
    'zh-CN': '左键加载更早的消息 · 右键加载全部历史',
    en: 'Left-click: load earlier · Right-click: load full history',
  },
  loadingAllHistory: { 'zh-CN': '正在加载全部历史…', en: 'Loading full history…' },
  loadAllFailed: { 'zh-CN': '加载全部历史失败', en: 'Failed to load full history' },
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
  themeSystem: { 'zh-CN': '跟随系统', en: 'System' },
  themeDark: { 'zh-CN': '深色', en: 'Dark' },
  themeWarm: { 'zh-CN': '暖色护眼', en: 'Warm' },
  themeHearth: { 'zh-CN': '炉火', en: 'Hearth' },
  themeMatcha: { 'zh-CN': '茶室绿（浅）', en: 'Matcha (light)' },
  themeCream: { 'zh-CN': '米白纸质', en: 'Cream' },
  themeLight: { 'zh-CN': '浅色', en: 'Light' },
  themeCartoon: { 'zh-CN': '卡通风格', en: 'Cartoon' },
  themeTech: { 'zh-CN': '科技风格', en: 'Tech' },
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
  modelDeprecated: { 'zh-CN': '模型已下架或不可用，已自动回退', en: 'Model is no longer available, auto-fallback' },
  modelUnavailableRemoved: { 'zh-CN': '模型 {model} 不可用（{name}），已从模型列表移除', en: 'Model {model} unavailable ({name}), removed from model list' },
  manualSpecified: { 'zh-CN': '── 全量清单 ──', en: '── full list ──' },
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
  updateSource: { 'zh-CN': '更新源：{source}', en: 'Update source: {source}' },
  updateSourceNone: {
    'zh-CN': '无可用更新源（GitHub、镜像与 Gitee 均不可达）',
    en: 'No reachable update source (GitHub, mirrors and Gitee all failed)',
  },
  updateCheck: { 'zh-CN': '检查更新', en: 'Check for Updates' },
  updateChecking: { 'zh-CN': '检查中…', en: 'Checking…' },
  updateAvailable: { 'zh-CN': '发现新版本 v{version}', en: 'Update available: v{version}' },
  updateNotAvailable: { 'zh-CN': '已是最新版本', en: 'You are up to date' },
  updateBetaLabel: { 'zh-CN': '包含 Beta 版', en: 'Include Beta releases' },
  updateBetaHint: {
    'zh-CN': '开启后，更新检查会同时探测最新的 GitHub 预发布版本（如 0.3.5-beta.1）， stable 安装也可以收到 beta 更新。',
    en: 'When enabled, update checks also probe the newest GitHub prerelease (e.g. 0.3.5-beta.1), so stable installs can receive beta updates.',
  },
  updateDownload: { 'zh-CN': '下载更新', en: 'Download' },
  updateDownloading: { 'zh-CN': '下载中 {percent}%', en: 'Downloading {percent}%' },
  updateDownloadingSpeed: { 'zh-CN': '下载中 {percent}% · {speed}', en: 'Downloading {percent}% · {speed}' },
  updateDifferential: { 'zh-CN': '差分下载', en: 'differential' },
  updateFullDownload: { 'zh-CN': '全量下载', en: 'full download' },
  updateReady: { 'zh-CN': '更新已就绪，重启安装', en: 'Ready to install' },
  updateInstall: { 'zh-CN': '重启并安装', en: 'Restart & Install' },
  updateError: { 'zh-CN': '更新失败：{message}', en: 'Update failed: {message}' },
  updateUnavailable: { 'zh-CN': '仅安装版支持自动更新', en: 'Auto-update is only available in the installed app' },
  updateUnsupported: {
    'zh-CN': '当前安装方式不支持应用内更新（请使用 AppImage 或 deb 安装包）',
    en: 'This install type does not support in-app updates (use an AppImage or .deb install)',
  },
  updateDownloadedToast: {
    'zh-CN': '新版本 v{version} 已下载，重启后自动安装',
    en: 'v{version} downloaded — it will install when the app restarts',
  },
  updateDebHint: {
    'zh-CN': '安装 deb 更新时会请求系统授权',
    en: 'Installing this .deb update will prompt for system authorization',
  },
  updateInstallDebHint: {
    'zh-CN': '点击下方按钮后系统会弹出授权框；若无法授权，请到发布页手动下载安装包',
    en: 'Clicking below prompts for system authorization; if unavailable, download the .deb from the release page and install manually',
  },
  coreUpdateSection: { 'zh-CN': '核心更新', en: 'Core Updates' },
  coreUpdateCurrent: { 'zh-CN': '当前核心版本：v{version}', en: 'Current core: v{version}' },
  coreUpdateCheck: { 'zh-CN': '检查核心更新', en: 'Check Core Update' },
  coreUpdateChecking: { 'zh-CN': '检查中…', en: 'Checking core update…' },
  coreUpdateAvailable: { 'zh-CN': '发现核心新版本 v{version}', en: 'Core update available: v{version}' },
  coreUpdateNotAvailable: { 'zh-CN': '核心已是最新版本', en: 'Core is up to date' },
  coreUpdateDownload: { 'zh-CN': '下载核心更新', en: 'Download Core Update' },
  coreUpdateDownloading: { 'zh-CN': '下载核心更新 {percent}%', en: 'Downloading core update {percent}%' },
  coreUpdateDownloadingSpeed: { 'zh-CN': '下载核心更新 {percent}% · {speed}', en: 'Downloading core update {percent}% · {speed}' },
  coreUpdateSource: { 'zh-CN': '下载源：{source}', en: 'Download source: {source}' },
  coreUpdateReady: { 'zh-CN': '核心更新已就绪，重启应用生效', en: 'Core update ready; restart to apply' },
  coreUpdateInstall: { 'zh-CN': '重启并应用', en: 'Restart & Apply' },
  coreUpdateError: { 'zh-CN': '核心更新失败：{message}', en: 'Core update failed: {message}' },
  coreUpdateIncompatible: {
    'zh-CN': '核心 v{version} 与本客户端协议不兼容，请先更新桌面应用',
    en: 'Core v{version} is incompatible with this client; update the desktop app first',
  },
  coreUpdateCancel: { 'zh-CN': '取消下载', en: 'Cancel' },
  coreUpdateInstalling: { 'zh-CN': '正在重启…', en: 'Restarting…' },
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
  selectionCopied: { 'zh-CN': '已复制选中内容', en: 'Selection copied' },
  copiedSessionId: { 'zh-CN': '会话 ID 已复制', en: 'Session ID copied' },
  copiedProjectDir: { 'zh-CN': '项目目录已复制', en: 'Project dir copied' },
  copy: { 'zh-CN': '复制', en: 'Copy' },
  searchSessions: { 'zh-CN': '搜索会话（名称 / ID / graphId / 项目名）…', en: 'Search sessions (name / ID / graphId / project)…' },
  pinnedSessions: { 'zh-CN': '置顶', en: 'Pinned' },
  pin: { 'zh-CN': '置顶', en: 'Pin' },
  unpin: { 'zh-CN': '取消置顶', en: 'Unpin' },
  noSearchResults: { 'zh-CN': '无匹配会话', en: 'No matching sessions' },
  workerRestarted: { 'zh-CN': '核心已重启，正在恢复会话…', en: 'Core restarted, restoring session…' },
  historyLoadFailed: { 'zh-CN': '会话记录加载失败：', en: 'Failed to load this session: ' },
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
  providersNav: { 'zh-CN': '模型', en: 'Models' },
  settingsNavAria: { 'zh-CN': '设置导航', en: 'Settings navigation' },
  inputRowsLabel: { 'zh-CN': '输入框行数', en: 'Input box rows' },
  inputRowsHint: { 'zh-CN': '输入框的默认可见行数（1–20）', en: 'Default visible rows for the input box (1–20)' },
  editingSection: { 'zh-CN': '编辑与剪贴板', en: 'Editing & Clipboard' },
  linuxClipboardLabel: { 'zh-CN': 'Linux 风格剪贴板', en: 'Linux-style clipboard' },
  linuxClipboardHint: {
    'zh-CN':
      '开启（默认）：历史消息区选中即复制；Ctrl+C 复制选区；中键复制选区且不触发页面自动滚动；输入框右键等同 Ctrl+V（文本 / 图片 / 文件均可粘贴）。关闭：恢复 Windows 习惯——选区不写入剪贴板，中键恢复自动滚动，右键不粘贴，只保留 Ctrl+C / Ctrl+V。',
    en: 'On (default): selecting transcript text copies it, Ctrl+C copies the selection, middle-click copies the selection without page autoscroll, and right-clicking the composer pastes like Ctrl+V (text, images and files). Off: Windows defaults — selections leave the clipboard alone, middle-click autoscrolls, right-click does not paste, and only Ctrl+C / Ctrl+V copy and paste.',
  },
  linuxClipboardEnabled: {
    'zh-CN': '已开启：Linux 风格剪贴板（立即生效）',
    en: 'On: Linux-style clipboard (applied immediately)',
  },
  linuxClipboardDisabled: {
    'zh-CN': '已关闭：恢复 Windows 默认编辑行为（立即生效）',
    en: 'Off: Windows default editing behaviour (applied immediately)',
  },
  linuxClipboardSaveFailed: {
    'zh-CN': '保存失败，请重试',
    en: 'Failed to save, please try again',
  },
  resourceSection: { 'zh-CN': '资源与会话', en: 'Resources & Sessions' },
  rulesSection: { 'zh-CN': '全局规则', en: 'Rules' },
  rulesGlobalHint: {
    'zh-CN': '用户级工作纪律，对 agent 创建的所有会话生效（不限于当前项目）。项目宪法 .nexus/rules/NEXUS.md 会叠加其上。',
    en: 'User-level working discipline that applies to EVERY session the agent creates (not limited to the current project). The project constitution .nexus/rules/NEXUS.md is layered on top.',
  },
  rulesPathLabel: { 'zh-CN': '位置：', en: 'Location:' },
  rulesOpenFile: { 'zh-CN': '打开规则文件', en: 'Open rules file' },
  rulesReset: { 'zh-CN': '恢复默认', en: 'Reset to default' },
  rulesResetConfirm: {
    'zh-CN': '将全局规则恢复为默认模板？当前文件会备份为 .bak。',
    en: 'Reset global rules to the default template? The current file will be backed up as .bak.',
  },
  rulesResetDone: { 'zh-CN': '已恢复默认（原文件已备份）', en: 'Reset to default (previous file backed up)' },
  rulesUnavailable: { 'zh-CN': '不可用', en: 'Unavailable' },
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
  lazyWorkerLabel: { 'zh-CN': '预热备用 Worker', en: 'Pre-warm spare worker' },
  lazyWorkerHint: { 'zh-CN': '开启后自动预留一个空闲 Worker 以加速新建标签；低配电脑可关闭', en: 'Keeps one idle worker ready for faster tab creation; disable on low-end machines' },
  panelIdleLabel: { 'zh-CN': '面板自动折叠时间 (秒)', en: 'Panel auto-collapse delay (s)' },
  panelIdleHint: {
    'zh-CN': '侧边栏与文件浏览器在停止操作多久后自动折叠（5–300 秒，默认 10 秒）',
    en: 'How long after inactivity the sidebar and file browser auto-collapse (5–300 s, default 10)',
  },

  // Multi-tab (per-session worker) UI.
  tabsEmpty: { 'zh-CN': '无打开的会话标签', en: 'No open session tabs' },
  tabsAddHint: { 'zh-CN': '新建会话标签', en: 'New session tab' },
  tabsCloseHint: { 'zh-CN': '关闭此标签', en: 'Close this tab' },
  tabsMenuClose: { 'zh-CN': '关闭当前', en: 'Close' },
  tabsMenuCloseOthers: { 'zh-CN': '关闭其它', en: 'Close Others' },
  tabsMenuCloseLeft: { 'zh-CN': '关闭左侧', en: 'Close to the Left' },
  tabsMenuCloseRight: { 'zh-CN': '关闭右侧', en: 'Close to the Right' },
  tabsMenuCloseAll: { 'zh-CN': '关闭全部', en: 'Close All' },
  tabsCloseSkippedBusy: {
    'zh-CN': '已保留 {n} 个运行中的会话',
    en: 'Kept {n} running session(s) open',
  },
  tabsBusy: { 'zh-CN': '正在运行', en: 'Running' },
  tabsMaxReached: { 'zh-CN': '已达并发会话上限，无法新建标签', en: 'Concurrent session limit reached; cannot open another tab' },
  tabsMaxReachedCloseIdle: {
    'zh-CN': '已达并发会话上限（{max}），请先关闭其它闲置会话标签，再手工进入新会话',
    en: 'Concurrent session limit ({max}) reached — close other idle tabs, then start a new session manually',
  },
  tabsOverloaded: { 'zh-CN': '系统资源过高，已暂停新建会话', en: 'System overloaded; new sessions paused' },
  tabsOpenFailed: { 'zh-CN': '无法打开会话标签：', en: 'Failed to open session tab: ' },

  // Sidebar (Sub-Agents / Side Chat) — strings follow the active UI language.
  sidebarSubAgents: { 'zh-CN': '子级代理', en: 'Sub-Agents' },
  rateLimitLabel: { 'zh-CN': 'RPM 用量', en: 'RPM Usage' },
  rateLimitThrottled: { 'zh-CN': '限流中', en: 'Throttled' },
  summaryCount: { 'zh-CN': '摘要次数', en: 'Summaries' },
  compressBudgetLeft: { 'zh-CN': '下次摘要预算', en: 'Next summary budget' },
  compressStats: { 'zh-CN': '压缩统计', en: 'Compressions' },
  compressSummarize: { 'zh-CN': '摘要', en: 'Summary' },
  compressTruncate: { 'zh-CN': '截断', en: 'Truncate' },
  compressSnapshot: { 'zh-CN': '快照', en: 'Snapshot' },
  compressTotal: { 'zh-CN': '总计', en: 'Total' },
  sidebarSideChat: { 'zh-CN': '旁路对话', en: 'Side Chat' },
  subAgentsPanel: { 'zh-CN': '🛰 子代理面板', en: '🛰 Sub-Agent Panel' },
  subAgentsLegend: { 'zh-CN': '实时任务卡，不阻塞聊天', en: 'live task cards, chat never blocks' },
  subAgentsEmpty: {
    'zh-CN': '暂无多任务执行 —— 发起多任务调度后，任务卡片会实时显示在这里。',
    en: 'No multi-task runs yet — dispatch a multi-task run and its cards appear here live.',
  },
  subAgentsScopedEmpty: {
    'zh-CN': '当前会话（{session}）暂无子代理任务 —— 切换工作区后自动关联。',
    en: 'No sub-agent tasks in the current session ({session}). Switching workspaces re-associates automatically.',
  },
  subAgentsDefaultSession: { 'zh-CN': '默认会话', en: 'default session' },
  subAgentsTasks: { 'zh-CN': '{n} 个任务', en: '{n} tasks' },
  // Sub-Agents run-kind section headers (one per kind actually in flight).
  subAgentsSectionDag: { 'zh-CN': '任务图', en: 'Task graph' },
  subAgentsSectionStandalone: { 'zh-CN': '独立子代理', en: 'Standalone' },
  subAgentsSectionFanout: { 'zh-CN': '多任务执行', en: 'Fan-out' },
  // Background jobs (core bg_ shell jobs) — status line + Jobs sidebar page.
  jobsRunning: { 'zh-CN': '{n} 个后台任务运行中', en: '{n} background job(s) running' },
  bgJobDone: { 'zh-CN': '后台任务 {title}：{status}', en: 'Background job {title}: {status}' },
  bgJobStalled: { 'zh-CN': '后台任务疑似卡住：{label}', en: 'Background job looks stalled: {label}' },
  sidebarJobs: { 'zh-CN': '后台任务', en: 'Jobs' },
  jobsPanel: { 'zh-CN': '⚙ 后台任务面板', en: '⚙ Background Jobs' },
  jobsLegend: { 'zh-CN': 'Shell 与子代理任务实时状态', en: 'live shell + sub-agent job status' },
  jobsEmpty: {
    'zh-CN': '暂无后台任务 —— 用 /jobs launch 或发起子代理后，任务会显示在这里。',
    en: 'No background jobs yet — run /jobs launch or dispatch a sub-agent and cards appear here.',
  },
  jobsScopedEmpty: {
    'zh-CN': '当前会话（{session}）暂无后台任务 —— 切换工作区后自动关联。',
    en: 'No background jobs in the current session ({session}). Switching workspaces re-associates.',
  },
  jobsShellSection: { 'zh-CN': 'Shell 任务', en: 'Shell jobs' },
  jobsKill: { 'zh-CN': '终止', en: 'Kill' },
  jobsRemove: { 'zh-CN': '移除', en: 'Remove' },
  jobsTail: { 'zh-CN': '日志', en: 'Log' },
  jobsNoSession: { 'zh-CN': '无会话', en: 'no session' },
  sideChatTitle: { 'zh-CN': '💬 旁路聊天', en: '💬 Side Chat' },
  sideChatLegend: { 'zh-CN': '快速提问，不打断主对话', en: 'quick prompts, main chat untouched' },
  sideChatPlaceholder: { 'zh-CN': '输入快捷提问并回车…', en: 'type a quick prompt and press Enter…' },
  sideChatSend: { 'zh-CN': '发送', en: 'Send' },
  sideChatThinking: { 'zh-CN': '💭 思考中…', en: '💭 thinking…' },
  sideChatFailed: { 'zh-CN': '❌ 请求失败，请重试', en: '❌ request failed, try again' },
  sideChatEmptyReply: { 'zh-CN': '（空回复）', en: '(empty reply)' },

  // T6 automation control plane — sidebar Automations page.
  sidebarAutomations: { 'zh-CN': '自动化', en: 'Automations' },
  automationsPanel: { 'zh-CN': '⏰ 自动化面板', en: '⏰ Automations' },
  automationsEmpty: {
    'zh-CN': '暂无自动化任务 —— 使用 /automation create 或在会话中创建，任务会显示在这里。',
    en: 'No automations yet — use /automation create or create one in a session.',
  },
  automationsRunNow: { 'zh-CN': '立即运行', en: 'Run now' },
  automationsEnable: { 'zh-CN': '启用', en: 'Enable' },
  automationsDisable: { 'zh-CN': '禁用', en: 'Disable' },
  automationsDelete: { 'zh-CN': '删除', en: 'Delete' },
  automationsDeleteConfirm: {
    'zh-CN': '确定删除自动化「{name}」？',
    en: 'Delete automation "{name}"?',
  },
  automationsBusy: { 'zh-CN': '自动化正在运行中', en: 'Automation is busy' },
  automationsFailed: { 'zh-CN': '自动化运行失败', en: 'Automation run failed' },
  automationsCompleted: { 'zh-CN': '自动化运行完成', en: 'Automation run completed' },

  // P2 WorkBuddy artifact previews.
  artifactExportCsv: { 'zh-CN': '导出 CSV', en: 'Export CSV' },
  artifactExportPng: { 'zh-CN': '导出 PNG', en: 'Export PNG' },
  artifactError: { 'zh-CN': '产物生成失败', en: 'Artifact generation failed' },
  artifactEmptyData: { 'zh-CN': '（空数据）', en: '(empty data)' },
  artifactTruncated: { 'zh-CN': '已截断', en: 'truncated' },
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

const applyListeners = new Set<() => void>();

/** Re-run after every applyI18n() so state-dependent labels (e.g. sidebar fold
 *  hints that change with the collapsed class) survive language switches. */
export function onI18nApplied(fn: () => void): void {
  applyListeners.add(fn);
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
  for (const fn of applyListeners) {
    try { fn(); } catch { /* listener errors must not break i18n apply */ }
  }
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
