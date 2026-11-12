// Guards the "click a generated-file link in chat → preview must open" path.
//
// The preview containment list is static (project cwds, ~/.nexus, tmp, launch
// cwd), so a file the agent writes to a folder the user only ever *attached*
// a file from (e.g. E:\低效小区) used to be refused by previewOpen /
// previewDocument. The fix registers user-reached directories live:
//
//   renderer register.ts  — dedupes + fires previewAllowPaths IPC
//   main preview-protocol.ts — addPreviewRoots() unions them into
//   liveAllowedRoots() via normalizePreviewDir / previewDirOf (shared).
//
// Main's handler needs electron, so this file exercises the two node-importable
// halves: the pure normalization helpers and the renderer-side dedupe logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// ── shared normalization helpers ─────────────────────────────────────────────

const shared = await import(pathToFileURL(join(dist, 'shared', 'preview.js')).href);
const { normalizePreviewDir, previewDirOf } = shared;

test('normalizePreviewDir: Windows forms', () => {
  assert.equal(normalizePreviewDir('E:\\低效小区'), 'e:/低效小区');
  assert.equal(normalizePreviewDir('E:/低效小区/'), 'e:/低效小区');
  // Bare drive root stays bare so `norm === root` matches e:/x against e:
  assert.equal(normalizePreviewDir('E:/'), 'e:');
  assert.equal(normalizePreviewDir('e:'), 'e:');
});

test('normalizePreviewDir: JSON-doubled backslashes + UNC fold like realpath', () => {
  // Linkified JSON-escaped hit (E:\\a\\b) must normalize the same as the
  // realpath-derived form (E:\a\b) so the containment check matches.
  assert.equal(normalizePreviewDir('E:\\\\a\\\\b'), normalizePreviewDir('E:\\a\\b'));
  assert.equal(normalizePreviewDir('E:\\\\a\\\\b'), 'e:/a/b');
  assert.equal(normalizePreviewDir('\\\\srv\\share'), '/srv/share');
});

test('previewDirOf: parent directory of file paths', () => {
  assert.equal(previewDirOf('E:/低效小区/报告.docx'), 'e:/低效小区');
  assert.equal(previewDirOf('E:\\a\\b.txt'), 'e:/a');
  // File directly under a drive root → the drive root itself.
  assert.equal(previewDirOf('E:/报告.docx'), 'e:');
  assert.equal(previewDirOf('/var/tmp/x.txt'), '/var/tmp');
  assert.equal(previewDirOf('/x.txt'), '/');
});

// ── renderer-side registration helper ────────────────────────────────────────

// Shim the bridge BEFORE importing register.js (it only reads window at call
// time, but the shim must exist for the test's assertions).
const calls = [];
globalThis.window = globalThis.window ?? {};
globalThis.window.nexusDesktop = {
  previewAllowPaths: async (paths) => {
    calls.push([...paths]);
    return { ok: true, added: paths.length };
  },
};

const reg = await import(pathToFileURL(join(dist, 'renderer', 'preview', 'register.js')).href);
const { registerPreviewPaths, clearRegisteredPreviewPaths } = reg;

test('registerPreviewPaths: dedupes and only sends fresh paths', async () => {
  registerPreviewPaths(['E:/a/1.docx', 'E:/a/2.docx']);
  registerPreviewPaths(['E:/a/2.docx', 'E:/b/3.txt']); // 2.docx repeats
  registerPreviewPaths(['E:/a/1.docx']); // all repeats → no new call
  await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget resolve
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['E:/a/1.docx', 'E:/a/2.docx']);
  assert.deepEqual(calls[1], ['E:/b/3.txt']);

  clearRegisteredPreviewPaths();
  registerPreviewPaths(['E:/a/1.docx']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 3, 'cleared registrations are re-sent');
  assert.deepEqual(calls[2], ['E:/a/1.docx']);
});

test('registerPreviewPaths: ignores malformed entries and missing bridge', async () => {
  clearRegisteredPreviewPaths();
  registerPreviewPaths([123, '', 'relative/path.txt', 'E:/ok/f.docx']);
  await new Promise((r) => setTimeout(r, 20));
  const last = calls[calls.length - 1];
  assert.deepEqual(last, ['E:/ok/f.docx'], 'only absolute well-formed paths register');

  // No bridge at all → must not throw.
  globalThis.window = {};
  clearRegisteredPreviewPaths();
  registerPreviewPaths(['E:/x/y.docx']);
  await new Promise((r) => setTimeout(r, 20));
});
