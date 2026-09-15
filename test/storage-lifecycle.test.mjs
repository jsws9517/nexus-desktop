/**
 * Storage-lifecycle unit tests — log retention/rotation/redaction, slash-log
 * pruning, and bounded token-estimate caches.
 *
 * Mirrors .nexus/rules/NEXUS.md §3 "Storage & retention discipline":
 *   - runtime logs roll past MAX_LOG_FILE_BYTES and are pruned after 30 days
 *   - slash logs are pruned after 90 days
 *   - secrets are redacted before log lines hit disk
 *   - in-memory caches are bounded
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, utimesSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const tmp = mkdtempSync(join(tmpdir(), 'nexus-storage-'));

// Point every data-root resolver (logger + slash-log) at the isolated dir.
process.env.LLMA_DATA_DIR = tmp;
process.env.USERPROFILE = tmp;

const loggerMod = await import(pathToFileURL(join(dist, 'shared', 'logger.js')));
const { log, redactLogLine, pruneRetiredLogs, listLogFiles, MAX_LOG_FILE_BYTES } = loggerMod;
const { boundedSet } = await import(pathToFileURL(join(dist, 'shared', 'bounded.js')));
const { pruneSlashLogs, SLASH_LOG_RETENTION_DAYS } = await import(pathToFileURL(join(dist, 'slash-log.js')));

const nexusLogs = join(tmp, '.nexus', 'logs');
const slashBase = join(tmp, '.nexus', 'slash-logs');

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Create a file whose mtime is `msAgo` from now. */
function backdate(p, msAgo) {
  const t = new Date(Date.now() - msAgo);
  utimesSync(p, t, t);
}

// ===========================================================================
// 1. Redaction
// ===========================================================================

test('redactLogLine masks API keys, Bearer tokens, authorization, and query secrets', () => {
  assert.equal(redactLogLine('key sk-abcDEFGH123456789 seen'), 'key sk-*** seen');
  assert.equal(redactLogLine('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'), 'Authorization: Bearer ***');
  assert.equal(redactLogLine('Authorization: sk-live-abcdef'), 'Authorization: ***');
  assert.equal(redactLogLine('apikey=secretvalue123456'), 'apikey=***');
  assert.equal(redactLogLine('api_key: topsecretdata'), 'api_key: ***');
  assert.equal(redactLogLine('?token=abc123&foo=bar'), '?token=***&foo=bar');
  assert.equal(redactLogLine('innocent plain text'), 'innocent plain text');
});

test('log() writes a redacted line to the day-level file', () => {
  log('info', 'apikey=supersecret123 endpoint=ok');
  const today = new Date().toISOString().slice(0, 10);
  const p = join(nexusLogs, `${today}.info.log`);
  assert.ok(existsSync(p), 'info log file missing');
  const text = readFileSync(p, 'utf8');
  assert.ok(!text.includes('supersecret123'), 'secret leaked into log');
  assert.ok(text.includes('apikey=***'));
});

// ===========================================================================
// 2. Rotation (size cap)
// ===========================================================================

test('oversized day-level file rolls over into .N shards', () => {
  const today = new Date().toISOString().slice(0, 10);
  const base = join(nexusLogs, `${today}.warn.log`);
  const shard = `${base}.1`;
  // First append exceeds the per-file cap (rotation happens on the NEXT write).
  log('warn', 'x'.repeat(MAX_LOG_FILE_BYTES));
  assert.ok(statSync(base).size > MAX_LOG_FILE_BYTES);
  log('warn', 'shard marker');
  assert.ok(existsSync(shard), 'shard not created');
  assert.ok(statSync(base).size < MAX_LOG_FILE_BYTES, 'base file not reset');
  // listLogFiles treats sharded files as logs too.
  assert.ok(listLogFiles().some((f) => f === shard));
});

// ===========================================================================
// 3. Retention (age-based pruning)
// ===========================================================================

test('pruneRetiredLogs removes files older than 30 days, keeps fresh ones', () => {
  const oldInfo = join(nexusLogs, '2020-01-01.info.log');
  const oldShard = join(nexusLogs, '2020-01-01.warn.log.1');
  const fresh = join(nexusLogs, `${new Date().toISOString().slice(0, 10)}.error.log`);
  writeFileSync(oldInfo, 'old');
  writeFileSync(oldShard, 'old');
  writeFileSync(fresh, 'fresh');
  backdate(oldInfo, 400 * 24 * 60 * 60 * 1000);
  backdate(oldShard, 400 * 24 * 60 * 60 * 1000);

  assert.equal(pruneRetiredLogs(), 2);
  assert.ok(!existsSync(oldInfo));
  assert.ok(!existsSync(oldShard));
  assert.ok(existsSync(fresh));
});

test('pruneSlashLogs removes slash files older than 90 days, keeps recent ones', () => {
  mkdirSync(slashBase, { recursive: true });
  const old = join(slashBase, 'expired-session.md');
  const recent = join(slashBase, 'live-session.md');
  writeFileSync(old, 'old');
  writeFileSync(recent, 'recent');
  backdate(old, (SLASH_LOG_RETENTION_DAYS + 10) * 24 * 60 * 60 * 1000);

  assert.equal(pruneSlashLogs(), 1);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(recent));
});

// ===========================================================================
// 4. Bounded caches
// ===========================================================================

test('boundedSet evicts oldest entries above the cap', () => {
  const map = new Map();
  for (let i = 0; i < 250; i++) boundedSet(map, `k${i}`, i, 200);
  assert.equal(map.size, 200);
  assert.equal(map.get('k0'), undefined, 'oldest entry should be evicted');
  assert.ok(map.get('k249') !== undefined, 'newest entry must survive');
});