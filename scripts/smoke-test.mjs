import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', 'dist', 'agent-worker.js');

const child = spawn('node', [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

let nextId = 1;
const pending = new Map();
let ok = true;

function req(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, data: undefined });
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'result') {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  } else {
    console.log(`[worker] ${msg.type}:`, JSON.stringify(msg).slice(0, 200));
  }
});

const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

async function expect(cond, label, detail) {
  if (!cond) { ok = false; console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`PASS: ${label}`);
}

await timeout(500);
const init = await req('init');
await expect(init.ok === true, 'init ok', init.error);console.log('cwd =', init.data?.cwd);

const status = await req('getStatus');
await expect(status.ok === true && typeof status.data.provider === 'string', 'getStatus');

const providers = await req('getProviders');
await expect(Array.isArray(providers.data), 'getProviders list');

const cfg = await req('getConfig');
await expect(cfg.ok === true && !String(cfg.data.providers?.anthropic?.apiKey || '').includes('sk-'), 'getConfig masks apiKey');

const sessions = await req('listSessions');
await expect(Array.isArray(sessions.data?.items), 'listSessions');

const sid = await req('startSession');
await expect(typeof sid.data === 'string' && sid.data.length > 0, 'startSession');

const sessions2 = await req('listSessions');
await expect(Array.isArray(sessions2.data?.items) && sessions2.data.items.length > 0, 'session persisted');

const msgs = await req('getMessages', { sessionId: sid.data });
await expect(
  msgs.data && Array.isArray(msgs.data.items) && typeof msgs.data.total === 'number' && typeof msgs.data.userBefore === 'number',
  'getMessages',
);

const msgsLast = await req('getMessages', { sessionId: sid.data, last: 5 });
await expect(Array.isArray(msgsLast.data?.items) && msgsLast.data.items.length === 0, 'getMessages last');

// Derived session (Desktop /new path): the parent's memory is finalized in its
// own process first, then startSession with prevSessionId must create a NEW
// session id (via the core's create-new branch) AND keep the derived session's
// own transcript empty (inherited baseline is injected as system context, not
// replayed into the transcript).
const prep = await req('prepareParentMemory');
await expect(
  prep.ok === true && typeof prep.data?.msgs === 'number' && typeof prep.data?.summary === 'boolean',
  'prepareParentMemory finalizes parent memory in-process',
  JSON.stringify(prep.data),
);

const sid2 = await req('startSession', { prevSessionId: sid.data });
await expect(
  typeof sid2.data === 'string' && sid2.data.length > 0 && sid2.data !== sid.data,
  'startSession prevSessionId creates distinct id',
  `parent=${sid.data} derived=${sid2.data}`,
);

const derivedMsgs = await req('getMessages', { sessionId: sid2.data, last: 5 });
await expect(
  Array.isArray(derivedMsgs.data?.items) && derivedMsgs.data.items.length === 0,
  'derived session starts empty',
);

await req('deleteSession', { id: sid2.data });
await req('deleteSession', { id: sid.data });

// --- Built-in filesystem tools (src/fs-internal.ts) ---
const fsMod = await import('node:fs/promises');
const osMod = await import('node:os');
const pathMod = await import('node:path');
const { FILESYSTEM_TOOLS, FILESYSTEM_TOOL_DEFS, callFsTool } = await import(pathToFileURL(join(__dirname, '..', 'dist', 'tools', 'index.js')));
// Non-interactive: any out-of-allow path must be DENIED (never a dead prompt).
(await import(pathToFileURL(join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'security', 'path-authorizer.js'))))
  .setPermissionPrompter(() => 'n');

await expect(
  FILESYSTEM_TOOLS.size === 3 &&
    ['read_media_file', 'list_directory_with_sizes', 'list_allowed_directories'].every((n) => FILESYSTEM_TOOLS.has(n)),
  'fs-internal tool set',
);
await expect(FILESYSTEM_TOOL_DEFS.every((d) => d.server === 'filesystem-internal'), 'fs-internal defs tagged');

const fsTmp = pathMod.join(process.cwd(), '.smoke-fs-test');
await fsMod.mkdir(fsTmp, { recursive: true });
await fsMod.writeFile(pathMod.join(fsTmp, 'one.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64',
));
await fsMod.writeFile(pathMod.join(fsTmp, 'a.txt'), 'hello');

const list = await callFsTool('list_directory_with_sizes', { path: fsTmp });
const listJson = JSON.parse(list.content);
await expect(
  list.isError !== true && Array.isArray(listJson.entries) && listJson.entries.find((e) => e.name === 'a.txt')?.size === 5,
  'list_directory_with_sizes sizes',
);

