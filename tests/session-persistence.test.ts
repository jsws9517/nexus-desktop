import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import { SessionManager } from '../src/session/manager.js';
import { Message } from '../src/types.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

describe('Session persistence (SQLite)', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalDataDir: string;

  beforeEach(async () => {
    // Create temp directory and override HOME for session store isolation
    tmpDir = mkdtempSync(join(tmpdir(), 'llm-agent-session-test-'));
    originalHome = process.env.HOME || process.env.USERPROFILE;
    originalDataDir = process.env.LLMA_DATA_DIR || '';
    console.log('[TEST] Setting HOME:', tmpDir);
    console.log('[TEST] Setting LLMA_DATA_DIR:', join(tmpDir, '.llm-agent'));
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    // Use custom database path to avoid conflicts with global sessions.db
    process.env.LLMA_DATA_DIR = join(tmpDir, '.llm-agent');

    // Clear any existing session database by restarting node process
    const { SessionStore } = await import('../src/session/store.js');
    // Force close all existing connections
    if (typeof SessionStore.cleanupTempDatabases === 'function') {
      await SessionStore.cleanupTempDatabases();
    }
  });

  afterEach(() => {
    if (originalHome) {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalHome;
    }
    if (originalDataDir) {
      process.env.LLMA_DATA_DIR = originalDataDir;
    } else {
      delete process.env.LLMA_DATA_DIR;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  after(async () => {
    // Cleanup temp databases after all tests
    const { SessionStore } = await import('../src/session/store.js');
    await SessionStore.cleanupTempDatabases();
  });

  it('should create and retrieve a session', async () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager.create('Test Session', 'anthropic', 'claude-3');

    assert.ok(session.id, 'should have UUID');
    assert.equal(session.name, 'Test Session');
    assert.equal(session.provider, 'anthropic');
    assert.equal(session.model, 'claude-3');
    assert.ok(session.createdAt > 0);
    assert.ok(session.updatedAt > 0);

    const retrieved = manager.get(session.id);
    assert.ok(retrieved);
    assert.equal(retrieved!.name, 'Test Session');
  });

  it('should list sessions ordered by updatedAt desc', () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const s1 = manager.create('First', 'anthropic', 'model');
    const s2 = manager.create('Second', 'openai', 'model');
    const s3 = manager.create('Third', 'anthropic', 'model');

    const list = manager.list();
    console.log('Session list:', list.map(s => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })));
    assert.equal(list.length, 3);
    assert.equal(list[0].id, s3.id, 'most recently created should be first');
    assert.equal(list[2].id, s1.id, 'oldest should be last');
  });

  it('should rename a session', () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager.create('Old Name', 'anthropic', 'model');

    manager.rename(session.id, 'New Name');

    const retrieved = manager.get(session.id);
    assert.equal(retrieved!.name, 'New Name');
    assert.ok(retrieved!.updatedAt >= session.updatedAt, 'updatedAt should be refreshed');
  });

  it('should delete a session and its messages', () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager.create('To Delete', 'anthropic', 'model');

    manager.addMessage(session.id, { role: 'user', content: 'hello' });
    manager.addMessage(session.id, { role: 'assistant', content: 'hi' });

    manager.delete(session.id);

    assert.equal(manager.get(session.id), undefined);
    assert.equal(manager.getMessages(session.id).length, 0);
  });

  it('should store and retrieve messages', () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager.create('Message Test', 'anthropic', 'model');

    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      {
        role: 'assistant',
        content: 'Tool call',
        toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 'tc1' },
    ];

    for (const msg of messages) {
      manager.addMessage(session.id, msg);
    }

    const retrieved = manager.getMessages(session.id);
    assert.equal(retrieved.length, 4);
    assert.equal(retrieved[0].role, 'user');
    assert.equal(retrieved[0].content, 'Hello');
    assert.equal(retrieved[2].role, 'assistant');
    assert.ok(retrieved[2].toolCalls, 'should preserve toolCalls');
    assert.equal(retrieved[2].toolCalls![0].name, 'search');
    assert.equal(retrieved[3].role, 'tool');
    assert.equal(retrieved[3].toolCallId, 'tc1');
    assert.equal(retrieved[3].content, 'result');
  });

  it('should load session with messages', () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager.create('Load Test', 'openai', 'gpt-4');

    manager.addMessage(session.id, { role: 'user', content: 'question' });
    manager.addMessage(session.id, { role: 'assistant', content: 'answer' });

    const loaded = manager.loadSession(session.id);
    assert.ok(loaded);
    assert.equal(loaded!.session.id, session.id);
    assert.equal(loaded!.session.name, 'Load Test');
    assert.equal(loaded!.messages.length, 2);
    assert.equal(loaded!.messages[0].role, 'user');
    assert.equal(loaded!.messages[1].role, 'assistant');
  });

  it('should touch session to update timestamp', async () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager.create('Touch Test', 'anthropic', 'model');
    const originalUpdated = session.updatedAt;

    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 50));
    manager.touch(session.id);

    const retrieved = manager.get(session.id);
    assert.ok(retrieved!.updatedAt > originalUpdated, 'updatedAt should increase after touch');
  });

  it('should handle non-existent session gracefully', () => {
    const manager = new SessionManager(join(tmpDir, '.llm-agent'));
    assert.equal(manager.get('non-existent-uuid'), undefined);
    assert.equal(manager.getMessages('non-existent-uuid').length, 0);
    assert.equal(manager.loadSession('non-existent-uuid'), undefined);
  });

  it('should persist across manager instances', () => {
    const manager1 = new SessionManager(join(tmpDir, '.llm-agent'));
    const session = manager1.create('Cross Instance', 'anthropic', 'model');
    manager1.addMessage(session.id, { role: 'user', content: 'persisted' });

    // New manager instance reading same database
    const manager2 = new SessionManager(join(tmpDir, '.llm-agent'));
    const loaded = manager2.loadSession(session.id);
    assert.ok(loaded);
    assert.equal(loaded!.messages.length, 1);
    assert.equal(loaded!.messages[0].content, 'persisted');
  });
});
