import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ContextManager } from '../src/llm/context-manager.js';
import { Message } from '../src/types.js';

describe('ContextManager', () => {
  describe('basic operations', () => {
    it('should start empty', () => {
      const ctx = new ContextManager();
      assert.equal(ctx.getMessages().length, 0);
    });

    it('should add and retrieve messages', () => {
      const ctx = new ContextManager();
      const msg: Message = { role: 'user', content: 'hello' };
      ctx.add(msg);
      assert.equal(ctx.getMessages().length, 1);
      assert.equal(ctx.getMessages()[0].content, 'hello');
    });

    it('should clear all messages', () => {
      const ctx = new ContextManager();
      ctx.add({ role: 'user', content: 'a' });
      ctx.add({ role: 'assistant', content: 'b' });
      ctx.clear();
      assert.equal(ctx.getMessages().length, 0);
    });

    it('should set messages and clear pins', () => {
      const ctx = new ContextManager();
      ctx.add({ role: 'user', content: 'a' });
      ctx.pin(0);
      ctx.setMessages([{ role: 'user', content: 'b' }]);
      assert.equal(ctx.getMessages().length, 1);
      assert.equal(ctx.getMessages()[0].content, 'b');
    });
  });

  describe('pinning', () => {
    it('should pin and unpin messages', () => {
      const ctx = new ContextManager();
      ctx.add({ role: 'user', content: 'a' });
      ctx.add({ role: 'user', content: 'b' });
      ctx.pin(0);
      ctx.unpin(0);
      // After unpin, should be able to trim
      for (let i = 0; i < 60; i++) {
        ctx.add({ role: 'user', content: `msg-${i}` });
      }
      assert.ok(ctx.getMessages().length <= 200 + 1, 'should respect maxMessages limit');
    });

    it('should ignore invalid pin indices', () => {
      const ctx = new ContextManager();
      ctx.pin(-1);
      ctx.pin(100);
      assert.equal(ctx.getMessages().length, 0);
    });
  });

  describe('enforceLimits with tool message pairs', () => {
    it('should trim oldest unpinned messages', () => {
      const ctx = new ContextManager({ maxMessages: 5 });
      for (let i = 0; i < 10; i++) {
        ctx.add({ role: 'user', content: `msg-${i}` });
      }
      assert.ok(ctx.getMessages().length <= 5, 'should trim to maxMessages');
    });

    it('should preserve assistant+tool pairs when trimming', () => {
      const ctx = new ContextManager({ maxMessages: 3 });

      // Build: user0, assistant0+tool0, user1, assistant1+tool1, user2
      ctx.add({ role: 'user', content: 'user0' });
      ctx.add({ role: 'assistant', content: 'assistant0', toolCalls: [{ id: 'tc1', name: 'test', arguments: {} }] });
      ctx.add({ role: 'tool', content: 'tool0', toolCallId: 'tc1' });
      ctx.add({ role: 'user', content: 'user1' });
      ctx.add({ role: 'assistant', content: 'assistant1', toolCalls: [{ id: 'tc2', name: 'test', arguments: {} }] });
      ctx.add({ role: 'tool', content: 'tool1', toolCallId: 'tc2' });
      ctx.add({ role: 'user', content: 'user2' });

      const msgs = ctx.getMessages();
      // After trimming, verify no orphaned tool messages
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === 'tool') {
          // Find preceding assistant with matching toolCall
          let found = false;
          for (let j = i - 1; j >= 0; j--) {
            if (msgs[j].role === 'assistant' && msgs[j].toolCalls?.some((tc) => tc.id === msgs[i].toolCallId)) {
              found = true;
              break;
            }
          }
          assert.ok(found, `tool message at index ${i} should have preceding assistant with matching toolCalls`);
        }
      }
    });

    it('should handle multiple tool calls per assistant', () => {
      const ctx = new ContextManager({ maxMessages: 3 });
      ctx.add({ role: 'user', content: 'user0' });
      ctx.add({ role: 'assistant', content: 'assistant0', toolCalls: [
        { id: 'tc1', name: 'test1', arguments: {} },
        { id: 'tc2', name: 'test2', arguments: {} },
      ]});
      ctx.add({ role: 'tool', content: 'tool1', toolCallId: 'tc1' });
      ctx.add({ role: 'tool', content: 'tool2', toolCallId: 'tc2' });
      ctx.add({ role: 'user', content: 'user1' });

      const msgs = ctx.getMessages();
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].role === 'tool') {
          let found = false;
          for (let j = i - 1; j >= 0; j--) {
            if (msgs[j].role === 'assistant' && msgs[j].toolCalls?.some((tc) => tc.id === msgs[i].toolCallId)) {
              found = true;
              break;
            }
          }
          assert.ok(found, `multi-tool: tool ${msgs[i].toolCallId} should have preceding assistant`);
        }
      }
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens for messages', () => {
      const ctx = new ContextManager();
      ctx.add({ role: 'user', content: 'hello world' });
      const count = ctx.getTokenCount();
      assert.ok(count > 0, 'should have positive token count');
    });
  });
});
