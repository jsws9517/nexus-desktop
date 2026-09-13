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

const statusColors: Record<SubTaskStatus, string> = {
  pending: '#6b7280',
  queued: '#3b82f6',
  running: '#f59e0b',
  succeeded: '#10b981',
  failed: '#ef4444',
  timeout: '#f97316',
  cancelled: '#6b7280',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function ParallelExecutionCard({ 
  taskId, description, status, output, durationMs, error 
}: ParallelExecutionCardProps) {
  const displayTitle = description || taskId;
  
  return `
    <div class="parallel-task-card" style="
      border: 1px solid ${statusColors[status]};
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 8px;
      background-color: #f9fafb;
    ">
      <div style="
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      ">
        <span style="font-weight: bold; color: #374151;">
          ${displayTitle}
        </span>
        <span style="color: ${statusColors[status]};">
          ${statusIcons[status]} ${status}
        </span>
        ${durationMs ? `
          <span style="color: #6b7280; font-size: 0.875rem;">
            ${formatDuration(durationMs)}
          </span>
        ` : ''}
      </div>
      
      ${description ? `
        <div style="
          font-size: 0.75rem;
          color: #6b7280;
          margin-bottom: 8px;
        ">${taskId}</div>
      ` : ''}
      
      ${status === 'running' ? `
        <div style="
          height: 4px;
          background-color: #e5e7eb;
          border-radius: 2px;
          overflow: hidden;
        ">
          <div style="
            height: 100%;
            width: 100%;
            background-color: ${statusColors.running};
            animation: pulse 1.5s infinite;
          "></div>
        </div>
      ` : ''}
      
      ${status === 'succeeded' && output ? `
        <div style="
          margin-top: 8px;
          padding: 8px;
          background-color: #f3f4f6;
          border-radius: 4px;
          font-size: 0.875rem;
          color: #374151;
          max-height: 200px;
          overflow: auto;
          white-space: pre-wrap;
        ">${output}</div>
      ` : ''}
      
      ${status === 'failed' && error ? `
        <div style="
          margin-top: 8px;
          padding: 8px;
          background-color: #fef2f2;
          border-radius: 4px;
          font-size: 0.875rem;
          color: #dc2626;
        ">
          ❌ ${error}
        </div>
      ` : ''}
    </div>
  `;
}
