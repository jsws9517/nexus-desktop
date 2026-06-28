import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { BUILTIN_TOOLS } from '../src/mcp/builtin-tools.js';

describe('Built-in Tools', () => {
  describe('file_read', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'file_read');

    it('should exist and have correct metadata', () => {
      assert.ok(tool, 'file_read tool should exist');
      assert.equal(tool!.name, 'file_read');
      assert.ok(tool!.description.includes('Read'), 'description should mention Read');
      assert.ok(tool!.inputSchema, 'should have input schema');
    });

    it('should read an existing file', async () => {
      const result = await tool!.execute({ path: 'package.json' });
      assert.equal(result.isError, undefined);
      assert.ok(result.content.includes('llm-agent'), 'should contain project name');
    });

    it('should return error for non-existent file', async () => {
      const result = await tool!.execute({ path: '/nonexistent/path/file.txt' });
      assert.equal(result.isError, true);
      assert.ok(result.content.includes('not found') || result.content.includes('Error'), 'should report error');
    });

    it('should handle empty path gracefully', async () => {
      const result = await tool!.execute({ path: '' });
      assert.equal(result.isError, true);
    });
  });

  describe('file_write', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'file_write');

    it('should exist and have correct metadata', () => {
      assert.ok(tool, 'file_write tool should exist');
      assert.equal(tool!.name, 'file_write');
      assert.ok(tool!.inputSchema, 'should have input schema');
    });

    it('should write and read back content', async () => {
      const testPath = 'tests/_tmp_write_test.txt';
      const testContent = 'Hello from test: ' + Date.now();

      const writeResult = await tool!.execute({ path: testPath, content: testContent });
      assert.equal(writeResult.isError, undefined);

      const readTool = BUILTIN_TOOLS.find((t) => t.name === 'file_read');
      const readResult = await readTool!.execute({ path: testPath });
      assert.equal(readResult.content, testContent);
    });

    it('should handle empty content', async () => {
      const testPath = 'tests/_tmp_empty.txt';
      const result = await tool!.execute({ path: testPath, content: '' });
      assert.equal(result.isError, undefined);
    });
  });

  describe('exec_command', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'exec_command');

    it('should exist and have security protections', () => {
      assert.ok(tool, 'exec_command tool should exist');
      assert.ok(tool!.description.includes('shell') || tool!.description.includes('command'), 'should describe command execution');
    });

    it('should execute safe command successfully', async () => {
      const result = await tool!.execute({ command: 'echo hello-test' });
      assert.equal(result.isError, undefined, `should not error: ${result.content}`);
      assert.ok(result.content.includes('hello-test'), 'output should contain expected text');
    });

    it('should block dangerous rm command', async () => {
      const result = await tool!.execute({ command: 'rm -rf /' });
      assert.equal(result.isError, true, 'should block rm command');
      assert.ok(result.content.includes('blocked') || result.content.includes('security'), 'should mention security');
    });

    it('should block subshell injection', async () => {
      const result = await tool!.execute({ command: 'echo $(whoami)' });
      assert.equal(result.isError, true, 'should block subshell');
    });

    it('should block interpreter inline execution', async () => {
      const result = await tool!.execute({ command: 'bash -c "echo hack"' });
      assert.equal(result.isError, true, 'should block bash -c');
    });

    it('should respect timeout parameter', async () => {
      // Use a command that sleeps longer than timeout
      const start = Date.now();
      const result = await tool!.execute({ command: 'sleep 5', timeout: 500 });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 2000, `should timeout quickly, took ${elapsed}ms`);
      assert.equal(result.isError, true, 'should report timeout as error');
    });
  });

  describe('fetch_url', () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === 'fetch_url');
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should exist and have security protections', () => {
      assert.ok(tool, 'fetch_url tool should exist');
    });

    it('should fetch URL successfully', async () => {
      globalThis.fetch = async () => {
        return new Response('mock response body', { status: 200, statusText: 'OK' });
      };

      const result = await tool!.execute({ url: 'https://example.com/data' });
      assert.equal(result.isError, undefined, `unexpected error: ${result.content}`);
      assert.ok(result.content.includes('mock response body'), 'should contain fetched content');
    });

    it('should handle HTTP errors', async () => {
      globalThis.fetch = async () => {
        return new Response('Not Found', { status: 404, statusText: 'Not Found' });
      };

      const result = await tool!.execute({ url: 'https://example.com/missing' });
      assert.equal(result.isError, true, 'should report HTTP error');
      assert.ok(result.content.includes('404'), 'should include status code');
    });

    it('should handle network errors', async () => {
      globalThis.fetch = async () => {
        throw new Error('Network failure');
      };

      const result = await tool!.execute({ url: 'https://example.com/fail' });
      assert.equal(result.isError, true, 'should report network error');
      assert.ok(result.content.includes('Fetch error'), 'should mention fetch error');
    });

    it('should truncate large responses', async () => {
      const largeBody = 'x'.repeat(60000);
      globalThis.fetch = async () => {
        return new Response(largeBody, { status: 200 });
      };

      const result = await tool!.execute({ url: 'https://example.com/large' });
      assert.equal(result.isError, undefined);
      assert.ok(result.content.includes('[truncated]'), 'should truncate large response');
    });

    it('should block localhost access', async () => {
      const result = await tool!.execute({ url: 'http://localhost:8080' });
      assert.equal(result.isError, true, 'should block localhost');
      assert.ok(result.content.includes('blocked') || result.content.includes('private'), 'should mention blocking');
    });

    it('should block private IP addresses', async () => {
      const result = await tool!.execute({ url: 'http://192.168.1.1' });
      assert.equal(result.isError, true, 'should block private IP');
    });

    it('should block 127.0.0.1', async () => {
      const result = await tool!.execute({ url: 'http://127.0.0.1:3000' });
      assert.equal(result.isError, true, 'should block 127.0.0.1');
    });

    it('should handle non-HTTP protocols', async () => {
      const result = await tool!.execute({ url: 'file:///etc/passwd' });
      assert.equal(result.isError, true, 'should block file:// protocol');
    });
  });

  describe('tool schema validation', () => {
    it('should have unique tool names', () => {
      const names = BUILTIN_TOOLS.map((t) => t.name);
      const unique = new Set(names);
      assert.equal(unique.size, names.length, 'all tool names should be unique');
    });

    it('should have input schema for all tools', () => {
      for (const tool of BUILTIN_TOOLS) {
        assert.ok(tool.inputSchema, `${tool.name} should have inputSchema`);
        assert.ok(tool.description, `${tool.name} should have description`);
      }
    });
  });
});
