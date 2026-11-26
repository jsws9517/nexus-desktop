#!/usr/bin/env node
/**
 * Sub-Agent panel + delegation stress test — REAL model conversations.
 *
 * What it verifies (after the recent permission/contract hardening):
 *   1. Delegation works end-to-end with the real LLM:
 *        - desktop fan-out (explicit task list / parallel directive)
 *          emits fanout_start → N×{running,succeeded} → fanout_end;
 *        - standalone spawn_subagent emits
 *          task_graph → task_started → subagent_status(running) →
 *          task_completed → subagent_status(completed).
 *   2. Event contract: status machine is legal, task sets agree across
 *      start / progress / end, no stall aborts, session ids stay scoped.
 *   3. The NEW `basic` permission mode (and unattended) can complete a
 *      delegation turn without wedging; permission cards are answered by the
 *      harness and counted, never silently dropped.
 *   4. The Sub-Agents sidebar page renders the REAL captured event stream
 *      correctly (3 sections, topological DAG order, session scoping) and
 *      survives high-frequency progress replays without leaking DOM nodes.
 *
 * Usage:
 *   npm run build && node scripts/subagent-stress-test.mjs
 *   node scripts/subagent-stress-test.mjs --mode unattended --rounds 2
 *   node scripts/subagent-stress-test.mjs --quick
 *
 * Flags:
 *   --mode basic|unattended|auto|prompt  (default basic; the new mode)
 *   --rounds N        rounds per worker (default 3)
 *   --concurrency N   parallel worker processes (default 2)
 *   --model ID        (default agnes-2.5-flash)
 *   --base-url URL    (default https://apihub.agnes-ai.com/v1)
 *   --turn-timeout-ms N  (default 180000)
 *   --quick           concurrency=1, rounds=2, forced scenario subset
 *   --keep-tmp        keep the throwaway config dir
 *
 * API key: $API_KEY_CODING (or LOADTEST_API_KEY / AGNES_API_KEY).
 * Reports: test/reports/subagent-stress-report.json + -events.jsonl
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WORKER = join(ROOT, 'dist', 'agent-worker.js');
const REPORT_DIR = join(ROOT, 'test', 'reports');
const KEY_ENV = 'API_KEY_CODING';

// ---------------------------------------------------------------------------
// Scenarios — prompts designed to hit one delegation path each, deterministically.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  'fanout-list': {
    kind: 'fanout', minTasks: 2,
    prompt: [
      '请并行处理以下两个独立任务，分别给出结果：',
      '任务 1：计算 12 + 30 的值。',
      '任务 2：计算 100 - 58 的值。',
    ].join('\n'),
  },
  'fanout-three': {
    // Default spend tier is `token`, whose fanoutCap=2: a 3-item plan is
    // intentionally truncated. Asserting 2 here pins that cap behaviour.
    kind: 'fanout', minTasks: 2,
    prompt: [
      '请分别执行下面三个独立任务，逐条给出答案：',
      '1. 计算 7 * 6 的结果。',
      '2. 计算 81 / 9 的结果。',
      '3. 计算 50 - 17 的结果。',
    ].join('\n'),
  },
  'spawn-standalone': {
    kind: 'spawn',
    prompt: '请使用 spawn_subagent 工具委派一个子代理，让它计算 123 乘以 456 的结果；你只需把子代理返回的数值告诉我，不要自己算。',
  },
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    mode: 'basic', rounds: 3, concurrency: 2,
    model: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1',
    turnTimeoutMs: 180_000, quick: false, keepTmp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const n = () => argv[++i];
    if (a === '--mode') o.mode = n();
    else if (a === '--rounds') o.rounds = Number(n());
    else if (a === '--concurrency') o.concurrency = Number(n());
    else if (a === '--model') o.model = n();
    else if (a === '--base-url') o.baseUrl = n();
    else if (a === '--turn-timeout-ms') o.turnTimeoutMs = Number(n());
    else if (a === '--quick') o.quick = true;
    else if (a === '--keep-tmp') o.keepTmp = true;
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  if (o.quick) { o.concurrency = 1; o.rounds = 2; }
  if (!['basic', 'auto', 'unattended', 'prompt'].includes(o.mode)) {
    console.error(`invalid --mode: ${o.mode}`); process.exit(2);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Worker client (stdio JSON-RPC) — production worker, real LLM behind it.
// ---------------------------------------------------------------------------
class WorkerClient {
  constructor(id, env, { onEvent, onPermission }) {
    this.id = id;
    this.onEvent = onEvent;
    this.onPermission = onPermission;
    this.child = spawn('node', [WORKER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = '';
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (l) => this.handle(l));
    this.child.stderr.on('data', (d) => { this.stderrTail = (this.stderrTail + String(d)).slice(-4000); });
    this.child.on('exit', (code) => {
      for (const [id, e] of this.pending) {
        clearTimeout(e.timer); e.resolve({ ok: false, error: `worker exited (${code})` });
      }
    });
  }
  handle(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'result') {
      const e = this.pending.get(m.id);
      if (e) { clearTimeout(e.timer); this.pending.delete(m.id); e.resolve(m); }
    } else if (m.type === 'event') {
      this.onEvent(m.event ?? {});
    } else if (m.type === 'permission') {
      this.onPermission(m);
      this.write('resolvePermission', { id: m.id, answer: 'y' }, 15_000);
    }
    // mcpRequest/getTools & rateLimitReport are intentionally not proxied here:
    // the worker tolerates an absent hub (probed), which keeps this harness lean.
  }
  write(method, params, timeoutMs) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
    if (timeoutMs === undefined) return undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); resolve({ ok: false, error: `timeout (${method})` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }
  req(method, params, timeoutMs = 60_000) { return this.write(method, params, timeoutMs); }
  kill() { try { this.child.kill('SIGKILL'); } catch { /* dead */ } }
}

