/**
 * Routing metadata for every tool the desktop exposes.
 *
 * Kept as one table rather than inline on each `ToolDef` because the tools come
 * from four places the desktop does not own: this repo's `src/tools/*`, the
 * main-process injected families (src/main/git-internal.ts, memory-kg.ts, …),
 * whatever external MCP servers advertise, and the core's own `BUILTIN_TOOLS`
 * (nexus-coder/src/mcp/builtin-tools.ts). Annotating by name covers all four,
 * and keeps the selector's behaviour reviewable in a single file.
 *
 * `keywords` are the important field. The core's own filter matches raw input
 * against `name + description`, which is English-only — so for a Chinese prompt
 * the only way a tool can surface is an author-supplied term in the prompt's own
 * script. Every entry below therefore carries Chinese trigger words alongside the
 * English ones. A tool with no `keywords` still scores via bigram similarity
 * (src/tools/tool-relevance.ts), just more weakly.
 *
 * The core-owned builtins need entries here for exactly that reason: they ship
 * with English-only descriptions and no keywords, and they are not in
 * ESSENTIAL_TOOLS either, so the scorer drops them on any CJK prompt. `acp_route`
 * disappearing that way is what made named-agent delegation unusable.
 * test/tool-relevance.test.mjs enforces that every core builtin is either pinned,
 * routed, or explicitly listed as unrouted-by-design.
 */

import type { ToolDef, ToolGroup } from './types.js';

export interface ToolRouting {
  group: ToolGroup;
  /** Case-insensitive substrings, any language. */
  keywords?: string[];
  readOnly?: boolean;
}

const GIT_ROUTING: Record<string, ToolRouting> = {
  // read-only inspection
  git_status: { group: 'git', readOnly: true, keywords: ['git', 'status', '状态', '工作区', '有没有改动', 'uncommitted', '未提交', '当前分支'] },
  git_diff: { group: 'git', readOnly: true, keywords: ['git', 'diff', '差异', '改动', '变更', '对比', '改了', 'what changed'] },
  git_log: { group: 'git', readOnly: true, keywords: ['git', 'log', '日志', '提交历史', '历史', 'history', '谁改的'] },
  git_show: { group: 'git', readOnly: true, keywords: ['git', 'show', '查看提交', '某个提交'] },
  git_blame: { group: 'git', readOnly: true, keywords: ['git', 'blame', '谁修改', '逐行', '责任人'] },
  git_file_history: { group: 'git', readOnly: true, keywords: ['git', 'file history', '文件历史', '文件改动历史'] },
  git_search: { group: 'git', readOnly: true, keywords: ['git', 'search', '搜索提交', '查找提交'] },
  git_list_branches: { group: 'git', readOnly: true, keywords: ['git', 'branch', '分支列表', '列出分支', '本地分支', '远程分支'] },
  git_reflog: { group: 'git', readOnly: true, keywords: ['git', 'reflog', '恢复', '找回', 'recover', '丢失的提交'] },
  git_find_lost: { group: 'git', readOnly: true, keywords: ['git', 'lost', 'dangling', '丢失', '悬空提交'] },
  git_remote: { group: 'git', readOnly: true, keywords: ['git', 'remote', '远程', '远端', '仓库地址'] },
  git_stash: { group: 'git', keywords: ['git', 'stash', '暂存改动', '贮藏', '临时保存改动'] },

  // write operations
  git_commit: { group: 'git', keywords: ['git', 'commit', '提交', '提交代码', 'commit message', '保存提交'] },
  git_stage: { group: 'git', keywords: ['git', 'stage', 'add', '暂存', '加入暂存区'] },
  git_unstage: { group: 'git', keywords: ['git', 'unstage', '取消暂存', '移出暂存区'] },
  git_amend: { group: 'git', keywords: ['git', 'amend', '修改上一次提交', '修补提交'] },
  git_squash: { group: 'git', keywords: ['git', 'squash', '压缩提交', '合并提交'] },
  git_undo_commit: { group: 'git', keywords: ['git', 'undo commit', '撤销提交', '取消提交', '保留改动'] },
  git_undo_merge: { group: 'git', keywords: ['git', 'abort merge', '中止合并', '放弃合并'] },
  git_reset: { group: 'git', keywords: ['git', 'reset', '重置', '回退', 'hard reset'] },
  git_reset_to_reflog: { group: 'git', keywords: ['git', 'reflog', '恢复', '找回', 'reset to reflog'] },
  git_revert: { group: 'git', keywords: ['git', 'revert', '还原', '反向提交'] },
  git_discard_changes: { group: 'git', keywords: ['git', 'discard', '丢弃改动', '扔掉改动'] },
  git_checkout: { group: 'git', keywords: ['git', 'checkout', '切换分支', '检出'] },
  git_create_branch: { group: 'git', keywords: ['git', 'new branch', '新建分支', '创建分支'] },
  git_delete_branch: { group: 'git', keywords: ['git', 'delete branch', '删除分支'] },
  git_merge: { group: 'git', keywords: ['git', 'merge', '合并分支', '合并'] },
  git_rebase: { group: 'git', keywords: ['git', 'rebase', '变基', 'rebase'] },
  git_cherry_pick: { group: 'git', keywords: ['git', 'cherry pick', 'cherry-pick', '摘取提交'] },
  git_move_changes: { group: 'git', keywords: ['git', 'move changes', '移动改动', '带到新分支'] },
  git_fetch: { group: 'git', keywords: ['git', 'fetch', '拉取远端', '获取远端'] },
  git_pull: { group: 'git', keywords: ['git', 'pull', '拉取', '拉代码', '同步远端'] },
  git_push: { group: 'git', keywords: ['git', 'push', '推送', '推上去', '上传代码'] },
  git_update_branch: { group: 'git', keywords: ['git', 'update branch', '更新分支', '同步主分支'] },
  git_recover_branch: { group: 'git', keywords: ['git', 'recover branch', '恢复分支', '找回分支'] },
  git_recover_commit: { group: 'git', keywords: ['git', 'recover commit', '恢复提交', '找回提交'] },
};