const media = await callFsTool('read_media_file', { path: pathMod.join(fsTmp, 'one.png') });
await expect(
  media.isError !== true && media.content.startsWith('![one.png](data:image/png;base64,'),
  'read_media_file data-URI',
  media.content?.slice(0, 60),
);

const allowed = await callFsTool('list_allowed_directories');
const allowedJson = JSON.parse(allowed.content);
await expect(
  allowedJson.cwd === process.cwd() && typeof allowedJson.sandboxActive === 'boolean' && Array.isArray(allowedJson.grantedRoots),
  'list_allowed_directories boundary report',
);

const denied = await callFsTool('list_directory_with_sizes', { path: osMod.tmpdir() });
await expect(denied.isError === true, 'fs-internal out-of-root denied', (denied.content || '').slice(0, 60));

await fsMod.rm(fsTmp, { recursive: true, force: true });

// --- Built-in sequential-thinking (src/sequential-think.ts) ---
const { SEQUENTIAL_THINK_TOOLS, SEQUENTIAL_THINK_TOOL_DEFS, callSequentialThinkTool } =
  await import(pathToFileURL(join(__dirname, '..', 'dist', 'tools', 'index.js')));
await expect(
  SEQUENTIAL_THINK_TOOL_DEFS.length === 1 && SEQUENTIAL_THINK_TOOLS.has('sequentialthinking'),
  'seq-thinking tool set',
);
const st1 = await callSequentialThinkTool('sequentialthinking', { thought: 'step one', thoughtNumber: 1, totalThoughts: 3, nextThoughtNeeded: true });
const st1j = JSON.parse(st1.content);
await expect(
  st1.isError !== true && st1j.thoughtNumber === 1 && st1j.thoughtHistoryLength === 1,
  'seq-thinking first thought',
  st1.content?.slice(0, 60),
);
const stBad = await callSequentialThinkTool('sequentialthinking', { thought: '', thoughtNumber: 1, totalThoughts: 3, nextThoughtNeeded: true });
await expect(stBad.isError === true, 'seq-thinking bad thought rejected');
const stBranch = await callSequentialThinkTool('sequentialthinking', { thought: 'branch', thoughtNumber: 2, totalThoughts: 4, nextThoughtNeeded: true, branchFromThought: 1, branchId: 'A', isRevision: true, revisesThought: 1 });
const stBj = JSON.parse(stBranch.content);
await expect(stBj.branches.includes('A') && stBj.thoughtHistoryLength === 2, 'seq-thinking branch registered', stBranch.content?.slice(0, 60));

// --- Built-in sqlite (src/sqlite-tools.ts) ---
const { SQLITE_TOOLS, SQLITE_TOOL_DEFS, callSqliteTool, closeSqliteDbs } =
  await import(pathToFileURL(join(__dirname, '..', 'dist', 'tools', 'index.js')));
await expect(
  SQLITE_TOOLS.size === 10 && SQLITE_TOOL_DEFS.every((d) => d.server === 'sqlite-internal'),
  'sqlite-internal tool set',
);
const sqTmp = pathMod.join(process.cwd(), '.smoke-sqlite-test');
await fsMod.mkdir(sqTmp, { recursive: true });
const sqDb = pathMod.join(sqTmp, 'test.db');
const sqliteCtx = { getConfig: () => ({}), requestWriteApproval: async () => true };
const created = await callSqliteTool('create-table', { name: 't1', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'name', type: 'TEXT' }], dbPath: sqDb }, sqliteCtx);
await expect(created.isError !== true, 'sqlite create-table', created.content?.slice(0, 80));
const inserted = await callSqliteTool('insert-record', { table: 't1', data: { id: 1, name: 'nexus' }, dbPath: sqDb }, sqliteCtx);
await expect(inserted.isError !== true, 'sqlite insert-record', inserted.content?.slice(0, 80));
const q = await callSqliteTool('query', { sql: 'SELECT * FROM t1', dbPath: sqDb }, sqliteCtx);
const qJson = JSON.parse(q.content);
await expect(Array.isArray(qJson) && qJson[0]?.name === 'nexus', 'sqlite query', q.content?.slice(0, 80));
const qBad = await callSqliteTool('query', { sql: 'PRAGMA journal_mode=WAL', dbPath: sqDb }, sqliteCtx);
await expect(qBad.isError === true, 'sqlite dangerous SQL rejected', (qBad.content || '').slice(0, 60));
const dropped = await callSqliteTool('drop-table', { name: 't1', dbPath: sqDb }, sqliteCtx);
await expect(dropped.isError !== true, 'sqlite drop-table', dropped.content?.slice(0, 80));
const sqDenied = await callSqliteTool('query', { sql: 'SELECT 1', dbPath: pathMod.join(osMod.tmpdir(), 'nexus-no.db') }, sqliteCtx);
await expect(sqDenied.isError === true, 'sqlite out-of-root dbPath denied', (sqDenied.content || '').slice(0, 60));
const sqMiss = await callSqliteTool('query', { sql: 'SELECT 1', dbPath: pathMod.join(sqTmp, 'no-such.db') }, sqliteCtx);
await expect(
  sqMiss.isError === true && (sqMiss.content || '').includes('create the database first'),
  'sqlite missing custom dbPath hints to create',
  (sqMiss.content || '').slice(0, 80),
);
const sqMissingUncreated = !(await fsMod.access(pathMod.join(sqTmp, 'no-such.db')).then(() => true).catch(() => false));
await expect(sqMissingUncreated, 'sqlite read never creates a custom db file');
// Default (config-granted) database is still create-on-first-open, like before hardening.
const defDb = pathMod.join(sqTmp, 'default.db');
const defCtx = { getConfig: () => ({ mcpServers: { sqlite: { args: ['node', defDb] } } }), requestWriteApproval: async () => true };
const listTablesDefault = await callSqliteTool('list-tables', {}, defCtx);
await expect(listTablesDefault.isError !== true, 'sqlite config-default db still opens', listTablesDefault.content?.slice(0, 60));
const defaultCreated = (await fsMod.access(defDb).then(() => true).catch(() => false));
await expect(defaultCreated, 'sqlite config-default db is created on first read');
closeSqliteDbs();
await fsMod.rm(sqTmp, { recursive: true, force: true });

