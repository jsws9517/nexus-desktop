/**
 * Built-in git engine (replaces the external `git-mcp` MCP server for the
 * desktop app).
 *
 * Every one of the 36 `git_*` tools exercised by the model is served here
 * in-process in the main process:
 *   - commands run as `git` child processes with an argv array (no shell
 *     string interpolation, so no shell-injection surface),
 *   - the repository is resolved from the tool's `cwd` argument, the
 *     configured `git` server's `--repository` arg, the last successfully
 *     resolved repo, or the current working directory - in that order,
 *   - read-heavy tools (status/log/diff/branches/show/file_history/blame/
 *     search) are cached per repo for a short TTL and invalidated the moment
 *     any mutating tool runs, so repeated reads return in the low-millisecond
 *     range instead of paying a fresh git-process spawn every time.
 *
 * Output keeps 1:1 parity with git-mcp v1.0.0 (same tool names, schemas,
 * JSON shapes and error strings) so model-facing behaviour is unchanged.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { logger } from '../shared/logger.js';

interface GitToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server: string;
}

export type GitToolResult = { content: string; isError: boolean };

const STR = (description: string): unknown => ({ type: 'string', description });
const NUM = (description: string): unknown => ({ type: 'number', description });
const BOOL = (description: string): unknown => ({ type: 'boolean', description });
const ENUM = (values: string[], description: string): unknown => ({
  type: 'string',
  enum: values,
  description,
});
const STRARR = (description: string): unknown => ({
  type: 'array',
  items: { type: 'string', description },
  description,
});
const CWD = STR('Working directory path');

type Args = Record<string, unknown>;

const S = (v: unknown): string => (typeof v === 'string' ? v : '');
const B = (v: unknown): boolean => v === true;
const N = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const A = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const E = <T extends string>(v: unknown, def: T, allowed: readonly T[]): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;

/** Exact tool names served by the built-in engine (36, mirrors git-mcp v1.0.0). */
export const GIT_INTERNAL_TOOLS = new Set([
  'git_checkout',
  'git_cherry_pick',
  'git_create_branch',
  'git_delete_branch',
  'git_list_branches',
  'git_merge',
  'git_move_changes',
  'git_rebase',
  'git_commit',
  'git_stage',
  'git_amend',
  'git_squash',
  'git_blame',
  'git_diff',
  'git_file_history',
  'git_log',
  'git_search',
  'git_show',
  'git_status',
  'git_find_lost',
  'git_recover_branch',
  'git_recover_commit',
  'git_reflog',
  'git_reset_to_reflog',
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
]);