const MEMORY_ROUTING: Record<string, ToolRouting> = {
  read_graph: { group: 'memory', readOnly: true, keywords: ['memory', 'graph', '知识图谱', '记忆', '读取图谱'] },
  search_nodes: { group: 'memory', readOnly: true, keywords: ['memory', 'search', '知识图谱', '记忆', '搜索记忆', '查找节点'] },
  open_nodes: { group: 'memory', readOnly: true, keywords: ['memory', 'open', '知识图谱', '读取节点'] },
  create_entities: { group: 'memory', keywords: ['memory', '记住', '记录', '知识图谱', '新增实体', 'remember'] },
  create_relations: { group: 'memory', keywords: ['memory', '关系', '关联', '知识图谱', '新增关系'] },
  add_observations: { group: 'memory', keywords: ['memory', '补充', '观察', '知识图谱', '追加'] },
  delete_entities: { group: 'memory', keywords: ['memory', '删除实体', '移除实体'] },
  delete_observations: { group: 'memory', keywords: ['memory', '删除观察', '移除观察'] },
  delete_relations: { group: 'memory', keywords: ['memory', '删除关系', '移除关系'] },
};

const SQLITE_ROUTING: Record<string, ToolRouting> = {
  query: { group: 'db', readOnly: true, keywords: ['sql', 'sqlite', '数据库', '查询', 'select', '查表', '查数据库'] },
  'list-tables': { group: 'db', readOnly: true, keywords: ['sql', 'sqlite', '数据库', '表', 'list tables', '有哪些表'] },
  'describe-table': { group: 'db', readOnly: true, keywords: ['sql', 'sqlite', '数据库', '表结构', 'describe', '字段'] },
  execute: { group: 'db', keywords: ['sql', 'sqlite', '数据库', '执行', 'insert', 'update', 'delete'] },
  'create-table': { group: 'db', keywords: ['sql', 'sqlite', '数据库', '建表', 'create table', '表结构'] },
  'drop-table': { group: 'db', keywords: ['sql', 'sqlite', '数据库', '删表', 'drop table'] },
  'insert-record': { group: 'db', keywords: ['sql', 'sqlite', '数据库', '插入', 'insert', '新增记录'] },
  'update-record': { group: 'db', keywords: ['sql', 'sqlite', '数据库', '更新', 'update', '修改记录'] },
  'delete-record': { group: 'db', keywords: ['sql', 'sqlite', '数据库', '删除记录', 'delete record'] },
  transaction: { group: 'db', keywords: ['sql', 'sqlite', '数据库', '事务', 'transaction', '批量执行'] },
};

