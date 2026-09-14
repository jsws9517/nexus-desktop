/**
 * P1 — Sub-Agent sidebar page (flagship use case).
 * See docs/dsh-plugin-adoption-plan.md §4.4.
 *
 * Renders a live overview of multi-agent parallel executions: one section per
 * active orchestration (from the shared parallel-session map) with a card per
 * task, driven by the agent event bus (parallel_start / task_progress /
 * parallel_end). It lives in its own sidebar container — completely outside
 * the chat stream — so parallel activity never blocks or pollutes the
 * conversation, and a heavy task fan-out cannot stall message rendering.
 *
 * Dependency-injected so the page is unit-testable without Electron or a real
 * event bus: the test passes a fake context (scripted events + a plain Map).
 */

import { ParallelExecutionCard } from '../../components/ParallelExecutionCard.js';
import type { AgentEvent } from '../../../agent/types.js';
import type { ParallelSessionView, SidebarContext } from '../types.js';

export interface SubAgentsPageOptions {
  /** Optional overrides for testing (inject a different card renderer). */
  renderCard?: typeof ParallelExecutionCard;
  getUiLang?: () => string;
}

const statusRank: Record<string, number> = {
  running: 0,
  queued: 1,
  pending: 2,
  succeeded: 3,
  failed: 4,
  timeout: 4,
  cancelled: 5,
};

function sortSessions(a: [string, ParallelSessionView], b: [string, ParallelSessionView]): number {
  // Most-recently-started first (sessions store startTime).
  return (b[1]?.startTime ?? 0) - (a[1]?.startTime ?? 0);
}

/**
 * Mount the sub-agent page into `container`. Returns a dispose function that
 * unsubscribes from the event bus and removes every DOM node created here.
 */
export function mountSubAgentsPage(
  container: HTMLElement,
  ctx: SidebarContext,
  opts: SubAgentsPageOptions = {},
): () => void {
  const renderCard = opts.renderCard ?? ParallelExecutionCard;
  const getUiLang = opts.getUiLang ?? (() => 'zh-CN');

  container.classList.add('sub-agents-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'sub-agents-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'sub-agents-header';
  header.innerHTML = `
    <span class="sub-agents-title">${getUiLang() === 'zh-CN' ? '🛰 子代理并行面板' : '🛰 Sub-Agent Panel'}</span>
    <span class="sub-agents-legend">${getUiLang() === 'zh-CN' ? '实时任务卡，不阻塞聊天' : 'live task cards, chat never blocks'}</span>
  `;
  root.appendChild(header);

  const list = document.createElement('div');
  list.className = 'sub-agents-list';
  root.appendChild(list);

  const empty = document.createElement('div');
  empty.className = 'sub-agents-empty';
  empty.textContent = getUiLang() === 'zh-CN'
    ? '暂无并行执行 —— 发起多任务调度后，任务卡片会实时显示在这里。'
    : 'No parallel executions yet — dispatch a multi-task run and its cards appear here live.';
  list.appendChild(empty);

  /** Rebuild the whole list from the shared parallel-session map (cheap: card render is string-based). */
  const render = (): void => {
    ctx.pruneParallelSessions?.();
    const sessions = [...ctx.getParallelSessions().entries()].sort(sortSessions);
    list.replaceChildren();
    if (sessions.length === 0) {
      list.appendChild(empty);
      return;
    }
    for (const [sessionId, session] of sessions) {
      const section = document.createElement('div');
      section.className = 'sub-agents-session';

      const head = document.createElement('div');
      head.className = 'sub-agents-session-head';
      head.textContent = `${session.prompt?.slice(0, 60) || sessionId} — ${session.tasks.size} tasks`;
      section.appendChild(head);

      for (const [taskId, task] of [...session.tasks.entries()].sort((x, y) => {
        const rx = statusRank[String(x[1]?.status)] ?? 99;
        const ry = statusRank[String(y[1]?.status)] ?? 99;
        return rx - ry;
      })) {
        const card = document.createElement('div');
        card.dataset.taskId = taskId;
        card.innerHTML = renderCard({
          taskId,
          description: task?.description,
          status: (task?.status as 'running') || 'pending',
          output: task?.output,
          durationMs: task?.durationMs,
          error: task?.error,
        });
        const first = card.firstElementChild;
        if (first) section.appendChild(first);
        else section.appendChild(card);
      }
      list.appendChild(section);
    }
  };

  render();

  /** Incremental updates: a plain re-render is deterministic and O(running tasks). */
  const onEvent = (event: AgentEvent): void => {
    if (event.type === 'parallel_start' || event.type === 'task_progress' || event.type === 'parallel_end' || event.type === 'parallel_error') {
      render();
    }
  };

  const unsubscribe = ctx.subscribe(onEvent);
  // Auto-recycle: while the page is mounted, sweep finished sessions on a timer
  // so expired cards disappear without needing a parallel event to re-render.
  const autoRecycle = setInterval(() => {
    render();
  }, 10_000);
  return () => {
    clearInterval(autoRecycle);
    unsubscribe();
    container.classList.remove('sub-agents-page');
    container.innerHTML = '';
  };
}

/** Assistant binding: constructs the page with the real ParallelExecutionCard. */
export const SubAgentsPage = {
  id: 'sub-agents',
  title: 'Sub-Agents',
  icon: '🛰',
  mount: mountSubAgentsPage,
} as const;