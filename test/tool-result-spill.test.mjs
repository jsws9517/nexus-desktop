/**
 * L3 — oversized tool results spill to a temp file; the model gets the path.
 *
 * Before L3, any result above 30K chars was lossily truncated (head 24K +
 * tail 6K) and the data was gone. Now, results above the loose 1M-char
 * (~1MB) threshold are written to a temp file and the model receives the path
 * plus a head/tail preview — the full output stays recoverable via
 * read_file/grep instead of re-running the tool. Media (data:image URIs) stay
 * exempt at every size. The 30K–1M band still truncates exactly as before.
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const mod = await import(pathToFileURL(join(dist, 'agent', 'service.js')));
const { capToolResult, spillLargeToolResult } = mod;
// sandbox-env.mjs points NEXUS_CONFIG_DIR at a throwaway tree, so the spill
// dir (cache-cleanup's dataDir()/tool-results) is fully contained.
const { toolResultSpillDir } = await import(pathToFileURL(join(dist, 'main', 'cache-cleanup.js')));

// A >1M-char string, built cheaply.
function big(n) {
  const unit = 'x'.repeat(1000);
  let s = '';
  while (s.length < n) s += unit;
  return s.slice(0, n);
}

test('small results pass through unchanged', async () => {
  const res = { content: 'hello', isError: false };
  const out = await capToolResult(res);
  assert.equal(out, res, 'same object, untouched');
});

test('the 30K–1M band still truncates exactly as before', async () => {
  const res = { content: big(100_000), isError: false };
  const out = await capToolResult(res);
  assert.notEqual(out, res, 'a new capped object is returned');
  assert.match(out.content, /output truncated/i, 'the classic marker');
  assert.match(out.content, /--- head ---|showing head/i);
  // Far smaller than the original.
  assert.ok(out.content.length < 40_000);
});

test('a >1M result spills to a temp file and hands back the path', async () => {
  const full = big(1_200_000);
  const res = { content: full, isError: false };
  const out = await capToolResult(res);
  assert.notEqual(out, res);
  const text = out.content;
  assert.match(text, /output too large/i, 'the spill note is present');
  assert.match(text, /full result saved to/, 'it names the saved file');
  // The path is in our spill dir and actually exists with the full payload.
  const m = text.match(/full result saved to (\S+)/);
  assert.ok(m, 'could extract the path');
  const file = m[1].replace(/\.$/, ''); // drop the sentence period that follows the path
  assert.ok(file.startsWith(toolResultSpillDir()), `path is in the spill dir: ${file}`);
  assert.ok(existsSync(file), 'the temp file exists');
  const written = readFileSync(file, 'utf8');
  assert.equal(written.length, full.length, 'the full output was written');
  assert.equal(written, full, 'byte-for-byte the original content');
  // The preview shows the head and tail.
  assert.match(text, /--- head ---/);
  assert.match(text, /--- tail ---/);
  assert.ok(text.includes(full.slice(0, 100)), 'head preview carries the start');
  assert.ok(text.includes(full.slice(-50)), 'tail preview carries the end');
  // The spilled result is far smaller than the original.
  assert.ok(text.length < 20_000, 'the note + preview is small');
});

test('media data-URIs are exempt even above 1M', async () => {
  // A data:image URI far past every threshold must pass through untouched.
  const res = { content: `data:image/png;base64,${'A'.repeat(1_200_000)}`, isError: false };
  const out = await capToolResult(res);
  assert.equal(out, res, 'media passes through unchanged');
});

test('spillLargeToolResult returns a readable path in the spill dir', async () => {
  const p = await spillLargeToolResult('abc');
  assert.ok(p && p.startsWith(toolResultSpillDir()), 'a path in the spill dir');
  assert.equal(readFileSync(p, 'utf8'), 'abc');
});

test('structured (non-string) results pass through', async () => {
  const res = { content: { rows: [1, 2] }, isError: false };
  const out = await capToolResult(res);
  assert.equal(out, res, 'non-string content is untouched');
});
