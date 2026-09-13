/**
 * P1 — Git sidebar page (DSH Better SideBar port).
 * See docs/dsh-plugin-adoption-plan.md §4.2 ("Git → wrap existing 36 git_* tools").
 *
 * A read-only project/git overview panel: shows the session's bound project
 * directory and the git_* tools available to the agent, so the user can see
 * at a glance where the agent operates and which git operations it can run.
 * The heavy lifting stays with the agent's 36 git_* tools invoked through
 * the main conversation — this page never spawns its own git process.
 *
 * Dependency-injected for unit tests (fake metadata/status loaders).
 */

import type { SidebarContext } from '../types.js';

export interface GitPageOptions {
  /** Resolve the bound project dir; default uses getSessionMetadata. */
  getProjectDir?: (sessionId: string) => Promise<string>;
  /** Static tool list override (default: the documented git_* surface). */
  toolNames?: string[];
  getUiLang?: () => string;
}

async function defaultGetProjectDir(sessionId: string): Promise<string> {
  try {
    const meta = (await window.nexusDesktop.getSessionMetadata(sessionId)) as Record<string, unknown>;
    return typeof meta?.projectDir === 'string' ? meta.projectDir : '';
  } catch {
    return '';
  }
}

const DEFAULT_GIT_TOOLS = [
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame',
  'git_branch', 'git_checkout', 'git_commit', 'git_stage', 'git_push',
  'git_pull', 'git_fetch', 'git_merge', 'git_rebase', 'git_stash',
  'git_reset', 'git_remote', 'git_file_history', 'git_search',
];

/**
 * Mount the Git page into `container`. Returns a dispose function that
 * removes every DOM node created here.
 */
export function mountGitPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: GitPageOptions = {},
): () => void {
  const getProjectDir = opts.getProjectDir ?? defaultGetProjectDir;
  const toolNames = opts.toolNames ?? DEFAULT_GIT_TOOLS;
  const getUiLang = opts.getUiLang ?? (() => 'zh-CN');

  container.classList.add('git-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'git-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'git-header';
  header.innerHTML = `
    <span class="git-title">${getUiLang() === 'zh-CN' ? '🔀 Git 概览' : '🔀 Git Overview'}</span>
    <span class="git-legend">${getUiLang() === 'zh-CN' ? '项目目录 · 代理可用的 git 工具' : 'project dir · agent git surface'}</span>
  `;
  root.appendChild(header);

  const dirBox = document.createElement('div');
  dirBox.className = 'git-dir';
  dirBox.dataset.testid = 'git-dir';
  dirBox.textContent = getUiLang() === 'zh-CN' ? '正在读取项目目录…' : 'Reading project dir…';
  root.appendChild(dirBox);

  const hint = document.createElement('div');
  hint.className = 'git-hint';
  hint.textContent = getUiLang() === 'zh-CN'
    ? '在对话中直接告诉代理要执行的 git 操作即可（如 "git status"、"提交最近的改动"），代理会调用下方的工具。'
    : 'Just ask the agent in chat (e.g. "git status", "commit the recent changes") — it calls the tools below.';
  root.appendChild(hint);

  const chipWrap = document.createElement('div');
  chipWrap.className = 'git-tools';
  root.appendChild(chipWrap);

  for (const name of toolNames) {
    const chip = document.createElement('span');
    chip.className = 'git-chip';
    chip.textContent = name;
    chipWrap.appendChild(chip);
  }

  void getProjectDir(ctx.sessionId).then((dir) => {
    dirBox.textContent = dir || (getUiLang() === 'zh-CN' ? '（未绑定项目目录）' : '(no project dir bound)');
  });

  return () => {
    container.classList.remove('git-page');
    container.innerHTML = '';
  };
}

/** Assistant binding: constructs the page with the real metadata bridge. */
export const GitPage = {
  id: 'git',
  title: 'Git',
  icon: '🔀',
  mount: mountGitPage,
} as const;