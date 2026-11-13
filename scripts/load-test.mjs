#!/usr/bin/env node
/**
 * CICD load test — batch real-LLM runs through the desktop agent architecture
 * to verify built-in tool × MCP tool coordination and runtime quality.
 *
 * What it does (production-faithful topology):
 *   1. Builds a throwaway NEXUS_CONFIG_DIR with:
 *      - provider  "coding" / model "agnes-2.5-flash" (OpenAI-compatible,
 *        key via $API_KEY_CODING env placeholder, resolved from process.env);
 *      - the deterministic fixture MCP server (scripts/fixtures/
 *        loadtest-mcp-server.mjs) registered as mcpServers."loadtest";
 *      - unattended permissions with the fixture server whole-trusted
 *        (mcp:loadtest) so no interactive prompt can ever stall a run.
 *   2. Imports the COMPILED production hub (dist/main/mcp-hub.js) in-process
 *      and answers every worker's `mcpRequest` through it — exactly the
 *      "one hub, many workers" topology Electron main owns in production.
 *   3. Spawns K worker processes (dist/agent-worker.js, stdio JSON-RPC) and
 *      drives each through: init → setProviderOverride(coding/model) →
 *      setPermissionsOverride(unattended) → R rounds of
 *      { startSession → chat(scenario prompt) → event capture }.
 *   4. Scenarios exercise, by design, the full tool-coordination surface:
 *        - builtin core tools   (file_write / file_read / exec_command)
 *        - builtin in-process MCP tools (get_current_time, sequentialthinking)
 *        - builtin office skills        (sheet.read / sheet.analyze)
 *        - external MCP tools via the hub (loadtest_echo / loadtest_add)
 *   5. Emits machine reports (JSON + JUnit XML under test/reports/) and gates
 *      the pipeline on: pass rate, tool-error rate, stall-abort rate
 *      (runs cut by the core thinking-stall loop guard — a model-quality
 *      signal, not a per-run failure), optional p99 latency, and
 *      MCP-hub readiness.
 *
 * Usage:
 *   npm run build && node scripts/load-test.mjs [flags]
 *   node scripts/load-test.mjs --quick          # 1 worker, 2 scenarios, sanity
 *   node scripts/load-test.mjs --concurrency 4 --rounds 2
 *
 * Flags (env override in parentheses):
 *   --concurrency N      (LOADTEST_CONCURRENCY,  default 4)  parallel workers
 *   --rounds N           (LOADTEST_ROUNDS,       default 2)  scenario rounds per worker
 *   --scenarios a,b,c    (LOADTEST_SCENARIOS)    subset of the scenario list
 *   --provider NAME      (LOADTEST_PROVIDER,     default "coding")
 *   --model ID           (LOADTEST_MODEL,        default "agnes-2.5-flash")
 *   --base-url URL       (LOADTEST_BASE_URL,     default https://apihub.agnes-ai.com/v1)
 *   --turn-timeout-ms N  (LOADTEST_TURN_TIMEOUT_MS,  default 180000)
 *   --total-timeout-ms N (LOADTEST_TOTAL_TIMEOUT_MS, default 1800000)
 *   --pass-rate X        (LOADTEST_PASS_RATE,    default 0.75)
 *   --tool-error-rate X  (LOADTEST_TOOL_ERROR_RATE, default 0.30)
 *   --max-stall-abort-rate X (LOADTEST_MAX_STALL_ABORT_RATE, default 0.50)
 *   --max-turn-ms N      (LOADTEST_MAX_TURN_MS,  default 0 = latency gate off)
 *   --keep-tmp           keep the throwaway NEXUS_CONFIG_DIR for inspection
 *   --list               print scenario ids and exit
 *
 *   LOADTEST_EVENT_LOG=1  also dump per-worker event JSONL to test/reports/
 *                          (events-<worker>.jsonl) — the post-mortem trail
 *                          for a red gate; CI keeps it in the report artifact.
 *
 * API key resolution order: API_KEY_CODING → LOADTEST_API_KEY → AGNES_API_KEY.
 * Without a key the harness exits 2 (preflight failure, no LLM spend).
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const WORKER = join(ROOT, 'dist', 'agent-worker.js');
const HUB_MODULE = pathToFileURL(join(ROOT, 'dist', 'main', 'mcp-hub.js')).href;
const FIXTURE = join(ROOT, 'scripts', 'fixtures', 'loadtest-mcp-server.mjs');
const REPORT_DIR = join(ROOT, 'test', 'reports');
const MCP_SERVER = 'loadtest';

const DEFAULT_PROVIDER = 'coding';
const DEFAULT_MODEL = 'agnes-2.5-flash';
const DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const KEY_ENV = 'API_KEY_CODING'; // the $VAR reference the generated config carries

// ---------------------------------------------------------------------------
// Scenario definitions — each prompt names the tools it requires so the
// tool-relevance selector keeps them visible and the assertion is exact.
// ---------------------------------------------------------------------------
const SCENARIO_DEFS = {
  'builtin-fs': {
    desc: 'builtin core fs tools (file_write + file_read)',
    required: ['file_write', 'file_read'],
    prompt: [
      '请严格执行以下两步，必须使用指定的内置工具：',
      '1. 用 file_write 工具在当前目录创建文件 loadtest-a.txt，内容为单行文本：nexus load test ok',
      '2. 用 file_read 工具读取 loadtest-a.txt，确认内容正确',
      '完成后用一句话报告文件内容。禁止使用 exec_command。',
    ].join('\n'),
  },
  'mcp-add': {
    desc: 'external MCP tools via hub (loadtest_add + loadtest_now)',
    required: ['loadtest_add', 'loadtest_now'],
    prompt: [
      '请严格执行（必须实际调用 MCP 工具，仅用文字算术/猜测一律视为无效回答）：',
      '1. 用 MCP 工具 loadtest_add 计算 a=17 且 b=25 的和；',
      '2. 用 MCP 工具 loadtest_now 获取当前 UTC 时间戳（你自己无法知道，必须调用工具）；',
      '3. 用一句话报告 loadtest_add 返回的 sum 值和 loadtest_now 返回的 iso 时间戳。',
    ].join('\n'),
  },
  'exec-time': {
    desc: 'builtin exec + in-process time tool (exec_command + get_current_time)',
    required: ['exec_command', 'get_current_time'],
    prompt: [
      '请严格执行：',
      '1. 用 exec_command 工具执行命令：node -e "console.log(\'nexus-ok\', 42*100)"',
      '2. 用 get_current_time 工具获取当前 UTC 时间（ISO 8601 字符串）',
      '最后用一句话报告命令输出中的数字和该 ISO 时间。',
    ].join('\n'),
  },
  'mixed-chain': {
    desc: '4-tool mixed chain: builtin thinking + builtin fs + external MCP + time',
    required: ['sequentialthinking', 'file_write', 'loadtest_echo', 'get_current_time'],
    prompt: [
      '请严格按顺序使用工具完成一条混合链：',
      '1. 用 sequentialthinking 工具写一个两步计划（先建文件，再回显）；',
      '2. 用 file_write 工具在当前目录创建 loadtest-d.md，内容为：mixed chain ok',
      '3. 用 MCP 工具 loadtest_echo 回显字符串：chain-ok',
      '4. 用 get_current_time 工具记录当前时间',
      '完成后用一句话总结这四步的结果。',
    ].join('\n'),
  },
  'skill-sheet': {
    desc: 'builtin office skill chain (sheet.read + sheet.analyze) + MCP echo',
    required: ['sheet.read', 'sheet.analyze', 'loadtest_echo'],
    prompt: (fixtureCsv) =>
      [
        '请严格执行（使用内置技能工具）：',
        `1. 用 sheet.read 读取 CSV 文件：${fixtureCsv}`,
        '2. 用 sheet.analyze 统计 amount 列的 sum 与 mean',
        '3. 用 MCP 工具 loadtest_echo 回显字符串：sheet-ok',
        '最后用一句话报告 sum 与 mean 的数值。',
      ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// Args / env
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const v = (name) => process.env[name];
  const num = (x, d) => {
    if (x === undefined || x === '') return d;
    const n = Number(x);
    return Number.isFinite(n) ? n : d;
  };
  const str = (x, d) => (x === undefined || x === '' ? d : x);
  const opts = {
    concurrency: num(v('LOADTEST_CONCURRENCY'), 4),
    rounds: num(v('LOADTEST_ROUNDS'), 2),
    scenarios: v('LOADTEST_SCENARIOS') || Object.keys(SCENARIO_DEFS).join(','),
    provider: v('LOADTEST_PROVIDER') || DEFAULT_PROVIDER,
    model: v('LOADTEST_MODEL') || DEFAULT_MODEL,
    baseUrl: v('LOADTEST_BASE_URL') || DEFAULT_BASE_URL,
    providerType: v('LOADTEST_PROVIDER_TYPE') || 'openai',
    turnTimeoutMs: num(v('LOADTEST_TURN_TIMEOUT_MS'), 180_000),
    totalTimeoutMs: num(v('LOADTEST_TOTAL_TIMEOUT_MS'), 1_800_000),
    passRate: num(v('LOADTEST_PASS_RATE'), 0.75),
    toolErrorRate: num(v('LOADTEST_TOOL_ERROR_RATE'), 0.3),
    maxStallAbortRate: num(v('LOADTEST_MAX_STALL_ABORT_RATE'), 0.5),
    maxTurnMs: num(v('LOADTEST_MAX_TURN_MS'), 0),
    keepTmp: false,
    list: false,
    quick: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--concurrency': opts.concurrency = num(next(), opts.concurrency); break;
      case '--rounds': opts.rounds = num(next(), opts.rounds); break;
      case '--scenarios': opts.scenarios = str(next(), opts.scenarios); break;
      case '--provider': opts.provider = str(next(), opts.provider); break;
      case '--model': opts.model = str(next(), opts.model); break;
      case '--base-url': opts.baseUrl = str(next(), opts.baseUrl); break;
      case '--provider-type': opts.providerType = str(next(), opts.providerType); break;
      case '--turn-timeout-ms': opts.turnTimeoutMs = num(next(), opts.turnTimeoutMs); break;
      case '--total-timeout-ms': opts.totalTimeoutMs = num(next(), opts.totalTimeoutMs); break;
      case '--pass-rate': opts.passRate = num(next(), opts.passRate); break;
      case '--tool-error-rate': opts.toolErrorRate = num(next(), opts.toolErrorRate); break;
      case '--max-stall-abort-rate': opts.maxStallAbortRate = num(next(), opts.maxStallAbortRate); break;
      case '--max-turn-ms': opts.maxTurnMs = num(next(), opts.maxTurnMs); break;
      case '--keep-tmp': opts.keepTmp = true; break;
      case '--list': opts.list = true; break;
      case '--quick': opts.quick = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        console.error(`unknown flag: ${a}`);
        process.exit(2);
    }
  }
  if (opts.help) {
    console.log('Usage: node scripts/load-test.mjs [flags]  (see header for full docs)');
    process.exit(0);
  }
  if (opts.quick) {
    opts.concurrency = 1;
    // rounds=2 with a single worker covers BOTH quick scenarios exactly once
    // (round r takes scenario r % N), including the MCP path — the point of the smoke.
    opts.rounds = 2;
    opts.scenarios = 'builtin-fs,mcp-add';
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function normTool(name) {
  return String(name ?? '').trim();
}

/**
 * Capability families: distinct tool names that satisfy the SAME required
 * capability. The model may legitimately pick any member of the family the
 * prompt asked for (e.g. "read the file" → `file_read` or the core-builtin
 * alias `read_text_file`), so a scenario requirement is met when ANY family
 * member was observed. The map is symmetric (each direction is listed).
 */
