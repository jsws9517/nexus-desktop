import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { BuiltinTool } from './types.js';
import { ToolResult } from '../types.js';

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: 'file_read',
    description: 'Read the contents of a file at the given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const path = String(args.path || '');
      try {
        if (!existsSync(path)) {
          return { content: `File not found: ${path}`, isError: true };
        }
        const content = readFileSync(path, 'utf-8');
        return { content };
      } catch (err) {
        return { content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file at the given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(args): Promise<ToolResult> {
      const path = String(args.path || '');
      const content = String(args.content || '');
      try {
        writeFileSync(path, content, 'utf-8');
        return { content: `Successfully wrote to ${path}` };
      } catch (err) {
        return { content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'exec_command',
    description: 'Execute a shell command and return stdout/stderr',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['command'],
    },
    async execute(args): Promise<ToolResult> {
      const command = String(args.command || '');
      const timeout = Number(args.timeout || 30000);
      if (!command) {
        return { content: 'Empty command', isError: true };
      }
      // Security: command originates from LLM tool calls; execute in controlled environment only
      try {
        const result = execSync(command, {
          encoding: 'utf-8',
          timeout,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { content: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stdout = (err as { stdout?: string }).stdout || '';
        const stderr = (err as { stderr?: string }).stderr || '';
        return {
          content: `Error: ${message}\nstdout: ${stdout}\nstderr: ${stderr}`,
          isError: true,
        };
      }
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch content from a URL via HTTP GET',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
    async execute(args): Promise<ToolResult> {
      const url = String(args.url || '');
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return { content: `HTTP ${response.status}: ${response.statusText}`, isError: true };
        }
        const text = await response.text();
        // Truncate if too long
        const maxLen = 50000;
        const content = text.length > maxLen ? text.slice(0, maxLen) + '\n...[truncated]' : text;
        return { content };
      } catch (err) {
        return { content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
];
