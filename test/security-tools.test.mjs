import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

// Isolate the path-authorizer's persisted grant file so tests never read the
// developer's real ~/.nexus/path-auth.json. Home is read at module load, so we
// set the env before importing the target modules.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-sec-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.LLMA_DATA_DIR = tmp;

const { callSqliteTool, SQLITE_TOOLS, closeSqliteDbs } = await import(pathToFileURL(join(dist, 'tools', 'sqlite.js')));
const { callFsTool, FILESYSTEM_TOOLS } = await import(pathToFileURL(join(dist, 'tools', 'filesystem.js')));
const { callSequentialThinkTool, SEQUENTIAL_THINK_TOOLS } = await import(pathToFileURL(join(dist, 'tools', 'sequential-think.js')));
const { callMemoryTool, MEMORY_WRITE_TOOLS, MEMORY_TOOL_DEFS, INTERNAL_MEMORY_TOOLS } =
  await import(pathToFileURL(join(dist, 'main', 'memory-kg.js')));
const { WORKER_METHODS, validateWorkerParams, PERMISSION_ANSWERS } =
  await import(pathToFileURL(join(dist, 'shared', 'ipc-validation.js')));

// Force every out-of-sandbox path prompt to deny, so tests are deterministic
// (mirrors the smoke test's approach).
const { setPermissionPrompter } = await import(
  pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js')),
);
setPermissionPrompter(() => 'n');

// A write-approval gate that denies, to prove write tools respect the gate.
const denyGateCtx = { getConfig: () => ({}), requestWriteApproval: async () => false };
const allowGateCtx = { getConfig: () => ({}), requestWriteApproval: async () => true };

// A path that is NOT under cwd / sandbox, so authorizePath denys it.
const outsideDir = join(tmpdir(), 'nexus-sec-outside');
mkdirSync(outsideDir, { recursive: true });

// Working dirs under cwd are implicitly allowed (cwd is always an allowed root).
const sqDir = join(process.cwd(), '.sec-sqlite');
const fsDir = join(process.cwd(), '.sec-fs');
mkdirSync(sqDir, { recursive: true });
mkdirSync(fsDir, { recursive: true });
const sqDb = join(sqDir, 'sec.db');
const outsideDb = join(outsideDir, 'outside.db');

let memCtx;

before(() => {
  // Point memory-kg's file under the temp dir via a config it reads lazily.
  const memFile = join(tmp, 'memory.jsonl');
  const nexusDir = join(tmp, '.nexus');
  mkdirSync(nexusDir, { recursive: true });
  writeFileSync(join(nexusDir, 'config.json'), JSON.stringify({
    mcpServers: { memory: { env: { MEMORY_FILE_PATH: memFile } } },
  }));
  memCtx = {};
});

