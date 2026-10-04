import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { ensureTrailingUserMessage } = await import(pathToFileURL(join(dist, 'agent', 'service.js')));

const MARKER = '[tool-result-continuation]';
const isContinuation = (m) => typeof m.content === 'string' && m.content.startsWith(MARKER);
const continuations = (msgs) => msgs.filter(isContinuation).length;

/** The shape a multi-tool turn reaches the provider with on its 2nd+ LLM call. */
const toolTail = () => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '用 acp_route 验证连通性' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
  { role: 'tool', content: '[claude] 可用', tool_call_id: 'c1' },
];

// ---------------------------------------------------------------------------
// The regression: relocating the real user turn made the model re-answer it
// ---------------------------------------------------------------------------

test('the user turn stays where the user wrote it', () => {
  // The reported symptom was four identical acp_route calls with fresh
  // tool_call_ids and no assistant text between them. Cause: the guard hoisted
  // the original request to the tail, so every round read as "the user just
  // asked again" and the model answered again — whether the tool had succeeded
  // or failed.
  const msgs = toolTail();
  ensureTrailingUserMessage(msgs);
  assert.equal(msgs[1].content, '用 acp_route 验证连通性', 'the original request must not move');
  assert.equal(msgs.indexOf(msgs.find((m) => m.content === '用 acp_route 验证连通性')), 1);
});

test('an earlier user turn is not deleted', () => {
  // The old version spliced out findIndex(m => m.role === 'user') — the FIRST
  // user message — so a multi-turn session lost an unrelated earlier exchange.
  const msgs = [
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '答案一' },
    { role: 'user', content: '第二个问题' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  ];
  ensureTrailingUserMessage(msgs);
  assert.ok(msgs.some((m) => m.content === '第一个问题'), 'the first user turn must survive');
  assert.ok(msgs.some((m) => m.content === '答案一'), 'its answer must survive too');
});

test('the message list ends with a user message', () => {
  // The provider workaround itself: a tail of assistant(toolCalls)/tool with no
  // trailing user message returns 400 "No user query found in messages".
  const msgs = toolTail();
  ensureTrailingUserMessage(msgs);
  assert.equal(msgs[msgs.length - 1].role, 'user');
  assert.ok(isContinuation(msgs[msgs.length - 1]));
});

// ---------------------------------------------------------------------------
// Bounded across rounds
// ---------------------------------------------------------------------------

test('repeated rounds add exactly one continuation, not one per round', () => {
  const msgs = toolTail();
  for (let round = 0; round < 12; round++) {
    ensureTrailingUserMessage(msgs);
    // The model answers again with another tool call, so the tail stops being a
    // user message and the guard runs once more — the shape that produced four
    // duplicate calls before.
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${round + 2}` }] });
    msgs.push({ role: 'tool', content: '[claude] 可用', tool_call_id: `c${round + 2}` });
  }
  assert.equal(continuations(msgs), 1, `expected 1 continuation, found ${continuations(msgs)}`);
});

test('the continuation is replaced in place, not stacked', () => {
  const msgs = toolTail();
  ensureTrailingUserMessage(msgs);
  msgs.push({ role: 'assistant', content: 'done' });
  ensureTrailingUserMessage(msgs);
  assert.equal(continuations(msgs), 1);
  assert.equal(msgs[msgs.length - 1].content.startsWith(MARKER), true);
});

test('a trailing user message is left completely alone', () => {
  // On the first LLM call the tail IS the user request; the guard must not
  // append anything, or every turn would grow a spurious message.
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '真实问题' },
  ];
  ensureTrailingUserMessage(msgs);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, '真实问题');
});

test('degenerate input does not throw', () => {
  assert.doesNotThrow(() => ensureTrailingUserMessage([]));
  assert.doesNotThrow(() => ensureTrailingUserMessage(undefined));
  assert.doesNotThrow(() => ensureTrailingUserMessage(null));
});

test('a user-authored message is never mistaken for a continuation', () => {
  // Identity is the marker, not the role — a real user turn is role=user too.
  const msgs = [
    { role: 'user', content: '刚才那个 tool-result-continuation 是干嘛的？' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', content: 'ok', tool_call_id: 'c1' },
  ];
  ensureTrailingUserMessage(msgs);
  assert.ok(msgs.some((m) => m.content === '刚才那个 tool-result-continuation 是干嘛的？'));
  assert.equal(continuations(msgs), 1);
});