/** Mutating tools that need the same approval gate as sqlite/memory writes. */
export const GIT_WRITE_TOOLS = new Set([
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

export const GIT_TOOL_DEFS: GitToolDef[] = [
  { name: 'git_checkout', description: 'Switch to a different branch.', inputSchema: { type: 'object', properties: { branch: STR('Branch name to switch to'), cwd: CWD }, required: ['branch'] }, server: 'git-internal' },
  { name: 'git_cherry_pick', description: 'Apply commit(s) from another branch to current branch.', inputSchema: { type: 'object', properties: { commit: STR('Commit hash to cherry-pick'), endCommit: STR('End commit for cherry-picking a range (startCommit^..endCommit)'), noCommit: BOOL('Apply changes without committing'), cwd: CWD }, required: ['commit'] }, server: 'git-internal' },
  { name: 'git_create_branch', description: 'Create a new branch, optionally from a specific commit or ref.', inputSchema: { type: 'object', properties: { name: STR('Name of the new branch'), fromRef: STR('Create branch from this ref (commit, branch, tag). Defaults to HEAD.'), checkout: BOOL('Switch to the new branch after creating it'), cwd: CWD }, required: ['name'] }, server: 'git-internal' },
  { name: 'git_delete_branch', description: 'Delete a local branch. Use force to delete unmerged branches.', inputSchema: { type: 'object', properties: { branch: STR('Branch name to delete'), force: BOOL('Force delete even if not fully merged'), cwd: CWD }, required: ['branch'] }, server: 'git-internal' },
  { name: 'git_list_branches', description: 'List git branches. Can show local, remote, or all branches.', inputSchema: { type: 'object', properties: { all: BOOL('Show all branches (local and remote)'), remote: BOOL('Show only remote branches'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_merge', description: 'Merge a branch into the current branch.', inputSchema: { type: 'object', properties: { branch: STR('Branch to merge into current branch'), noFastForward: BOOL('Create a merge commit even if fast-forward is possible'), squash: BOOL('Squash all commits into one (does not auto-commit)'), message: STR('Custom merge commit message'), cwd: CWD }, required: ['branch'] }, server: 'git-internal' },
  { name: 'git_move_changes', description: 'Move uncommitted changes to a new branch. Stashes changes, creates branch, and applies them.', inputSchema: { type: 'object', properties: { branch: STR('Name of the new branch to move changes to'), cwd: CWD }, required: ['branch'] }, server: 'git-internal' },
  { name: 'git_rebase', description: 'Rebase current branch onto another branch. Can also abort or continue a rebase.', inputSchema: { type: 'object', properties: { target: STR('Target branch or commit to rebase onto'), abort: BOOL('Abort an in-progress rebase'), continue: BOOL('Continue a paused rebase'), cwd: CWD }, required: ['target'] }, server: 'git-internal' },
  { name: 'git_commit', description: 'Create a new commit with staged changes.', inputSchema: { type: 'object', properties: { message: STR('Commit message'), allowEmpty: BOOL('Allow creating an empty commit'), cwd: CWD }, required: ['message'] }, server: 'git-internal' },
  { name: 'git_stage', description: 'Stage files for commit. Can stage specific files or all changes.', inputSchema: { type: 'object', properties: { files: STRARR('Files to stage. If not provided, stages all changes.'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_amend', description: 'Amend the last commit. Can change the message and/or include staged changes.', inputSchema: { type: 'object', properties: { message: STR('New commit message. If not provided, keeps the original message.'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_squash', description: 'Squash the last N commits into a single commit with a new message.', inputSchema: { type: 'object', properties: { count: NUM('Number of commits to squash into one'), message: STR('Commit message for the squashed commit'), cwd: CWD }, required: ['count', 'message'] }, server: 'git-internal' },
  { name: 'git_blame', description: 'Show who last modified each line of a file.', inputSchema: { type: 'object', properties: { file: STR('File path to blame'), startLine: NUM('Start line number for range'), endLine: NUM('End line number for range'), cwd: CWD }, required: ['file'] }, server: 'git-internal' },
  { name: 'git_diff', description: 'Show changes between commits, staging area, or working directory.', inputSchema: { type: 'object', properties: { staged: BOOL('Show staged changes'), commitA: STR('First commit for comparison'), commitB: STR('Second commit for comparison'), file: STR('Specific file to diff'), stat: BOOL('Show only file statistics'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_file_history', description: 'Show commit history for a specific file, including renames.', inputSchema: { type: 'object', properties: { file: STR('File path to show history for'), count: NUM('Number of commits to show'), follow: BOOL('Follow file renames'), cwd: CWD }, required: ['file'] }, server: 'git-internal' },
  { name: 'git_log', description: 'Show commit history with various filters.', inputSchema: { type: 'object', properties: { count: NUM('Number of commits to show'), file: STR('Show commits for specific file'), author: STR('Filter by author name or email'), since: STR('Show commits after date (e.g., "2024-01-01")'), until: STR('Show commits before date'), grep: STR('Filter by commit message'), oneline: BOOL('Show compact one-line format'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_search', description: 'Search commits by message, content changes, or author.', inputSchema: { type: 'object', properties: { term: STR('Search term'), type: ENUM(['message', 'content', 'author'], 'Search type: message (commit messages), content (code changes), author'), count: NUM('Maximum results to return'), cwd: CWD }, required: ['term'] }, server: 'git-internal' },
  { name: 'git_show', description: 'Show details of a specific commit including changes.', inputSchema: { type: 'object', properties: { commit: STR('Commit hash, branch, or reference to show'), stat: BOOL('Show file change statistics'), patch: BOOL('Show the actual changes (diff)'), cwd: CWD }, required: ['commit'] }, server: 'git-internal' },
  { name: 'git_status', description: 'Show the working tree status - staged, unstaged, and untracked files.', inputSchema: { type: 'object', properties: { cwd: CWD } }, server: 'git-internal' },
  { name: 'git_find_lost', description: 'Find dangling/unreachable commits that may have been lost.', inputSchema: { type: 'object', properties: { cwd: CWD } }, server: 'git-internal' },
  { name: 'git_recover_branch', description: 'Recover a deleted branch by searching the reflog.', inputSchema: { type: 'object', properties: { branch: STR('Name of the deleted branch to recover'), cwd: CWD }, required: ['branch'] }, server: 'git-internal' },
  { name: 'git_recover_commit', description: 'Recover a lost commit by creating a branch or cherry-picking it.', inputSchema: { type: 'object', properties: { commit: STR('Commit hash to recover'), createBranch: STR('Create a new branch at this commit'), cherryPick: BOOL('Cherry-pick the commit to current branch'), cwd: CWD }, required: ['commit'] }, server: 'git-internal' },
  { name: 'git_reflog', description: 'Show reference log - useful for recovering lost commits and branches.', inputSchema: { type: 'object', properties: { count: NUM('Number of reflog entries to show'), search: STR('Search term to filter reflog entries'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_reset_to_reflog', description: 'Reset to a previous state from reflog. Use git_reflog first to find the index.', inputSchema: { type: 'object', properties: { index: NUM('Reflog index (e.g., 0 for HEAD@{0}, 1 for HEAD@{1})'), mode: ENUM(['soft', 'mixed', 'hard'], 'Reset mode: soft (keep staged), mixed (unstage), hard (discard all)'), cwd: CWD }, required: ['index'] }, server: 'git-internal' },
  { name: 'git_fetch', description: 'Fetch changes from all remotes without merging.', inputSchema: { type: 'object', properties: { prune: BOOL('Remove remote-tracking branches that no longer exist'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_pull', description: 'Pull changes from remote. Can use rebase to avoid merge commits.', inputSchema: { type: 'object', properties: { rebase: BOOL('Use rebase instead of merge when pulling'), remote: STR('Remote name'), branch: STR('Specific branch to pull'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_push', description: 'Push commits to remote. Supports safe force push with --force-with-lease.', inputSchema: { type: 'object', properties: { remote: STR('Remote name'), branch: STR('Specific branch to push'), force: BOOL('Force push (dangerous - use forceWithLease instead)'), forceWithLease: BOOL('Force push safely - fails if remote has new commits'), setUpstream: BOOL('Set upstream tracking branch'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_remote', description: 'Manage git remotes. List, add, or remove remotes.', inputSchema: { type: 'object', properties: { action: ENUM(['list', 'add', 'remove'], 'Remote action to perform'), name: STR('Remote name (required for add/remove)'), url: STR('Remote URL (required for add)'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_stash', description: 'Stash or restore uncommitted changes. Save, pop, list, or drop stashes.', inputSchema: { type: 'object', properties: { action: ENUM(['save', 'pop', 'list', 'drop'], 'Stash action to perform'), message: STR('Message for the stash (when saving)'), index: NUM('Stash index for pop/drop operations'), includeUntracked: BOOL('Include untracked files when saving'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_update_branch', description: 'Update current branch with latest changes from main/master branch.', inputSchema: { type: 'object', properties: { useRebase: BOOL('Use rebase (true) or merge (false) to update'), mainBranch: STR('Main branch name (defaults to origin default branch)'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_discard_changes', description: 'Discard local changes. Can discard all changes or changes to a specific file.', inputSchema: { type: 'object', properties: { file: STR('Specific file to discard changes for. If not provided, discards all changes.'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_reset', description: 'Reset current branch to a specific commit. Use soft/mixed to keep changes, hard to discard.', inputSchema: { type: 'object', properties: { commitRef: STR('Commit hash, branch name, or reference (e.g., HEAD~3, origin/main)'), mode: ENUM(['soft', 'mixed', 'hard'], 'soft: keep changes staged, mixed: keep changes unstaged, hard: discard all changes'), cwd: CWD }, required: ['commitRef'] }, server: 'git-internal' },
  { name: 'git_revert', description: 'Revert commits by creating new commits that undo changes. Safe for shared branches.', inputSchema: { type: 'object', properties: { count: NUM('Number of commits to revert from HEAD'), commitHash: STR('Specific commit hash to revert'), noCommit: BOOL('Stage the revert changes without committing'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_undo_commit', description: 'Undo the last commit while keeping changes. Use this when you want to uncommit but keep your work.', inputSchema: { type: 'object', properties: { soft: BOOL('If true, keeps changes staged. If false, unstages changes.'), cwd: CWD } }, server: 'git-internal' },
  { name: 'git_undo_merge', description: 'Abort an in-progress merge. Use this when you have merge conflicts and want to start over.', inputSchema: { type: 'object', properties: { cwd: CWD } }, server: 'git-internal' },
  { name: 'git_unstage', description: 'Unstage files that were added with git add. Keeps the changes but removes them from staging.', inputSchema: { type: 'object', properties: { file: STR('Specific file to unstage. If not provided, unstages all files.'), cwd: CWD } }, server: 'git-internal' },
];

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const EXEC_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Run git with an argv array (no shell). cwd must already be in a repo. */
function gitRun(argv: string[], cwd: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', argv, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 });
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), stderr: 'Git command timed out', exitCode: 1 });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (chunks.reduce((n, c) => n + c.length, 0) + d.length > MAX_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve({ stdout: Buffer.concat([...chunks, d]).toString('utf-8').slice(0, MAX_OUTPUT_BYTES), stderr: 'Output exceeded 50MB limit', exitCode: 1 });
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), stderr: err.message, exitCode: 1 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), stderr, exitCode: code ?? 1 });
    });
  });
}

function formatGitError(error: string): string {
  if (error.includes('not a git repository')) {
    return 'Error: Not a git repository. Please run this command from within a git repository.';
  }
  if (error.includes('CONFLICT')) {
    return `Merge conflict detected:\n${error}\n\nTo resolve conflicts:\n1. Edit the conflicted files\n2. Run 'git add <file>' to mark as resolved\n3. Complete the operation`;
  }
  if (error.includes('nothing to commit')) {
    return 'No changes to commit. Working tree is clean.';
  }
  return error;
}

function okJson(payload: Record<string, unknown>, command: string): GitToolResult {
  return { content: JSON.stringify({ ...payload, command }, null, 2), isError: false };
}

function errJson(stderr: string, command: string): GitToolResult {
  return { content: JSON.stringify({ success: false, error: formatGitError(stderr.trim()), command }, null, 2), isError: true };
}

function caughtJson(err: unknown): GitToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: JSON.stringify({ error: msg }, null, 2), isError: true };
}

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

function parseCommits(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of stdout.split('\n').filter((l) => l.trim())) {
    const parts = line.split('|');
    if (parts.length >= 6) {
      commits.push({
        hash: parts[0],
        shortHash: parts[1],
        author: parts[2],
        email: parts[3],
        date: parts[4],
        message: parts.slice(5).join('|'),
      });
    }
  }
  return commits;
}

function parseOnelineCommits(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of stdout.split('\n').filter((l) => l.trim())) {
    const [shortHash, ...messageParts] = line.split(' ');
    commits.push({ hash: '', shortHash, author: '', email: '', date: '', message: messageParts.join(' ') });
  }
  return commits;
}

interface GitReflogEntry {
  hash: string;
  action: string;
  message: string;
}

interface GitBlameEntry {
  commit: string;
  author: string;
  date: string;
  content: string;
  lineNumber: number;
}

interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  trackingBranch?: string;
}

/** --repository target from the configured `git` server; the default repo. */
function configuredRepository(): string | null {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.nexus', 'config.json'), 'utf-8'),
    ) as { mcpServers?: Record<string, { args?: string[] }> };
    const args = cfg.mcpServers?.git?.args ?? [];
    const i = args.indexOf('--repository');
    const value = i >= 0 ? args[i + 1] : undefined;
    return typeof value === 'string' && value.trim() ? resolvePath(value) : null;
  } catch {
    return null;
  }
}

class GitInternalEngine {
  private lastRepo: string | null = null;
  private rootCache = new Map<string, string | null>();
  private cache = new Map<string, { ts: number; text: string; isError: boolean }>();

  private resolveRoot(candidate: string): Promise<string | null> {
    const key = candidate.toLowerCase();
    if (this.rootCache.has(key)) return Promise.resolve(this.rootCache.get(key) ?? null);
    return gitRun(['rev-parse', '--show-toplevel'], candidate, 10_000).then((r) => {
      const root = r.exitCode === 0 && r.stdout.trim() ? resolvePath(r.stdout.trim()) : null;
      this.rootCache.set(key, root);
      if (root) this.lastRepo = root;
      return root;
    });
  }

  /** Inside any already-known repo? (fast path, no process spawn) */
  private knownRoot(candidate: string): string | null {
    const c = candidate.toLowerCase();
    if (this.lastRepo && (c === this.lastRepo.toLowerCase() || `${c}\\`.startsWith(`${this.lastRepo.toLowerCase()}\\`))) {
      return this.lastRepo;
    }
    return null;
  }

  private async resolveContext(args: Args): Promise<{ repo: string } | { error: string }> {
    const cwdArg = S(args.cwd).trim();
    const configured = configuredRepository();
    const candidates = [
      cwdArg ? resolvePath(cwdArg) : '',
      configured ?? '',
      this.lastRepo ?? '',
      resolvePath(process.cwd()),
    ].filter((p) => p.length > 0);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const known = this.knownRoot(candidate);
      const root = known ?? (await this.resolveRoot(candidate));
      if (root) return { repo: root };
    }
    return { error: 'Error: Not a git repository. Please run this command from within a git repository.' };
  }

  private async run(ctx: { repo: string }, tool: string, argv: string[]): Promise<GitResult> {
    const res = await gitRun(argv, ctx.repo);
    if (GIT_WRITE_TOOLS.has(tool)) this.clearCache(ctx.repo);
    return res;
  }

  private clearCache(repo: string): void {
    const prefix = `${repo.toLowerCase()}\u0000`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private cached(tool: string, args: Args): GitToolResult | null {
    if (this.cacheTtl(tool) <= 0) return null;
    const key = this.cacheKey(tool, args);
    const hit = key ? this.cache.get(key) : undefined;
    if (hit && Date.now() - hit.ts < this.cacheTtl(tool)) {
      return { content: hit.text, isError: hit.isError };
    }
    return null;
  }

  private remember(tool: string, args: Args, result: GitToolResult): void {
    if (this.cacheTtl(tool) <= 0) return;
    const key = this.cacheKey(tool, args);
    if (!key) return;
    this.cache.set(key, { ts: Date.now(), text: result.content, isError: result.isError });
  }

  private cacheKey(tool: string, args: Args): string | null {
    const repo = this.lastRepo;
    if (!repo) return null;
    const relevant = Object.fromEntries(
      Object.entries(args).filter(([k, v]) => k !== 'cwd' && v !== undefined && v !== null && v !== false && v !== ''),
    );
    return `${repo.toLowerCase()}\u0000${tool}\u0000${JSON.stringify(relevant)}`;
  }

  private static CACHE_TTL: Record<string, number> = {
    git_status: 800,
    git_log: 1500,
    git_diff: 1500,
    git_list_branches: 1500,
    git_show: 1500,
    git_file_history: 1500,
    git_blame: 1500,
    git_search: 3000,
  };

  private cacheTtl(tool: string): number {
    return GitInternalEngine.CACHE_TTL[tool] ?? 0;
  }

  /** Format `log -N --format=...` together, mirroring git-mcp's getLog commits. */
  private logArgv(count: number): string[] {
    return ['log', `-${count}`, '--format=%H|%h|%an|%ae|%ai|%s'];
  }

  async call(tool: string, rawArgs: unknown): Promise<GitToolResult> {
    const args = (rawArgs ?? {}) as Args;
    if (!GIT_INTERNAL_TOOLS.has(tool)) {
      return { content: `Tool "${tool}" is not an internal git tool`, isError: true };
    }
    const context = await this.resolveContext(args);
    if ('error' in context) return { content: JSON.stringify({ success: false, error: context.error }, null, 2), isError: true };
    const cached = this.cached(tool, args);
    if (cached) return cached;
    const result = await this.execute(tool, args, context.repo);
    this.remember(tool, args, result);
    return result;
  }

  private async execute(tool: string, args: Args, repo: string): Promise<GitToolResult> {
    try {
      switch (tool) {
        case 'git_checkout': return this.tCheckout(args, repo);
        case 'git_cherry_pick': return this.tCherryPick(args, repo);
        case 'git_create_branch': return this.tCreateBranch(args, repo);
        case 'git_delete_branch': return this.tDeleteBranch(args, repo);
        case 'git_list_branches': return this.tListBranches(args, repo);
        case 'git_merge': return this.tMerge(args, repo);
        case 'git_move_changes': return this.tMoveChanges(args, repo);
        case 'git_rebase': return this.tRebase(args, repo);
        case 'git_commit': return this.tCommit(args, repo);
        case 'git_stage': return this.tStage(args, repo);
        case 'git_amend': return this.tAmend(args, repo);
        case 'git_squash': return this.tSquash(args, repo);
        case 'git_blame': return this.tBlame(args, repo);
        case 'git_diff': return this.tDiff(args, repo);
        case 'git_file_history': return this.tFileHistory(args, repo);
        case 'git_log': return this.tLog(args, repo);
        case 'git_search': return this.tSearch(args, repo);
        case 'git_show': return this.tShow(args, repo);
        case 'git_status': return this.tStatus(args, repo);
        case 'git_find_lost': return this.tFindLost(args, repo);
        case 'git_recover_branch': return this.tRecoverBranch(args, repo);
        case 'git_recover_commit': return this.tRecoverCommit(args, repo);
        case 'git_reflog': return this.tReflog(args, repo);
        case 'git_reset_to_reflog': return this.tResetToReflog(args, repo);
        case 'git_fetch': return this.tFetch(args, repo);
        case 'git_pull': return this.tPull(args, repo);
        case 'git_push': return this.tPush(args, repo);
        case 'git_remote': return this.tRemote(args, repo);
        case 'git_stash': return this.tStash(args, repo);
        case 'git_update_branch': return this.tUpdateBranch(args, repo);
        case 'git_discard_changes': return this.tDiscardChanges(args, repo);
        case 'git_reset': return this.tReset(args, repo);
        case 'git_revert': return this.tRevert(args, repo);
        case 'git_undo_commit': return this.tUndoCommit(args, repo);
        case 'git_undo_merge': return this.tUndoMerge(args, repo);
        case 'git_unstage': return this.tUnstage(args, repo);
        default: return { content: `Unknown internal git tool "${tool}"`, isError: true };
      }
    } catch (err) {
      return caughtJson(err);
    }
  }

  private async tCheckout(a: Args, repo: string): Promise<GitToolResult> {
    const branch = S(a.branch);
    const command = `git checkout ${branch}`;
    const r = await this.run({ repo }, 'git_checkout', ['checkout', branch]);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: `Switched to branch "${branch}"` }, command);
  }

  private async tCherryPick(a: Args, repo: string): Promise<GitToolResult> {
    const commit = S(a.commit);
    const endCommit = S(a.endCommit);
    const noCommit = B(a.noCommit);
    const argv = ['cherry-pick', ...(noCommit ? ['-n'] : [])];
    const command = endCommit
      ? `git cherry-pick ${noCommit ? '-n ' : ''}${commit}^..${endCommit}`
      : `git cherry-pick ${noCommit ? '-n ' : ''}${commit}`;
    const argvFinal = endCommit ? [...argv, `${commit}^..${endCommit}`] : [...argv, commit];
    const r = await this.run({ repo }, 'git_cherry_pick', argvFinal);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson(
      { success: true, message: noCommit ? 'Cherry-pick changes staged (not committed)' : 'Cherry-pick completed successfully' },
      command,
    );
  }

  private async tCreateBranch(a: Args, repo: string): Promise<GitToolResult> {
    const name = S(a.name);
    const fromRef = S(a.fromRef);
    const checkout = B(a.checkout) || true;
    const argv = checkout ? ['checkout', '-b', name] : ['branch', name];
    if (fromRef) argv.push(fromRef);
    const command = checkout ? `git checkout -b ${name}${fromRef ? ` ${fromRef}` : ''}` : `git branch ${name}${fromRef ? ` ${fromRef}` : ''}`;
    const r = await this.run({ repo }, 'git_create_branch', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: checkout ? `Created and switched to branch "${name}"` : `Created branch "${name}"` }, command);
  }

  private async tDeleteBranch(a: Args, repo: string): Promise<GitToolResult> {
    const forceFlag = B(a.force) ? '-D' : '-d';
    const branch = S(a.branch);
    const command = `git branch ${forceFlag} ${branch}`;
    const r = await this.run({ repo }, 'git_delete_branch', ['branch', forceFlag, branch]);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: `Deleted branch "${branch}"` }, command);
  }

  private async tListBranches(a: Args, repo: string): Promise<GitToolResult> {
    const all = B(a.all);
    const remote = B(a.remote);
    const flag = all ? '-a' : remote ? '-r' : '';
    try {
      const r = await this.run({ repo }, 'git_list_branches', ['branch', ...(flag ? [flag] : []), '-vv']);
      if (r.exitCode !== 0) throw new Error(r.stderr);
      const branches: GitBranchInfo[] = [];
      for (const line of r.stdout.split('\n').filter((l) => l.trim())) {
        const isCurrent = line.startsWith('*');
        const cleanLine = line.replace(/^\*?\s+/, '');
        const parts = cleanLine.split(/\s+/);
        const name = parts[0];
        let trackingBranch: string | undefined;
        const trackingMatch = line.match(/\[([^\]]+)\]/);
        if (trackingMatch) trackingBranch = trackingMatch[1].split(':')[0];
        branches.push({ name, isCurrent, isRemote: name.startsWith('remotes/') || name.includes('/'), trackingBranch });
      }
      const command = `git branch ${flag} -vv`;
      return okJson({ success: true, branches, count: branches.length }, command);
    } catch (err) {
      return caughtJson(err);
    }
  }

  private async tMerge(a: Args, repo: string): Promise<GitToolResult> {
    const squash = B(a.squash);
    const noFastForward = B(a.noFastForward);
    const message = S(a.message);
    const branch = S(a.branch);
    const argv = ['merge', ...(squash ? ['--squash'] : noFastForward ? ['--no-ff'] : []), ...(message ? ['-m', message] : []), branch];
    let command = 'git merge';
    if (squash) command += ' --squash';
    else if (noFastForward) command += ' --no-ff';
    if (message) command += ` -m "${message}"`;
    command += ` ${branch}`;
    const r = await this.run({ repo }, 'git_merge', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson(
      { success: true, message: squash ? `Squash merge completed. Run "git commit" to finish.` : `Merged "${branch}" into current branch`, output: r.stdout },
      command,
    );
  }

  private async tMoveChanges(a: Args, repo: string): Promise<GitToolResult> {
    const branch = S(a.branch);
    const command = `git stash && git checkout -b ${branch} && git stash pop`;
    const stashResult = await this.run({ repo }, 'git_move_changes', ['stash']);
    if (stashResult.exitCode !== 0 && !stashResult.stderr.includes('No local changes')) return errJson(stashResult.stderr, command);
    const hasStash = !stashResult.stderr.includes('No local changes');
    const branchResult = await this.run({ repo }, 'git_move_changes', ['checkout', '-b', branch]);
    if (branchResult.exitCode !== 0) {
      if (hasStash) await this.run({ repo }, 'git_move_changes', ['stash', 'pop']);
      return errJson(branchResult.stderr, command);
    }
    if (hasStash) {
      const popResult = await this.run({ repo }, 'git_move_changes', ['stash', 'pop']);
      if (popResult.exitCode !== 0) return errJson(popResult.stderr, command);
    }
    return okJson({ success: true, message: `Changes moved to new branch "${branch}"` }, command);
  }

  private async tRebase(a: Args, repo: string): Promise<GitToolResult> {
    const abort = B(a.abort);
    const cont = B(a.continue);
    let argv: string[];
    let command: string;
    if (abort) {
      argv = ['rebase', '--abort'];
      command = 'git rebase --abort';
    } else if (cont) {
      argv = ['rebase', '--continue'];
      command = 'git rebase --continue';
    } else {
      argv = ['rebase', S(a.target)];
      command = `git rebase ${S(a.target)}`;
    }
    const r = await this.run({ repo }, 'git_rebase', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    const message = abort ? 'Rebase aborted' : cont ? 'Rebase continued' : `Rebased onto "${S(a.target)}"`;
    return okJson({ success: true, message, output: r.stdout }, command);
  }

  private async tCommit(a: Args, repo: string): Promise<GitToolResult> {
    const message = S(a.message);
    const command = `git commit -m "${message}"`;
    const argv = ['commit', ...(B(a.allowEmpty) ? ['--allow-empty'] : []), '-m', message];
    const r = await this.run({ repo }, 'git_commit', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: 'Commit created successfully', output: r.stdout }, command);
  }

  private async tStage(a: Args, repo: string): Promise<GitToolResult> {
    const files = A(a.files);
    const argv = files.length > 0 ? ['add', ...files] : ['add', '-A'];
    const command = files.length > 0 ? `git add ${files.join(' ')}` : 'git add -A';
    const r = await this.run({ repo }, 'git_stage', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: files.length > 0 ? `Staged ${files.length} file(s)` : 'All changes staged' }, command);
  }

  private async tAmend(a: Args, repo: string): Promise<GitToolResult> {
    const message = S(a.message);
    const argv = message ? ['commit', '--amend', '-m', message] : ['commit', '--amend', '--no-edit'];
    const command = message ? `git commit --amend -m "${message}"` : 'git commit --amend --no-edit';
    const r = await this.run({ repo }, 'git_amend', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: message ? 'Commit message amended' : 'Staged changes added to last commit' }, command);
  }

  private async tSquash(a: Args, repo: string): Promise<GitToolResult> {
    const count = N(a.count, 0);
    const message = S(a.message);
    const command = `git reset --soft HEAD~${count} && git commit -m "${message}"`;
    const reset = await this.run({ repo }, 'git_squash', ['reset', '--soft', `HEAD~${count}`]);
    if (reset.exitCode !== 0) return errJson(reset.stderr, command);
    const commit = await this.run({ repo }, 'git_squash', ['commit', '-m', message]);
    if (commit.exitCode !== 0) return errJson(commit.stderr, command);
    return okJson({ success: true, message: `${count} commits squashed into one` }, command);
  }

  private async tBlame(a: Args, repo: string): Promise<GitToolResult> {
    const file = S(a.file);
    const startLine = N(a.startLine, 0);
    const endLine = N(a.endLine, 0);
    const argv = ['blame', '--line-porcelain', ...(startLine > 0 && endLine > 0 ? ['-L', `${startLine},${endLine}`] : []), file];
    let command = 'git blame';
    if (startLine > 0 && endLine > 0) command += ` -L ${startLine},${endLine}`;
    command += ` "${file}"`;
    const r = await this.run({ repo }, 'git_blame', argv);
    if (r.exitCode !== 0) throw new Error(r.stderr);
    const entries: GitBlameEntry[] = [];
    let current: Partial<GitBlameEntry> = {};
    let lineNumber = 0;
    for (const line of r.stdout.split('\n')) {
      if (/^[a-f0-9]{40}/.test(line)) {
        const parts = line.split(' ');
        current.commit = parts[0];
        lineNumber = parseInt(parts[2], 10);
      } else if (line.startsWith('author ')) {
        current.author = line.substring(7);
      } else if (line.startsWith('author-time ')) {
        const ts = parseInt(line.substring(12), 10);
        current.date = new Date(ts * 1000).toISOString();
      } else if (line.startsWith('\t')) {
        current.content = line.substring(1);
        current.lineNumber = lineNumber;
        entries.push(current as GitBlameEntry);
        current = {};
      }
    }
    return okJson({ success: true, blame: entries, lineCount: entries.length }, command);
  }

  private async tDiff(a: Args, repo: string): Promise<GitToolResult> {
    const staged = B(a.staged);
    const commitA = S(a.commitA);
    const commitB = S(a.commitB);
    const file = S(a.file);
    const stat = B(a.stat);
    const argv = ['diff', ...(staged ? ['--staged'] : []), ...(stat ? ['--stat'] : [])];
    if (commitA) {
      argv.push(commitA);
      if (commitB) argv.push(commitB);
    }
    if (file) argv.push('--', file);
    let command = 'git diff';
    if (staged) command += ' --staged';
    if (stat) command += ' --stat';
    if (commitA) {
      command += ` ${commitA}`;
      if (commitB) command += ` ${commitB}`;
    }
    if (file) command += ` -- "${file}"`;
    const r = await this.run({ repo }, 'git_diff', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, diff: r.stdout || 'No changes' }, command);
  }

  private async tFileHistory(a: Args, repo: string): Promise<GitToolResult> {
    const file = S(a.file);
    const count = N(a.count, 20);
    const follow = B(a.follow) || true;
    const argv = [...this.logArgv(count), ...(follow ? ['--follow'] : []), '--', file];
    const command = `git log -${count}${follow ? ' --follow' : ''} -- "${file}"`;
    const r = await this.run({ repo }, 'git_file_history', argv);
    if (r.exitCode !== 0) throw new Error(r.stderr);
    const commits = parseCommits(r.stdout);
    return okJson({ success: true, file, commits, count: commits.length }, command);
  }

  private async tLog(a: Args, repo: string): Promise<GitToolResult> {
    const count = N(a.count, 10);
    const file = S(a.file);
    const author = S(a.author);
    const since = S(a.since);
    const until = S(a.until);
    const grep = S(a.grep);
    const oneline = B(a.oneline);
    const argv = oneline ? ['log', `-${count}`, '--oneline'] : this.logArgv(count);
    if (author) argv.push(`--author=${author}`);
    if (since) argv.push(`--since=${since}`);
    if (until) argv.push(`--until=${until}`);
    if (grep) argv.push(`--grep=${grep}`);
    if (file) argv.push('--', file);
    let command = `git log -${count}`;
    if (oneline) command += ' --oneline';
    if (author) command += ` --author="${author}"`;
    if (since) command += ` --since="${since}"`;
    if (until) command += ` --until="${until}"`;
    if (grep) command += ` --grep="${grep}"`;
    if (file) command += ` -- "${file}"`;
    const r = await this.run({ repo }, 'git_log', argv);
    if (r.exitCode !== 0) throw new Error(r.stderr);
    const commits = oneline ? parseOnelineCommits(r.stdout) : parseCommits(r.stdout);
    return okJson({ success: true, commits, count: commits.length }, command);
  }

  private async tSearch(a: Args, repo: string): Promise<GitToolResult> {
    const term = S(a.term);
    const type = E(a.type as string, 'message' as const, ['message', 'content', 'author'] as const);
    const count = N(a.count, 20);
    const argv = this.logArgv(count);
    switch (type) {
      case 'message': argv.push(`--grep=${term}`); break;
      case 'content': argv.push('-S', term); break;
      case 'author': argv.push(`--author=${term}`); break;
    }
    let command = `git log -${count}`;
    switch (type) {
      case 'message': command += ` --grep="${term}"`; break;
      case 'content': command += ` -S "${term}"`; break;
      case 'author': command += ` --author="${term}"`; break;
    }
    const r = await this.run({ repo }, 'git_search', argv);
    if (r.exitCode !== 0) return okJson({ success: true, commits: [], count: 0, searchType: type }, command);
    const commits = parseCommits(r.stdout);
    return okJson({ success: true, commits, count: commits.length, searchType: type }, command);
  }

  private async tShow(a: Args, repo: string): Promise<GitToolResult> {
    const commit = S(a.commit);
    const stat = B(a.stat);
    const patch = a.patch !== false;
    const argv = ['show', commit, ...(stat ? ['--stat'] : []), ...(!patch ? ['--no-patch'] : [])];
    let command = `git show ${commit}`;
    if (stat) command += ' --stat';
    if (!patch) command += ' --no-patch';
    const r = await this.run({ repo }, 'git_show', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, output: r.stdout }, command);
  }

  private async tStatus(a: Args, repo: string): Promise<GitToolResult> {
    const r = await this.run({ repo }, 'git_status', ['status']);
    if (r.exitCode !== 0) return errJson(r.stderr, 'git status');
    return okJson({ success: true, status: r.stdout }, 'git status');
  }

  private async tFindLost(a: Args, repo: string): Promise<GitToolResult> {
    const command = 'git fsck --no-reflogs --unreachable';
    const fsck = await this.run({ repo }, 'git_find_lost', ['fsck', '--no-reflogs', '--unreachable']);
    if (fsck.exitCode !== 0) return errJson(fsck.stderr, command);
    const hashes: string[] = [];
    for (const line of fsck.stdout.split('\n')) {
      if (line.includes('unreachable commit')) {
        const parts = line.split(' ');
        const hash = parts[parts.length - 1];
        if (hash) hashes.push(hash);
      }
    }
    if (hashes.length === 0) {
      return okJson({ success: true, output: 'No dangling commits found.', hint: 'Use git_show or git_recover_commit to inspect and recover these commits' }, command);
    }
    const log = await this.run({ repo }, 'git_find_lost', ['log', '--oneline', '--no-walk', ...hashes.slice(0, 20)]);
    if (log.exitCode !== 0) return errJson(log.stderr, command);
    return okJson({ success: true, output: log.stdout, hint: 'Use git_show or git_recover_commit to inspect and recover these commits' }, command);
  }

  private async tRecoverBranch(a: Args, repo: string): Promise<GitToolResult> {
    const branch = S(a.branch);
    const command = `git reflog | grep "${branch}"`;
    const reflog = await this.run({ repo }, 'git_recover_branch', ['reflog', '--format=%h %gs']);
    if (reflog.exitCode !== 0) return errJson(reflog.stderr, command);
    let commitHash: string | null = null;
    for (const line of reflog.stdout.split('\n')) {
      if (
        line.includes(`checkout: moving from ${branch}`) ||
        (line.includes('branch: Created from') && line.includes(branch))
      ) {
        commitHash = line.split(' ')[0];
        break;
      }
    }
    if (!commitHash) {
      for (const line of reflog.stdout.split('\n')) {
        if (line.toLowerCase().includes(branch.toLowerCase())) {
          commitHash = line.split(' ')[0];
          break;
        }
      }
    }
    if (!commitHash) {
      return {
        content: JSON.stringify({
          success: false,
          error: `Could not find deleted branch "${branch}" in reflog. Try running git reflog to manually find the commit.`,
          hint: 'Try running git_reflog to manually find the commit hash, then use git_recover_commit',
          command,
        }, null, 2),
        isError: true,
      };
    }
    const result = await this.run({ repo }, 'git_recover_branch', ['checkout', '-b', branch, commitHash]);
    if (result.exitCode !== 0) return errJson(result.stderr, command);
    return okJson({ success: true, message: `Recovered branch "${branch}"`, command: `git checkout -b ${branch} <commit-from-reflog>` }, command);
  }

  private async tRecoverCommit(a: Args, repo: string): Promise<GitToolResult> {
    const commit = S(a.commit);
    const createBranch = S(a.createBranch);
    const cherryPick = B(a.cherryPick);
    let argv: string[];
    let command: string;
    let message: string;
    if (createBranch) {
      argv = ['checkout', '-b', createBranch, commit];
      command = `git checkout -b ${createBranch} ${commit}`;
      message = `Created branch "${createBranch}" at commit ${commit}`;
    } else if (cherryPick) {
      argv = ['cherry-pick', commit];
      command = `git cherry-pick ${commit}`;
      message = `Cherry-picked commit ${commit}`;
    } else {
      argv = ['checkout', commit];
      command = `git checkout ${commit}`;
      message = `Checked out commit ${commit} (detached HEAD)`;
    }
    const r = await this.run({ repo }, 'git_recover_commit', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message }, command);
  }

  private async tReflog(a: Args, repo: string): Promise<GitToolResult> {
    const count = N(a.count, 50);
    const search = S(a.search);
    let entries: GitReflogEntry[];
    let command: string;
    if (search) {
      const r = await this.run({ repo }, 'git_reflog', ['reflog', '--format=%h|%gd|%gs']);
      if (r.exitCode !== 0) throw new Error(r.stderr);
      entries = [];
      for (const line of r.stdout.split('\n').filter((l) => l.trim())) {
        if (line.toLowerCase().includes(search.toLowerCase())) {
          const parts = line.split('|');
          if (parts.length >= 3) entries.push({ hash: parts[0], action: parts[1], message: parts.slice(2).join('|') });
        }
      }
      command = `git reflog | grep "${search}"`;
    } else {
      const r = await this.run({ repo }, 'git_reflog', ['reflog', `-${count}`, '--format=%h|%gd|%gs']);
      if (r.exitCode !== 0) throw new Error(r.stderr);
      entries = [];
      for (const line of r.stdout.split('\n').filter((l) => l.trim())) {
        const parts = line.split('|');
        if (parts.length >= 3) entries.push({ hash: parts[0], action: parts[1], message: parts.slice(2).join('|') });
      }
      command = `git reflog -${count}`;
    }
    return okJson({ success: true, entries, count: entries.length }, command);
  }

  private async tResetToReflog(a: Args, repo: string): Promise<GitToolResult> {
    const index = N(a.index, 0);
    const mode = E(a.mode as string, 'mixed' as const, ['soft', 'mixed', 'hard'] as const);
    const command = `git reset --${mode} HEAD@{${index}}`;
    const r = await this.run({ repo }, 'git_reset_to_reflog', ['reset', `--${mode}`, `HEAD@{${index}}`]);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    const modeDescription: Record<string, string> = { soft: 'Changes are staged', mixed: 'Changes are unstaged', hard: 'All changes discarded' };
    return okJson({ success: true, message: `Reset to HEAD@{${index}}. ${modeDescription[mode]}` }, command);
  }

  private async tFetch(a: Args, repo: string): Promise<GitToolResult> {
    const prune = a.prune !== false;
    const command = `git fetch --all${prune ? ' --prune' : ''}`;
    const r = await this.run({ repo }, 'git_fetch', ['fetch', '--all', ...(prune ? ['--prune'] : [])]);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: 'Fetch completed successfully', output: r.stdout || r.stderr || 'Up to date' }, command);
  }

  private async tPull(a: Args, repo: string): Promise<GitToolResult> {
    const rebase = B(a.rebase);
    const remote = S(a.remote) || 'origin';
    const branch = S(a.branch);
    const argv = ['pull', ...(rebase ? ['--rebase'] : []), remote, ...(branch ? [branch] : [])];
    let command = `git pull${rebase ? ' --rebase' : ''} ${remote}`;
    if (branch) command += ` ${branch}`;
    const r = await this.run({ repo }, 'git_pull', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: 'Pull completed successfully', output: r.stdout }, command);
  }

  private async tPush(a: Args, repo: string): Promise<GitToolResult> {
    const remote = S(a.remote) || 'origin';
    const branch = S(a.branch);
    const force = B(a.force);
    const forceWithLease = B(a.forceWithLease);
    const setUpstream = B(a.setUpstream);
    const argv = [
      'push',
      ...(forceWithLease ? ['--force-with-lease'] : force ? ['--force'] : []),
      ...(setUpstream ? ['-u'] : []),
      remote,
      ...(branch ? [branch] : []),
    ];
    let command = 'git push';
    if (forceWithLease) command += ' --force-with-lease';
    else if (force) command += ' --force';
    if (setUpstream) command += ' -u';
    command += ` ${remote}`;
    if (branch) command += ` ${branch}`;
    const r = await this.run({ repo }, 'git_push', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: 'Push completed successfully', output: r.stdout || r.stderr }, command);
  }

  private async tRemote(a: Args, repo: string): Promise<GitToolResult> {
    const action = E(a.action as string, 'list' as const, ['list', 'add', 'remove'] as const);
    const name = S(a.name);
    const url = S(a.url);
    let r: GitResult;
    let command: string;
    let message: string;
    switch (action) {
      case 'list':
        r = await this.run({ repo }, 'git_remote', ['remote', '-v']);
        command = 'git remote -v';
        message = 'Remotes retrieved';
        break;
      case 'add': {
        if (!name || !url) {
          return { content: JSON.stringify({ success: false, error: 'Name and URL are required for adding a remote' }, null, 2), isError: true };
        }
        r = await this.run({ repo }, 'git_remote', ['remote', 'add', name, url]);
        command = `git remote add ${name} ${url}`;
        message = `Remote "${name}" added`;
        break;
      }
      case 'remove': {
        if (!name) {
          return { content: JSON.stringify({ success: false, error: 'Name is required for removing a remote' }, null, 2), isError: true };
        }
        r = await this.run({ repo }, 'git_remote', ['remote', 'remove', name]);
        command = `git remote remove ${name}`;
        message = `Remote "${name}" removed`;
        break;
      }
      default:
        return { content: JSON.stringify({ error: 'Invalid remote action' }, null, 2), isError: true };
    }
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message, output: r.stdout || 'No remotes configured' }, command);
  }

  private async tStash(a: Args, repo: string): Promise<GitToolResult> {
    const action = E(a.action as string, 'save' as const, ['save', 'pop', 'list', 'drop'] as const);
    const message = S(a.message);
    const index = a.index;
    const includeUntracked = B(a.includeUntracked);
    let r: GitResult;
    let command: string;
    switch (action) {
      case 'save':
        r = await this.run({ repo }, 'git_stash', ['stash', ...(includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]);
        command = `git stash${includeUntracked ? ' --include-untracked' : ''}${message ? ` -m "${message}"` : ''}`;
        break;
      case 'pop':
        r = await this.run({ repo }, 'git_stash', ['stash', 'pop', ...(typeof index === 'number' ? [`stash@{${index}}`] : [])]);
        command = `git stash pop${typeof index === 'number' ? ` stash@{${index}}` : ''}`;
        break;
      case 'list':
        r = await this.run({ repo }, 'git_stash', ['stash', 'list']);
        command = 'git stash list';
        break;
      case 'drop':
        r = await this.run({ repo }, 'git_stash', ['stash', 'drop', ...(typeof index === 'number' ? [`stash@{${index}}`] : [])]);
        command = `git stash drop${typeof index === 'number' ? ` stash@{${index}}` : ''}`;
        break;
      default:
        return { content: JSON.stringify({ error: 'Invalid stash action' }, null, 2), isError: true };
    }
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    const messages: Record<string, string> = { save: 'Changes stashed successfully', pop: 'Stash applied and dropped', list: 'Stash list retrieved', drop: 'Stash dropped' };
    return okJson({ success: true, message: messages[action], output: r.stdout || 'No stashes' }, command);
  }

  private async tUpdateBranch(a: Args, repo: string): Promise<GitToolResult> {
    const useRebase = a.useRebase !== false;
    const provided = S(a.mainBranch);
    let main = provided;
    if (!main) {
      const head = await this.run({ repo }, 'git_update_branch', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
      main = head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : 'main';
    }
    const command = useRebase
      ? `git fetch origin ${main} && git rebase origin/${main}`
      : `git fetch origin ${main} && git merge origin/${main}`;
    const fetch = await this.run({ repo }, 'git_update_branch', ['fetch', 'origin', main]);
    if (fetch.exitCode !== 0) return errJson(fetch.stderr, command);
    const apply = useRebase
      ? await this.run({ repo }, 'git_update_branch', ['rebase', `origin/${main}`])
      : await this.run({ repo }, 'git_update_branch', ['merge', `origin/${main}`]);
    if (apply.exitCode !== 0) return errJson(apply.stderr, command);
    return okJson({ success: true, message: `Branch updated with latest from ${main}`, output: apply.stdout }, command);
  }

  private async tDiscardChanges(a: Args, repo: string): Promise<GitToolResult> {
    const file = S(a.file);
    let r: GitResult;
    let command: string;
    if (file) {
      r = await this.run({ repo }, 'git_discard_changes', ['checkout', '--', file]);
      command = `git checkout -- "${file}"`;
    } else {
      const clean = await this.run({ repo }, 'git_discard_changes', ['clean', '-fd']);
      if (clean.exitCode !== 0) return errJson(clean.stderr, 'git clean -fd && git checkout -- .');
      r = await this.run({ repo }, 'git_discard_changes', ['checkout', '--', '.']);
      command = 'git clean -fd && git checkout -- .';
    }
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: file ? `Changes to "${file}" discarded` : 'All local changes discarded' }, command);
  }

  private async tReset(a: Args, repo: string): Promise<GitToolResult> {
    const commitRef = S(a.commitRef);
    const mode = E(a.mode as string, 'mixed' as const, ['soft', 'mixed', 'hard'] as const);
    const command = `git reset --${mode} ${commitRef}`;
    const r = await this.run({ repo }, 'git_reset', ['reset', `--${mode}`, commitRef]);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    const modeDescription: Record<string, string> = { soft: 'Changes are staged', mixed: 'Changes are unstaged', hard: 'All changes discarded' };
    return okJson({ success: true, message: `Reset to ${commitRef}. ${modeDescription[mode]}` }, command);
  }

  private async tRevert(a: Args, repo: string): Promise<GitToolResult> {
    const commitHash = S(a.commitHash);
    const count = N(a.count, 0);
    const noCommit = B(a.noCommit);
    let argv: string[];
    let command: string;
    if (commitHash) {
      argv = ['revert', ...(noCommit ? ['--no-commit'] : []), commitHash];
      command = `git revert ${noCommit ? '--no-commit ' : ''}${commitHash}`;
    } else if (count > 0) {
      argv = ['revert', ...(noCommit ? ['--no-commit'] : []), `HEAD~${count}..HEAD`];
      command = `git revert ${noCommit ? '--no-commit ' : ''}HEAD~${count}..HEAD`;
    } else {
      return { content: JSON.stringify({ success: false, error: 'Please provide either count or commitHash' }, null, 2), isError: true };
    }
    const r = await this.run({ repo }, 'git_revert', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: noCommit ? 'Revert changes staged (not committed)' : 'Commits reverted successfully', output: r.stdout }, command);
  }

  private async tUndoCommit(a: Args, repo: string): Promise<GitToolResult> {
    const soft = a.soft !== false;
    const command = `git reset ${soft ? '--soft' : '--mixed'} HEAD~1`;
    const r = await this.run({ repo }, 'git_undo_commit', ['reset', soft ? '--soft' : '--mixed', 'HEAD~1']);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: 'Last commit undone successfully', changesStaged: soft }, command);
  }

  private async tUndoMerge(a: Args, repo: string): Promise<GitToolResult> {
    const command = 'git merge --abort';
    const r = await this.run({ repo }, 'git_undo_merge', ['merge', '--abort']);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: 'Merge aborted successfully' }, command);
  }

  private async tUnstage(a: Args, repo: string): Promise<GitToolResult> {
    const file = S(a.file);
    const argv = file ? ['reset', 'HEAD', file] : ['reset', 'HEAD'];
    const command = file ? `git reset HEAD "${file}"` : 'git reset HEAD';
    const r = await this.run({ repo }, 'git_unstage', argv);
    if (r.exitCode !== 0) return errJson(r.stderr, command);
    return okJson({ success: true, message: file ? `"${file}" unstaged` : 'All files unstaged' }, command);
  }
}

