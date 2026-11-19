/**
 * Pure helpers for the worktree UI (T2-3). Kept free of Node built-ins so they
 * can be imported by both the main process and unit tests. All git execution
 * lives in `src/main/git-shell.ts`; this module only validates / parses.
 */

/** Project/worktree names are deliberately conservative (FR-3.3). */
export const WORKTREE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a user-supplied worktree / branch name. Returns the trimmed name or
 * `null` when it is unsafe (traversal, absolute-looking, or invalid as a git
 * ref). The caller decides what error to surface.
 */
export function sanitizeWorktreeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 80) return null;
  if (!WORKTREE_NAME_RE.test(name)) return null;
  if (name.includes('..') || name.endsWith('.') || name.endsWith('.lock')) return null;
  return name;
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
}

/**
 * Parse `git worktree list --porcelain`. Each block is separated by a blank
 * line; a missing `branch refs/heads/...` line means a detached HEAD.
 */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let path = '';
    let head = '';
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
      else if (line === 'bare') bare = true;
      else if (line === 'detached') detached = true;
    }
    if (path) out.push({ path, head, branch, bare, detached });
  }
  return out;
}