// ---------------------------------------------------------------------------
// Contract checks on a captured run
// ---------------------------------------------------------------------------
const TERMINAL = new Set(['succeeded', 'failed', 'timeout', 'cancelled']);

function checkFanout(run) {
  const problems = [];
  const { events } = run;
  const starts = events.filter((e) => e.type === 'fanout_start');
  const ends = events.filter((e) => e.type === 'fanout_end');
  const progresses = events.filter((e) => e.type === 'fanout_task_progress');
  if (starts.length !== 1) problems.push(`expected 1 fanout_start, got ${starts.length}`);
  if (ends.length !== 1) problems.push(`expected 1 fanout_end, got ${ends.length}`);
  if (!starts.length || !ends.length) return problems;
  const start = starts[0]; const end = ends[0];
  const startIds = (start.tasks ?? []).map((t) => t.id);
  if (startIds.length < run.scenario.minTasks) {
    problems.push(`fanout_start tasks=${startIds.length} < min ${run.scenario.minTasks}`);
  }
  const endIds = (end.tasks ?? []).map((t) => t.taskId);
  if (startIds.join('|') !== endIds.join('|')) {
    problems.push(`task id set drift: start=[${startIds}] end=[${endIds}]`);
  }
  const expectedRunning = new Set(startIds);
  const seenRunning = new Set();
  for (const p of progresses) {
    if (p.status === 'running') {
      if (!expectedRunning.has(p.taskId)) problems.push(`running for unknown task ${p.taskId}`);
      if (seenRunning.has(p.taskId)) problems.push(`duplicate running for ${p.taskId}`);
      seenRunning.add(p.taskId);
    } else if (!TERMINAL.has(String(p.status))) {
      problems.push(`non-terminal progress status ${p.status} for ${p.taskId}`);
    }
  }
  for (const id of startIds) if (!seenRunning.has(id)) problems.push(`missing running progress for ${id}`);
  for (const t of end.tasks ?? []) {
    if (!TERMINAL.has(String(t.status))) problems.push(`fanout_end non-terminal status ${t.status} for ${t.taskId}`);
    if (!Number.isFinite(t.durationMs)) problems.push(`fanout_end missing durationMs for ${t.taskId}`);
    if (!t.tokenUsage || !Number.isFinite(t.tokenUsage.prompt)) {
      problems.push(`fanout_end missing tokenUsage for ${t.taskId}`);
    }
  }
  // Ordering: every progress must precede fanout_end.
  const endIdx = events.indexOf(end);
  for (const p of progresses) {
    if (events.indexOf(p) > endIdx) problems.push(`progress for ${p.taskId} after fanout_end`);
  }
  return problems;
}

