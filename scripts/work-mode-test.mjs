/**
 * Work-mode end-to-end test (Tier 1): boots the per-session worker, submits a
 * real LLM "work" prompt against the committed fixture CSV, and asserts the
 * sub-agent loop degrades through the deterministic skills and surfaces their
 * Artifact envelopes as tool_result events — the exact A-grade WorkBuddy chain
 * the renderer consumes (docs/work-mode-test.md).
 *
 * Requires a configured LLM provider (like test:chat). Not part of CI.
 *
 * Run: npm run build && node scripts/work-mode-test.mjs   (or npm run test:work)
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', 'dist', 'agent-worker.js');

let parseArtifactContent;
try {
  ({ parseArtifactContent } = await import(pathToFileURL(join(__dirname, '..', 'dist', 'shared', 'artifact.js'))));
} catch {
  console.error('dist/shared/artifact.js missing — run `npm run build` first.');
  process.exit(1);
}

const child = spawn('node', [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

let nextId = 1;
const pending = new Map();

/** tool sequence observed on the event stream */
const toolCalls = []; // { name, args }
const toolResults = []; // { name, content, isError, artifactType? }
const artifactResults = []; // { name, type, title, status }
let sawTurnEnd = false;
let sawText = false;
let permissionQuestions = 0;

function req(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
  });
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'result') {
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  } else if (msg.type === 'event') {
    const e = msg.event;
    if (!e) return;
    if (e.type === 'text') { sawText = true; process.stdout.write(e.text); }
    if (e.type === 'thinking') process.stdout.write('[thinking]');
    if (e.type === 'tool_call_start') {
      toolCalls.push({ name: e.name, args: e.args });
      process.stdout.write(`\n[tool:${e.name}] ${JSON.stringify(e.args ?? {}).slice(0, 160)}\n`);
    }
    if (e.type === 'tool_result') {
      const parsed = parseArtifactContent(e.content);
      const rec = { name: e.name, isError: e.isError === true, artifactType: parsed?.type ?? null };
      if (parsed) artifactResults.push({ name: e.name, type: parsed.type, title: parsed.title, status: parsed.status });
      toolResults.push(rec);
      process.stdout.write(`[result:${e.name} ${parsed ? `${parsed.type}(${parsed.status})` : 'text'}\n`);
    }
    if (e.type === 'turn_end') sawTurnEnd = true;
  } else if (msg.type === 'permission') {
    permissionQuestions++;
    console.log(`\n[PERMISSION] ${msg.question.slice(0, 160)}`);
    child.stdin.write(JSON.stringify({ id: nextId++, method: 'resolvePermission', params: { id: msg.id, answer: 'y' } }) + '\n');
  }
});

const ok = async (cond, label) => {
  console.log(`\n${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) process.exitCode = 1;
};

const SKILL_NAMES = new Set(['sheet.read', 'sheet.analyze', 'bi.chart']);

const init = await req('init');
await ok(init.ok === true, 'init');
const sid = await req('startSession');
await ok(typeof sid.data === 'string' && sid.data.length > 0, 'startSession');

const prompt = [
  '请用中文完成一个数据小报告,严格按步骤调用工具,不要跳过:',
  '1) sheet.read 读取 test/fixtures/sales.csv;',
  '2) sheet.analyze 统计 amount 列的 sum 与 mean;',
  '3) bi.chart 画 amount by month 的柱状图;',
  '最后用一句话总结。',
].join('\n');
console.log('\n>>> sending work prompt...\n');
await req('chat', { input: prompt });
console.log('\n\n--- tool sequence ---');
for (const c of toolCalls) console.log(`  ${c.name}`);
console.log('--- end ---');
await ok(toolCalls.length > 0, 'at least one tool was called');
await ok(
  toolCalls.some((t) => t.name === 'sheet.read'),
  'sheet.read called',
);
await ok(
  toolCalls.some((t) => t.name === 'sheet.analyze'),
  'sheet.analyze called',
);
await ok(
  toolCalls.some((t) => t.name === 'bi.chart'),
  'bi.chart called',
);
await ok(sawText, 'streamed text');
await ok(sawTurnEnd, 'turn_end');
await ok(permissionQuestions === 0, `no permission prompts (got ${permissionQuestions})`);
const skillResults = toolResults.filter((r) => SKILL_NAMES.has(r.name));
const healthy = skillResults.every((r) => !r.isError && r.artifactType !== null);
await ok(healthy, 'every skill tool_result carried an artifact envelope without error');
for (const a of artifactResults) console.log(`  artifact: ${a.type} · ${a.title} · ${a.status}`);
await ok(
  artifactResults.some((a) => a.type === 'sheet') &&
    artifactResults.some((a) => a.type === 'chart'),
  'both sheet and chart artifacts surfaced',
);

await req('shutdown');
child.kill();
if (process.exitCode) console.log('\nWORK MODE TEST: FAILED');
else console.log('\nWORK MODE TEST: PASS');
process.exit(process.exitCode ?? 0);