const TOOL_FAMILY_ALIASES = {
  file_read: ['read_text_file'],
  read_text_file: ['file_read'],
  file_write: ['write_file', 'create_file'],
  write_file: ['file_write', 'create_file'],
  create_file: ['file_write', 'write_file'],
  exec_command: ['execute_command'],
  execute_command: ['exec_command'],
};

/** A required tool counts as called when any observed name matches under
 *  dotted/underscore alias recovery AND capability-family aliasing
 *  (file_read ↔ read_text_file, exec_command ↔ execute_command, …). */
function matchesRequired(observedNames, required) {
  const r1 = required.replace(/\./g, '_');
  const r2 = required.replace(/_/g, '.');
  const family = TOOL_FAMILY_ALIASES[required] ?? [];
  const familyOfObserved = (n) => (TOOL_FAMILY_ALIASES[n] ?? []).includes(required);
  return observedNames.some((n) => {
    const n1 = n.replace(/\./g, '_');
    const n2 = n.replace(/_/g, '.');
    return n === required || n === r1 || n === r2 || n1 === required || n2 === required
      || family.includes(n) || familyOfObserved(n);
  });
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ---------------------------------------------------------------------------
// Stop-reason classes (nexus-coder agent.js turn_end vocabulary)
// ---------------------------------------------------------------------------
// 'end_turn' | 'tool_use'  — normal completion / continuation.
// 'aborted'                — harness RPC-level abort: the turn exceeded the
//                            configured timeout and WE sent the `abort` RPC.
// 'abort' | 'deadline'     — core-INTERNAL stop: the desktop thinking-stall
//                            loop guard (src/agent/service.ts
//                            handleThinkingStall → agent.abort()) or a
//                            watchdog/deadline path cut the turn. That is a
//                            MODEL-QUALITY signal (the model degenerated into
//                            a repeated-thinking loop or stalled), not an
//                            architectural defect — the coordination that made
//                            the run work already happened. Tracked as the
//                            stall-abort-rate gate, not a per-run failure.
const STALL_STOP_REASONS = new Set(['abort', 'deadline']);

// When a turn is cancelled before a response arrives, the worker emits fixed
// placeholder `text` events instead of an assistant answer. Excluding them
// keeps the "assistant text produced" check honest (a cancelled turn must
// not masquerade as a completed one).
const CANCEL_TEXT_RE = /^\[(stopped|Turn incomplete|model stream stalled)/;

// ---------------------------------------------------------------------------
// Worker client — one stdio-JSON-RPC nexus agent worker
// ---------------------------------------------------------------------------
class WorkerClient {
  constructor(id, env, { onMcpRequest }) {
    this.id = id;
    this.onMcpRequest = onMcpRequest;
    this.eventLogPath = eventLogPath(id);
    this.child = spawn('node', [WORKER], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.activeRun = null; // run metrics object for the in-flight chat (if any)
    this.stderrTail = '';
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + String(d)).slice(-6000);
    });
    this.child.on('exit', (code) => {
      // Drain: any pending request resolves as an error so callers never hang.
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve({ ok: false, error: `worker exited (code=${code})` });
      }
    });
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'result': {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        entry.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error, errorStack: msg.errorStack });
        break;
      }
      case 'event':
        this.onEvent(msg.event ?? {});
        break;
      case 'permission':
        // Unattended architecture should never prompt; if it does, answer 'y'
        // and count it — permission prompts are a quality metric, not a block.
        if (this.activeRun) this.activeRun.permissionPrompts += 1;
        this.writeReq('resolvePermission', { id: msg.id, answer: 'y' }, 15_000);
        break;
      case 'mcpRequest':
        this.routeMcp(msg);
        break;
      case 'log':
      case 'rateLimitReport':
        break;
      default:
        break;
    }
  }

  onEvent(e) {
    const run = this.activeRun;
    if (this.eventLogPath) {
      appendFileSync(this.eventLogPath, JSON.stringify({ t: Date.now(), worker: this.id, event: e }) + '\n');
    }
    if (!run) return;
    switch (e.type) {
      case 'tool_call_start':
        run.toolCalls.push({ name: normTool(e.name), args: JSON.stringify(e.args ?? {}).slice(0, 160) });
        break;
      case 'tool_result': {
        const isError = e.isError === true;
        if (isError) run.toolErrors.push({ name: normTool(e.name), preview: String(e.content ?? '').slice(0, 200) });
        break;
      }
      case 'text': {
        const t = String(e.text ?? '');
        run.textChars += t.length;
        if (!CANCEL_TEXT_RE.test(t.trim())) run.realTextChars += t.length;
        break;
      }
      case 'turn_end':
        run.turnEnds += 1;
        run.stopReasons.push(e.stopReason ?? '(none)');
        run.stopReason = e.stopReason ?? run.stopReason;
        break;
      default:
        break;
    }
  }

  /** Worker → hub proxy (the production mcp-hub contract over stdio). */
  async routeMcp(msg) {
    try {
      const data = await this.onMcpRequest(msg.op, msg.data ?? {}, 120_000);
      this.child.stdin.write(JSON.stringify({ type: 'mcpResult', id: msg.id, ok: true, data }) + '\n');
    } catch (err) {
      this.child.stdin.write(
        JSON.stringify({ type: 'mcpResult', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n',
      );
    }
  }

  writeReq(method, params, timeoutMs) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
    if (timeoutMs === undefined) return undefined;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `timeout after ${timeoutMs}ms (${method})` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
  }

  /** Send a request, awaiting its result. `timeoutMs` guards a wedged worker. */
  req(method, params, timeoutMs = 60_000) {
    return this.writeReq(method, params, timeoutMs);
  }

  kill() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function fail(code, message) {
  console.error(`\n[loadtest] PREFLIGHT FAIL: ${message}`);
  process.exit(code);
}

/**
 * Optional full-fidelity event dump (LOADTEST_EVENT_LOG=1): every worker→host
 * event (tool_call_start/tool_result/text/turn_end/permission/…) per worker,
 * JSONL under test/reports/events-w<N>.jsonl. CI keeps it for post-mortems of
 * a gate that is red but the summary line is too coarse to explain.
 */
function eventLogPath(workerId) {
  return process.env.LOADTEST_EVENT_LOG === '1' ? join(REPORT_DIR, `events-${workerId}.jsonl`) : null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    for (const [id, def] of Object.entries(SCENARIO_DEFS)) {
      console.log(`${id}\t${def.desc}`);
    }
    process.exit(0);
  }

  // ---- preflight -----------------------------------------------------------
  for (const p of [WORKER, HUB_MODULE, FIXTURE]) {
    if (p.startsWith('file://') ? !existsSync(fileURLToPath(p)) : !existsSync(p)) {
      fail(2, `missing ${p} — run \`npm run build\` first.`);
    }
  }
  const key =
    process.env[KEY_ENV] || process.env.LOADTEST_API_KEY || process.env.AGNES_API_KEY || '';
  if (!key) {
    fail(
      2,
      `no API key found. Set ${KEY_ENV} (or LOADTEST_API_KEY / AGNES_API_KEY) in the environment.`,
    );
  }
  if (/\s|&|\||;|`|\$|\(|\)|<|>/.test(FIXTURE)) {
    fail(2, `fixture server path "${FIXTURE}" contains characters the MCP launch guard rejects (no whitespace/metachars).`);
  }

  const scenarioIds = opts.scenarios
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = scenarioIds.filter((s) => !(s in SCENARIO_DEFS));
  if (unknown.length > 0) fail(2, `unknown scenario id(s): ${unknown.join(', ')} (see --list)`);
  if (scenarioIds.length === 0) fail(2, 'no scenarios selected');
  if (opts.concurrency < 1 || opts.rounds < 1) fail(2, 'concurrency and rounds must be ≥ 1');

  // Throwaway NEXUS_CONFIG_DIR so the whole tree (config, session DB, hub)
  // runs hermetically — production semantics, zero user-state pollution.
  const tmpRoot = mkdtempSync(join(tmpdir(), `nexus-loadtest-${process.pid}-`));
  const cfgDir = join(tmpRoot, 'nexus');
  mkdirSync(cfgDir, { recursive: true });
  const fixtureCsv = join(ROOT, 'test', 'fixtures', 'sales.csv');

  // The report dir must exist BEFORE the probe worker — with
  // LOADTEST_EVENT_LOG=1 the event dumps stream into it as the run
  // progresses (a fresh CI checkout has no test/reports yet). Also clear
  // stale event dumps from earlier runs so post-mortems never mix runs.
  mkdirSync(REPORT_DIR, { recursive: true });
  if (process.env.LOADTEST_EVENT_LOG === '1') {
    for (const f of readdirSync(REPORT_DIR)) {
      if (f.startsWith('events-') && f.endsWith('.jsonl')) rmSync(join(REPORT_DIR, f));
    }
  }

  const config = {
    activeProvider: opts.provider,
    providers: {
      [opts.provider]: {
        type: opts.providerType,
        apiKey: `$${KEY_ENV}`, // env-resolved at provider construction
        model: opts.model,
        baseUrl: opts.baseUrl,
        depth: 'low',
        options: {},
      },
    },
    mcpServers: {
      [MCP_SERVER]: {
        command: 'node',
        args: [FIXTURE],
        autoStart: true,
        connectTimeoutMs: 15_000,
      },
    },
    permissions: {
      mode: 'unattended',
      // Production-shaped exec trust: with exec_command allowlisted, the
      // unattended path records a per-call one-shot for prompt-class commands
      // (inline evals) INSTEAD of routing them through the interactive prompt
      // channel — deterministic, no prompt race. Hard/destructive commands are
      // still blocked by the safety tiers, so this cannot loosen the gate.
      allowlist: ['exec_command', 'execute_command'],
      execPermission: 'auto',
      safePaths: [tmpRoot],
      mcpAllowlist: [`mcp:${MCP_SERVER}`],
      safetyRules: {
        requireGitCheckpoint: false,
        autoCheckpoint: false,
        inlineEvalWhitelist: [
          "node.*-e.*console\\.log",
          "node.*-e.*JSON\\.stringify",
        ],
      },
    },
    modelContextLimits: { [opts.model]: 524_288 },
  };
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(config, null, 2));

  // Worker children get the resolved key under the $VAR name their config uses.
  process.env[KEY_ENV] = key;
  // The in-process hub (imported below) builds its ConfigManager lazily in THIS
  // process, so NEXUS_CONFIG_DIR must point at the throwaway root here too —
  // otherwise the hub would connect the user's real ~/.nexus servers instead of
  // the fixture, and every mcp tool assertion would silently target the wrong
  // server set.
  process.env.NEXUS_CONFIG_DIR = cfgDir;
  const workerEnv = { [KEY_ENV]: key, NEXUS_CONFIG_DIR: cfgDir };

  const gitSha = (() => {
    try {
      return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim();
    } catch {
      return '(unknown)';
    }
  })();

  console.log(
    `[loadtest] provider=${opts.provider} model=${opts.model} concurrency=${opts.concurrency} ` +
      `rounds=${opts.rounds} scenarios=[${scenarioIds.join(', ')}] tmp=${tmpRoot}`,
  );

  // ---- production hub (one instance for ALL workers — the real topology) ---
  const mcpHub = (await import(HUB_MODULE)).mcpHub;
  const hubConnect = async (timeoutMs) => {
    await mcpHub.handle('connect');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const servers = mcpHub.servers?.() ?? [];
      const entry = servers.find((s) => s.name === MCP_SERVER);
      if (entry?.connected && entry.toolCount > 0) return entry;
      if (Date.now() > deadline) throw new Error(`MCP server "${MCP_SERVER}" not connected after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  let hubEntry;
  try {
    hubEntry = await hubConnect(30_000);
  } catch (e) {
    rmSync(tmpRoot, { recursive: true, force: true });
    fail(2, `production MCP hub could not connect the "${MCP_SERVER}" fixture server: ${e.message}`);
  }
  console.log(
    `[loadtest] MCP hub ready: server=${MCP_SERVER} tools=${hubEntry.toolCount} — ` +
      `${opts.concurrency} workers will proxy through this single hub.`,
  );
  const onMcpRequest = (op, params, timeoutMs) =>
    withTimeout(mcpHub.handle(op, params), timeoutMs, `hub op "${op}" timed out`);

  // ---- probe worker: prove the full init path before spending LLM quota ----
  {
    const probeSandbox = join(tmpRoot, 'sandbox', 'probe');
    mkdirSync(probeSandbox, { recursive: true });
    const probe = new WorkerClient('probe', workerEnv, { onMcpRequest });
    let step = '';
    try {
      step = 'init';
      const init = await probe.req('init', { cwd: probeSandbox }, 120_000);
      if (!init.ok) fail(2, `probe worker init failed: ${init.error ?? 'unknown'}\n${tail(probe, 4)}`);
      step = 'mcp-status';
      if (!(await waitForMcpReady(probe, 20_000))) {
        fail(2, `probe worker never saw MCP server "${MCP_SERVER}" connected: ${tail(probe, 6)}`);
      }
      step = 'setProviderOverride';
      const ov = await probe.req('setProviderOverride', { name: opts.provider, model: opts.model }, 30_000);
      if (!ov.ok) fail(2, `setProviderOverride failed: ${ov.error ?? 'unknown'}`);
      step = 'setPermissionsOverride';
      const po = await probe.req('setPermissionsOverride', { mode: 'unattended' }, 30_000);
      if (!po.ok) fail(2, `setPermissionsOverride failed: ${po.error ?? 'unknown'}`);
      step = 'setMcpServer';
      // Idempotent no-op against the hub (the server is already connected and
      // enabled), but the worker's setMcpServer awaits refreshMcpToolCache() —
      // guaranteeing THIS worker's MCP tool list is populated before any LLM
      // round, so a tool-list assertion can never race the async cache fill.
      const ms = await probe.req('setMcpServer', { name: MCP_SERVER, enabled: true }, 30_000);
      if (!ms.ok) fail(2, `setMcpServer failed: ${ms.error ?? 'unknown'}`);
      step = 'getProviders';
      const prov = await probe.req('getProviders', undefined, 30_000);
      const mine = (prov.data ?? []).find((p) => p.name === opts.provider);
      if (!mine) fail(2, `provider "${opts.provider}" not visible to worker (getProviders: ${JSON.stringify(prov.data ?? [])})`);
      console.log(`[loadtest] probe OK (provider=${opts.provider}/${opts.model}, mcp=${MCP_SERVER} connected)`);
    } catch (e) {
      fail(2, `probe failed at step "${step}": ${e?.message ?? e}`);
    } finally {
      probe.kill();
    }
  }

  // ---- load phase: K workers × R rounds -----------------------------------
  const deadline = Date.now() + opts.totalTimeoutMs;
  const workers = Array.from({ length: opts.concurrency }, (_, id) =>
    runWorker(id, opts, {
      tmpRoot,
      workerEnv,
      onMcpRequest,
      scenarioIds,
      fixtureCsv,
      deadline,
      key,
    }),
  );
  const settled = await Promise.allSettled(workers);

  const runs = [];
  const workerOutcomes = [];
  settled.forEach((s, id) => {
    if (s.status === 'rejected') {
      workerOutcomes.push({ worker: id, fatal: `harness crashed: ${s.reason?.message ?? s.reason}` });
      return;
    }
    workerOutcomes.push(s.value);
    runs.push(...s.value.runs);
  });

  // ---- aggregate + gates ----------------------------------------------------
  const aggregates = buildAggregates(runs, workerOutcomes);
  const gates = buildGates(opts, aggregates, hubEntry, workerOutcomes);
  const verdict = gates.every((g) => g.ok) ? 'PASS' : 'FAIL';

  // ---- reports ---------------------------------------------------------------
  const report = {
    generatedAt: new Date().toISOString(),
    git: gitSha,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    config: {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      concurrency: opts.concurrency,
      rounds: opts.rounds,
      scenarios: scenarioIds,
      turnTimeoutMs: opts.turnTimeoutMs,
      totalTimeoutMs: opts.totalTimeoutMs,
    },
    mcpHub: { server: MCP_SERVER, connected: true, toolCount: hubEntry.toolCount },
    runs,
    aggregates,
    gates,
    verdict,
  };
  writeFileSync(join(REPORT_DIR, 'loadtest-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(REPORT_DIR, 'loadtest-report.xml'), toJUnit(report, workerOutcomes));

  // ---- console summary ---------------------------------------------------------
  printSummary(report, workerOutcomes);

  // ---- cleanup -----------------------------------------------------------------
  await mcpHub.handle('setEnabled', { enable: false }).catch(() => {});
  if (!opts.keepTmp) rmSync(tmpRoot, { recursive: true, force: true });
  else console.log(`[loadtest] kept tmp dir for inspection: ${tmpRoot}`);

  process.exit(verdict === 'PASS' ? 0 : 1);
}

function tail(client, lines) {
  return client.stderrTail ? `\n--- worker stderr (last ${lines} lines) ---\n${client.stderrTail.split('\n').slice(-lines).join('\n')}` : '';
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function waitForMcpReady(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.req('getMcpStatus', undefined, 30_000);
    if (res.ok) {
      const entry = (res.data?.servers ?? []).find((s) => s.name === MCP_SERVER);
      if (entry && (entry.status === 'connected' || entry.status === 'degraded') && (entry.toolCount ?? 0) > 0) {
        return true;
      }
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function runWorker(id, opts, ctx) {
  const sandbox = join(ctx.tmpRoot, 'sandbox', `w${id}`);
  mkdirSync(sandbox, { recursive: true });
  const client = new WorkerClient(`w${id}`, ctx.workerEnv, { onMcpRequest: ctx.onMcpRequest });
  const out = { worker: id, runs: [], initMs: null, mcpReady: false, fatal: null };
  try {
    const t0 = Date.now();
    const init = await client.req('init', { cwd: sandbox }, 120_000);
    out.initMs = Date.now() - t0;
    if (!init.ok) {
      out.fatal = `init: ${init.error ?? 'unknown'}${tail(client, 5)}`;
      return out;
    }
    const ov = await client.req('setProviderOverride', { name: opts.provider, model: opts.model }, 30_000);
    if (!ov.ok) {
      out.fatal = `setProviderOverride: ${ov.error ?? 'unknown'}${tail(client, 5)}`;
      return out;
    }
    const po = await client.req('setPermissionsOverride', { mode: 'unattended' }, 30_000);
    if (!po.ok) {
      out.fatal = `setPermissionsOverride: ${po.error ?? 'unknown'}${tail(client, 5)}`;
      return out;
    }
    // Idempotent against the hub (fixture already connected+enabled); on the
    // worker side it awaits refreshMcpToolCache(), so the worker's own MCP
    // tool cache is guaranteed populated before its first LLM round.
    const mcpOn = await client.req('setMcpServer', { name: MCP_SERVER, enabled: true }, 30_000);
    if (!mcpOn.ok) {
      out.fatal = `setMcpServer: ${mcpOn.error ?? 'unknown'}${tail(client, 5)}`;
      return out;
    }
    out.mcpReady = await waitForMcpReady(client, 20_000);

    for (let round = 0; round < opts.rounds; round++) {
      if (Date.now() > ctx.deadline) break;
      const scId = ctx.scenarioIds[(round * opts.concurrency + id) % ctx.scenarioIds.length];
      const def = SCENARIO_DEFS[scId];
      const prompt = typeof def.prompt === 'function' ? def.prompt(ctx.fixtureCsv) : def.prompt;
      await runRound(out, client, round, scId, def, prompt, opts, ctx);
    }
  } finally {
    await client.req('shutdown', undefined, 15_000).catch(() => {});
    client.kill();
  }
  return out;
}

async function runRound(out, client, round, scId, def, prompt, opts, ctx) {
  const run = {
    worker: out.worker,
    round,
    scenario: scId,
    desc: def.desc,
    status: 'error',
    failReasons: [],
    turnMs: null,
    textChars: 0,
    realTextChars: 0,
    stopReason: null,
    stopReasons: [],
    stallAborted: false,
    turnEnds: 0,
    toolCalls: [],
    toolErrors: [],
    permissionPrompts: 0,
    requiredTools: def.required ?? [],
    missingTools: [],
    startedAt: null,
    finishedAt: null,
  };
  out.runs.push(run);

  const sid = await client.req('startSession', { name: `loadtest-${out.worker}-${round}-${scId}` }, 60_000);
  if (!sid.ok) {
    run.failReasons.push(`startSession: ${sid.error ?? 'unknown'}`);
    run.finishedAt = new Date().toISOString();
    return;
  }

  client.activeRun = run;
  const t0 = Date.now();
  run.startedAt = new Date(t0).toISOString();
  const chatReq = client.req('chat', { input: prompt }, opts.turnTimeoutMs + 60_000);
  const timedOut = await Promise.race([
    chatReq.then(() => false),
    new Promise((r) => setTimeout(() => r(true), opts.turnTimeoutMs)),
  ]);

  if (timedOut) {
    run.status = 'timeout';
    run.failReasons.push(`turn exceeded ${opts.turnTimeoutMs}ms`);
    await client.req('abort', undefined, 15_000).catch(() => {});
    await chatReq.catch(() => {});
  } else {
    const res = await chatReq;
    if (!res.ok) {
      run.status = 'error';
      run.failReasons.push(`chat: ${res.error ?? 'unknown'}`);
    } else {
      run.status = 'ok'; // chat completed; tool/turn checks below decide pass/fail
    }
  }
  run.turnMs = Date.now() - t0;
  run.finishedAt = new Date().toISOString();

  // Short drain so trailing events (final text chunks, turn_end) land.
  await new Promise((r) => setTimeout(r, 400));
  client.activeRun = null;

  // Evaluate (only meaningful when the chat itself completed).
  if (run.status !== 'ok') return;
  const called = run.toolCalls.map((t) => t.name);
  run.missingTools = (def.required ?? []).filter((req) => !matchesRequired(called, req));
  // A required tool that ERRORED when called is a scenario failure (the
  // capability the run was built to exercise did not work). Errors on tools
  // the model merely reached for and recovered from (an exploratory exec the
  // gate blocked, then a workaround) are quality METRICS, not failures: the
  // global tool-error-rate gate polices their frequency, and a per-run trip
  // would double-count one event.
  const requiredToolErrors = run.toolErrors.filter((e) =>
    (def.required ?? []).some((req) => matchesRequired([e.name], req)),
  );

  // A core-internal stop (thinking-stall loop guard / watchdog 'deadline') is
  // a model-quality event: the turn was cut before a response arrived, so its
  // text — if any — is a cancellation placeholder. That is EXPECTED here and
  // policed by the stall-abort-rate gate, not a per-run failure.
  run.stallAborted = STALL_STOP_REASONS.has(run.stopReason ?? '');

  const checks = [
    run.missingTools.length === 0 ? null : `missing required tool call(s): ${run.missingTools.join(', ')}`,
    requiredToolErrors.length > 0 ? `${requiredToolErrors.length} required tool_result(s) errored: ${requiredToolErrors.map((e) => e.name).join(', ')}` : null,
    run.turnEnds === 0 ? 'no turn_end observed' : null,
    !run.stallAborted && run.realTextChars === 0 ? 'no assistant text produced' : null,
    run.stopReason === 'aborted' ? 'turn aborted (harness turn-timeout)' : null,
  ];
  run.failReasons.push(...checks.filter(Boolean));
  run.status = run.failReasons.length === 0 ? 'pass' : 'fail';
}

function buildAggregates(runs, workerOutcomes) {
  const completed = runs.filter((r) => r.status !== 'skipped');
  const passed = completed.filter((r) => r.status === 'pass');
  const turnMs = completed.map((r) => r.turnMs).filter((ms) => ms != null).sort((a, b) => a - b);
  const toolCallsTotal = runs.reduce((n, r) => n + r.toolCalls.length, 0);
  const toolErrorTotal = runs.reduce((n, r) => n + r.toolErrors.length, 0);
  const permTotal = runs.reduce((n, r) => n + r.permissionPrompts, 0);
  const wallMs =
    runs.length > 0
      ? Math.max(...runs.map((r) => new Date(r.finishedAt).getTime())) -
        Math.min(...runs.map((r) => new Date(r.startedAt).getTime()))
      : 0;
  const initMs = workerOutcomes.map((w) => w.initMs).filter((n) => n != null).sort((a, b) => a - b);
  return {
    totalRuns: completed.length,
    passed: passed.length,
    failed: completed.length - passed.length,
    passRate: completed.length > 0 ? passed.length / completed.length : 0,
    wallMs,
    throughputPerMin: wallMs > 0 ? (completed.length / wallMs) * 60_000 : 0,
    turnMs: {
      p50: percentile(turnMs, 0.5),
      p90: percentile(turnMs, 0.9),
      p99: percentile(turnMs, 0.99),
      max: turnMs.length ? turnMs[turnMs.length - 1] : null,
    },
    initMs: { p50: percentile(initMs, 0.5), max: initMs.length ? initMs[initMs.length - 1] : null },
    toolCallsTotal,
    toolErrorTotal,
    toolErrorRate: toolCallsTotal > 0 ? toolErrorTotal / toolCallsTotal : 0,
    permissionPromptsTotal: permTotal,
    stallAborts: completed.filter((r) => r.stallAborted).length,
    stallAbortRate: completed.length > 0
      ? completed.filter((r) => r.stallAborted).length / completed.length
      : 0,
  };
}

function buildGates(opts, aggregates, hubEntry, workerOutcomes) {
  const gates = [];
  gates.push({
    name: 'mcp-hub-ready',
    ok: hubEntry.connected && hubEntry.toolCount > 0,
    detail: `server "${MCP_SERVER}" connected=${hubEntry.connected} tools=${hubEntry.toolCount}`,
  });
  gates.push({
    name: 'workers-fatal',
    ok: workerOutcomes.every((w) => !w.fatal),
    detail: workerOutcomes.filter((w) => w.fatal).map((w) => `w${w.worker}: ${w.fatal}`).join('; ') || 'none',
  });
  gates.push({
    name: 'pass-rate',
    ok: aggregates.passRate >= opts.passRate,
    detail: `${aggregates.passed}/${aggregates.totalRuns} = ${(aggregates.passRate * 100).toFixed(1)}% (threshold ${opts.passRate})`,
  });
  gates.push({
    name: 'tool-error-rate',
    ok: aggregates.toolErrorRate <= opts.toolErrorRate,
    detail: `${aggregates.toolErrorTotal}/${aggregates.toolCallsTotal} = ${aggregates.toolErrorRate.toFixed(3)} (threshold ${opts.toolErrorRate})`,
  });
  gates.push({
    name: 'stall-abort-rate',
    ok: aggregates.stallAbortRate <= opts.maxStallAbortRate,
    detail:
      `${aggregates.stallAborts}/${aggregates.totalRuns} runs ended in a core-internal abort ` +
      `(thinking-stall loop / watchdog) = ${aggregates.stallAbortRate.toFixed(3)} ` +
      `(threshold ${opts.maxStallAbortRate})`,
  });
  if (opts.maxTurnMs > 0) {
    gates.push({
      name: 'p99-latency',
      ok: aggregates.turnMs.p99 != null && aggregates.turnMs.p99 <= opts.maxTurnMs,
      detail: `p99=${aggregates.turnMs.p99}ms (threshold ${opts.maxTurnMs}ms)`,
    });
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function toJUnit(report, workerOutcomes) {
  const cases = [];
  for (const r of report.runs) {
    const name = `w${r.worker}-r${r.round}-${r.scenario}`;
    const time = r.turnMs != null ? (r.turnMs / 1000).toFixed(2) : '0';
    if (r.status === 'pass') {
      cases.push(`  <testcase name="${xmlEscape(name)}" time="${time}"/>`);
    } else {
      const reasons = r.failReasons.length
        ? r.failReasons.map((f) => xmlEscape(f)).join('\n')
        : xmlEscape(`status=${r.status}`);
      const failMsg = xmlEscape(`scenario ${r.scenario} ${r.status}: ${r.failReasons.join(' | ') || 'unknown'}`);
      const callsLine = `      tool-calls: ${r.toolCalls.map((t) => t.name).join(', ')}`;
      const errsLine = `      tool-errors: ${r.toolErrors.map((t) => `${t.name} :: ${xmlEscape(t.preview)}`).join('; ')}`;
      const metaLine = `      stopReason=${r.stopReason} textChars=${r.textChars} realTextChars=${r.realTextChars} perms=${r.permissionPrompts}`;
      cases.push(
        `  <testcase name="${xmlEscape(name)}" time="${time}">\n` +
          `    <failure message="${failMsg}">\n` +
          reasons + '\n' +
          callsLine + '\n' +
          errsLine + '\n' +
          metaLine + '\n' +
          `    </failure>\n  </testcase>`,
      );
    }
  }
  for (const w of workerOutcomes) {
    if (w.fatal) {
      const fatalMsg = xmlEscape(`worker fatal: ${w.fatal}`);
      cases.push(
        `  <testcase name="worker-${w.worker}-fatal" time="0">\n` +
          `    <failure message="${fatalMsg}">${xmlEscape(w.fatal ?? '')}\n` +
          `    </failure>\n  </testcase>`,
      );
    }
  }
  const failed =
    report.runs.filter((r) => r.status !== 'pass').length +
    workerOutcomes.filter((w) => w.fatal).length;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="nexus-load-test" tests="${report.runs.length + workerOutcomes.filter((w) => w.fatal).length}" failures="${failed}" errors="0" skipped="0">\n` +
    `  <testsuite name="tools-x-mcp load test (${report.config.provider}/${report.config.model})" tests="${report.runs.length}" failures="${report.runs.filter((r) => r.status !== 'pass').length}">\n` +
    cases.join('\n') +
    `\n  </testsuite>\n</testsuites>\n`
  );
}

function printSummary(report, workerOutcomes) {
  const a = report.aggregates;
  console.log('\n================ load test summary ================');
  for (const r of report.runs) {
    const tools = r.toolCalls.map((t) => t.name).join(', ') || '(none)';
    console.log(
      `  ${r.status.toUpperCase().padEnd(7)} w${r.worker} r${r.round} ${r.scenario.padEnd(14)} ` +
        `${(r.turnMs != null ? (r.turnMs / 1000).toFixed(1) + 's' : '   n/a').padEnd(8)} ` +
        `tools=[${tools}] errs=${r.toolErrors.length} perms=${r.permissionPrompts} stop=${r.stopReason ?? '-'}${r.stallAborted ? ' (stall)' : ''}` +
        (r.failReasons.length ? ` :: ${r.failReasons.join(' | ')}` : ''),
    );
  }
  for (const w of workerOutcomes) {
    if (w.fatal) console.log(`  FATAL   worker ${w.worker}: ${w.fatal}`);
  }
  console.log('-----------------------------------------------');
  console.log(
    `  runs=${a.totalRuns} pass=${a.passed} (${(a.passRate * 100).toFixed(1)}%) ` +
      `turnMs p50=${a.turnMs.p50 ?? '-'} p90=${a.turnMs.p90 ?? '-'} p99=${a.turnMs.p99 ?? '-'} max=${a.turnMs.max ?? '-'} ` +
      `initMs p50=${a.initMs.p50 ?? '-'}\n` +
      `  tool-calls=${a.toolCallsTotal} tool-errors=${a.toolErrorTotal} (${(a.toolErrorRate * 100).toFixed(1)}%) ` +
      `stall-aborts=${a.stallAborts} (${(a.stallAbortRate * 100).toFixed(1)}%) ` +
      `permission-prompts=${a.permissionPromptsTotal} throughput=${a.throughputPerMin.toFixed(2)} runs/min\n` +
      `  git=${report.git} node=${report.node}`,
  );
  console.log('  gates:');
  for (const g of report.gates) {
    console.log(`    ${g.ok ? 'PASS' : 'FAIL'}  ${g.name}: ${g.detail}`);
  }
  console.log(`  VERDICT: ${report.verdict}  (reports: test/reports/loadtest-report.json | .xml)`);
  console.log('===============================================\n');
}

main().catch((e) => {
  console.error('[loadtest] harness crashed:', e);
  process.exit(1);
});
