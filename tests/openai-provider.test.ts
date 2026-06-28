import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { OpenAIProvider } from '../src/llm/openai.js';
import { Message } from '../src/types.js';

/**
 * Mock OpenAI streaming response by intercepting fetch.
 * The OpenAI SDK uses fetch under the hood for streaming.
 */
function mockOpenAIStream(chunks: Array<{ id?: string; choices: Array<{ delta: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const data = `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAIProvider streaming', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should stream text chunks', async () => {
    const provider = new OpenAIProvider('fake-key', 'gpt-4o', 'http://localhost:9999');

    globalThis.fetch = async () => {
      return mockOpenAIStream([
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: {} }] },
      ]);
    };

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
      if (chunk.type === 'text') chunks.push(chunk.text || '');
    }

    assert.equal(chunks.join(''), 'Hello world');
  });

  it('should parse incremental tool call arguments', async () => {
    const provider = new OpenAIProvider('fake-key', 'gpt-4o', 'http://localhost:9999');

    globalThis.fetch = async () => {
      return mockOpenAIStream([
        { choices: [{ delta: { content: 'Calling tool...' } }] },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call_123', function: { name: 'test_tool', arguments: '{"q' } }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'uery":' } }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }],
            },
          }],
        },
        { choices: [{ delta: {} }] },
      ]);
    };

    const chunks: Array<{ type: string; text?: string; toolCall?: unknown }> = [];
    for await (const chunk of provider.chat([{ role: 'user', content: 'call tool' }])) {
      if (chunk.type !== 'done') {
        chunks.push({ type: chunk.type, text: chunk.text, toolCall: chunk.toolCall });
      }
    }

    const textChunks = chunks.filter((c) => c.type === 'text');
    assert.equal(textChunks.map((c) => c.text).join(''), 'Calling tool...');

    const toolChunks = chunks.filter((c) => c.type === 'tool_call');
    assert.equal(toolChunks.length, 1, 'should yield exactly one tool_call');
    assert.deepEqual(toolChunks[0].toolCall, {
      id: 'call_123',
      name: 'test_tool',
      arguments: { query: 'hello' },
    });
  });

  it('should handle multiple parallel tool calls', async () => {
    const provider = new OpenAIProvider('fake-key', 'gpt-4o', 'http://localhost:9999');

    globalThis.fetch = async () => {
      return mockOpenAIStream([
        {
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'tool_a', arguments: '{}' } },
                { index: 1, id: 'call_2', function: { name: 'tool_b', arguments: '{}' } },
              ],
            },
          }],
        },
        { choices: [{ delta: {} }] },
      ]);
    };

    const toolCalls: unknown[] = [];
    for await (const chunk of provider.chat([{ role: 'user', content: 'multi' }])) {
      if (chunk.type === 'tool_call') toolCalls.push(chunk.toolCall);
    }

    assert.equal(toolCalls.length, 2);
    assert.deepEqual((toolCalls[0] as { name: string }).name, 'tool_a');
    assert.deepEqual((toolCalls[1] as { name: string }).name, 'tool_b');
  });

  it('should convert messages to OpenAI format correctly', async () => {
    const provider = new OpenAIProvider('fake-key', 'gpt-4o', 'http://localhost:9999');

    let capturedBody: unknown;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return mockOpenAIStream([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {} }] }]);
    };

    const messages: Message[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Let me help',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'x' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 'tc1' },
    ];

    for await (const _chunk of provider.chat(messages)) {
      // consume stream
    }

    const body = capturedBody as { messages: Array<{ role: string; content?: string; tool_calls?: unknown; tool_call_id?: string }> };
    assert.ok(body.messages, 'should have messages');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[2].role, 'assistant');
    assert.ok(body.messages[2].tool_calls, 'assistant should have tool_calls');
    assert.equal(body.messages[3].role, 'tool');
    assert.equal(body.messages[3].tool_call_id, 'tc1');
  });

  it('should convert tools to OpenAI format correctly', async () => {
    const provider = new OpenAIProvider('fake-key', 'gpt-4o', 'http://localhost:9999');

    let capturedBody: unknown;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return mockOpenAIStream([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {} }] }]);
    };

    const tools = [{
      name: 'calc',
      description: 'Calculate something',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
    }];

    for await (const _chunk of provider.chat([{ role: 'user', content: 'calc' }], tools)) {
      // consume stream
    }

    const body = capturedBody as { tools: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }> };
    assert.ok(body.tools, 'should have tools');
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, 'function');
    assert.equal(body.tools[0].function.name, 'calc');
    assert.equal(body.tools[0].function.description, 'Calculate something');
  });
});
