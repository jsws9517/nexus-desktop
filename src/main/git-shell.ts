/**
 * Controlled git execution for desktop UI features (T2-2 diff, T2-3 worktrees).
 *
 * The renderer never passes an argv array — every function here builds a fixed
 * argv from validated inputs, so a malicious caller cannot inject arbitrary git
 * subcommands or flags. All calls are argv-based (no shell) and run with a
 * bounded timeout and output cap.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseWorktreeList, type WorktreeEntry } from '../shared/worktree.js';

export interface GitShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
  timedOut?: boolean;
}

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Run git with a fixed argv array (no shell). */
function runGit(argv: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitShellResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', argv, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 });
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, stdout: Buffer.concat(chunks).toString('utf8'), stderr: 'Git command timed out', code: 1, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (settled) return;
      if (chunks.reduce((n, c) => n + c.length, 0) + d.length > MAX_GIT_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve({ ok: false, stdout: '', stderr: 'Git output exceeded limit', code: 1 });
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: err.message, code: 1 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      resolve({ ok: code === 0, stdout, stderr: stderr.trim(), code: code ?? 1 });
    });
  });
}

/** Absolute repo root for `dir`, or `null` when `dir` is not inside a repo. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '--show-toplevel'], dir, 10_000);
  if (!r.ok) return null;
  const root = r.stdout.trim();
  return root || null;
}

export interface RepoDiff {
  ok: boolean;
  text: string;
  truncated: boolean;
  error?: string;
}

/** `git diff` text for the UI (bypasses the model-facing JSON summarizer). */
export async function getRepoDiff(dir: string, staged: boolean, maxBytes: number): Promise<RepoDiff> {
  const root = await findRepoRoot(dir);
  if (!root) return { ok: false, text: '', truncated: false, error: 'not a git repository' };
  const argv = ['diff', '--no-color', '--no-ext-diff'];
  if (staged) argv.push('--staged');
  const r = await runGit(argv, root);
  if (!r.ok) return { ok: false, text: '', truncated: false, error: r.stderr || 'git diff failed' };
  const buf = Buffer.from(r.stdout, 'utf8');
  const truncated = buf.length > maxBytes;
  return {
    ok: true,
    text: truncated ? buf.subarray(0, maxBytes).toString('utf8') : r.stdout,
    truncated,
  };
}

/** Deterministic worktree root: `<nexusRoot>/worktrees/<sha256(repo).slice(0,12)>`. */
export function worktreeRootFor(repoReal: string, nexusRoot: string): string {
  const hash = createHash('sha256').update(repoReal).digest('hex').slice(0, 12);
  return join(nexusRoot, 'worktrees', hash);
}

export interface WorktreeMutation {
  ok: boolean;
  error?: string;
}

/** `git worktree add -b <branch> <path> HEAD` (based on HEAD, ignores working changes). */
export async function addWorktree(repo: string, path: string, branch: string): Promise<WorktreeMutation> {
  const r = await runGit(['worktree', 'add', '-b', branch, path, 'HEAD'], repo);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || r.stdout || 'git worktree add failed' };
}

export interface WorktreeListResult {
  ok: boolean;
  worktrees: WorktreeEntry[];
  error?: string;
}

export async function listWorktrees(repo: string): Promise<WorktreeListResult> {
  const r = await runGit(['worktree', 'list', '--porcelain'], repo);
  if (!r.ok) return { ok: false, worktrees: [], error: r.stderr || 'git worktree list failed' };
  return { ok: true, worktrees: parseWorktreeList(r.stdout) };
}

/** `git worktree remove <path>` (refuses to remove a dirty worktree). */
export async function removeWorktree(repo: string, path: string): Promise<WorktreeMutation> {
  const r = await runGit(['worktree', 'remove', path], repo);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || r.stdout || 'git worktree remove failed' };
}

/** Whether a local branch with this exact name already exists. */
export async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo);
  return r.ok;
}
