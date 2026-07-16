import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync, cpSync, unlinkSync, rmdirSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { BuiltinTool } from './types.js';
import { ToolResult } from '../types.js';
import { authorizePath } from '../security/path-authorizer.js';
import { sanitizeContent } from '../utils/sanitize.js';
import { translateCommand } from './cmd-alias.js';

const execAsync = promisify(exec);

/**
 * Resolve relative paths (~, ., ..) to absolute OS paths.
 * Lets the LLM pass paths like ~/dir/file, ../file, ./file without
 * needing to resolve them to absolute paths first.
 */
function resolveRelativePath(p: string): string {
  if (!p) return p;
  // ~ → homedir
  if (p.startsWith('~')) {
    return resolve(homedir(), p.slice(1).replace(/^[/\\]/, ''));
  }
  // Everything else gets resolved relative to CWD (resolve handles absolute as-is)
  return resolve(process.cwd(), p);
}

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
    name: 'read_text_file',
    description: 'Read the contents of a text file at the given path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const path = resolveRelativePath(String(args.path || ''));
      if (!existsSync(path)) {
        return { content: `File not found: ${path}`, isError: true };
      }
      const authorized = await authorizePath(path);
      if (!authorized) {
        return { content: `Access denied: "${path}" is not in the allowed path list and access was rejected by user.`, isError: true };
      }
      try {
        const content = readFileSync(path, 'utf-8');
        return { content };
      } catch (err) {
        return { content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'read_multiple_files',
    description: 'Read the contents of multiple files at once',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths' },
      },
      required: ['paths'],
    },
    async execute(args): Promise<ToolResult> {
      const paths = (args.paths as string[]) || [];
      const results: string[] = [];
      for (const p of paths) {
        const resolved = resolveRelativePath(p);
        if (!existsSync(resolved)) { results.push(`\n--- ${resolved}: NOT FOUND ---`); continue; }
        const authorized = await authorizePath(resolved);
        if (!authorized) { results.push(`\n--- ${resolved}: ACCESS DENIED ---`); continue; }
        try {
          const content = readFileSync(resolved, 'utf-8');
          results.push(`\n--- ${resolved} ---\n${content}`);
        } catch (err) {
          results.push(`\n--- ${resolved}: ${err instanceof Error ? err.message : String(err)} ---`);
        }
      }
      return { content: results.join('') };
    },
  },
  {
    name: 'edit_file',
    description: 'Make targeted edits to a file (search-and-replace on exact text)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to search for (must match exactly once)' },
              newText: { type: 'string', description: 'Replacement text' },
            },
            required: ['oldText', 'newText'],
          },
        },
        dryRun: { type: 'boolean', description: 'If true, show diff without applying' },
      },
      required: ['path', 'edits'],
    },
    async execute(args): Promise<ToolResult> {
      const path = resolveRelativePath(String(args.path || ''));
      const edits = (args.edits as Array<{ oldText: string; newText: string }>) || [];
      const dryRun = !!args.dryRun;
      if (!existsSync(path)) return { content: `File not found: ${path}`, isError: true };
      const authorized = await authorizePath(path);
      if (!authorized) return { content: `Access denied: "${path}"`, isError: true };
      try {
        const content = readFileSync(path, 'utf-8');
        const results: string[] = [];
        let modified = content;
        for (const edit of edits) {
          const oldText = edit.oldText;
          const newText = sanitizeContent(edit.newText);
          const idx = modified.indexOf(oldText);
          if (idx === -1) {
            results.push(`✗ "${oldText.slice(0, 60)}" not found — SKIPPED`);
            continue;
          }
          const nextIdx = modified.indexOf(oldText, idx + 1);
          if (nextIdx !== -1) {
            results.push(`✗ "${oldText.slice(0, 60)}" appears ${nextIdx > idx ? 'multiple times' : 'once'} — SKIPPED (must match exactly once)`);
            continue;
          }
          modified = modified.slice(0, idx) + newText + modified.slice(idx + oldText.length);
          results.push(`✓ Replaced "${oldText.slice(0, 60)}" → "${newText.slice(0, 60)}"`);
        }
        if (dryRun) {
          return { content: `[DRY RUN — not applied]\n${results.join('\n')}` };
        }
        writeFileSync(path, sanitizeContent(modified), 'utf-8');
        return { content: results.join('\n') };
      } catch (err) {
        return { content: `Error editing file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'create_directory',
    description: 'Create a new directory at the given path (including parent dirs)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path to create' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const path = resolveRelativePath(String(args.path || ''));
      const parent = path.split(/[/\\]/).slice(0, -1).join('/') || '.';
      const authorized = await authorizePath(parent);
      if (!authorized) return { content: `Access denied: parent of "${path}"`, isError: true };
      try {
        mkdirSync(path, { recursive: true });
        return { content: `Created directory: ${path}` };
      } catch (err) {
        return { content: `Error creating directory: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a given directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const path = resolveRelativePath(String(args.path || ''));
      if (!existsSync(path)) return { content: `Directory not found: ${path}`, isError: true };
      const authorized = await authorizePath(path);
      if (!authorized) return { content: `Access denied: "${path}"`, isError: true };
      try {
        const entries = readdirSync(path, { withFileTypes: true });
        const list = entries.map(e => `${e.isDirectory() ? '/' : ''}${e.name}`).join('\n');
        return { content: list || '(empty directory)' };
      } catch (err) {
        return { content: `Error listing directory: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'directory_tree',
    description: 'Get a recursive directory tree listing',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path' },
        maxDepth: { type: 'number', description: 'Maximum recursion depth (default 10)' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const dirPath = resolveRelativePath(String(args.path || ''));
      const maxDepth = Math.min(Math.max(Number(args.maxDepth) || 10, 1), 20);
      if (!existsSync(dirPath)) return { content: `Directory not found: ${dirPath}`, isError: true };
      const authorized = await authorizePath(dirPath);
      if (!authorized) return { content: `Access denied: "${dirPath}"`, isError: true };
      try {
        function walk(d: string, depth: number): string[] {
          if (depth > maxDepth) return ['  ...(max depth)'];
          const lines: string[] = [];
          try {
            const entries = readdirSync(d, { withFileTypes: true });
            for (const e of entries) {
              const prefix = e.isDirectory() ? '/' : '  ';
              lines.push(prefix + e.name);
              if (e.isDirectory()) {
                const sub = walk(join(d, e.name), depth + 1);
                lines.push(...sub.map(l => '  ' + l));
              }
            }
          } catch {}
          return lines;
        }
        const tree = walk(dirPath, 0);
        return { content: tree.join('\n') };
      } catch (err) {
        return { content: `Error listing tree: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute source path' },
        destination: { type: 'string', description: 'Absolute destination path' },
      },
      required: ['source', 'destination'],
    },
    async execute(args): Promise<ToolResult> {
      const src = resolveRelativePath(String(args.source || ''));
      const dst = resolveRelativePath(String(args.destination || ''));
      if (!existsSync(src)) return { content: `Source not found: ${src}`, isError: true };
      const srcAuth = await authorizePath(src);
      if (!srcAuth) return { content: `Access denied: source "${src}"`, isError: true };
      const dstAuth = await authorizePath(dst);
      if (!dstAuth) return { content: `Access denied: destination "${dst}"`, isError: true };
      try {
        renameSync(src, dst);
        return { content: `Moved: ${src} → ${dst}` };
      } catch (err) {
        return { content: `Error moving file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'copy_file',
    description: 'Copy a file or directory to a new location',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Absolute source path' },
        destination: { type: 'string', description: 'Absolute destination path' },
      },
      required: ['source', 'destination'],
    },
    async execute(args): Promise<ToolResult> {
      const src = resolveRelativePath(String(args.source || ''));
      const dst = resolveRelativePath(String(args.destination || ''));
      if (!existsSync(src)) return { content: `Source not found: ${src}`, isError: true };
      const srcAuth = await authorizePath(src);
      if (!srcAuth) return { content: `Access denied: source "${src}"`, isError: true };
      const dstAuth = await authorizePath(dst);
      if (!dstAuth) return { content: `Access denied: destination "${dst}"`, isError: true };
      try {
        const st = statSync(src);
        if (st.isDirectory()) {
          cpSync(src, dst, { recursive: true });
        } else {
          cpSync(src, dst);
        }
        return { content: `Copied: ${src} → ${dst}` };
      } catch (err) {
        return { content: `Error copying: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'get_file_info',
    description: 'Get metadata about a file or directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const path = resolveRelativePath(String(args.path || ''));
      if (!existsSync(path)) return { content: `File not found: ${path}`, isError: true };
      const authorized = await authorizePath(path);
      if (!authorized) return { content: `Access denied: "${path}"`, isError: true };
      try {
        const st = statSync(path);
        return {
          content: [
            `Size: ${st.size} bytes`,
            `Type: ${st.isDirectory() ? 'directory' : 'file'}`,
            `Created: ${new Date(st.birthtime).toISOString()}`,
            `Modified: ${new Date(st.mtime).toISOString()}`,
            `Permissions: ${(st.mode & 0o777).toString(8)}`,
          ].join('\n'),
        };
      } catch (err) {
        return { content: `Error getting file info: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or empty directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path to delete' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const path = resolveRelativePath(String(args.path || ''));
      if (!existsSync(path)) return { content: `File not found: ${path}`, isError: true };
      const authorized = await authorizePath(path);
      if (!authorized) return { content: `Access denied: "${path}"`, isError: true };
      try {
        const st = statSync(path);
        if (st.isDirectory()) {
          rmdirSync(path);
        } else {
          unlinkSync(path);
        }
        return { content: `Deleted: ${path}` };
      } catch (err) {
        return { content: `Error deleting: ${err instanceof Error ? err.message : String(err)}`, isError: true };
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
      const path = resolveRelativePath(String(args.path || ''));
      const content = sanitizeContent(String(args.content || ''));
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
    description: 'Execute a shell command and return stdout/stderr. Use the "cwd" parameter to run the command in a specific project directory instead of the agent\'s default working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory to run the command in (absolute or relative path). Defaults to the agent\'s current working directory. Set this to the target project directory when operating on a specific project.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['command'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const command = String(args.command || '');
      const timeout = Number(args.timeout || 30000);
      const requestedCwd = args.cwd ? resolveRelativePath(String(args.cwd)) : undefined;
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
          cwd: requestedCwd || ctx?.workDir || process.cwd(),
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
  {
    name: 'create_skill',
    description: 'Create a new SKILL.md skill in ~/.nexus/skills/. Provide a name, description, and markdown instructions. The skill becomes available after reload.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (lowercase, hyphens allowed, e.g. my-weather-skill)' },
        description: { type: 'string', description: 'Short description of what the skill does' },
        instructions: { type: 'string', description: 'Full markdown instructions the skill should follow. Include workflow steps, tool usage, output format.' },
        version: { type: 'string', description: 'Semantic version (optional, defaults to 1.0.0)' },
      },
      required: ['name', 'description', 'instructions'],
    },
    async execute(args): Promise<ToolResult> {
      const { createSkillFromPrompt } = await import('../skills/manager.js');
      try {
        const result = createSkillFromPrompt(
          String(args.name || ''),
          String(args.description || ''),
          String(args.instructions || ''),
          String(args.version || '') || undefined,
        );
        return {
          content: `Skill created successfully.\n  Name: ${result.name}\n  Path: ${result.path}\n  File: ${result.skillFile}\n\nReload skills with /skill reload or restart the agent to use it.`,
        };
      } catch (err) {
        return { content: `Failed to create skill: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'validate_skill',
    description: 'Validate a skill directory structure against the expected paradigm. Checks for SKILL.md, frontmatter, required fields, and common issues.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Skill name (in ~/.nexus/skills/) or absolute/relative path to skill directory' },
        fix: { type: 'boolean', description: 'Whether to auto-fix detected issues (optional, default false)' },
      },
      required: ['path'],
    },
    async execute(args): Promise<ToolResult> {
      const { validateSkill, fixSkill } = await import('../skills/manager.js');
      try {
        const skillPath = String(args.path || '');
        const doFix = args.fix === true;

        if (doFix) {
          const fixResult = fixSkill(skillPath);
          const lines: string[] = [];
          if (fixResult.fixed.length > 0) {
            lines.push('Fixed:');
            for (const f of fixResult.fixed) lines.push(`  ✓ ${f}`);
          }
          if (fixResult.remaining.length > 0) {
            lines.push('Remaining issues (not auto-fixable):');
            for (const r of fixResult.remaining) {
              lines.push(`  ${r.severity === 'error' ? '✗' : '⚠'} [${r.severity}] ${r.message}`);
            }
          }
          if (lines.length === 0) lines.push('No issues found. Skill is valid.');
          return { content: lines.join('\n') };
        }

        const report = validateSkill(skillPath);
        const lines: string[] = [`Validation result: ${report.valid ? '✓ VALID' : '✗ ISSUES FOUND'}`];
        for (const issue of report.issues) {
          const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
          lines.push(`  ${icon} [${issue.severity}] ${issue.message}`);
          if (issue.fix) lines.push(`      Suggested fix: ${issue.fix}`);
        }
        if (report.issues.length === 0) lines.push('  Skill follows the expected paradigm.');
        return { content: lines.join('\n') };
      } catch (err) {
        return { content: `Validation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
  {
    name: 'fix_skill_smart',
    description: 'Fix a skill using an LLM-powered sub-agent. Handles complex issues like YAML block scalars, missing tool references, short body, old namespace paths, non-semver versions, and description problems. Reads the skill, validates it, then spawns a Skill Fixer sub-agent to repair it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Skill name (in ~/.nexus/skills/) or absolute/relative path to skill directory' },
        instructions: { type: 'string', description: 'Additional fix instructions (optional)' },
      },
      required: ['path'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { validateSkill, findSkillDir } = await import('../skills/manager.js');
      const { preAuthorizeRoot } = await import('../security/path-authorizer.js');
      const skillPath = String(args.path || '');
      const extra = String(args.instructions || '');

      const report = validateSkill(skillPath);
      if (report.valid && report.issues.length === 0) {
        return { content: 'No issues found. Skill already follows the paradigm.' };
      }

      // Resolve absolute skill path & pre-authorize so sub-agent can read/write
      const absDir = findSkillDir(skillPath);
      const absMd = absDir ? join(absDir, 'SKILL.md') : `${skillPath}/SKILL.md`;
      const absEvals = absDir ? join(absDir, 'evals', 'evals.json') : null;
      if (absDir) {
        preAuthorizeRoot(absDir);
        preAuthorizeRoot(join(absDir, '..'));
      }

      const issueSummary = report.issues.map((i) =>
        `  [${i.severity}] ${i.message}${i.fix ? ` (fix: ${i.fix})` : ''}`
      ).join('\n');

      const taskDesc =
        `Fix all issues in the skill at "${absDir}".\n\nIssues to fix:\n${issueSummary}\n\n` +
        `Use read_text_file("${absMd}") to read SKILL.md.\n` +
        `Use file_write("${absMd}", ...) to save SKILL.md changes.\n` +
        (absEvals ? `Use file_write("${absEvals}", ...) to update evals.json.\n` : '') +
        (extra ? `\nAdditional instructions: ${extra}` : '');

      const { SubAgentWorker } = await import('../task/sub-agent-worker.js');
      const node = {
        id: `skill-fix-${Date.now()}`,
        description: taskDesc,
        dependencies: [] as string[],
        status: 'in_progress' as const,
        retryCount: 0,
        maxRetries: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (!ctx?.agent) {
        return { content: 'Error: fix_skill_smart requires an agent context', isError: true };
      }

      try {
        const worker = new SubAgentWorker(ctx.agent);
        const result = await worker.execute(node, undefined, 'skill-fixer');
        return { content: result.output };
      } catch (err) {
        return { content: `Skill fix failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  },
];