// --- P2 skills (src/skills/*): artifact envelope over the tool loop ---
const { parseArtifactContent } = await import(pathToFileURL(join(__dirname, '..', 'dist', 'shared', 'artifact.js')));
const { SHEET_TOOLS, SHEET_TOOL_DEFS, callSheetTool, CHART_TOOLS, CHART_TOOL_DEFS, callChartTool } =
  await import(pathToFileURL(join(__dirname, '..', 'dist', 'tools', 'index.js')));
await expect(
  SHEET_TOOLS.size === 2 && SHEET_TOOL_DEFS.every((d) => d.server === 'sheet-internal'),
  'sheet-internal tool set',
);
await expect(CHART_TOOLS.has('bi.chart') && CHART_TOOL_DEFS[0].server === 'chart-internal', 'chart-internal tool set');
const sheetTmp = pathMod.join(process.cwd(), '.smoke-sheet-test');
await fsMod.mkdir(sheetTmp, { recursive: true });
const csvPath = pathMod.join(sheetTmp, 'sales.csv');
await fsMod.writeFile(csvPath, 'month,amount\nJan,120\nFeb,260\nMar,90\n', 'utf8');
const sheetCtx = { getConfig: () => ({}), requestWriteApproval: async () => true };
const sheetRead = await callSheetTool('sheet.read', { path: csvPath }, sheetCtx);
const sheetArt = sheetRead.isError ? null : parseArtifactContent(sheetRead.content);
await expect(
  !sheetRead.isError && sheetArt?.type === 'sheet' && sheetArt.body.columns?.length === 2 && sheetArt.body.rowCount === 3,
  'sheet.read parses CSV into a sheet artifact',
  sheetRead.content?.slice(0, 60),
);
const chartRes = await callChartTool(
  'bi.chart',
  {
    data: { columns: ['month', 'amount'], rows: [['Jan', 120], ['Feb', 260], ['Mar', 90]] },
    mark: 'bar',
    x: 'month',
    y: 'amount',
    title: 'Sales',
  },
  sheetCtx,
);
const chartArt = chartRes.isError ? null : parseArtifactContent(chartRes.content);
await expect(
  !chartRes.isError && chartArt?.type === 'chart' && chartArt.body.spec?.marks?.[0]?.type === 'rect',
  'bi.chart compiles a Vega spec into a chart artifact',
  chartRes.content?.slice(0, 60),
);
const chartBad = await callChartTool(
  'bi.chart',
  { data: { columns: ['a'], rows: [[1]] }, mark: 'bar', encoding: { gradient: { field: 'a', type: 'quantitative' } } },
  sheetCtx,
);
await expect(chartBad.isError === true, 'bi.chart rejects untracked encoding channels', (chartBad.content || '').slice(0, 80));
await fsMod.rm(sheetTmp, { recursive: true, force: true });

await req('shutdown');
child.on('exit', () => {
  console.log(ok ? '\nSMOKE TEST: ALL PASS' : '\nSMOKE TEST: FAILED');
  process.exit(ok ? 0 : 1);
});
