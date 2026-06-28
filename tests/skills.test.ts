import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SkillRegistry } from '../src/skills/registry.js';

describe('Skills', () => {
  describe('SkillRegistry', () => {
    it('should start with empty skills', () => {
      const registry = new SkillRegistry();
      assert.equal(registry.list().length, 0);
      assert.equal(registry.getTools().length, 0);
    });

    it('should load skills from filesystem', async () => {
      const registry = new SkillRegistry();
      await registry.load();
      // Skills dir may or may not exist; test should not crash
      const skills = registry.list();
      assert.ok(Array.isArray(skills), 'should return array');
    });

    it('should reload without error', async () => {
      const registry = new SkillRegistry();
      await registry.load();
      await registry.reload();
      assert.ok(Array.isArray(registry.list()));
    });

    it('should return empty tools when no skills loaded', () => {
      const registry = new SkillRegistry();
      assert.equal(registry.getTools().length, 0);
    });
  });

  describe('Skill types', () => {
    it('should handle skills with tools property', () => {
      const registry = new SkillRegistry();
      // Manually add a skill with tools for testing
      (registry as any).skills = [{
        name: 'test-skill',
        version: '1.0.0',
        tools: [{
          name: 'test-tool',
          description: 'A test tool',
          inputSchema: { type: 'object', properties: {} },
        }],
      }];
      const tools = registry.getTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'test-tool');
    });

    it('should handle skills without tools property', () => {
      const registry = new SkillRegistry();
      (registry as any).skills = [{
        name: 'prompt-skill',
        version: '1.0.0',
        // no tools
      }];
      assert.equal(registry.getTools().length, 0);
    });

    it('should handle handleCommand for non-existent skill', async () => {
      const registry = new SkillRegistry();
      const result = await registry.handleCommand('nonexistent', 'cmd', []);
      assert.equal(result, undefined);
    });

    it('should handle handleCommand for existing skill', async () => {
      const registry = new SkillRegistry();
      (registry as any).skills = [{
        name: 'cmd-skill',
        version: '1.0.0',
        async handleCommand(cmd: string, args: string[]) {
          return `handled: ${cmd}`;
        },
      }];
      const result = await registry.handleCommand('cmd-skill', 'test', []);
      assert.equal(result, 'handled: test');
    });
  });
});
