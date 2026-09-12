import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import compiled modules (only tool-categories to avoid Electron dependency)
const { READ_ONLY_TOOLS, WRITE_TOOLS, requiresSerialization, filterToolsForSubAgent } = await import('../dist/agent/sub-agent/tool-categories.js');

describe('Tool Categories', () => {
  it('should have correct read-only tools', () => {
    assert.ok(READ_ONLY_TOOLS.has('read_media_file'));
    assert.ok(READ_ONLY_TOOLS.has('query'));
    assert.ok(READ_ONLY_TOOLS.has('git_log'));
    assert.ok(READ_ONLY_TOOLS.has('sheet.read'));
    assert.ok(READ_ONLY_TOOLS.has('fetch'));
  });

  it('should have correct write tools', () => {
    assert.ok(WRITE_TOOLS.has('execute'));
    assert.ok(WRITE_TOOLS.has('git_commit'));
    assert.ok(WRITE_TOOLS.has('git_push'));
    assert.ok(WRITE_TOOLS.has('create_entities'));
  });

  it('should correctly identify tasks requiring serialization', () => {
    const readOnlyTask = {
      id: 'task_1',
      description: 'Read task',
      prompt: 'Read files',
      tools: ['read_media_file', 'query'],
    };
    
    const writeTask = {
      id: 'task_2',
      description: 'Write task',
      prompt: 'Write files',
      tools: ['read_media_file', 'git_commit'],
    };
    
    const mixedTask = {
      id: 'task_3',
      description: 'Mixed task',
      prompt: 'Read and write',
      tools: ['read_media_file', 'execute'],
    };
    
    assert.equal(requiresSerialization(readOnlyTask), false);
    assert.equal(requiresSerialization(writeTask), true);
    assert.equal(requiresSerialization(mixedTask), true);
  });

  it('should filter tools for sub-agent', () => {
    const allTools = filterToolsForSubAgent();
    assert.ok(allTools.includes('read_media_file'));
    assert.ok(allTools.includes('query'));
    assert.ok(!allTools.includes('git_commit'));
    
    const specificTools = filterToolsForSubAgent(['read_media_file', 'git_commit', 'query']);
    assert.ok(specificTools.includes('read_media_file'));
    assert.ok(specificTools.includes('query'));
    assert.ok(!specificTools.includes('git_commit'));
  });
});