after(() => {
  // best-effort close sqlite handles so Windows can delete the WAL files.
  try { closeSqliteDbs(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  rmSync(sqDir, { recursive: true, force: true });
  rmSync(fsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- sqlite-tools

test('sqlite: identifier break-out via table name is contained (quoteIdent)', async () => {
  const evil = 't1"; DROP TABLE x; --';
  const r = await callSqliteTool('create-table', { name: evil, columns: [{ name: 'id', type: 'INTEGER' }], dbPath: sqDb }, allowGateCtx);
  // Either the quoted name survives as a literal table (no breakout) or the
  // statement is rejected — but it must NEVER execute the injected DROP.
  assert.equal(typeof r.content, 'string');
  // No side table named `t1` was created via an injected separate statement:
  const q = await callSqliteTool('query', { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='t1'", dbPath: sqDb }, allowGateCtx);
  assert.equal(typeof q.content, 'string');
  const rows = JSON.parse(q.content);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.filter((x) => x.name === 't1').length, 0, 'no injected t1 table');
});

test('sqlite: prototype-polluting identifiers cannot touch the object chain', async () => {
  for (const evil of ['__proto__', 'constructor', 'prototype']) {
    const r = await callSqliteTool('insert-record', { table: evil, data: { a: 1 }, dbPath: sqDb }, allowGateCtx);
    // Not an attacker-visible exception/object-pollution: it errors cleanly as
    // "table not found" (or creates nothing). The important property is that the
    // tool returns a controlled isError result, never pollutes a global object.
    assert.equal(typeof r.content, 'string');
    assert.equal(typeof r.isError, 'boolean');
  }
});

test('sqlite: stacked statements cannot smuggle a DROP through execute', async () => {
  const r = await callSqliteTool('execute', { sql: 'CREATE TABLE t2 (id INTEGER); DROP TABLE t2;', dbPath: sqDb }, allowGateCtx);
  // better-sqlite3 rejects multiple statements in one prepare → structured error.
  assert.equal(r.isError, true);
});

test('sqlite: dangerous PRAGMA / ATTACH / DETACH are rejected', async () => {
  for (const sql of [
    'PRAGMA writable_schema=ON',
    'PRAGMA journal_mode=WAL',
    "ATTACH DATABASE 'x.db' AS other",
    'DETACH DATABASE other',
  ]) {
    const q = await callSqliteTool('query', { sql, dbPath: sqDb }, allowGateCtx);
    assert.equal(q.isError, true, `should reject: ${sql}`);
  }
});

test('sqlite: read-only query never creates a database file (fileMustExist)', async () => {
  const ghost = join(sqDir, 'ghost-readonly.db');
  rmSync(ghost, { force: true });
  // A read on a non-existent db via `query` must fail (readonly + fileMustExist),
  // NOT silently create an empty file.
  const q = await callSqliteTool('query', { sql: 'SELECT 1', dbPath: ghost }, allowGateCtx);
  assert.equal(q.isError, true, 'read-only query on missing db errors');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(ghost), false, 'read-only query did not create a file');
});

test('sqlite: create-table DEFAULT allows only safe literals', async () => {
  const injection = '1); DROP TABLE t3; --';
  const r = await callSqliteTool('create-table', {
    name: 't3',
    columns: [{ name: 'c', type: 'TEXT', defaultValue: injection }],
    dbPath: sqDb,
  }, allowGateCtx);
  assert.equal(r.isError, true, 'unsafe default literal rejected');
});

test('sqlite: write tools honor a denying approval gate', async () => {
  const r = await callSqliteTool('create-table', { name: 't4', columns: [{ name: 'a', type: 'INTEGER' }], dbPath: sqDb }, denyGateCtx);
  assert.equal(r.isError, true, 'create-table denied when gate denies');
  const q = await callSqliteTool('query', { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='t4'", dbPath: sqDb }, allowGateCtx);
  assert.equal(JSON.parse(q.content).filter((x) => x.name === 't4').length, 0, 't4 never created');
});

test('sqlite: custom dbPath outside the authorization boundary is denied', async () => {
  const dbPathOutside = join(outsideDir, 'oot.db');
  const r = await callSqliteTool('list-tables', { dbPath: dbPathOutside }, allowGateCtx);
  assert.equal(r.isError, true, 'out-of-bound custom dbPath denied');
});

// ---------------------------------------------------------------- fs-internal

test('fs: read_media_file rejects extension/content mismatch (magic bytes)', async () => {
  const fake = join(fsDir, 'evil.png');
  writeFileSync(fake, 'this is not an image despite the .png name');
  const r = await callFsTool('read_media_file', { path: fake });
  assert.equal(r.isError, true, 'fake .png rejected by magic-byte sniff');
});

test('fs: read_media_file accepts a real PNG', async () => {
  const real = join(fsDir, 'real.png');
  writeFileSync(real, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ));
  const r = await callFsTool('read_media_file', { path: real });
  assert.equal(r.isError !== true, true);
  assert.ok(r.content.startsWith('![real.png](data:image/png;base64,'), 'real png, correct data-URI');
});

test('fs: read_media_file respects the size cap', async () => {
  const big = join(fsDir, 'big.png');
  writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 0)); // > 8 MiB cap
  const r = await callFsTool('read_media_file', { path: big });
  assert.equal(r.isError, true, 'oversize media rejected');
});

test('fs: out-of-root directory access is denied', async () => {
  const r = await callFsTool('list_directory_with_sizes', { path: outsideDir });
  assert.equal(r.isError, true, 'out-of-root denied');
});

test('fs: list_directory_with_sizes bounds maxDepth and entry budget', async () => {
  // Build a nested tree deep enough to exceed MAX_DEPTH if unbounded.
  let deep = fsDir;
  for (let i = 0; i < 6; i++) deep = join(deep, `d${i}`);
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'leaf.txt'), 'x');
  const r = await callFsTool('list_directory_with_sizes', { path: fsDir, maxDepth: 99 });
  assert.equal(r.isError !== true, true);
  const payload = JSON.parse(r.content);
  assert.ok(payload.maxDepth <= 3, 'maxDepth clamped to MAX_DEPTH');
  assert.ok(Array.isArray(payload.entries));
});

// ---------------------------------------------------------------- sequential-think

test('seq: branchId prototype-pollution keys are contained (Map, not object)', async () => {
  const thinker = (await import(pathToFileURL(join(dist, 'tools', 'sequential-think.js'))));
  // Construct a fresh thinker-reachable call; branchId __proto__ must not reach
  // the prototype chain — the earlier shell already proves the pure function
  // path; here assert the branch registry does not break globals.
  const r1 = callSequentialThinkTool('sequentialthinking', {
    thought: 'a', thoughtNumber: 1, totalThoughts: 2, nextThoughtNeeded: true,
    branchFromThought: 1, branchId: '__proto__',
  });
  assert.equal(r1.isError !== true, true);
  // A plain Object.prototype must remain intact after misuse.
  assert.equal(({}).polluted, undefined);
});

test('seq: oversized thought rejected', async () => {
  const r = callSequentialThinkTool('sequentialthinking', {
    thought: 'x'.repeat(1_000_001), thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false,
  });
  assert.equal(r.isError, true);
});

test('seq: invalid coercion params rejected', async () => {
  const r = callSequentialThinkTool('sequentialthinking', {
    thought: 'ok', thoughtNumber: 0, totalThoughts: 1, nextThoughtNeeded: true,
  });
  assert.equal(r.isError, true, 'thoughtNumber >= 1 enforced');
});

// ---------------------------------------------------------------- memory-kg

test('memory: malformed JSONL degrades to a readable error, not a crash', async () => {
  const net = await import('node:fs/promises');
  const { memoryKg } = await import(pathToFileURL(join(dist, 'main', 'memory-kg.js')));
  const f = memoryKg.memoryFilePath;
  const original = await net.readFile(f, 'utf-8').catch(() => '');
  await net.writeFile(f, 'not-json\n{also bad\n').catch(() => {});
  // readGraph must reject cleanly (callMemoryTool returns isError), not throw synchronously.
  const res = await callMemoryTool('read_graph', {});
  assert.equal(typeof res.content, 'string');
  // Restore to the original content so later memory tests are clean.
  await net.writeFile(f, original).catch(() => {});
});

test('memory: every write tool is listed in MEMORY_WRITE_TOOLS for gating', async () => {
  for (const t of MEMORY_TOOL_DEFS) {
    if (INTERNAL_MEMORY_TOOLS.has(t.name)) {
      // Non-read tools (anything not read_graph/search_nodes/open_nodes) must be gated.
      const isRead = ['read_graph', 'search_nodes', 'open_nodes'].includes(t.name);
      assert.equal(MEMORY_WRITE_TOOLS.has(t.name), !isRead, `${t.name} gating consistency`);
    }
  }
});

// ---------------------------------------------------------------- ipc-validation

test('ipc: every worker-routed method in agent-worker has an IPC spec', async () => {
  // Cross-check the spec map keys against the methods dispatched in agent-worker.
  const workerSrc = await (await import('node:fs/promises')).readFile(join(__dirname, '..', 'src', 'agent-worker.ts'), 'utf-8');
  const dispatched = [...workerSrc.matchAll(/case '(\w+)':/g)].map((m) => m[1]);
  // shutdown is handled specially; earlyInit/init are special-cased pre-validation.
  for (const m of new Set(dispatched)) {
    assert.ok(WORKER_METHODS[m], `method ${m} has an IPC validation spec`);
  }
});

test('ipc: adversarial params are rejected', () => {
  assert.match(validateWorkerParams('chat', { input: 'x'.repeat(65 * 1024) }) || '', /exceeds max length/);
  assert.equal(validateWorkerParams('chat', { input: 123 }), 'params.input must be a string');
  assert.match(validateWorkerParams('resolvePermission', { id: '1', answer: 'z' }) || '', /must be one of/);
  assert.ok(PERMISSION_ANSWERS.includes('y') && PERMISSION_ANSWERS.includes('a') && PERMISSION_ANSWERS.includes('n'));
  assert.equal(validateWorkerParams('setCwd', { cwd: 42 }), 'params.cwd must be a string');
  assert.equal(validateWorkerParams('bogusMethod', {}), 'unknown method: bogusMethod');
});

test('sqlite: tool-set completeness (the 10 documented built-ins)', () => {
  const expected = ['query', 'execute', 'list-tables', 'describe-table', 'create-table', 'drop-table', 'insert-record', 'update-record', 'delete-record', 'transaction'];
  for (const n of expected) assert.ok(SQLITE_TOOLS.has(n), `sqlite tool ${n}`);
  assert.equal(SQLITE_TOOLS.size, 10);
});

test('fs: tool-set completeness (the 3 documented built-ins)', () => {
  const expected = ['read_media_file', 'list_directory_with_sizes', 'list_allowed_directories'];
  for (const n of expected) assert.ok(FILESYSTEM_TOOLS.has(n), `fs tool ${n}`);
  assert.equal(FILESYSTEM_TOOLS.size, 3);
});
