import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { BuiltinTool } from './types.js';
import { ToolResult } from '../types.js';

// Dangerous commands that should never be executed automatically
const DANGEROUS_COMMANDS = new Set([
  'rm', 'del', 'rmdir', 'format', 'mkfs', 'fdisk', 'dd', 'shred',
  'mv', 'move', 'ren', 'rename',
]);

function getBaseCommand(command: string): string {
  const trimmed = command.trim();
  // Skip common prefixes
  const withoutPrefix = trimmed.replace(/^(sudo|nohup|time)\s+/i, '');
  const match = withoutPrefix.match(/^[\"']?([^\s\"';|&<>]+)/);
  return match ? match[1].toLowerCase() : '';
}

function isDangerousCommand(command: string): boolean {
  const base = getBaseCommand(command);
  return DANGEROUS_COMMANDS.has(base);
}

function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return true;
    }
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
    if (hostname === '0.0.0.0' || hostname === '::1' || hostname === '::') return true;

    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      const [a, b, ,] = parts;
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      if (a === 0) return true;
      if (a === 169 && b === 254) return true;
    }
    return false;
  } catch {
    return true;
  }
}

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
      if (isDangerousCommand(command)) {
        return { content: `Command blocked for security: "${getBaseCommand(command)}" is not allowed`, isError: true };
      }
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
      if (isPrivateUrl(url)) {
        return { content: 'URL blocked: internal/private addresses are not allowed', isError: true };
      }
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
