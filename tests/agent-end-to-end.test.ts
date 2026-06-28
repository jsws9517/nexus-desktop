import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Agent } from '../src/agent.js';
import { MockProvider } from './_helpers/mock-provider.js';
import { Message } from '../src/types.js';

describe('Agent end-to-end', () => {
  it('should complete a single-turn chat without tools', async () => {
    const agent = new Agent();
    agent.detailMode = true; // avoid compact output in tests
    const mock = new MockProvider();
    mock.setResponses([{ chunks: [{ type: 'text', text: 'Hello, user!' }] }]);

    // Inject mock provider
    (agent as any).provider = mock;
    await agent.init();

    const sessionId = await agent.startSession('test');
    assert.ok(sessionId);

    await agent.chat('Say hello');

    const messages = agent.context.getMessages();
    assert.equal(messages.length, 2, 'should have user + assistant messages');
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'Say hello');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, 'Hello, user!');
  });

  it('should execute a single tool call and continue', async () => {
    const agent = new Agent();
    agent.detailMode = true;
    const mock = new MockProvider();
    mock.setResponses([
      {
        chunks: [
          { type: 'text', text: 'Let me search.' },
          { type: 'tool_call', toolCall: { id: 'tc1', name: 'file_read', arguments: { path: 'package.json' } } },
        ],
      },
      {
        chunks: [{ type: 'text', text: 'Found the project info.' }],
      },
    ]);

    (agent as any).provider = mock;
    await agent.init();
    await agent.startSession('test');

    await agent.chat('Read package.json');

    const messages = agent.context.getMessages();
    // user, assistant(with toolCalls), tool, assistant(final)
    assert.equal(messages.length, 4, 'should have 4 messages in context');
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.ok(messages[1].toolCalls, 'assistant should have toolCalls');
    assert.equal(messages[1].toolCalls![0].name, 'file_read');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].toolCallId, 'tc1');
    assert.ok(messages[2].content.includes('llm-agent'), 'tool result should contain project info');
    assert.equal(messages[3].role, 'assistant');
    assert.equal(messages[3].content, 'Found the project info.');

    // Verify provider was called twice
    assert.equal(mock.getCallLog().length, 2, 'provider.chat should be called twice');
  });

  it('should execute multiple tool calls in one turn', async () => {
    const agent = new Agent();
    agent.detailMode = true;
    const mock = new MockProvider();
    mock.setResponses([
      {
        chunks: [
          { type: 'text', text: 'Reading files.' },
          { type: 'tool_call', toolCall: { id: 'tc1', name: 'file_read', arguments: { path: 'package.json' } } },
          { type: 'tool_call', toolCall: { id: 'tc2', name: 'file_read', arguments: { path: 'tsconfig.json' } } },
        ],
      },
      {
        chunks: [{ type: 'text', text: 'Done reading both files.' }],
      },
    ]);

    (agent as any).provider = mock;
    await agent.init();
    await agent.startSession('test');

    await agent.chat('Read package.json and tsconfig.json');

    const messages = agent.context.getMessages();
    // user, assistant(with 2 toolCalls), tool1, tool2, assistant(final)
    assert.equal(messages.length, 5, 'should have 5 messages');
    assert.equal(messages[1].toolCalls?.length, 2, 'assistant should have 2 toolCalls');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].toolCallId, 'tc1');
    assert.equal(messages[3].role, 'tool');
    assert.equal(messages[3].toolCallId, 'tc2');
  });

  it('should chain multiple tool call rounds', async () => {
    const agent = new Agent();
    agent.detailMode = true;
    const mock = new MockProvider();
    mock.setResponses([
      {
        chunks: [
          { type: 'text', text: 'First tool.' },
          { type: 'tool_call', toolCall: { id: 'tc1', name: 'file_read', arguments: { path: 'package.json' } } },
        ],
      },
      {
        chunks: [
          { type: 'text', text: 'Need another file.' },
          { type: 'tool_call', toolCall: { id: 'tc2', name: 'file_read', arguments: { path: 'tsconfig.json' } } },
        ],
      },
      {
        chunks: [{ type: 'text', text: 'All done.' }],
      },
    ]);

    (agent as any).provider = mock;
    await agent.init();
    await agent.startSession('test');

    await agent.chat('Chain tool calls');

    const messages = agent.context.getMessages();
    // user + assistant(tc1) + tool1 + assistant(tc2) + tool2 + assistant(final)
    assert.equal(messages.length, 6, 'should have 6 messages');
    assert.equal(mock.getCallLog().length, 3, 'provider should be called 3 times');
  });

  it('should persist messages to session store', async () => {
    const agent = new Agent();
    agent.detailMode = true;
    const mock = new MockProvider();
    mock.setResponses([
      { chunks: [{ type: 'text', text: 'Response.' }] },
    ]);

    (agent as any).provider = mock;
    await agent.init();
    const sessionId = await agent.startSession('persist-test');

    await agent.chat('Hello');

    const stored = agent.session.loadSession(sessionId);
    assert.ok(stored);
    assert.equal(stored!.messages.length, 2);
    assert.equal(stored!.messages[0].role, 'user');
    assert.equal(stored!.messages[1].role, 'assistant');
  });

  it('should maintain message sequence integrity for OpenAI', async () => {
    const agent = new Agent();
    agent.detailMode = true;
    const mock = new MockProvider();
    mock.setResponses([
      {
        chunks: [
          { type: 'text', text: 'Tool call.' },
          { type: 'tool_call', toolCall: { id: 'tc1', name: 'file_read', arguments: { path: 'package.json' } } },
        ],
      },
      { chunks: [{ type: 'text', text: 'Done.' }] },
    ]);

    (agent as any).provider = mock;
    await agent.init();
    await agent.startSession('test');

    await agent.chat('Test sequence');

    const messages = agent.context.getMessages();

    // Verify no orphaned tool messages
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        let found = false;
        for (let j = i - 1; j >= 0; j--) {
          if (
            messages[j].role === 'assistant' &&
            messages[j].toolCalls?.some((tc) => tc.id === messages[i].toolCallId)
          ) {
            found = true;
            break;
          }
        }
        assert.ok(found, `tool message at index ${i} must have preceding assistant with matching toolCalls`);
      }
    }
  });
});
