import type { SubTaskStatus } from '../../agent/sub-agent/types.js';

interface ParallelExecutionCardProps {
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
    tooltipElement.className = 'parallel-task-tooltip';
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
  
  const card = (e.target as HTMLElement).closest('.parallel-task-card') as HTMLElement;
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

  const tooltipContent = `
    <div class="tooltip-header"><strong>Task ID:</strong> ${taskId}</div>
    ${description ? `<div class="tooltip-desc"><strong>Description:</strong> ${description}</div>` : ''}
    <div class="tooltip-status"><strong>Status:</strong> ${statusIcons[status]} ${status}</div>
    ${durationMs !== undefined ? `<div class="tooltip-duration"><strong>Duration:</strong> ${formatDuration(durationMs)}</div>` : ''}
    ${output ? `<div class="tooltip-output"><strong>Output:</strong> <pre>${output.substring(0, 500)}${output.length > 500 ? '...' : ''}</pre></div>` : ''}
    ${error ? `<div class="tooltip-error"><strong>Error:</strong> <pre>${error}</pre></div>` : ''}
  `;

  return `
    <div class="parallel-task-card status-${status}" 
         data-tooltip="${tooltipContent.replace(/"/g, '&quot;').replace(/\n/g, ' ')}">
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

export function initParallelCardTooltips(): void {
  let currentCard: HTMLElement | null = null;

  document.addEventListener('mouseenter', (e) => {
    const card = (e.target as HTMLElement).closest('.parallel-task-card') as HTMLElement | null;
    if (card && card !== currentCard) {
      currentCard = card;
      const tooltipContent = card.getAttribute('data-tooltip');
      if (tooltipContent) {
        showTooltip(e, tooltipContent);
      }
    }
  }, true);

  document.addEventListener('mouseleave', (e) => {
    const card = (e.target as HTMLElement).closest('.parallel-task-card') as HTMLElement | null;
    if (card && card === currentCard) {
      const relatedTarget = e.relatedTarget as HTMLElement;
      if (!relatedTarget || !card.contains(relatedTarget)) {
        currentCard = null;
        hideTooltip();
      }
    }
  }, true);
}