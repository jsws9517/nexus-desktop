/**
 * The desktop app used to append a synthetic `[tool-result-continuation]`
 * user message whenever a multi-tool turn reached the provider with a tail of
 * `assistant(toolCalls) + tool` and no trailing user message: some
 * OpenAI-compatible providers reject that shape ("No user query found").
 *
 * Ownership of that workaround moved into the core (nexus-coder), where it
 * now appends the continuation only for endpoints that actually rejected a
 * tool tail (commit "refactor(desktop): move trailing-user-tail ownership
 * into core"). The desktop layer no longer does it, so every test below is
 * skipped. Re-enable only if the desktop reintroduces its own
 * trailing-user-tail mutation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(new URL(import.meta.url).pathname);
const dist = join(__dirname, '..', 'dist');

// ensureTrailingUserMessage no longer exists in dist/agent/service.js, so the
// destructure yields undefined. Guard the import so this module still loads;
// every test is skipped regardless.
const { ensureTrailingUserMessage } = await import(
  pathToFileURL(join(dist, 'agent', 'service.js'))
).catch(() => ({}));

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

const SKIP = { skip: 'moved into core (USER_TAIL_MARKER, nexus-coder); see header' };

// ---------------------------------------------------------------------------
// The regression: relocating the real user turn made the model re-answer it
// ---------------------------------------------------------------------------

test('the user turn stays where the user wrote it', SKIP, () => {
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

test('an earlier user turn is not deleted', SKIP, () => {
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

test('the message list ends with a user message', SKIP, () => {
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

test('repeated rounds add exactly one continuation, not one per round', SKIP, () => {
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

test('the continuation is replaced in place, not stacked', SKIP, () => {
  const msgs = toolTail();
  ensureTrailingUserMessage(msgs);
  msgs.push({ role: 'assistant', content: 'done' });
  ensureTrailingUserMessage(msgs);
  assert.equal(continuations(msgs), 1);
  assert.equal(msgs[msgs.length - 1].content.startsWith(MARKER), true);
});

test('a trailing user message is left completely alone', SKIP, () => {
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

test('degenerate input does not throw', SKIP, () => {
  assert.doesNotThrow(() => ensureTrailingUserMessage([]));
  assert.doesNotThrow(() => ensureTrailingUserMessage(undefined));
  assert.doesNotThrow(() => ensureTrailingUserMessage(null));
});

test('a user-authored message is never mistaken for a continuation', SKIP, () => {
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