/**
 * External PostgreSQL MCP tools. `@abiswas97/postgres-mcp` (and peers) expose
 * underscore-names that collide with no in-process tool except `query` (shadowed
 * by the built-in SQLite `query` and re-exposed as the `postgres__query` alias in
 * src/agent/service.ts). Routing keywords here are what lets the relevance
 * selector keep them alive on a Chinese prompt that only says
 * "查一下 postgres 数据库" — without author keywords the bigram similarity to
 * their English descriptions never clears SIMILARITY_KEEP.
 *
 * The alias `postgres__query` is annotated under its own key: `applyRouting`
 * fills `keywords`/`group` per tool name, and the aliased def keeps that name
 * through to `selectTools`.
 */
const POSTGRES_ROUTING: Record<string, ToolRouting> = {
  query: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '查询数据库', '数据库查询', 'sql查询'] },
  postgres__query: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '查询数据库', '数据库查询', 'sql查询', 'psql'] },
  describe_table: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '表结构', '字段', '表结构', 'describe table'] },
  list_objects: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '表', '有哪些表', 'list tables', 'list objects', '函数'] },
  list_schemas: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', 'schema', '数据库', '模式'] },
  list_indexes: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '索引', 'index', '索引'] },
  explain_query: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '执行计划', 'explain', 'explain', '慢', '性能'] },
  diagnose_database: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '诊断', '数据库状态', 'diagnose', '健康'] },
  get_slow_queries: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '慢查询', 'slow query', '慢sql'] },
  search_objects: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '查找表', '搜索表', 'search table', '对象'] },
  get_connections: { group: 'db', readOnly: true, keywords: ['postgres', 'postgresql', 'pg', '连接', 'connections', '活跃连接'] },
};

