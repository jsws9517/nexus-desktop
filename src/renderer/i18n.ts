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
  // Permission-mode picker (input toolbar, next to MCP selector). Session-scoped.
  permPickTitle: { 'zh-CN': '权限模式（仅当前会话）', en: 'Permission mode (this session only)' },
  permPopoverTitle: { 'zh-CN': '权限模式', en: 'Permission mode' },
  permPopoverSub: { 'zh-CN': '仅对当前会话生效，不修改全局设置。', en: 'Applies to this session only — global settings stay untouched.' },
  permModePrompt: { 'zh-CN': 'prompt', en: 'prompt' },
  permModeAuto: { 'zh-CN': 'auto', en: 'auto' },
  permModeUnattended: { 'zh-CN': 'unattended', en: 'unattended' },
  permBadgeDefault: { 'zh-CN': '默认', en: 'default' },
  permBadgeGuard: { 'zh-CN': '安全门', en: 'guard' },
  permDescPrompt: { 'zh-CN': '每次调用工具都询问确认。', en: 'Ask for confirmation on every tool call.' },
  permDescAuto: { 'zh-CN': '自动放行工具调用，不再逐项询问。', en: 'Auto-approve tool calls without prompting.' },
  permDescUnattended: { 'zh-CN': '自动放行，但破坏性操作被硬性拦截。', en: 'Auto-approve, but hard-block destructive operations.' },
  permPopoverFoot: {
    'zh-CN': '切换只绑定到你正在查看的会话；切换标签页会显示该会话生效的模式。',
    en: 'A switch binds only to the session you are viewing; switching tabs shows that session’s effective mode.',
  },
  permSetFailed: { 'zh-CN': '权限模式切换失败：{error}', en: 'Failed to switch permission mode: {error}' },
  permChanged: { 'zh-CN': '本会话权限模式已切换为 {mode}', en: 'Session permission mode switched to {mode}' },
  inputPlaceholder: { 'zh-CN': '输入消息，Enter 发送，Shift+Enter 换行…', en: 'Type a message, Enter to send…' },

  // Voice input picker (click → auto-stop on silence → insert into composer).
  voiceInputTitle: { 'zh-CN': '语音输入', en: 'Voice input' },
  voicePopoverTitle: { 'zh-CN': '语音输入', en: 'Voice input' },
  voiceProvider: { 'zh-CN': 'STT：{name}', en: 'STT: {name}' },
  voiceHint: {
    'zh-CN': '聆听中… · 开始说话吧',
    en: 'Listening… · Start speaking',
  },
  voiceHintPreparing: {
    'zh-CN': '麦克风启动中… · 就绪后再说话',
    en: 'Starting microphone… · Speak once it is ready',
  },
  voiceHintVoice: {
    'zh-CN': '检测到语音 · 再点麦克风可立即转写',
    en: 'Speech detected · Click the mic to transcribe now',
  },
  voiceHintSilence: {
    'zh-CN': '安静中 · {seconds} 秒后自动转写',
    en: 'Quiet · Auto-transcribes in {seconds} s',
  },
  voiceMicTitleIdle: {
    'zh-CN': '语音输入 · 点击开始录音（静音 5 秒后自动转写）',
    en: 'Voice input · Click to record (auto-transcribes after 5 s of silence)',
  },
  voiceMicTitleRecording: {
    'zh-CN': '停止并转写 · 再点一次麦克风（或静音 5 秒自动转写）',
    en: 'Stop & transcribe · Click the mic again (or after 5 s of silence)',
  },
  voiceMicTitleTranscribing: {
    'zh-CN': '正在转写… · 请稍候（此时点击麦克风无效）',
    en: 'Transcribing… · Please wait (mic clicks are ignored)',
  },
  voiceMicTitleInserted: {
    'zh-CN': '开始下一段语音输入 · 点击麦克风',
    en: 'Start another voice input · Click the mic',
  },
  voiceClearTitleRecording: {
    'zh-CN': '取消本次录音（不转写）',
    en: 'Cancel this recording (no transcription)',
  },
  voiceClearTitleTranscribing: {
    'zh-CN': '取消转写',
    en: 'Cancel transcription',
  },
  voiceClearTitleInserted: {
    'zh-CN': '撤销本次语音转写（10 秒内有效）',
    en: 'Undo this transcript (within 10 s)',
  },
  voiceCannotUndo: {
    'zh-CN': '内容已修改，无法自动撤销',
    en: 'Text changed — cannot auto-undo',
  },
  voiceNoProvider: {
    'zh-CN': '未配置 STT 服务商，请先在设置中添加语音识别服务',
    en: 'No STT provider configured — add a speech-to-text provider in Settings',
  },
  voiceMicDenied: { 'zh-CN': '无法访问麦克风，请检查系统权限', en: 'Cannot access the microphone — check system permissions' },
  voiceRecordFailed: { 'zh-CN': '录音启动失败：{error}', en: 'Failed to start recording: {error}' },
  voiceTranscribeFailed: { 'zh-CN': '转写失败：{error}', en: 'Transcription failed: {error}' },
  voiceEmpty: { 'zh-CN': '没有识别到语音内容', en: 'No speech recognized' },
  voiceNoSpeech: { 'zh-CN': '未检测到语音，已取消录音', en: 'No speech detected — recording cancelled' },
  voiceTooShort: { 'zh-CN': '语音太短，已丢弃', en: 'Speech too short — discarded' },
  voiceLimit: { 'zh-CN': '录音已达 2 分钟上限，已自动停止', en: 'Reached the 2-minute limit — recording stopped' },

  // T1-2 @ mention candidates.
  atMentionPanelAria: { 'zh-CN': '上下文引用候选', en: 'Context reference candidates' },
  atMentionFile: { 'zh-CN': '文件', en: 'File' },
  atMentionDirectory: { 'zh-CN': '目录', en: 'Folder' },
  atMentionRule: { 'zh-CN': '规则', en: 'Rule' },
  atMentionInvalidPath: { 'zh-CN': '引用路径无效或越出当前项目目录', en: 'Invalid reference path or outside the current project' },
  atMentionGenericError: { 'zh-CN': '加载引用候选失败', en: 'Failed to load reference candidates' },
  atMentionFolderOverflow: {
    'zh-CN': '目录文件较多，仅引用前 {n} 个',
    en: 'Folder has many files — only the first {n} were attached',
  },
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
  compactContext: { 'zh-CN': '压缩上下文', en: 'Compact Context' },
  compactHint: { 'zh-CN': '向当前会话发送 /compact，压缩后继续', en: 'Send /compact to this session and continue' },
  compactBusy: { 'zh-CN': 'agent 忙碌中，暂不能压缩', en: 'Agent is busy — cannot compact now' },
  compactNoSession: { 'zh-CN': '没有活动会话', en: 'No active session' },
  compactCaution: { 'zh-CN': '谨慎操作：压缩会永久丢弃部分历史上下文，且不可恢复', en: 'Use with caution: compaction permanently discards part of the history and cannot be undone' },
  constraintSources: { 'zh-CN': '约束来源', en: 'Constraint Sources' },
  dedupInactiveWarn: { 'zh-CN': '当前核心不支持外部规则注入，规则可能双份注入', en: 'Core does not honor external rules — rules may be injected twice' },
  rulesNone: { 'zh-CN': '无项目规则', en: 'No project rules' },
  rulesContextOnly: { 'zh-CN': '仅项目上下文（核心）', en: 'Project context only (core)' },
  rulesEdit: { 'zh-CN': '编辑', en: 'Edit' },
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
  fbPreview: { 'zh-CN': '预览', en: 'Preview' },
  fbOpenExternal: { 'zh-CN': '外部程序打开（兜底）', en: 'Open externally (fallback)' },
  fbCopyPath: { 'zh-CN': '复制路径', en: 'Copy path' },
  fbRevealInFolder: { 'zh-CN': '在文件夹中显示', en: 'Reveal in folder' },
  fbPreviewUnavailable: { 'zh-CN': '内置预览不可用，已用外部程序打开', en: 'Built-in preview unavailable, opened externally' },
  fbGitCommitted: { 'zh-CN': '已提交', en: 'Committed' },
  fbGitModified: { 'zh-CN': '已修改', en: 'Modified' },
  fbGitUntracked: { 'zh-CN': '未跟踪', en: 'Untracked' },
  // T2-2: AI Git actions in the file browser + diff tab.
  aiCommitMessage: { 'zh-CN': 'AI 提交信息', en: 'AI Commit Message' },
  aiReviewChanges: { 'zh-CN': 'AI 审查', en: 'AI Review' },
  viewDiff: { 'zh-CN': '查看 Diff', en: 'View Diff' },
  notGitRepo: { 'zh-CN': '当前目录不是 Git 仓库', en: 'Current folder is not a Git repository' },
  diffTruncated: { 'zh-CN': '仅显示前 200 KB', en: 'Only the first 200 KB is shown' },
  diffEmpty: { 'zh-CN': '没有未提交的更改', en: 'No uncommitted changes' },
  diffTitle: { 'zh-CN': '工作区 Diff', en: 'Working Tree Diff' },
  aiCommitPrompt: { 'zh-CN': '根据当前未提交更改生成符合仓库风格的 commit message，仅输出信息正文。', en: 'Generate a commit message matching this repository\'s style from the current uncommitted changes. Output only the message body.' },
  aiReviewPrompt: { 'zh-CN': '审查当前未提交更改，输出问题清单与风险等级。', en: 'Review the current uncommitted changes and output a list of issues with risk levels.' },
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
  languageZh: { 'zh-CN': '中文', en: 'Chinese' },
  languageEn: { 'zh-CN': '英文', en: 'English' },
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
  copiedToast: { 'zh-CN': '已复制到剪贴板', en: 'Copied to clipboard' },
  copyFailedToast: { 'zh-CN': '复制失败', en: 'Copy failed' },
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

  // T1-4 security & permissions settings.
  permissionsSection: { 'zh-CN': '安全与权限', en: 'Security & Permissions' },
  permissionsModeHint: {
    'zh-CN': '此处编辑全局权限配置（~/.nexus/config.json 的 permissions 子树），保存后下次工具调用生效；只修改权限，不影响 Provider / MCP / 技能等其它配置。',
    en: 'Edit the global permission config here (the permissions subtree of ~/.nexus/config.json); changes take effect on the next tool call. Only permissions are touched — providers, MCP, skills and other config are left intact.',
  },
  permissionsGlobalMode: { 'zh-CN': '全局模式（只读）', en: 'Global mode (read-only)' },
  permissionsSessionModeNote: {
    'zh-CN': '输入框旁的会话级模式选择器只影响当前会话，不修改此处的全局配置。',
    en: 'The per-session mode selector next to the composer affects only the current session; it does not change the global config here.',
  },
  permissionsMcpAllowlist: { 'zh-CN': 'MCP 白名单（每行一个 mcp:<server> 或工具名）', en: 'MCP allowlist (one mcp:<server> or tool name per line)' },
  permissionsAllowlist: { 'zh-CN': '工具白名单（每行一个工具名，或 *）', en: 'Tool allowlist (one tool name per line, or *)' },
  permissionsExecPermission: { 'zh-CN': 'Exec 模式', en: 'Exec mode' },
  permissionsSafePaths: { 'zh-CN': 'Exec 安全路径（每行一个目录）', en: 'Exec safe paths (one directory per line)' },
  permissionsSafetyRules: { 'zh-CN': '安全规则（JSON）', en: 'Safety rules (JSON)' },
  permissionsSave: { 'zh-CN': '保存权限配置', en: 'Save permissions' },
  permissionsSaved: { 'zh-CN': '已保存，下次工具调用生效', en: 'Saved — takes effect on the next tool call' },
  permissionsInvalidJson: { 'zh-CN': '安全规则不是合法 JSON 对象，请修正后再保存', en: 'Safety rules is not a valid JSON object — fix it before saving' },
  permissionsConfigWebOpen: { 'zh-CN': '请先关闭配置网页再保存', en: 'Please close the config web UI before saving' },
  permissionsSaveFailed: { 'zh-CN': '保存失败', en: 'Failed to save' },

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
  permTimeoutLabel: { 'zh-CN': '权限卡片超时 (分钟)', en: 'Permission card timeout (min)' },
  permTimeoutHint: {
    'zh-CN': '权限卡片无人应答多久后自动拒绝（1–60 分钟，默认 10 分钟；对下一张卡片生效）',
    en: 'How long an unanswered permission card waits before auto-denying (1–60 min, default 10; applies to the next card)',
  },
  permTimeoutToast: {
    'zh-CN': '权限卡片已自动拒绝（超时未应答）',
    en: 'Permission card auto-denied (timed out with no answer)',
  },
  turnLost: {
    'zh-CN': '该回合因工作进程意外退出而中断；进度已保留，工作进程已自动重启，可继续输入。',
    en: 'This turn was interrupted by an unexpected worker exit; progress is kept and the worker restarted automatically — you can continue.',
  },
  turnLostRestart: {
    'zh-CN': '该回合因内核重启而中断；进度已保留，会话已在新内核上重新绑定，可继续输入。',
    en: 'This turn was interrupted by a core restart; progress is kept and the session was re-bound on the new core — you can continue.',
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
  sessionOpening: { 'zh-CN': '正在打开会话…', en: 'Opening session…' },
  sessionOpeningSlow: {
    'zh-CN': '会话仍在打开中，比平时稍慢，请稍候…',
    en: 'Still opening this session — taking longer than usual…',
  },
  // The session has been deleted: its row no longer exists in the sessions
  // table, so "Open session" cannot point at it. Shown by the tabs layer when
  // openSession refuses to spawn a blank worker for a gone id (defense-in-depth
  // for stale artifact rows that survived a session delete).
  tabsSessionGone: { 'zh-CN': '该会话已删除，无法打开', en: 'This session was deleted and cannot be opened' },
  // T2-3: git worktree task isolation.
  worktreeNew: { 'zh-CN': '在新 worktree 中打开', en: 'Open in New Worktree' },
  worktreeManage: { 'zh-CN': '管理 worktree', en: 'Manage Worktrees' },
  worktreeExists: { 'zh-CN': '同名 worktree 或分支已存在', en: 'A worktree or branch with that name already exists' },
  worktreeInUse: { 'zh-CN': '该 worktree 正在标签中打开，请先关闭标签', en: 'This worktree is open in a tab — close it first' },
  worktreeNamePrompt: { 'zh-CN': '输入 worktree / 分支名称（字母、数字、. _ -）', en: 'Enter a worktree / branch name (letters, digits, . _ -)' },
  worktreeDirtyHint: { 'zh-CN': '当前仓库有未提交更改；worktree 将基于 HEAD 创建，不包含这些更改。', en: 'This repository has uncommitted changes; the worktree will be created from HEAD and will not include them.' },
  worktreeCreated: { 'zh-CN': '已创建 worktree 并打开新标签', en: 'Worktree created and opened in a new tab' },
  worktreeCreateFailed: { 'zh-CN': '创建 worktree 失败：', en: 'Failed to create worktree: ' },
  worktreeRemoved: { 'zh-CN': '已移除 worktree', en: 'Worktree removed' },
  worktreeRemoveFailed: { 'zh-CN': '移除 worktree 失败：', en: 'Failed to remove worktree: ' },
  worktreeEmpty: { 'zh-CN': '当前仓库没有 worktree', en: 'No worktrees for this repository' },
  worktreeManageTitle: { 'zh-CN': '管理 worktree', en: 'Manage Worktrees' },
  worktreeRemoveBtn: { 'zh-CN': '移除', en: 'Remove' },
  // T2-1: custom agent role picker.
  agentRoleLabel: { 'zh-CN': '角色', en: 'Role' },
  agentRoleNone: { 'zh-CN': '无角色（默认）', en: 'No role (default)' },
  agentRoleUser: { 'zh-CN': '用户', en: 'user' },
  agentRoleProject: { 'zh-CN': '项目', en: 'project' },
  agentRoleInvalid: { 'zh-CN': '配置有误', en: 'invalid' },
  agentRoleTooMany: { 'zh-CN': '角色过多，已截断', en: 'Too many roles; list truncated' },

  // Unified workbench panel (子任务 / 角色 / 自动化 / 后台 / 产物)。
  workbenchEntry: { 'zh-CN': '工作台', en: 'Workbench' },
  workbenchEntrySub: {
    'zh-CN': '子任务 · 角色 · 自动化 · 后台 · 产物',
    en: 'Tasks · Roles · Automations · Jobs · Artifacts',
  },
  workbenchTitle: { 'zh-CN': '工作台', en: 'Workbench' },
  workbenchClose: { 'zh-CN': '收起工作台', en: 'Collapse workbench' },

  // T2-1: Agent Roles workbench section — novice-friendly template + form.
  sidebarAgents: { 'zh-CN': 'Agent 角色', en: 'Agent Roles' },
  agentNewRole: { 'zh-CN': '新建角色', en: 'New role' },
  agentEditRole: { 'zh-CN': '编辑角色', en: 'Edit role' },
  agentFormHint: { 'zh-CN': '结构化表单，无需手写 Markdown', en: 'Structured form — no Markdown needed' },
  agentId: { 'zh-CN': '标识 id（文件名）', en: 'Id (file name)' },
  agentName: { 'zh-CN': '名称', en: 'Name' },
  agentScope: { 'zh-CN': '保存位置', en: 'Save location' },
  agentScopeUser: { 'zh-CN': '用户级（所有项目）', en: 'User (all projects)' },
  agentScopeProject: { 'zh-CN': '项目级（仅当前项目）', en: 'Project (this project only)' },
  agentDescription: { 'zh-CN': '描述（何时使用）', en: 'Description (when to use)' },
  agentTools: { 'zh-CN': '工具白名单（逗号分隔，留空 = 不限制）', en: 'Tool allowlist (comma-separated, empty = unrestricted)' },
  agentPrompt: { 'zh-CN': '角色指令（正文）', en: 'Role instructions (body)' },
  agentCancel: { 'zh-CN': '取消', en: 'Cancel' },
  agentSave: { 'zh-CN': '保存角色', en: 'Save role' },
  agentClear: { 'zh-CN': '✕ 清除', en: '✕ Clear' },
  agentCurrent: { 'zh-CN': '当前会话角色', en: 'Current session role' },
  agentCurrentBadge: { 'zh-CN': '● 当前', en: '● Current' },
  agentTemplateTitle: { 'zh-CN': '📖 快速开始 · 配置模板', en: '📖 Quick start · config template' },
  agentTemplateHint: {
    'zh-CN': '角色是一个 Markdown 文件（用户级 ~/.nexus/agents 或项目级 <项目>/.nexus/agents）。正文写指令，frontmatter 限工具。不懂格式？点「使用此模板新建」，用表单填写即可。',
    en: 'A role is a Markdown file (user: ~/.nexus/agents, project: <project>/.nexus/agents). The body holds instructions; frontmatter limits tools. New to the format? Click "Use this template" and fill in the form.',
  },
  agentLangHint: {
    'zh-CN': '模板与内置角色的文案随界面语言切换。内置角色随应用自动安装，不可直接编辑或删除；如需修改请另存副本。',
    en: 'The template and built-in role text follows the UI language. Built-in roles are auto-installed with the app and cannot be edited or deleted — save a copy to customize.',
  },
  agentUseTemplate: { 'zh-CN': '📋 使用此模板新建', en: '📋 Use this template' },
  agentBuiltInBadge: { 'zh-CN': '内置', en: 'Built-in' },
  agentBuiltInHint: {
    'zh-CN': '内置角色随应用自动安装，在下方列表中可直接启用或「另存副本」。内置角色不可直接编辑或删除；如需修改，请另存为新角色后编辑。',
    en: 'Built-in roles are auto-installed with the app and appear in the list below — apply or save as a copy. They cannot be edited or deleted in place.',
  },
  agentPresetSaveAs: { 'zh-CN': '✎ 另存副本', en: '✎ Save as copy' },
  agentExisting: { 'zh-CN': '已有角色 ({n})', en: 'Existing roles ({n})' },
  agentEmpty: {
    'zh-CN': '还没有自定义角色。内置角色已自动安装，可从下方列表启用或另存副本；也可用上方模板新建。',
    en: 'No custom roles yet. Built-in roles are auto-installed — apply or save a copy from the list below, or create one from the template above.',
  },
  agentNoTools: { 'zh-CN': '不限制工具', en: 'Unrestricted tools' },
  agentBuiltInLocked: { 'zh-CN': '内置角色 · 随应用自动安装，不可修改或删除', en: 'Built-in · auto-installed; not editable or deletable' },
  agentApply: { 'zh-CN': '▶ 启用', en: '▶ Apply' },
  agentApplied: { 'zh-CN': '已启用', en: 'Applied' },
  agentEdit: { 'zh-CN': '✎ 编辑', en: '✎ Edit' },
  agentDelete: { 'zh-CN': '🗑 删除', en: '🗑 Delete' },
  agentConfirmDelete: { 'zh-CN': '确定删除角色「{name}」？', en: 'Delete role "{name}"?' },
  agentBadId: {
    'zh-CN': 'id 只能含字母、数字、-、_，且以字母或数字开头（最长 64 字符）',
    en: 'Id may only contain letters, digits, - and _, starting with a letter or digit (max 64 chars)',
  },
  agentBadName: { 'zh-CN': '名称不能为空', en: 'Name cannot be empty' },
  agentSaveFailed: { 'zh-CN': '保存失败', en: 'Failed to save' },
  agentDeleteFailed: { 'zh-CN': '删除失败', en: 'Failed to delete' },
  agentCopyIdTaken: { 'zh-CN': '该 id 已被其他角色占用，请更换', en: 'That id is already in use by another role — pick a different one' },
  agentCopyFailed: { 'zh-CN': '另存副本失败', en: 'Failed to save copy' },
  agentCopyApplied: { 'zh-CN': '已为你创建副本「{name}」并打开编辑；内置角色本身保持不变。', en: 'Created copy "{name}" and opened it for editing; the built-in role is unchanged.' },

  // Sidebar (Sub-Agents / Side Chat) — strings follow the active UI language.
  sidebarSubAgents: { 'zh-CN': '子级代理', en: 'Sub-Agents' },
  rateLimitLabel: { 'zh-CN': 'RPM 用量', en: 'RPM Usage' },
  rateLimitThrottled: { 'zh-CN': '限流中', en: 'Throttled' },
  rateLimitQueued: {
    'zh-CN': '⏳ 请求因限流排队中，已等待约 {n} 秒…（配额恢复后自动继续）',
    en: '⏳ Request queued by rate limiting, waited ~{n}s… (continues automatically once quota frees up)',
  },
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
    'zh-CN': '暂无自动化任务 —— 在会话中描述要建的定时任务即可（如「帮我建个定时任务：每天早上9点生成日报 Word 文档」），创建后会显示在这里；本面板可「立即运行」并查看最近运行历史。',
    en: 'No automations yet — ask in any session to create one (e.g. "create a scheduled task: generate a daily report Word doc every day at 9am") and it will appear here. Run one now and check its recent run history from this panel.',
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

  // T1-3 automation create/edit form.
  automationsNew: { 'zh-CN': '新建任务', en: 'New task' },
  automationsEdit: { 'zh-CN': '编辑', en: 'Edit' },
  automationFieldName: { 'zh-CN': '名称', en: 'Name' },
  automationFieldPrompt: { 'zh-CN': '任务提示词（执行内容）', en: 'Task prompt (what to do)' },
  automationFieldSchedule: { 'zh-CN': '调度方式', en: 'Schedule' },
  automationSchedDaily: { 'zh-CN': '每天', en: 'Daily' },
  automationSchedWeekly: { 'zh-CN': '每周', en: 'Weekly' },
  automationSchedInterval: { 'zh-CN': '每隔', en: 'Every' },
  automationSchedCron: { 'zh-CN': 'Cron 表达式', en: 'Cron expression' },
  automationTimeZoneHint: { 'zh-CN': '按本机时区', en: 'Your local time zone' },
  automationWeekMon: { 'zh-CN': '周一', en: 'Mon' },
  automationWeekTue: { 'zh-CN': '周二', en: 'Tue' },
  automationWeekWed: { 'zh-CN': '周三', en: 'Wed' },
  automationWeekThu: { 'zh-CN': '周四', en: 'Thu' },
  automationWeekFri: { 'zh-CN': '周五', en: 'Fri' },
  automationWeekSat: { 'zh-CN': '周六', en: 'Sat' },
  automationWeekSun: { 'zh-CN': '周日', en: 'Sun' },
  automationUnitMinute: { 'zh-CN': '分钟', en: 'minutes' },
  automationUnitHour: { 'zh-CN': '小时', en: 'hours' },
  automationUnitDay: { 'zh-CN': '天', en: 'days' },
  automationFieldCron: { 'zh-CN': 'Cron（分 时 日 月 周）', en: 'Cron (min hour day month weekday)' },
  automationFieldCwd: { 'zh-CN': '工作目录', en: 'Working directory' },
  automationFieldProfile: { 'zh-CN': '配置', en: 'Profile' },
  automationFieldMissPolicy: { 'zh-CN': '错过策略', en: 'Miss policy' },
  automationFieldProvider: { 'zh-CN': 'Provider（留空用默认）', en: 'Provider (blank = default)' },
  automationFieldModel: { 'zh-CN': 'Model（留空用默认）', en: 'Model (blank = default)' },
  automationCancel: { 'zh-CN': '取消', en: 'Cancel' },
  automationSave: { 'zh-CN': '保存', en: 'Save' },
  automationErrName: { 'zh-CN': '请填写名称', en: 'Please enter a name' },
  automationErrPrompt: { 'zh-CN': '请填写任务提示词', en: 'Please enter a task prompt' },
  automationErrSchedule: { 'zh-CN': '调度配置无效，请检查时间或 Cron 表达式', en: 'Invalid schedule — check the time or Cron expression' },
  automationErrSave: { 'zh-CN': '保存失败', en: 'Failed to save' },

  // P2 WorkBuddy artifact previews.
  artifactExportCsv: { 'zh-CN': '导出 CSV', en: 'Export CSV' },
  artifactExportPng: { 'zh-CN': '导出 PNG', en: 'Export PNG' },
  artifactError: { 'zh-CN': '产物生成失败', en: 'Artifact generation failed' },
  artifactEmptyData: { 'zh-CN': '（空数据）', en: '(empty data)' },
  artifactTruncated: { 'zh-CN': '已截断', en: 'truncated' },
  artifactImageUnavailable: { 'zh-CN': '图片内容不可用', en: 'Image data unavailable' },

  // T2-4: My Artifacts center (cross-session structured index).
  sidebarArtifacts: { 'zh-CN': '产物', en: 'Artifacts' },
  artifactsPanel: { 'zh-CN': '我的产物', en: 'My Artifacts' },
  artifactEmpty: { 'zh-CN': '还没有产物', en: 'No artifacts yet' },
  artifactLoadError: { 'zh-CN': '产物加载失败', en: 'Failed to load artifacts' },
  artifactRefresh: { 'zh-CN': '刷新', en: 'Refresh' },
  artifactExport: { 'zh-CN': '保存', en: 'Save' },
  artifactRevealFile: { 'zh-CN': '定位', en: 'Reveal' },
  artifactOpenSession: { 'zh-CN': '打开会话', en: 'Open session' },
  artifactOpenFile: { 'zh-CN': '打开文件', en: 'Open file' },
  artifactFilterType: { 'zh-CN': '类型', en: 'Type' },
  artifactFilterSession: { 'zh-CN': '会话', en: 'Session' },
  artifactFilterTime: { 'zh-CN': '时间', en: 'Time' },
  artifactTimeToday: { 'zh-CN': '今天', en: 'Today' },
  artifactTime7Days: { 'zh-CN': '近 7 天', en: 'Last 7 days' },
  artifactTimeAll: { 'zh-CN': '全部', en: 'All time' },
  artifactFilterAllTypes: { 'zh-CN': '全部类型', en: 'All types' },
  artifactFilterAllSessions: { 'zh-CN': '全部会话', en: 'All sessions' },
  // The "current session" sentinel option in the session dropdown. It scopes
  // the list to the live active tab; when no tab is active the list shows
  // artifactNoActiveSession instead of silently widening.
  artifactCurrentSession: { 'zh-CN': '当前会话', en: 'Current session' },
  artifactCurrentSessionHint: { 'zh-CN': '只看当前激活标签页的会话产物', en: 'Show only the active tab\'s session artifacts' },
  artifactNoActiveSession: { 'zh-CN': '当前没有激活的会话', en: 'No active session' },
  artifactUntitledSession: { 'zh-CN': '未命名会话', en: 'Untitled session' },

  // P0 Preview panel.
  previewOpenLabel: { 'zh-CN': '预览文件', en: 'Preview file' },
  previewCloseLabel: { 'zh-CN': '关闭预览', en: 'Close preview' },
  previewFullscreenLabel: { 'zh-CN': '全屏预览', en: 'Toggle fullscreen' },
  previewFitLabel: { 'zh-CN': '适应窗口', en: 'Fit to window' },
  previewZoomInLabel: { 'zh-CN': '放大', en: 'Zoom in' },
  previewZoomOutLabel: { 'zh-CN': '缩小', en: 'Zoom out' },
  previewUnsupported: { 'zh-CN': '无法内嵌预览此类型，请用系统程序打开。', en: 'Cannot preview inline — open with system app.' },
  previewTooLarge: { 'zh-CN': '文件过大（>512MB），请在外部查看。', en: 'File too large (>512 MB) — view externally.' },
  previewLoading: { 'zh-CN': '加载中…', en: 'Loading…' },
  previewFailed: { 'zh-CN': '加载失败', en: 'Failed to load' },
  artifactOpenExternal: { 'zh-CN': '外部打开', en: 'Open externally' },

  // Inline preview cards (chat stream).
  inlinePreviewReveal: { 'zh-CN': '在文件夹中显示', en: 'Reveal in folder' },
  inlinePreviewDownload: { 'zh-CN': '下载', en: 'Download' },
  inlinePreviewOpenSidebar: { 'zh-CN': '在侧栏打开', en: 'Open in sidebar' },
  inlinePreviewClose: { 'zh-CN': '关闭预览', en: 'Close preview' },
  inlinePreviewSource: { 'zh-CN': '源码', en: 'Source' },
  inlinePreviewPreview: { 'zh-CN': '预览', en: 'Preview' },
  inlinePreviewCopy: { 'zh-CN': '复制路径', en: 'Copy path' },
  inlinePreviewQuote: { 'zh-CN': '引用', en: 'Quote' },
  inlinePreviewAiGenerated: { 'zh-CN': '由 AI 生成', en: 'Generated by AI' },
  inlinePreviewLoading: { 'zh-CN': '正在加载预览…', en: 'Loading preview…' },
  inlinePreviewUnavailable: { 'zh-CN': '无法预览', en: 'Preview unavailable' },

  // PR2 right-sidebar tabs (信息 / 文件 / 浏览器 / 侧边对话).
  rsideTabInfo: { 'zh-CN': '信息', en: 'Info' },
  rsideTabFiles: { 'zh-CN': '文件', en: 'Files' },
  rsideTabBrowser: { 'zh-CN': '浏览器', en: 'Browser' },
  rsideTabSideChat: { 'zh-CN': '侧边对话', en: 'Side Chat' },

  // PR2 browser tab (WebContentsView + local iframe).
  browserBackLabel: { 'zh-CN': '后退', en: 'Back' },
  browserForwardLabel: { 'zh-CN': '前进', en: 'Forward' },
  browserReloadLabel: { 'zh-CN': '刷新', en: 'Reload' },
  browserCloseLabel: { 'zh-CN': '关闭标签页', en: 'Close tab' },
  browserAddressPlaceholder: { 'zh-CN': '输入网址 (https://…) 并回车', en: 'Enter a URL (https://…) and press Enter' },
  browserOpenedExternally: { 'zh-CN': '已在系统浏览器中打开', en: 'Opened in your system browser' },
  browserNavFailed: { 'zh-CN': '无法打开该地址', en: 'Could not open that address' },

  // PR3 document preview — doc-canvas viewers (docx/xlsx/pptx) + media bars.
  docParsing: { 'zh-CN': '解析文档中…', en: 'Parsing document…' },
  docEyebrow: { 'zh-CN': '{kind} · 文档', en: '{kind} · document' },
  docUnsupported: { 'zh-CN': '不支持的文档', en: 'Unsupported document' },
  docNoSheets: { 'zh-CN': '工作簿中未找到工作表', en: 'No sheets found in workbook' },
  docNoSlides: { 'zh-CN': '演示文稿中未找到幻灯片', en: 'No slides found in presentation' },
  docXlsxTruncated: {
    'zh-CN': '已截断 — 仅显示该工作表的前部分内容（预览上限）',
    en: 'Truncated — showing the first portion of this sheet (preview caps).',
  },
  docPptxTruncated: {
    'zh-CN': '已截断 — 仅显示前若干张幻灯片（预览上限）',
    en: 'Truncated — showing the first portion of the deck (preview caps).',
  },
  docKpiParagraphs: { 'zh-CN': '段落', en: 'Paragraphs' },
  docKpiTables: { 'zh-CN': '表格', en: 'Tables' },
  docKpiWords: { 'zh-CN': '字数（约）', en: 'Words (approx)' },
  docKpiSheets: { 'zh-CN': '工作表', en: 'Sheets' },
  docKpiSheet: { 'zh-CN': '当前工作表', en: 'Sheet' },
  docKpiRows: { 'zh-CN': '行数', en: 'Rows' },
  docKpiColumns: { 'zh-CN': '列数', en: 'Columns' },
  docKpiSlides: { 'zh-CN': '幻灯片', en: 'Slides' },
  docKpiPage: { 'zh-CN': '页码', en: 'Page' },
  docSlidePrev: { 'zh-CN': '上一张幻灯片', en: 'Previous slide' },
  docSlideNext: { 'zh-CN': '下一张幻灯片', en: 'Next slide' },
  docImageRotateLeft: { 'zh-CN': '向左旋转', en: 'Rotate left' },
  docImageRotateRight: { 'zh-CN': '向右旋转', en: 'Rotate right' },
  docTextSearchPlaceholder: { 'zh-CN': '在文件中搜索…', en: 'Search in file…' },
  docTextSearchCount: { 'zh-CN': '匹配 {n} 行', en: '{n} lines' },
  docTextTruncated: { 'zh-CN': '…（已截断）', en: '… (truncated)' },
  docLoadFailed: { 'zh-CN': '无法加载内容', en: 'Unable to load content' },
  docUnsupportedMsg: {
    'zh-CN': '此文件类型无法内联预览，请使用默认应用打开。',
    en: 'This file type cannot be previewed inline. Open with the default application instead.',
  },
  docUnimplMsg: { 'zh-CN': '此类型的内联预览尚未实现。', en: 'Inline preview is not implemented for this type yet.' },
  docOpenExternal: { 'zh-CN': '外部打开', en: 'Open externally' },
  docExternalFailed: { 'zh-CN': '外部打开失败：{error}', en: 'External open failed: {error}' },

  // Inline preview card — action-row labels (收藏/点赞/更多 were hardcoded).
  inlinePreviewFavorite: { 'zh-CN': '收藏', en: 'Favorite' },
  inlinePreviewLike: { 'zh-CN': '点赞', en: 'Like' },
  inlinePreviewMore: { 'zh-CN': '更多', en: 'More' },

  // Spend mode (消费模式) — sidebar chip + settings section + suggestion chip.
  spendMode: { 'zh-CN': '消费模式', en: 'Spend Mode' },
  spendModeHint: {
    'zh-CN': '控制 harness 的空转 / 限速 / 扇出策略。全局默认 + 每个 provider 的记忆；会话内可用 /billing 切换。',
    en: 'Paces the harness (idle / RPM / fan-out). Global default + per-provider memory; switch in-session with /billing.',
  },
  spendGlobalDefault: { 'zh-CN': '全局默认', en: 'Global default' },
  spendModeToken: { 'zh-CN': 'Token（按量，省额度）', en: 'Token (metered)' },
  spendModeCoding: { 'zh-CN': 'Coding Plan（包月）', en: 'Coding plan (subscription)' },
  spendModeFree: { 'zh-CN': 'Free（免费 / 本地）', en: 'Free (free tier / local)' },
  spendManual: { 'zh-CN': '手动', en: 'manual' },
  spendDefault: { 'zh-CN': '默认', en: 'default' },
  spendHostChanged: { 'zh-CN': '{mode} · {def} (host 已变)', en: '{mode} · {def} (host changed)' },
  spendHostChangedTitle: {
    'zh-CN': 'Provider "{provider}" 地址已变，暂按全局默认 {mode}',
    en: 'Provider "{provider}" address changed; using global default {mode} for now',
  },
  spendManualTitle: {
    'zh-CN': 'Provider "{provider}" 消费模式（{manual}）',
    en: 'Provider "{provider}" spend mode ({manual})',
  },
  spendGlobalTitle: {
    'zh-CN': 'Provider "{provider}" 消费模式（全局默认）',
    en: 'Provider "{provider}" spend mode (global default)',
  },
  spendSuggestText: {
    'zh-CN': '建议将 "{provider}" 设为 {mode} 消费模式',
    en: 'Suggest "{provider}" → {mode} spend mode',
  },
  spendSuggestApply: { 'zh-CN': '设为 {mode}', en: 'set {mode}' },
  spendSuggestApplied: {
    'zh-CN': '已将 "{provider}" 设为 {mode}',
    en: 'Set "{provider}" → {mode}',
  },
  spendSuggestDismiss: { 'zh-CN': '忽略', en: 'dismiss' },
  spendClear: { 'zh-CN': '清除', en: 'clear' },
  spendNoProviders: { 'zh-CN': '（尚无已记忆的 provider）', en: '(no providers remembered yet)' },

  // Rate-limit status chips in the session-info panel (RPM row + toast).
  rateBackoff: { 'zh-CN': '退避中', en: 'Backoff' },
  rateQueued: { 'zh-CN': '排队', en: 'Queued' },
  rateFull429: { 'zh-CN': '已满 (429)', en: 'Full (429)' },
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