/** Singleton owned by the main process (single git child-process issuer). */
export const gitInternal = new GitInternalEngine();

/** Dispatch an internal git tool call, mirroring the MCP `{content,isError}` shape. */
export async function callGitTool(name: string, args: unknown): Promise<GitToolResult> {
  try {
    return await gitInternal.call(name, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[git-internal] "${name}" failed: ${msg}`);
    return { content: `Git tool "${name}" failed: ${msg}`, isError: true };
  }
}

// ---- file-browser git status (lightweight, no MCP/MCP tool parity) ----

export interface RepoStatusEntry {
  /** Absolute path (forward slashes). A missing path means a clean file. */
  path: string;
  /** 'untracked' for `??`, 'ignored' for `!!`, 'modified' for any other
   *  non-clean state. */
  state: 'untracked' | 'modified' | 'ignored';
}

export interface RepoStatusResult {
  ok: boolean;
  isRepo: boolean;
  branch?: string;
  statuses?: RepoStatusEntry[];
  error?: string;
}

const MAX_STATUS_ENTRIES = 5000;

/**
 * Snapshot the repo status for the file browser. Resolves the repo root from
 * `dir` (fails → `isRepo:false`) and parses `git status --porcelain=v1 -z`
 * records. Rename/copy entries carry a second NUL field (the origin path),
 * which is skipped; the visible (destination) path is what we report. Paths
 * are absolute (forward slashes) so the renderer can key them directly
 * against the rows it renders.
 */
export async function getRepoGitStatus(dir: string): Promise<RepoStatusResult> {
  const toplevel = await gitRun(['rev-parse', '--show-toplevel'], dir, 10_000);
  if (toplevel.exitCode !== 0) return { ok: true, isRepo: false };
  const repoRoot = toplevel.stdout.trim();
  if (!repoRoot) return { ok: false, isRepo: false, error: 'empty repo root' };

  const branchRes = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 10_000);
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : undefined;

  const st = await gitRun(
    // --ignored lets the browser leave git-ignored files unbadged instead of
    // mislabelling them as committed.
    ['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching'],
    repoRoot,
    30_000,
  );
  if (st.exitCode !== 0) return { ok: false, isRepo: true, error: st.stderr.trim() || 'git status failed' };

  const statuses: RepoStatusEntry[] = [];
  const fields = st.stdout.split('\0');
  for (let i = 0; i < fields.length && statuses.length < MAX_STATUS_ENTRIES; i++) {
    const field = fields[i];
    if (!field) continue;
    const xy = field.slice(0, 2);
    // porcelain v1 records are `XY<space>path`; drop the separator.
    let rel = field.slice(2).replace(/^ /, '');
    if (rel && (xy[0] === 'R' || xy[0] === 'C')) {
      // The origin path is the next NUL field — the tree only shows the
      // current (destination) file, so the extra field is consumed here.
      i++;
    }
    if (!rel) continue;
    rel = rel.replace(/\\/g, '/');
    // Ignored directories arrive with a trailing slash; strip it so the path
    // matches the renderer's row paths (which have none).
    if (rel.endsWith('/')) rel = rel.slice(0, -1);
    const abs = resolvePath(repoRoot, rel).replace(/\\/g, '/');
    const state: RepoStatusEntry['state'] =
      xy[0] === '!' ? 'ignored' : xy[0] === '?' && xy[1] === '?' ? 'untracked' : 'modified';
    statuses.push({ path: abs, state });
  }
  return { ok: true, isRepo: true, branch, statuses };
}