/**
 * T2-2 / T2-3 — controlled git diff + worktree helpers.
 *
 * Pure helpers are deterministic and always run. The integration cases spin up
 * a throwaway git repo and exercise the same argv-only wrappers the IPC layer
 * uses, proving: real diff text, byte truncation, and worktree add/list/remove.
 * Everything is argv-based (no shell) and the renderer never supplies git flags.
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { sanitizeWorktreeName, parseWorktreeList, WORKTREE_NAME_RE } = await import(
  pathToFileURL(join(dist, 'shared', 'worktree.js')).href
);
const {
  findRepoRoot, getRepoDiff, worktreeRootFor,
  addWorktree, listWorktrees, removeWorktree, branchExists,
} = await import(pathToFileURL(join(dist, 'main', 'git-shell.js')).href);

const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
// git --porcelain reports paths with forward slashes on Windows.
const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

function hasGit() {
  try { git(tmpdir(), ['--version']); return true; } catch { return false; }
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-git-test-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'base.txt'), 'hello\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('sanitizeWorktreeName accepts safe names and rejects traversal / refs', () => {
  assert.equal(sanitizeWorktreeName('feature-1'), 'feature-1');
  assert.equal(sanitizeWorktreeName('  fix.a_b  '), 'fix.a_b');
  assert.equal(sanitizeWorktreeName('TASK_2024.09'), 'TASK_2024.09');
  for (const bad of ['', '   ', '../escape', 'a/b', 'a b', '-lead', '.hidden',
                     'trail.', 'x.lock', 'a..b', 42, null, undefined, 'x'.repeat(81)]) {
    assert.equal(sanitizeWorktreeName(bad), null, `rejected: ${String(bad)}`);
  }
});

test('WORKTREE_NAME_RE disallows leading dash and slash', () => {
  assert.equal(WORKTREE_NAME_RE.test('ok_name-1'), true);
  assert.equal(WORKTREE_NAME_RE.test('-bad'), false);
  assert.equal(WORKTREE_NAME_RE.test('bad/name'), false);
});

test('parseWorktreeList handles multiple blocks, detached, bare and branch', () => {
  const text = [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.nexus/worktrees/aaa/task-1',
    'HEAD def456',
    'detached',
    '',
    'worktree /bare.git',
    'HEAD 000000',
    'bare',
    '',
  ].join('\n');
  const list = parseWorktreeList(text);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { path: '/repo', head: 'abc123', branch: 'refs/heads/main', bare: false, detached: false });
  assert.equal(list[1].branch, null);
  assert.equal(list[1].detached, true);
  assert.equal(list[2].bare, true);
});

test('worktreeRootFor is deterministic and namespaced per repo', () => {
  const nexus = join(tmpdir(), 'nexus');
  const a = worktreeRootFor('C:\\repo-one', nexus);
  const b = worktreeRootFor('C:\\repo-one', nexus);
  const c = worktreeRootFor('C:\\repo-two', nexus);
  assert.equal(a, b, 'same repo → same root');
  assert.notEqual(a, c, 'different repos → different roots');
  assert.match(a, /worktrees[\\/][0-9a-f]{12}$/, '12-hex hash suffix');
});

// ── integration (real git) ─────────────────────────────────────────────────

test('getRepoDiff returns real diff text and truncates by bytes', { skip: !hasGit() }, async () => {
  const repo = makeRepo();
  try {
    const root = await findRepoRoot(repo);
    assert.ok(root, 'repo root resolved');
    // No changes yet → empty diff.
    const empty = await getRepoDiff(repo, false, 200 * 1024);
    assert.equal(empty.ok, true);
    assert.equal(empty.text, '');
    assert.equal(empty.truncated, false);

    // Modify + stage, then diff both worktree and staged.
    writeFileSync(join(repo, 'base.txt'), 'hello\nworld\n');
    git(repo, ['add', 'base.txt']);
    const staged = await getRepoDiff(repo, true, 200 * 1024);
    assert.equal(staged.ok, true);
    assert.match(staged.text, /\+world/);
    assert.match(staged.text, /diff --git/);

    const tiny = await getRepoDiff(repo, true, 10);
    assert.equal(tiny.ok, true);
    assert.equal(tiny.truncated, true);
    assert.ok(Buffer.byteLength(tiny.text) <= 10, 'truncated to byte budget');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('add/list/remove worktree via controlled wrappers', { skip: !hasGit() }, async () => {
  const repo = makeRepo();
  const parent = mkdtempSync(join(tmpdir(), 'nexus-wt-'));
  const target = join(parent, 'task-1');
  try {
    assert.equal(await branchExists(repo, 'task-1'), false);
    const added = await addWorktree(repo, target, 'task-1');
    assert.equal(added.ok, true, added.error);
    assert.equal(await branchExists(repo, 'task-1'), true);

    const listed = await listWorktrees(repo);
    assert.equal(listed.ok, true);
    assert.ok(listed.worktrees.some((w) => norm(w.path) === norm(target) && w.branch === 'refs/heads/task-1'));

    const removed = await removeWorktree(repo, target);
    assert.equal(removed.ok, true, removed.error);
    const after = await listWorktrees(repo);
    assert.equal(after.worktrees.some((w) => norm(w.path) === norm(target)), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
