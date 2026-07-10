import { readFileSync, writeFileSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { BuiltinTool } from './types.js';
import { ToolResult } from '../types.js';
import { authorizePath } from '../security/path-authorizer.js';
import { translateCommand } from './cmd-alias.js';

const execAsync = promisify(exec);

// ---- exec_command security ----

const DANGEROUS_COMMANDS = new Set([
  // File destruction
  'rm', 'del', 'rmdir', 'unlink', 'erase', 'rd',
  // Disk/formatting
  'format', 'mkfs', 'fdisk', 'dd', 'shred', 'newfs', 'mkfs.ext4', 'mkfs.ntfs',
  // File movement (destructive overwrite)
  'mv', 'move', 'ren', 'rename',
  // Permission changes
  'chmod', 'chown', 'chgrp', 'attrib', 'icacls', 'setfacl', 'cacls', 'takeown',
  // Network exfiltration tools
  'nc', 'netcat', 'ncat',
]);

const INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh',
  'python', 'python3', 'python2', 'node', 'nodejs', 'perl', 'ruby', 'php',
]);

function containsSubshell(command: string): boolean {
  return /\$\(|`\s|\\`|\$\{/.test(command);
}

function extractAllCommands(command: string): string[] {
  const commands: string[] = [];
  // Split by shell control operators
  const segments = command.split(/\s*[|&;]+\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Remove common prefixes
    const withoutPrefix = trimmed.replace(/^(sudo|nohup|time|env|stdbuf|nice|ionice)\s+/i, '');
    if (!withoutPrefix) continue;

    // Tokenize respecting quotes
    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    for (const char of withoutPrefix) {
      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (/\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) tokens.push(current);
    if (tokens.length === 0) continue;

    const cmd = tokens[0].toLowerCase();
    commands.push(cmd);

    // If interpreter with -c, recursively extract sub-commands from the script
    if (INTERPRETERS.has(cmd) && tokens.length >= 3) {
      const dashC = tokens.findIndex((t) => t === '-c' || t === '--command' || t === '/c');
      if (dashC !== -1 && dashC + 1 < tokens.length) {
        const script = tokens[dashC + 1];
        const subCommands = extractAllCommands(script);
        commands.push(...subCommands);
      }
    }
  }

  return commands;
}

function isDangerousCommand(command: string): { blocked: boolean; reason?: string } {
  if (containsSubshell(command)) {
    return { blocked: true, reason: 'subshell/command substitution is not allowed' };
  }

  const commands = extractAllCommands(command);
  for (const cmd of commands) {
    if (DANGEROUS_COMMANDS.has(cmd)) {
      return { blocked: true, reason: `"${cmd}" is not allowed` };
    }
  }

  // Block direct interpreter execution with inline code
  const first = commands[0];
  if (first && INTERPRETERS.has(first)) {
    const lowered = command.toLowerCase();
    const hasInline = /(^|\s)(bash|sh|zsh|python|python3|node|perl|ruby|php)\s+.*(-c\s|--command\s|eval\s|exec\s)/.test(lowered);
    if (hasInline) {
      return { blocked: true, reason: 'inline script execution via interpreter is not allowed' };
    }
  }

  return { blocked: false };
}

// ---- fetch_url security ----

function isPrivateIPv4(a: number, b: number): boolean {
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe90:') || lower.startsWith('fea0:') || lower.startsWith('feb0:')) return true; // fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('::ffff:')) {
    const ipv4 = lower.slice(7);
    const parts = ipv4.split('.').map(Number);
    if (parts.length === 4) return isPrivateIPv4(parts[0], parts[1]);
  }
  return false;
}

function isPrivateIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length === 4) return isPrivateIPv4(parts[0], parts[1]);
    return false;
  }
  if (version === 6) return isPrivateIPv6(ip);
  return false;
}

function normalizeIP(ip: string): string | null {
  // Hexadecimal IP like 0x7f000001
  if (/^0x[0-9a-f]{1,8}$/i.test(ip)) {
    const num = parseInt(ip, 16);
    if (!isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff].join('.');
    }
  }
  return null;
}

async function isPrivateUrl(urlStr: string): Promise<boolean> {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return true;
    }
    const hostname = url.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;

    // Direct IP check
    if (isIP(hostname) !== 0) {
      return isPrivateIP(hostname);
    }

    // Normalize hex/octal encoded IPs
    const normalized = normalizeIP(hostname);
    if (normalized !== null) {
      return isPrivateIP(normalized);
    }

    // DNS resolution check with timeout
    try {
      const addresses = await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
      ]);
      for (const addr of addresses) {
        if (isPrivateIP(addr.address)) return true;
      }
    } catch {
      // DNS failure: allow fetch to fail naturally rather than blocking arbitrarily
    }

    return false;
  } catch {
    return true;
  }
}

// ---- Built-in tools ----

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
      const authorized = await authorizePath(path);
      if (!authorized) {
        return { content: `Access denied: "${path}" is not in the allowed path list and access was rejected by user.`, isError: true };
      }
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
      const authorized = await authorizePath(path);
      if (!authorized) {
        return { content: `Access denied: "${path}" is not in the allowed path list and access was rejected by user.`, isError: true };
      }
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
        return { content: 'Empty command: you must provide a non-empty "command" string to exec_command. For reading files use file_read instead.', isError: true };
      }
      const danger = isDangerousCommand(command);
      if (danger.blocked) {
        return { content: `Command blocked for security: ${danger.reason}`, isError: true };
      }
      try {
        const actualCmd = process.platform === 'win32' ? `chcp 65001 >NUL && ${translateCommand(command)}` : command;
        const { stdout, stderr } = await execAsync(actualCmd, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        });
        const output = stdout + (stderr ? '\n' + stderr : '');
        return { content: output };
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
      if (await isPrivateUrl(url)) {
        return { content: 'URL blocked: internal/private addresses are not allowed', isError: true };
      }
      try {
        const response = await fetch(url);
        if (!response.ok) {
          return { content: `HTTP ${response.status}: ${response.statusText}`, isError: true };
        }
        const text = await response.text();
        const maxLen = 50000;
        const content = text.length > maxLen ? text.slice(0, maxLen) + '\n...[truncated]' : text;
        return { content };
      } catch (err) {
        return { content: `Fetch error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
];