const DESKTOP_ROUTING: Record<string, ToolRouting> = {
  // filesystem
  read_media_file: { group: 'media', readOnly: true, keywords: ['image', '图片', '看图', '截图', 'png', 'jpg', 'photo', '图片预览', 'video', '视频', 'audio', '音频', 'mp4', 'mp3', 'media', '媒体'] },
  list_directory_with_sizes: { group: 'fs', readOnly: true, keywords: ['list', '目录', '文件夹', '大小', 'size', '占用'] },
  list_allowed_directories: { group: 'fs', readOnly: true, keywords: ['allowed', '授权', '允许', '目录边界', 'sandbox'] },
  sequentialthinking: { group: 'meta', readOnly: true, keywords: ['think', '思考', '推理', 'reason', '分析步骤'] },

  // agents / project knowledge
  agents_index: { group: 'agents', readOnly: true, keywords: ['rule', '规则', 'constitution', '项目规范', '项目知道什么', 'agents', '约定'] },
  agents_read: { group: 'agents', readOnly: true, keywords: ['rule', '规则', 'constitution', '项目规范', '读规则'] },
  agents_search: { group: 'agents', readOnly: true, keywords: ['rule', '规则', '搜索规则', '哪条规则', '规范'] },

  // acp
  acp_router: { group: 'acp', keywords: ['acp', 'role', '角色', '代理角色', 'delegate', '委派', '派给'] },
  // The core's named-agent delegation tool. Peer of acp_router above: acp_route
  // hands the prompt to a spawned ACP agent (claude/kimi/qwen/opencode), while
  // acp_router only resolves a local role config. Both must be reachable or the
  // model silently falls back to spawn_subagent.
  acp_route: {
    group: 'acp',
    keywords: [
      'acp', 'delegate', 'handoff', 'route',
      '委派', '派发', '派给', '路由', '交给', '转交', '外包',
      '子agent', '子代理', '外部agent',
      'claude', 'kimi', 'qwen', 'opencode',
    ],
  },

  // core builtins: file operations the desktop's own filesystem family does not
  // cover (that family only adds read_media_file / list_directory_with_sizes /
  // list_allowed_directories). Unrouted, they vanish on a Chinese prompt.
  create_directory: { group: 'fs', keywords: ['mkdir', '创建目录', '新建目录', '建目录', '建文件夹', '文件夹'] },
  move_file: { group: 'fs', keywords: ['move', 'rename', '移动', '重命名', '改名', '挪走'] },
  copy_file: { group: 'fs', keywords: ['copy', '复制', '拷贝', '副本'] },
  delete_file: { group: 'fs', keywords: ['delete', 'remove', '删除', '删掉', '移除文件'] },
  fetch_url: { group: 'web', keywords: ['fetch', 'url', '网页', '抓取', '网址', '抓取网页', 'http'] },

  // core builtins: skill authoring
  create_skill: { group: 'meta', keywords: ['skill', '技能', '创建技能', '新建技能', '写技能'] },
  validate_skill: { group: 'meta', keywords: ['skill', 'validate', '校验技能', '验证技能', '检查技能'] },
  fix_skill_smart: { group: 'meta', keywords: ['skill', 'fix', '修复技能', '修技能', '自动修复'] },

  // data artifacts
  'sheet.read': { group: 'data', readOnly: true, keywords: ['excel', 'xlsx', 'csv', '表格', '电子表格', 'sheet', 'spreadsheet', '数据表'] },
  'sheet.analyze': { group: 'data', readOnly: true, keywords: ['excel', 'xlsx', 'csv', '表格', '分析', '统计', 'analyze', '统计表格'] },
  'sheet.write': { group: 'data', keywords: ['写excel', '写表格', '生成excel', '导出excel', '生成表格', '导出表格', '保存为excel', 'xlsx', '写sheet'] },
  'bi.chart': { group: 'data', readOnly: true, keywords: ['chart', '图表', '画图', '可视化', 'visualization', 'plot', '柱状图', '饼图'] },

  // T7 office write family
  'docx.write': { group: 'data', keywords: ['写word', '生成word', '写文档', '导出文档', 'word文档', 'docx', '写报告', '生成报告', 'office.write'] },
  'pptx.write': { group: 'data', keywords: ['写ppt', '生成ppt', '写演示文稿', '导出ppt', 'powerpoint', 'pptx', '幻灯片', '生成幻灯片', 'office.write'] },
  'pdf.write': { group: 'data', keywords: ['写pdf', '生成pdf', '导出pdf', 'pdf文档', 'pdf写入', 'office.write'] },

  // one-time attachment RAG (per-session store, desktop)
  attachments_search: { group: 'fs', readOnly: true, keywords: ['attachment', 'attachments', 'rag', '附件', '附件检索', '文档检索', '检索附件', '搜索附件', '知识库附件'] },

  // fetch / time
  fetch: { group: 'web', readOnly: true, keywords: ['fetch', 'url', '网页', '抓取', '抓取网页', 'http'] },
  get_current_time: { group: 'meta', readOnly: true, keywords: ['time', '时间', '现在几点', '日期', 'current time'] },
  convert_time: { group: 'meta', readOnly: true, keywords: ['time', '时间', '时区', '转换时间', 'convert time'] },
  inline_search: { group: 'fs', keywords: ['inline', '搜索', '查找', 'search'] },
};

