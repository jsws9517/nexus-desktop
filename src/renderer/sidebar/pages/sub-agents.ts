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
import { STR } from '../../i18n.js';
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

/** Translate a STR key using a live language getter (ctx first, then opts). */
function str(key: string, lang: string, vars?: Record<string, string | number>): string {
  let out = STR[key]?.[lang as keyof (typeof STR)[string]] ?? STR[key]?.['zh-CN'] ?? key;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));
  return out;
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
  // Live language: prefer the context accessor (renderer keeps it current) so
  // the page re-renders in the right language after a UI language change.
  const getLang = (): string => ctx.getUiLang?.() ?? opts.getUiLang?.() ?? 'zh-CN';

  container.classList.add('sub-agents-page');
  container.innerHTML = '';

  const root = document.createElement('div');
  root.className = 'sub-agents-root';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'sub-agents-header';
  root.appendChild(header);

  const titleEl = document.createElement('span');
  titleEl.className = 'sub-agents-title';
  header.appendChild(titleEl);

  const legendEl = document.createElement('span');
  legendEl.className = 'sub-agents-legend';
  header.appendChild(legendEl);

  // Tracks the session this panel is currently bound to (updates on tab switch).
  const scopedTracker = document.createElement('span');
  scopedTracker.className = 'sub-agents-scope';
  header.appendChild(scopedTracker);

  const list = document.createElement('div');
  list.className = 'sub-agents-list';
  root.appendChild(list);

  const empty = document.createElement('div');
  empty.className = 'sub-agents-empty';
  empty.textContent = str('subAgentsEmpty', getLang());
  list.appendChild(empty);

  const truncateId = (id: string, maxLen = 8): string =>
    id.length > maxLen ? id.slice(0, maxLen) + '…' : id;

  /** Rebuild the whole list from the shared parallel-session map (cheap: card render is string-based). */
  const render = (): void => {
    ctx.pruneParallelSessions?.();
    // Self-heal: close stale "running" tasks / dead batches before rendering so
    // the task graph never shows an unclosed slot after the timeout.
    ctx.forceCloseStaleTasks?.();
    // Re-paint static labels with the live language (mount / lang changes).
    titleEl.textContent = str('subAgentsPanel', getLang());
    legendEl.textContent = str('subAgentsLegend', getLang());
    // The panel is scoped to the FOCUSED workspace: switching tabs re-associates
    // it to that session's parallel activity automatically.
    const activeSessionId = ctx.getActiveSessionId?.() ?? ctx.sessionId;
    scopedTracker.textContent = `🗂 ${activeSessionId ? truncateId(activeSessionId) : str('subAgentsDefaultSession', getLang())}`;
    const all = [...ctx.getParallelSessions().entries()];
    const sessions = all.filter(([sid]) => sid === activeSessionId).sort(sortSessions);
    list.replaceChildren();
    if (sessions.length === 0) {
      if (all.length > 0) {
        empty.textContent = str('subAgentsScopedEmpty', getLang(), {
          session: truncateId(activeSessionId || (ctx.sessionId || '—')),
        });
      } else {
        empty.textContent = str('subAgentsEmpty', getLang());
      }
      list.appendChild(empty);
      return;
    }
    for (const [sessionId, session] of sessions) {
      const section = document.createElement('div');
      section.className = 'sub-agents-session';

      const head = document.createElement('div');
      head.className = 'sub-agents-session-head';
      head.textContent = `${session.prompt?.slice(0, 60) || sessionId} — ${str('subAgentsTasks', getLang(), { n: session.tasks.size })}`;
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
    if (event.type === 'parallel_start' || event.type === 'task_progress' || event.type === 'parallel_end' || event.type === 'parallel_error' || event.type === 'session_changed' || event.type === 'language_changed') {
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
  titleKey: 'sidebarSubAgents',
  icon: '🛰',
  mount: mountSubAgentsPage,
} as const;