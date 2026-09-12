import type { SubTask } from './types.js';

/**
 * Read-only tools that can be executed in parallel.
 * Based on actual tool definitions from src/tools/ and src/main/.
 */
export const READ_ONLY_TOOLS = new Set([
  // Filesystem tools
  'read_media_file',
  'list_directory_with_sizes',
  'list_allowed_directories',
  
  // Sequential thinking
  'sequentialthinking',
  
  // SQLite read operations
  'query',
  'list-tables',
  'describe-table',
  
  // Skills
  'sheet.read',
  'sheet.analyze',
  'bi.chart',
  
  // Memory read operations
  'read_graph',
  'search_nodes',
  'open_nodes',
  
  // Git read operations
  'git_list_branches',
  'git_blame',
  'git_diff',
  'git_file_history',
  'git_log',
  'git_search',
  'git_show',
  'git_status',
  'git_find_lost',
  'git_reflog',
  
  // Fetch
  'fetch',
  
  // Time
  'get_current_time',
  'convert_time',
]);

/**
 * Write tools that require serial execution.
 * These tools modify state and cannot run concurrently.
 */
export const WRITE_TOOLS = new Set([
  // SQLite write operations
  'execute',
  'create-table',
  'drop-table',
  'insert-record',
  'update-record',
  'delete-record',
  'transaction',
  
  // Memory write operations
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_observations',
  'delete_relations',
  
  // Git write operations
  'git_checkout',
  'git_cherry_pick',
  'git_create_branch',
  'git_delete_branch',
  'git_merge',
  'git_move_changes',
  'git_rebase',
  'git_commit',
  'git_stage',
  'git_amend',
  'git_squash',
  'git_fetch',
  'git_pull',
  'git_push',
  'git_remote',
  'git_stash',
  'git_update_branch',
  'git_discard_changes',
  'git_reset',
  'git_revert',
  'git_undo_commit',
  'git_undo_merge',
  'git_unstage',
  'git_recover_branch',
  'git_recover_commit',
  'git_reset_to_reflog',
]);

/**
 * Check if a task requires serial execution due to write operations.
 */
export function requiresSerialization(task: SubTask): boolean {
  if (!task.tools || task.tools.length === 0) return false;
  return task.tools.some(t => WRITE_TOOLS.has(t));
}

/**
 * Filter tools to only include read-only tools safe for parallel execution.
 */
export function filterToolsForSubAgent(allowedTools?: string[]): string[] {
  if (!allowedTools) return Array.from(READ_ONLY_TOOLS);
  return allowedTools.filter(t => READ_ONLY_TOOLS.has(t));
}

/**
 * Get all available tool names (for validation).
 */
export function getAllToolNames(): string[] {
  return [...Array.from(READ_ONLY_TOOLS), ...Array.from(WRITE_TOOLS)];
}
