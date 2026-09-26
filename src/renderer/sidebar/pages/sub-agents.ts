/**
 * Sub-Agent sidebar page (flagship use case).
 * See docs/dsh-plugin-adoption-plan.md §4.4.
 *
 * Renders a live overview of every sub-agent run in flight, grouped into three
 * sections because the three kinds are genuinely different things:
 *
 *   Task graph   — core DAG runs. Tasks render in the graph's own topological
 *                  order, so a dependency chain reads top to bottom.
 *   Standalone   — a single `spawn_subagent` outside any graph.
 *   Fan-out      — a desktop fan-out batch (one prompt → N serial sub-tasks).
 *
 * Data comes from the shared run registry (renderer.ts) plus the agent event
 * bus: fanout_start / fanout_task_progress / fanout_end for batches, and the
 * core run events (task_graph / task_* / subagent_status) that the renderer
 * mirrors into that same registry. It lives in its own sidebar container —
 * completely outside the chat stream — so multi-agent activity never blocks
 * or pollutes the conversation, and a heavy task fan-out cannot stall message
 * rendering.
 *
 * Dependency-injected so the page is unit-testable without Electron or a real
 * event bus: the test passes a fake context (scripted events + a plain Map).
 */

import { TaskStatusCard } from '../../components/TaskStatusCard.js';
import { STR } from '../../i18n.js';
import type { AgentEvent } from '../../../agent/types.js';
import type { SubAgentRunKind, SubAgentRunView, SidebarContext } from '../types.js';

export interface SubAgentsPageOptions {
  /** Optional overrides for testing (inject a different card renderer). */
  renderCard?: typeof TaskStatusCard;
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

/** Section order: the structured graph first, then the ungrouped single runs,
 *  then the desktop fan-out batches. */
const SECTION_ORDER: SubAgentRunKind[] = ['dag', 'standalone', 'fanout'];

const SECTION_LABEL_KEY: Record<SubAgentRunKind, string> = {
  dag: 'subAgentsSectionDag',
  standalone: 'subAgentsSectionStandalone',
  fanout: 'subAgentsSectionFanout',
};

function sortRunsNewestFirst(a: SubAgentRunView, b: SubAgentRunView): number {
  // Most-recently-started first (runs store startTime).
  return (b.startTime ?? 0) - (a.startTime ?? 0);
}

/** Running-first ordering, used where there is no dependency order to honour. */
function sortTasksByStatus(run: SubAgentRunView, a: string, b: string): number {
  const ra = statusRank[String(run.tasks.get(a)?.status)] ?? 99;
  const rb = statusRank[String(run.tasks.get(b)?.status)] ?? 99;
  return ra - rb;
}

/**
 * Task ids in render order. A DAG run follows the graph's own topological order
 * (taskOrder, captured verbatim from the task_graph event); tasks the graph has
 * not listed yet are appended in arrival order rather than re-sorted by status,
 * which would scramble the chain. Every other kind is a flat bag of independent
 * tasks, so running-first reads better there.
 */
function orderedTaskIds(run: SubAgentRunView): string[] {
  if (run.kind !== 'dag' || !run.taskOrder?.length) {
    return [...run.tasks.keys()].sort((a, b) => sortTasksByStatus(run, a, b));
  }
  const listed = new Set(run.taskOrder);
  const ordered = run.taskOrder.filter((id) => run.tasks.has(id));
  const unlisted = [...run.tasks.keys()].filter((id) => !listed.has(id));
  return [...ordered, ...unlisted];
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
  const renderCard = opts.renderCard ?? TaskStatusCard;
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

  /** Rebuild the whole panel from the shared run registry (cheap: card render
   *  is string-based). One section per run kind, in SECTION_ORDER. */
  const render = (): void => {
    ctx.pruneSubAgentRuns?.();
    // Self-heal: close stale "running" tasks / dead runs before rendering so
    // the task graph never shows an unclosed slot after the timeout.
    ctx.forceCloseStaleTasks?.();
    // Re-paint static labels with the live language (mount / lang changes).
    titleEl.textContent = str('subAgentsPanel', getLang());
    legendEl.textContent = str('subAgentsLegend', getLang());
    // The panel is scoped to the FOCUSED workspace: switching tabs re-associates
    // it to that session's multi-agent activity automatically.
    const activeSessionId = ctx.getActiveSessionId?.() ?? ctx.sessionId;
    scopedTracker.textContent = `🗂 ${activeSessionId ? truncateId(activeSessionId) : str('subAgentsDefaultSession', getLang())}`;
    const all = [...ctx.getSubAgentRuns().values()];
    // Runs are keyed per RUN (a graph, a standalone spawn, a fan-out batch), so
    // scoping filters on the owning session, not on the registry key.
    const runs = all.filter((run) => run.sessionId === activeSessionId);
    list.replaceChildren();
    if (runs.length === 0) {
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

    const appendRun = (run: SubAgentRunView): void => {
      const section = document.createElement('div');
      section.className = 'sub-agents-session';
      section.dataset.runKey = run.key;
      section.dataset.runKind = run.kind;

      const head = document.createElement('div');
      head.className = 'sub-agents-session-head';
      // A graph is identified by its graphId, a standalone run by what it was
      // asked to do, a fan-out batch by the prompt that produced it.
      const label = run.kind === 'dag' ? (run.graphId ?? run.prompt) : run.prompt;
      head.textContent = `${label?.slice(0, 60) || run.sessionId} — ${str('subAgentsTasks', getLang(), { n: run.tasks.size })}`;
      section.appendChild(head);

      for (const taskId of orderedTaskIds(run)) {
        const task = run.tasks.get(taskId);
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
    };

    for (const kind of SECTION_ORDER) {
      const group = runs.filter((run) => run.kind === kind).sort(sortRunsNewestFirst);
      if (group.length === 0) continue;
      // Section header — the three kinds are different things, so they are
      // labelled rather than flattened into one anonymous pile of cards.
      const groupHead = document.createElement('div');
      groupHead.className = 'sub-agents-group-head';
      groupHead.dataset.kind = kind;
      groupHead.textContent = `${str(SECTION_LABEL_KEY[kind], getLang())} · ${group.length}`;
      list.appendChild(groupHead);
      for (const run of group) appendRun(run);
    }
  };

  render();

  /** Incremental updates: a plain re-render is deterministic and O(running tasks). */
  const onEvent = (event: AgentEvent): void => {
    if (
      event.type === 'fanout_start' || event.type === 'fanout_task_progress' || event.type === 'fanout_end' || event.type === 'fanout_error'
      // Core sub-agent runs (spawn_subagent / DAG) are mirrored into the same
      // registry by the renderer — refresh on those too, not just on the desktop
      // fan-out batch events.
      || event.type === 'task_graph' || event.type === 'task_started' || event.type === 'task_completed'
      || event.type === 'task_failed' || event.type === 'task_interrupted' || event.type === 'subagent_status'
      // A task card changed inside ANY run (the renderer synthesises this for
      // dag / standalone / fanout alike).
      || event.type === 'subagent_task_progress'
      || event.type === 'session_changed' || event.type === 'language_changed'
    ) {
      render();
    }
  };

  const unsubscribe = ctx.subscribe(onEvent);
  // Auto-recycle: while the page is mounted, sweep finished runs on a timer
  // so expired cards disappear without needing an event to re-render.
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

/** Assistant binding: constructs the page with the real TaskStatusCard. */
export const SubAgentsPage = {
  id: 'sub-agents',
  title: 'Sub-Agents',
  titleKey: 'sidebarSubAgents',
  icon: '🛰',
  mount: mountSubAgentsPage,
} as const;