/**
 * Routing metadata for every tool the desktop exposes.
 *
 * Kept as one table rather than inline on each `ToolDef` because the tools come
 * from three places the desktop does not own: this repo's `src/tools/*`, the
 * main-process injected families (src/main/git-internal.ts, memory-kg.ts, …),
 * and whatever external MCP servers advertise. Annotating by name covers all
 * three, and keeps the selector's behaviour reviewable in a single file.
 *
 * `keywords` are the important field. The core's own filter matches raw input
 * against `name + description`, which is English-only — so for a Chinese prompt
 * the only way a tool can surface is an author-supplied term in the prompt's own
 * script. Every entry below therefore carries Chinese trigger words alongside the
 * English ones. A tool with no `keywords` still scores via bigram similarity
 * (src/tools/tool-relevance.ts), just more weakly.
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

const DESKTOP_ROUTING: Record<string, ToolRouting> = {
  // filesystem
  read_media_file: { group: 'media', readOnly: true, keywords: ['image', '图片', '看图', '截图', 'png', 'jpg', 'photo', '图片预览'] },
  list_directory_with_sizes: { group: 'fs', readOnly: true, keywords: ['list', '目录', '文件夹', '大小', 'size', '占用'] },
  list_allowed_directories: { group: 'fs', readOnly: true, keywords: ['allowed', '授权', '允许', '目录边界', 'sandbox'] },
  sequentialthinking: { group: 'meta', readOnly: true, keywords: ['think', '思考', '推理', 'reason', '分析步骤'] },

  // agents / project knowledge
  agents_index: { group: 'agents', readOnly: true, keywords: ['rule', '规则', 'constitution', '项目规范', '项目知道什么', 'agents', '约定'] },
  agents_read: { group: 'agents', readOnly: true, keywords: ['rule', '规则', 'constitution', '项目规范', '读规则'] },
  agents_search: { group: 'agents', readOnly: true, keywords: ['rule', '规则', '搜索规则', '哪条规则', '规范'] },

  // acp
  acp_router: { group: 'acp', keywords: ['acp', 'role', '角色', '代理角色', 'delegate', '委派', '派给'] },

  // data artifacts
  'sheet.read': { group: 'data', readOnly: true, keywords: ['excel', 'xlsx', 'csv', '表格', '电子表格', 'sheet', 'spreadsheet', '数据表'] },
  'sheet.analyze': { group: 'data', readOnly: true, keywords: ['excel', 'xlsx', 'csv', '表格', '分析', '统计', 'analyze', '统计表格'] },
  'bi.chart': { group: 'data', readOnly: true, keywords: ['chart', '图表', '画图', '可视化', 'visualization', 'plot', '柱状图', '饼图'] },

  // fetch / time
  fetch: { group: 'web', readOnly: true, keywords: ['fetch', 'url', '网页', '抓取', '抓取网页', 'http'] },
  get_current_time: { group: 'meta', readOnly: true, keywords: ['time', '时间', '现在几点', '日期', 'current time'] },
  convert_time: { group: 'meta', readOnly: true, keywords: ['time', '时间', '时区', '转换时间', 'convert time'] },
};

/** Every annotation, merged. Later maps do not override earlier ones. */
export const TOOL_ROUTING: Record<string, ToolRouting> = {
  ...GIT_ROUTING,
  ...MEMORY_ROUTING,
  ...SQLITE_ROUTING,
  ...DESKTOP_ROUTING,
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