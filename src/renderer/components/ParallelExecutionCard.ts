import type { SubTaskStatus } from '../../agent/sub-agent/types.js';

interface ParallelExecutionCardProps {
  taskId: string;
  description?: string;
  status: SubTaskStatus;
  output?: string;
  durationMs?: number;
  error?: string;
}

const statusIcons: Record<SubTaskStatus, string> = {
  pending: '⏳',
  queued: '📋',
  running: '🔄',
  succeeded: '✅',
  failed: '❌',
  timeout: '⏱️',
  cancelled: '🚫',
};

const TERMINAL = new Set<SubTaskStatus>(['succeeded', 'failed', 'timeout', 'cancelled']);

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Renders one sub-agent task card, styled exclusively through theme CSS
 * variables (`.parallel-task-card.status-*` in static/styles.css) — no
 * hardcoded hex/inline styles, so cards follow the app's palette in every
 * theme instead of the old grey-on-light look.
 */
export function ParallelExecutionCard({
  taskId, description, status, output, durationMs, error,
}: ParallelExecutionCardProps): string {
  const displayTitle = description || taskId;

  return `
    <div class="parallel-task-card status-${status}">
      <div class="ptc-head">
        <span class="ptc-title">${displayTitle}</span>
        <span class="ptc-status">${statusIcons[status]} ${status}</span>
        ${durationMs !== undefined && TERMINAL.has(status) ? `
          <span class="ptc-duration">${formatDuration(durationMs)}</span>
        ` : ''}
      </div>

      ${description ? `
        <div class="ptc-taskid">${taskId}</div>
      ` : ''}

      ${status === 'running' ? `
        <div class="ptc-progress"><div class="ptc-progress-bar"></div></div>
      ` : ''}

      ${status === 'succeeded' && output ? `
        <div class="ptc-output">${output}</div>
      ` : ''}

      ${status === 'failed' && error ? `
        <div class="ptc-error">❌ ${error}</div>
      ` : ''}
    </div>
  `;
}