/**
 * Core agent-layer tools (nexus-coder/src/agent.ts getToolsForContext).
 *
 * These defs never reach the desktop through `agent.mcp.getAllTools()` — the
 * core adds them statically — so src/agent/service.ts merges them into the
 * candidate pool from the core's own selection result. They ship with
 * English-only descriptions and are pinned in ESSENTIAL_TOOLS, so keywords
 * here only affect ranking and `refresh_tools` intent resolution: a widening
 * request like "生成视频" must match `generate_video` by keyword, because
 * resolveRefreshIntents compares the intent against name or keywords, never
 * descriptions.
 */
const AGENT_LAYER_ROUTING: Record<string, ToolRouting> = {
  // media generation
  generate_image: { group: 'media', keywords: ['image', '图片', '生成图片', '画图', '画一张', '画个', 'draw', 'logo', 'icon', '海报', 'poster'] },
  generate_video: { group: 'media', keywords: ['video', '视频', '生成视频', '动画', '短片', 'clip', '影片', 'mv'] },
  media_task: { group: 'media', readOnly: true, keywords: ['video', '视频', 'image', '图片', '媒体', '媒体任务', '任务状态', '生成进度'] },

  // memory
  remember: { group: 'memory', keywords: ['remember', '记住', '记下', '记忆', '保存记忆'] },
  recall: { group: 'memory', readOnly: true, keywords: ['recall', '回忆', '我的信息', '我之前', '记住过', '个人信息'] },
  remember_project: { group: 'memory', keywords: ['project', '项目', '记住项目', '项目信息', '项目知识'] },

  // sub-agents / task graph
  decompose_task: { group: 'task', keywords: ['plan', 'decompose', '分解', '拆解', '计划', '拆任务', '任务规划'] },
  spawn_subagent: { group: 'task', keywords: ['subagent', '子代理', '子agent', '委派', 'spawn', 'delegate', '派给'] },
  spawn_tester: { group: 'task', keywords: ['test', '测试', '验证', 'lint', '跑测试'] },
  spawn_committer: { group: 'task', keywords: ['commit', '提交', '提交代码', 'git commit'] },
  spawn_skill_fixer: { group: 'task', keywords: ['skill', '技能', '修复技能', '修技能', '自动修复'] },
  query_tasks: { group: 'task', readOnly: true, keywords: ['task', '任务状态', '任务进度', '进度'] },
  bg_job: { group: 'exec', keywords: ['background', '后台', 'job', '后台任务', '异步任务'] },

  // media analysis
  analyze_image: { group: 'media', readOnly: true, keywords: ['image', '图片', '看图', '分析图', '这张图', '截图'] },
  ocr_extract: { group: 'media', readOnly: true, keywords: ['ocr', '文字识别', '提取文字', '识别文字', '图片文字'] },
  transcribe_audio: { group: 'media', readOnly: true, keywords: ['transcribe', '转录', '语音转文字', '音频', '转写'] },
  synthesize_speech: { group: 'media', keywords: ['speech', '语音', 'tts', '朗读', '合成语音', '配音'] },

  // session history
  last_session: { group: 'meta', readOnly: true, keywords: ['上次会话', '之前的会话', '上次对话', 'previous session'] },
  search_sessions: { group: 'meta', readOnly: true, keywords: ['搜索会话', '历史会话', '查找会话', 'session search'] },
  set_project_location: { group: 'meta', keywords: ['项目位置', '项目目录', 'project location', '仓库路径'] },

  // T6 scheduled automations (core builtin-tools family, main-process store)
  automation_create: {
    group: 'automation',
    keywords: [
      'automation', 'automations', '定时', '定时任务', '周期任务',
      '计划任务', 'scheduled', 'cron', 'interval',
      '每周', '每天', '每小时', '自动运行', '定时运行', '自动执行',
    ],
  },
  automation_list: {
    group: 'automation',
    readOnly: true,
    keywords: ['automation', '定时任务', '周期任务', '计划任务', 'scheduled', '列出自动化', '自动化列表', 'automation list'],
  },
  automation_update: {
    group: 'automation',
    keywords: ['automation', '定时任务', '周期任务', '计划任务', 'scheduled', '修改自动化', '更新自动化', 'automation update'],
  },
  automation_delete: {
    group: 'automation',
    keywords: ['automation', '删除自动化', '移除自动化', 'automation delete', '定时任务', '计划任务'],
  },
  automation_run_now: {
    group: 'automation',
    keywords: ['automation', '立即运行', '马上跑', '手动触发', 'run now', '立即执行', '定时任务', '计划任务'],
  },
  automation_runs: {
    group: 'automation',
    readOnly: true,
    keywords: ['automation', '运行历史', '执行记录', '自动化日志', 'automation runs', '定时任务', '计划任务'],
  },

  // T8 desktop perception tools (core builtin-tools, wrap PowerShell host)
  desktop_windows: {
    group: 'media',
    readOnly: true,
    keywords: ['windows', '窗口', '列表窗口', '桌面窗口', 'window list', 'win.list', '所有窗口', '打开的窗口'],
  },
  desktop_uia_find: {
    group: 'media',
    readOnly: true,
    keywords: ['uia', '查找控件', '找按钮', '找菜单', 'ui find', '控件查找', '保存按钮', 'find element', 'ui automation', '界面元素'],
  },
  desktop_uia_tree: {
    group: 'media',
    readOnly: true,
    keywords: ['uia tree', '控件树', '界面树', 'walk tree', '层次结构', 'ui tree', 'widget hierarchy', '界面层次'],
  },
  desktop_uia_invoke: {
    group: 'media',
    keywords: ['uia invoke', '点击控件', '触发菜单', 'invoke', 'ui click', 'select control', 'toggle', 'setValue', '操作控件', '触发按钮'],
  },
  desktop_input: {
    group: 'media',
    keywords: ['input', '鼠标', '键盘', 'click', '点击', '打字', '输入', '键盘操作', 'mouse', 'send input', '输入文字', '屏幕点击'],
  },
  desktop_capture: {
    group: 'media',
    readOnly: true,
    keywords: ['capture', '截图', '截屏', 'screenshot', '抓屏', '屏幕截图', 'window capture', '画面截取', '窗口截图'],
  },

  // T9 office mail send
  office_mail_send: {
    group: 'media',
    keywords: ['邮件', '发邮件', 'email', 'send mail', 'outlook', 'smtp', '发送邮件', '发邮件', 'office.mail_send', 'mail send', '收件人'],
  },

  // vault index docs (read-only search into indexed vault content)
  vault_index_docs: {
    group: 'vault',
    readOnly: true,
    keywords: ['vault', 'index', '索引', '文档索引', 'vault_index_docs'],
  },
};

/** Every annotation, merged. Later maps do not override earlier ones. */
export const TOOL_ROUTING: Record<string, ToolRouting> = {
  ...GIT_ROUTING,
  ...MEMORY_ROUTING,
  ...SQLITE_ROUTING,
  ...POSTGRES_ROUTING,
  ...DESKTOP_ROUTING,
  ...AGENT_LAYER_ROUTING,
};

/**
 * Fill in `group` / `keywords` / `readOnly` from the table, without mutating the
 * input. Defs that already declare their own metadata keep it — the table is a
 * floor, not an override, so a tool can opt out by being explicit.
 */
export function applyRouting<T extends ToolDef>(defs: T[]): T[] {
  return defs.map((def) => {
    const route = TOOL_ROUTING[def.name];
    if (!route) return def;
    if (def.group && def.keywords) return def;
    return {
      ...def,
      group: def.group ?? route.group,
      keywords: def.keywords ?? route.keywords,
      readOnly: def.readOnly ?? route.readOnly,
    };
  });
}