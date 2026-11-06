import type { SubTaskStatus } from '../../agent/types.js';

interface TaskStatusCardProps {
  taskId: string;
  description?: string;
  status: SubTaskStatus;
  output?: string;
  durationMs?: number;
  error?: string;
}

let tooltipElement: HTMLDivElement | null = null;

function getTooltipElement(): HTMLDivElement {
  if (!tooltipElement) {
    tooltipElement = document.createElement('div');
    tooltipElement.className = 'task-status-tooltip';
    tooltipElement.style.display = 'none';
    document.body.appendChild(tooltipElement);
  }
  return tooltipElement;
}

function hideTooltip(): void {
  const tooltip = getTooltipElement();
  tooltip.style.display = 'none';
}

function showTooltip(e: MouseEvent, content: string): void {
  const tooltip = getTooltipElement();
  tooltip.innerHTML = content;
  tooltip.style.display = 'block';
  
  const card = (e.target as HTMLElement).closest('.task-status-card') as HTMLElement;
  const rect = card.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  
  let left = rect.left;
  let top = rect.bottom + 8;
  
  if (left + tooltipRect.width > window.innerWidth) {
    left = window.innerWidth - tooltipRect.width - 10;
  }
  if (top + tooltipRect.height > window.innerHeight) {
    top = rect.top - tooltipRect.height - 8;
  }
  
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
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

/**
 * Escape a value for insertion into the card's HTML. Card fields (task id,
 * description, output, error) ultimately come from LLM/sub-task output, so
 * they are untrusted: without this, a poisoned sub-task result could inject
 * markup that survives into the DOM (and, via the tooltip, into a second
 * `innerHTML` sink).
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a fully-built HTML fragment for storage inside a `data-*`
 * attribute. Entity ampersands must be escaped a second time so the parser
 * hands `getAttribute()` back the intended escaped markup (rather than
 * decoding `&lt;` into a real `<` before the tooltip's `innerHTML` sink).
 */
function attrEsc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Renders one task-status card, styled exclusively through theme CSS
 * variables (`.task-status-card.status-*` in static/styles.css) — no
 * hardcoded hex/inline styles, so cards follow the app's palette in every
 * theme instead of the old grey-on-light look.
 *
 * Used for both a fan-out sub-task and a core bg_ shell job, so it is named
 * for what it shows (a task's status) rather than for one caller.
 */
export function TaskStatusCard({
  taskId, description, status, output, durationMs, error,
}: TaskStatusCardProps): string {
  const displayTitle = esc(description || taskId);
  const safeId = esc(taskId);
  const safeDescription = description ? esc(description) : '';
  const safeOutput = output ? esc(output.substring(0, 500)) + (output.length > 500 ? '...' : '') : '';
  const safeError = error ? esc(error) : '';

  const tooltipContent = `
    <div class="tooltip-header"><strong>Task ID:</strong> ${safeId}</div>
    ${safeDescription ? `<div class="tooltip-desc"><strong>Description:</strong> ${safeDescription}</div>` : ''}
    <div class="tooltip-status"><strong>Status:</strong> ${statusIcons[status]} ${status}</div>
    ${durationMs !== undefined ? `<div class="tooltip-duration"><strong>Duration:</strong> ${formatDuration(durationMs)}</div>` : ''}
    ${safeOutput ? `<div class="tooltip-output"><strong>Output:</strong> <pre>${safeOutput}</pre></div>` : ''}
    ${safeError ? `<div class="tooltip-error"><strong>Error:</strong> <pre>${safeError}</pre></div>` : ''}
  `;

  return `
    <div class="task-status-card status-${status}" 
         data-tooltip="${attrEsc(tooltipContent)}">
      <div class="ptc-head">
        <span class="ptc-title">${displayTitle}</span>
        <span class="ptc-status">${statusIcons[status]} ${status}</span>
        ${durationMs !== undefined && TERMINAL.has(status) ? `
          <span class="ptc-duration">${formatDuration(durationMs)}</span>
        ` : ''}
      </div>

      ${description ? `
        <div class="ptc-taskid">${safeId}</div>
      ` : ''}

      ${status === 'running' ? `
        <div class="ptc-progress"><div class="ptc-progress-bar"></div></div>
      ` : ''}

      ${status === 'succeeded' && output ? `
        <div class="ptc-output">${safeOutput}</div>
      ` : ''}

      ${status === 'failed' && error ? `
        <div class="ptc-error">❌ ${safeError}</div>
      ` : ''}
    </div>
  `;
}

export function initTaskStatusCardTooltips(): void {
  let currentCard: HTMLElement | null = null;

  document.addEventListener('mouseenter', (e) => {
    const card = (e.target as HTMLElement).closest('.task-status-card') as HTMLElement | null;
    if (card && card !== currentCard) {
      currentCard = card;
      const tooltipContent = card.getAttribute('data-tooltip');
      if (tooltipContent) {
        showTooltip(e, tooltipContent);
      }
    }
  }, true);

  document.addEventListener('mouseleave', (e) => {
    const card = (e.target as HTMLElement).closest('.task-status-card') as HTMLElement | null;
    if (card && card === currentCard) {
      const relatedTarget = e.relatedTarget as HTMLElement;
      if (!relatedTarget || !card.contains(relatedTarget)) {
        currentCard = null;
        hideTooltip();
      }
    }
  }, true);
}