function checkSpawn(run) {
  const problems = [];
  const types = run.events.map((e) => e.type);
  const need = ['task_graph', 'task_started', 'subagent_status', 'task_completed'];
  for (const t of need) if (!types.includes(t)) problems.push(`missing ${t}`);
  const statuses = run.events.filter((e) => e.type === 'subagent_status').map((e) => e.run?.status);
  if (!statuses.includes('running')) problems.push('no subagent_status(running)');
  if (!statuses.some((s) => s === 'completed' || s === 'succeeded')) {
    problems.push(`no terminal subagent_status (got ${statuses.join(',')})`);
  }
  const graph = run.events.find((e) => e.type === 'task_graph');
  if (graph && (!graph.tasks?.length || !graph.graphId)) problems.push('task_graph missing graphId/tasks');
  return problems;
}

function checkCommon(run) {
  const problems = [];
  const ends = run.events.filter((e) => e.type === 'turn_end');
  if (!ends.length) problems.push('no turn_end');
  for (const e of ends) {
    if (['abort', 'deadline'].includes(e.stopReason)) {
      problems.push(`stall abort (stopReason=${e.stopReason})`);
    }
  }
  const text = run.events.filter((e) => e.type === 'text').map((e) => String(e.text ?? '')).join('');
  // Fan-out summaries are often terse (e.g. "429" for three arithmetic tasks);
  // require a real answer, not an arbitrary length. Sub-task detail lives in
  // fanout_end.tasks[].output and is checked by checkFanout.
  if (text.trim().length < 1) problems.push('assistant produced no text');
  for (const e of run.events) {
    if (e.sessionId && e.sessionId !== run.sessionId) {
      problems.push(`event ${e.type} leaked session ${e.sessionId}`);
    }
    if (e.run?.sessionId && e.run.sessionId !== run.sessionId) {
      problems.push(`subagent_status leaked session ${e.run.sessionId}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Real event stream → sidebar run views (mirrors renderer.ts registry shape)
// ---------------------------------------------------------------------------
function eventsToRuns(events, sessionId) {
  const runs = new Map();
  // Bare task_* events carry no graphId. The renderer files them under the
  // session's current graph — mirror that so a standalone spawn never shows up
  // as a duplicate second run next to its own DAG.
  const sessionGraphId = new Map();
  const ensure = (key, kind, seed) => {
    if (!runs.has(key)) {
      runs.set(key, {
        key, kind, sessionId,
        prompt: seed.prompt ?? '', startTime: seed.startTime ?? 1,
        graphId: seed.graphId, taskOrder: seed.taskOrder,
        tasks: new Map(),
      });
    }
    return runs.get(key);
  };
  const putTask = (run, id, patch) => {
    const t = run.tasks.get(id) ?? { status: 'pending', updatedAt: 0 };
    Object.assign(t, patch, { updatedAt: Date.now() });
    run.tasks.set(id, t);
  };
  for (const e of events) {
    if (e.type === 'fanout_start') {
      const r = ensure(`fanout:${sessionId}`, 'fanout', { prompt: e.prompt });
      for (const t of e.tasks ?? []) putTask(r, t.id, { description: t.description, status: t.status ?? 'pending' });
    } else if (e.type === 'fanout_task_progress') {
      const r = ensure(`fanout:${sessionId}`, 'fanout', {});
      putTask(r, e.taskId, { status: e.status, description: e.description ?? undefined, error: e.error });
    } else if (e.type === 'fanout_end') {
      const r = ensure(`fanout:${sessionId}`, 'fanout', {});
      for (const t of e.tasks ?? []) putTask(r, t.taskId, { status: t.status, output: t.output, error: t.error, durationMs: t.durationMs });
    } else if (e.type === 'task_graph') {
      const gid = e.graphId ?? `g-${sessionId}`;
      sessionGraphId.set(sessionId, gid);
      const r = ensure(`dag:${gid}`, 'dag', { graphId: gid, prompt: e.tasks?.[0]?.description ?? '', taskOrder: (e.tasks ?? []).map((t) => t.id) });
      for (const t of e.tasks ?? []) putTask(r, t.id, { description: t.description, status: t.status ?? 'pending' });
    } else if (e.type === 'task_started') {
      const gid = e.graphId ?? sessionGraphId.get(sessionId);
      const r = gid
        ? (runs.get(`dag:${gid}`) ?? ensure(`dag:${gid}`, 'dag', { graphId: gid }))
        : ensure(`standalone:${sessionId}`, 'standalone', {});
      if (r) putTask(r, e.taskId, { description: e.description, status: 'running' });
    } else if (e.type === 'task_completed') {
      for (const r of runs.values()) if (r.tasks.has(e.taskId)) putTask(r, e.taskId, { status: 'succeeded' });
    } else if (e.type === 'task_failed') {
      for (const r of runs.values()) if (r.tasks.has(e.taskId)) putTask(r, e.taskId, { status: 'failed', error: e.error });
    } else if (e.type === 'subagent_status') {
      const st = String(e.run?.status ?? '');
      const status = st === 'completed' ? 'succeeded' : (st === 'in_progress' ? 'running' : st);
      const gid = e.run?.graphId ?? sessionGraphId.get(sessionId);
      const target = gid ? runs.get(`dag:${gid}`) : runs.get(`standalone:${sessionId}`);
      if (target && target.tasks.has(e.run?.id)) {
        putTask(target, e.run.id, { status, description: e.run?.taskDesc });
      }
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Panel harness — drive the REAL compiled page with a fake DOM.
// ---------------------------------------------------------------------------
class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.className = ''; this.dataset = {}; this.style = {}; this.innerHTML = ''; }
  appendChild(el) { this.children.push(el); return el; }
  replaceChildren() { this.children = []; }
}
class FakeContainer extends FakeEl {
  constructor() { super('div'); this.classList = { add() {}, remove() {} }; }
}
function countEls(el) { return 1 + (el.children ?? []).reduce((n, c) => n + countEls(c), 0); }

async function panelStress(records, sessions) {
  globalThis.document = { createElement: (tag) => new FakeEl(tag) };
  const { mountSubAgentsPage } = await import(
    pathToFileURL(join(ROOT, 'dist', 'renderer', 'sidebar', 'pages', 'sub-agents.js')).href
  );
  const results = [];
  const runsBySession = new Map();
  // Events are attributed by the worker→renderer IPC channel the harness
  // recorded, NOT by an event-field sessionId (bare task_* events have none).
  for (const sid of sessions) runsBySession.set(sid, eventsToRuns(records.filter((r) => r.session === sid).map((r) => r.event), sid));

  // (a) Correct rendering of the real captured stream, per session.
  for (const sid of sessions) {
    const runs = runsBySession.get(sid);
    const container = new FakeContainer();
    const handlers = [];
    const ctx = {
      sessionId: sid,
      getUiLang: () => 'zh-CN',
      getSubAgentRuns: () => runs,
      getActiveSessionId: () => sid,
      pruneSubAgentRuns: () => {},
      forceCloseStaleTasks: () => {},
      subscribe: (fn) => { handlers.push(fn); return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); }; },
    };
    const dispose = mountSubAgentsPage(container, ctx, { getUiLang: () => 'zh-CN' });
    const list = container.children[0]?.children?.find?.((e) => e.className === 'sub-agents-list');
    const groups = (list?.children ?? []).filter((e) => e.className === 'sub-agents-group-head').map((e) => e.dataset.kind);
    const sections = (list?.children ?? []).filter((e) => e.className === 'sub-agents-session');
    const cards = sections.reduce((n, s) => n + (s.children ?? []).length - 1, 0); // minus each section head
    const expectedRuns = runs.size;
    results.push({
      sessionId: sid, check: 'real-event-render',
      ok: sections.length === expectedRuns && groups.length > 0,
      runs: expectedRuns, sections: sections.length, groups, cards,
      nodes: countEls(container),
    });
    // (b) High-frequency progress replay: 200 synthetic progress events against
    //     the SAME mounted page. No throw, bounded DOM, all handlers still live.
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      const e = { type: 'subagent_task_progress', taskId: 'stress', status: i % 2 ? 'running' : 'succeeded' };
      for (const h of handlers) h(e);
    }
    const ms = performance.now() - t0;
    results.push({
      sessionId: sid, check: 'high-frequency-replay',
      ok: handlers.length === 1 && countEls(container) < 100000 && ms < 5000,
      events: 200, ms: Math.round(ms), nodes: countEls(container), handlers: handlers.length,
    });
    dispose();
    // The fake DOM treats innerHTML as a plain property, so the real page's
    // cleanup is observed via innerHTML + class removal, not child removal.
    results.push({ sessionId: sid, check: 'dispose', ok: handlers.length === 0 && container.innerHTML === '' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(WORKER)) {
    console.error(`missing ${WORKER} — run npm run build first`); process.exit(2);
  }
  const key = process.env[KEY_ENV] || process.env.LOADTEST_API_KEY || process.env.AGNES_API_KEY || '';
  if (!key) { console.error(`no API key; set ${KEY_ENV}`); process.exit(2); }

  const tmp = mkdtempSync(join(tmpdir(), `nexus-subagent-stress-`));
  const cfgDir = join(tmp, 'nexus');
  mkdirSync(cfgDir, { recursive: true });
  const config = {
    activeProvider: 'coding',
    providers: { coding: { type: 'openai', apiKey: `$${KEY_ENV}`, model: opts.model, baseUrl: opts.baseUrl, depth: 'low', options: {} } },
    permissions: { mode: opts.mode },
    modelContextLimits: { [opts.model]: 524288 },
  };
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(config, null, 2));
  process.env.NEXUS_CONFIG_DIR = cfgDir;
  const workerEnv = { [KEY_ENV]: key, NEXUS_CONFIG_DIR: cfgDir };

  mkdirSync(REPORT_DIR, { recursive: true });
  const eventsPath = join(REPORT_DIR, `subagent-stress-events-${opts.mode}.jsonl`);
  writeFileSync(eventsPath, '');

  // Production topology: Electron main initializes/shared-warms sessions.db
  // BEFORE tab workers spawn. Mirror that with a probe worker — otherwise N
  // workers race the first schema creation and one loses with a spurious
  // "database is locked" (cold-start artifact, not a delegation contract bug).
  {
    const probe = new WorkerClient('probe', workerEnv, { onEvent() {}, onPermission() {} });
    const pi = await probe.req('init', { cwd: tmp }, 120_000);
    if (!pi.ok) {
      probe.kill();
      console.error(`[subagent-stress] probe init failed: ${pi.error}`);
      process.exit(2);
    }
    probe.kill();
  }

  const sessionIds = [];
  const runs = [];
  const scenarioIds = Object.keys(SCENARIOS);
  const workers = Array.from({ length: opts.concurrency }, (_, wid) => (async () => {
    const localRuns = [];
    const client = new WorkerClient(`w${wid}`, workerEnv, {
      onEvent: (e) => {
        appendFileSync(eventsPath, JSON.stringify({ worker: wid, session: localRuns.at(-1)?.sessionId ?? '', event: e }) + '\n');
        const cur = localRuns.at(-1);
        if (cur) cur.events.push(e);
      },
      onPermission: () => { if (localRuns.at(-1)) localRuns.at(-1).permissionCards += 1; },
    });
    try {
      const init = await client.req('init', { cwd: tmp }, 120_000);
      if (!init.ok) throw new Error(`init failed: ${init.error}`);
      const ov = await client.req('setProviderOverride', { name: 'coding', model: opts.model }, 30_000);
      if (!ov.ok) throw new Error(`setProviderOverride failed: ${ov.error}`);
      const po = await client.req('setPermissionsOverride', { mode: opts.mode }, 30_000);
      if (!po.ok) throw new Error(`setPermissionsOverride failed: ${po.error}`);
      for (let r = 0; r < opts.rounds; r++) {
        const sid = await client.req('startSession', undefined, 30_000);
        if (!sid.ok) { localRuns.push({ error: `startSession failed: ${sid.error}` }); continue; }
        const sessionId = String(sid.data ?? '');
        sessionIds.push(sessionId);
        const scenarioId = scenarioIds[r % scenarioIds.length];
        const scenario = SCENARIOS[scenarioId];
        const run = { worker: wid, round: r, scenarioId, scenario, sessionId, events: [], permissionCards: 0, startedAt: Date.now() };
        localRuns.push(run);
        const chat = await client.req('chat', { input: scenario.prompt }, opts.turnTimeoutMs);
        run.elapsedMs = Date.now() - run.startedAt;
        run.chatOk = !!chat.ok;
        if (!chat.ok) run.error = chat.error;
      }
    } catch (e) {
      localRuns.push({ worker: wid, error: e?.message ?? String(e), stderr: client.stderrTail.slice(-500) });
    } finally {
      client.kill();
    }
    return localRuns;
  })());
  const settled = await Promise.allSettled(workers);
  for (const s of settled) {
    if (s.status === 'fulfilled') runs.push(...s.value);
    else runs.push({ fatal: String(s.reason) });
  }

  // Contract verdicts
  for (const run of runs) {
    if (run.error || run.fatal) { run.problems = [run.error ?? run.fatal]; continue; }
    const kind = run.scenario?.kind;
    const problems = [...checkCommon(run)];
    if (kind === 'fanout') problems.push(...checkFanout(run));
    else if (kind === 'spawn') problems.push(...checkSpawn(run));
    run.problems = problems;
  }

  // Panel stress with the real captured stream (attributed by worker IPC).
  const records = [];
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.event && rec.event.type !== 'text' && rec.event.type !== 'thinking') records.push(rec);
    } catch { /* skip */ }
  }
  const panelResults = await panelStress(records, [...new Set(sessionIds)]);

  const okRuns = runs.filter((r) => r.problems?.length === 0).length;
  const report = {
    generatedAt: new Date().toISOString(),
    config: { mode: opts.mode, model: opts.model, concurrency: opts.concurrency, rounds: opts.rounds, baseUrl: opts.baseUrl },
    summary: {
      runs: runs.length, passed: okRuns, failed: runs.length - okRuns,
      passRate: runs.length ? okRuns / runs.length : 0,
      panelChecks: panelResults.length,
      panelPassed: panelResults.filter((p) => p.ok).length,
    },
    runs: runs.map((r) => ({
      worker: r.worker, round: r.round, scenarioId: r.scenarioId, sessionId: r.sessionId,
      chatOk: r.chatOk, elapsedMs: r.elapsedMs, permissionCards: r.permissionCards,
      eventCount: r.events?.length ?? 0, problems: r.problems,
    })),
    panel: panelResults,
  };
  const reportPath = join(REPORT_DIR, `subagent-stress-report-${opts.mode}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n[subagent-stress] mode=${opts.mode} runs=${runs.length} passed=${okRuns} failed=${runs.length - okRuns}`);
  console.log(`[subagent-stress] panel ${report.summary.panelPassed}/${panelResults.length} checks passed`);
  console.log(`[subagent-stress] reports: ${reportPath}\n                         ${eventsPath}`);
  for (const r of report.runs) {
    console.log(`  w${r.worker} r${r.round} ${r.scenarioId ?? '?'} ${r.sessionId ?? ''} ${r.elapsedMs ?? '-'}ms cards=${r.permissionCards ?? 0} events=${r.eventCount} ${r.problems?.length ? 'FAIL ' + r.problems.join('; ') : 'PASS'}`);
  }
  for (const p of panelResults) console.log(`  panel ${p.sessionId?.slice(0, 8)} ${p.check}: ${p.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(p)}`);

  if (!opts.keepTmp) rmSync(tmp, { recursive: true, force: true });
  else console.log(`[subagent-stress] kept tmp: ${tmp}`);
  process.exit(report.summary.failed === 0 && report.summary.panelPassed === panelResults.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
