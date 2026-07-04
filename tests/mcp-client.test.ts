import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ClientManager } from '../src/mcp/client-manager.js';

describe('MCP ClientManager', () => {
  describe('initialization', () => {
    it('should create instance with empty state', () => {
      const manager = new ClientManager();
      assert.equal(manager.getAllTools().length >= 0, true);
      assert.equal(manager.listConnections().length, 0);
    });
  });

  describe('builtin tools exposure', () => {
    it('should expose all builtin tools', () => {
      const manager = new ClientManager();
      const tools = manager.getAllTools();
      const builtinNames = ['file_read', 'file_write', 'exec_command', 'fetch_url'];
      for (const name of builtinNames) {
        const found = tools.find((t) => t.name === name);
        assert.ok(found, `builtin tool ${name} should be exposed`);
      }
    });

    it('should have unique tool names across builtin and MCP', () => {
      const manager = new ClientManager();
      const tools = manager.getAllTools();
      const names = tools.map((t) => t.name);
      const unique = new Set(names);
      assert.equal(unique.size, names.length, 'all tool names should be unique');
    });
  });

  describe('tool calling', () => {
    it('should call builtin tool by name', async () => {
      const manager = new ClientManager();
      const result = await manager.callTool('file_read', { path: 'package.json' });
      assert.equal(result.isError, undefined);
      assert.ok(result.content.includes('llm-agent'));
    });

    it('should return error for unknown tool', async () => {
      const manager = new ClientManager();
      const result = await manager.callTool('nonexistent_tool_xyz', {});
      assert.equal(result.isError, true);
      assert.ok(result.content.includes('not found'));
    });

    it('should call exec_command builtin', async () => {
      const manager = new ClientManager();
      const result = await manager.callTool('exec_command', { command: 'echo mcp-test' });
      assert.equal(result.isError, undefined, `unexpected error: ${result.content}`);
      assert.ok(result.content.includes('mcp-test'));
    });
  });

  describe('disconnect', () => {
    it('should disconnect all without error when empty', async () => {
      const manager = new ClientManager();
      await manager.disconnect();
      assert.equal(manager.listConnections().length, 0);
    });
  });
});
