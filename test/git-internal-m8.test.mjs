/**
 * M8 — git-slow is an independent failure class (>1MB git output summarized).
 *
 * A git TIMEOUT is environment slowness (network/remote/repo lock), not a
 * broken command. The engine must stamp the error payload so the agent's
 * failure monitor can tell it apart from a real exec failure: the marker keeps
 * it OUT of the fail_seq storm counter (retrying a slow op never helps) and in
 * its place the model gets one hint. Large (>1MB) successful git payloads are
 * summarized (head + tail + size) instead of shipping whole.
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { okJson, errJson } = await import(pathToFileURL(join(dist, 'main', 'git-internal.js')));
const { isGitSlowResult } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));

const TIMEOUT_TEXT = 'Git command timed out';

test('errJson stamps gitSlow + hint on a git timeout', () => {
  const r = errJson(TIMEOUT_TEXT, 'git pull');
  assert.equal(r.isError, true);
  const payload = JSON.parse(r.content);
  assert.equal(payload.success, false);
  assert.equal(payload.gitSlow, true, 'the git-slow marker is present');
  assert.match(payload.hint ?? '', /timed out|timeout/i, 'a hint explains it is not a broken command');
  assert.match(payload.error, /timed out/i);
});

test('errJson does NOT stamp gitSlow on a real git error', () => {
  const r = errJson('fatal: not a git repository', 'git status');
  const payload = JSON.parse(r.content);
  assert.equal(payload.gitSlow, undefined, 'a normal error is not git-slow');
  assert.equal(payload.hint, undefined);
});

test('okJson passes small payloads through unchanged', () => {
  const r = okJson({ commits: [{ message: 'a' }] }, 'git_log');
  assert.equal(r.isError, false);
  const payload = JSON.parse(r.content);
  assert.equal(payload.command, 'git_log');
  assert.equal(payload.commits.length, 1);
});

test('okJson summarizes payloads over the 1MB threshold', () => {
  // A payload well past LARGE_RESULT_BYTES (1MB) — build it from many entries.
  const rows = [];
  while (JSON.stringify(rows).length < 1_200_000) {
    rows.push({ hash: 'a'.repeat(40), message: 'm'.repeat(200) });
  }
  const full = JSON.stringify({ commits: rows, command: 'git_log' }, null, 2);
  const r = okJson({ commits: rows }, 'git_log');
  assert.equal(r.isError, false);
  const content = r.content;
  assert.match(content, /output truncated/i, 'the summary notes the truncation');
  assert.match(content, /--- head ---/);
  assert.match(content, /--- tail ---/);
  assert.ok(content.length * 3 < full.length, 'the summary is a small fraction of the payload');
});

test('isGitSlowResult: the marker wins (tool-name gated)', () => {
  const content = JSON.stringify({ success: false, error: TIMEOUT_TEXT, command: 'git push', gitSlow: true });
  assert.equal(isGitSlowResult('git_push', content), true);
  assert.equal(isGitSlowResult('git__git_push', content), true, 'server-qualified alias counts');
  assert.equal(isGitSlowResult('run_command', content), false, 'non-git tools never git-slow');
});

test('isGitSlowResult: loose fallback on the engine timeout text', () => {
  // No marker (e.g. the marker was stripped) but the engine timeout text remains.
  assert.equal(isGitSlowResult('git_pull', `{"success":false,"error":"${TIMEOUT_TEXT}"}`), true);
  // Plain error, no timeout text, no marker: not git-slow.
  assert.equal(isGitSlowResult('git_pull', '{"success":false,"error":"rejected"}'), false);
  // A git-slow marker on a NON-git tool is still rejected (the class is git-only).
  assert.equal(isGitSlowResult('npm_install', '{"gitSlow":true}'), false);
});
