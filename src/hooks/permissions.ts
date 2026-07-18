import { HookContext, HookResult } from './types.js';

export enum PermissionLevel {
  Allow = 'allow',
  Prompt = 'prompt',
  Deny = 'deny',
}

export interface ToolPermission {
  name: string;
  level: PermissionLevel;
  conditions?: {
    argsMatch?: Record<string, RegExp>;
    cwdMatch?: string;
  };
}

const DANGEROUS_PATTERNS = [
  /^rm\s+(-rf?)?\s*\/$/,
  /^mkfs/,
  /^dd\s+/,
  /^:\(\)\{/,
  /^chmod\s+777/,
  /^curl\s+.*\||^wget\s+.*\|/,
];

const SENSITIVE_COMMANDS = [
  'rm', 'mv', 'dd', 'mkfs', 'chmod', 'chown',
  'sudo', 'su', 'passwd', 'useradd', 'usermod',
  'iptables', 'ufw', 'mount', 'umount', 'fdisk',
  '>', '>>', '|', '`',
];

const WRITE_TOOLS = new Set([
  'write_file', 'file_write', 'edit_file', 'file_edit',
  'create_file', 'append_file', 'create_directory',
  'move_file', 'rename', 'copy_file',
]);

const DEFAULT_PERMISSIONS: ToolPermission[] = [
  { name: '*', level: PermissionLevel.Prompt },
  // Read operations — Allow
  { name: 'read_file', level: PermissionLevel.Allow },
  { name: 'file_read', level: PermissionLevel.Allow },
  { name: 'read_text_file', level: PermissionLevel.Allow },
  { name: 'read_multiple_files', level: PermissionLevel.Allow },
  { name: 'read_files', level: PermissionLevel.Allow },
  { name: 'search_files', level: PermissionLevel.Allow },
  { name: 'grep', level: PermissionLevel.Allow },
  { name: 'glob', level: PermissionLevel.Allow },
  { name: 'list_files', level: PermissionLevel.Allow },
  { name: 'list_directory', level: PermissionLevel.Allow },
  { name: 'directory_tree', level: PermissionLevel.Allow },
  { name: 'get_file_info', level: PermissionLevel.Allow },
  // Write operations — Prompt
  { name: 'write_file', level: PermissionLevel.Prompt },
  { name: 'file_write', level: PermissionLevel.Prompt },
  { name: 'edit_file', level: PermissionLevel.Prompt },
  { name: 'create_directory', level: PermissionLevel.Prompt },
  { name: 'move_file', level: PermissionLevel.Prompt },
  { name: 'copy_file', level: PermissionLevel.Prompt },
  // Execution — Prompt
  { name: 'execute_command', level: PermissionLevel.Prompt },
  { name: 'exec_command', level: PermissionLevel.Prompt },
  // Destructive — Deny
  { name: 'delete_file', level: PermissionLevel.Deny },
  { name: 'remove_file', level: PermissionLevel.Deny },
];

export function getToolPermission(toolName: string): ToolPermission {
  for (const perm of DEFAULT_PERMISSIONS) {
    if (perm.name === toolName) return perm;
    if (perm.name === '*' && !DEFAULT_PERMISSIONS.some(p => p.name === toolName)) {
      return { ...perm, name: toolName };
    }
  }
  return { name: toolName, level: PermissionLevel.Prompt };
}

export function isDangerousCommand(command: string): boolean {
  const trimmed = command.trim();
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() || '';
  if (SENSITIVE_COMMANDS.includes(firstToken)) return true;

  return false;
}

export async function permissionCheckHook(
  ctx: HookContext,
  promptUser?: (question: string) => Promise<boolean>,
  options?: { allowlist?: string[]; mode?: 'prompt' | 'auto'; safePaths?: string[]; resolveCwd?: () => string; mcpAllowlist?: string[]; toolServer?: string },
): Promise<HookResult> {
  if (!ctx.toolCall) return 'allow';

  const toolName = ctx.toolCall.name;
  const args = ctx.toolCall.arguments || {};

  // Permission whitelist (白名单): when mode === 'auto', any tool listed in the
  // allowlist (or '*' for everything) is auto-approved without prompting the user.
  // Dangerous commands and protected paths are still blocked regardless (see below).
  const allowlist = options?.allowlist ?? [];
  const whitelistMode = options?.mode ?? 'prompt';
  if (whitelistMode === 'auto' && (allowlist.includes('*') || allowlist.includes(toolName))) {
    // Still enforce hard denials (delete_file / remove_file) — never whitelist those.
    const perm0 = getToolPermission(toolName);
    if (perm0.level !== PermissionLevel.Deny) return 'allow';
  }

  const perm = getToolPermission(toolName);

  if (perm.level === PermissionLevel.Allow) return 'allow';

  if (perm.level === PermissionLevel.Deny) {
    return { verdict: 'deny', reason: `Tool "${toolName}" is denied by security policy.` };
  }

  if (perm.level === PermissionLevel.Prompt) {
    // MCP whitelist: auto-approve MCP tools by server or exact tool name.
    // Supported entries (mcp:* is intentionally NOT supported to avoid
    // blindly trusting every MCP server):
    //   'mcp:<server>'  — all tools from a specific MCP server
    //   '<toolName>'    — a specific tool by exact name
    // High-risk MCP tool names (delete_*, remove_*, drop_*, exec*, run_command,
    // etc.) are NEVER auto-approved by the whitelist — they fall through to the
    // normal prompt flow so the user is asked before they run.
    if (options?.mcpAllowlist && options.mcpAllowlist.length > 0 && options.toolServer) {
      if (!isHighRiskMcpTool(toolName)) {
        const server = options.toolServer;
        if (
          options.mcpAllowlist.includes(`mcp:${server}`) ||
          options.mcpAllowlist.includes(toolName)
        ) {
          return 'allow';
        }
      }
    }
    // Path whitelist for exec_command / execute_command: if the command's
    // effective working directory resolves under a configured safe path, auto-
    // approve without prompting. Dangerous commands are still blocked below.
    const isExec = toolName === 'exec_command' || toolName === 'execute_command';
    if (isExec && options?.safePaths && options.safePaths.length > 0) {
      const requestedCwd = (args.cwd || args.workdir || '') as string;
      const base = options.resolveCwd ? options.resolveCwd() : process.cwd();
      const effectiveCwd = requestedCwd ? resolveSafePath(requestedCwd, base) : base;
      if (isUnderSafePath(effectiveCwd, options.safePaths, base)) {
        const commandArg = (args.command || args.cmd || '') as string;
        if (!isDangerousCommand(commandArg)) {
          return 'allow';
        }
      }
    }
    const commandArg = (args.command || args.cmd || '') as string;
    if (commandArg && isDangerousCommand(commandArg)) {
      return {
        verdict: 'deny',
        reason: `Dangerous command blocked: "${commandArg.slice(0, 100)}"`,
      };
    }

    if (WRITE_TOOLS.has(toolName)) {
      const path = (args.path || args.filePath || '') as string;
      if (path && typeof path === 'string') {
        const lower = path.toLowerCase();
        if (lower.includes('node_modules') || lower.includes('.env') || lower.includes('dist/')) {
          return {
            verdict: 'deny',
            reason: `Writing to "${path.slice(0, 100)}" requires explicit approval.`,
          };
        }
      }
    }

    if (promptUser) {
      const argsPreview = JSON.stringify(args).slice(0, 200);
      const question = `Allow tool "${toolName}"?\n  Args: ${argsPreview}\n  Allow? (y/N): `;
      const approved = await promptUser(question);
      return approved ? 'allow' : { verdict: 'deny', reason: 'Rejected by user.' };
    }
  }

  return 'allow';
}

/* ----------------------- Path whitelist helpers ----------------------- */

function resolveSafePath(p: string, base: string): string {
  const expanded = p.replace(/^~($|\/|\\)/, (process.env.HOME || process.env.USERPROFILE || '') + '$1');
  if (expanded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(expanded) || expanded.startsWith('\\')) {
    return require('path').resolve(expanded);
  }
  return require('path').resolve(base, expanded);
}

function isUnderSafePath(target: string, safePaths: string[], base: string): boolean {
  const path = require('path');
  const norm = (s: string) => path.resolve(s).replace(/\\/g, '/').toLowerCase();
  const t = norm(target);
  for (const sp of safePaths) {
    const resolved = sp === '.' || sp === ''
      ? base
      : resolveSafePath(sp, base);
    const s = norm(resolved);
    if (t === s || t.startsWith(s + '/')) return true;
  }
  return false;
}

// High-risk MCP tool name patterns. Tools matching these are NEVER auto-approved
// by the MCP whitelist — they fall through to the normal prompt flow so the user
// is asked before they run. This prevents `mcp:<server>` or a tool-name entry from
// silently granting destructive operations.
const HIGH_RISK_MCP_PATTERNS: RegExp[] = [
  /^delete/i,
  /^remove/i,
  /^drop/i,
  /^truncate/i,
  /^exec/i,
  /^run_command/i,
  /^runcommand/i,
  /^shell/i,
  /^kill/i,
  /^shutdown/i,
  /^format/i,
  /^purge/i,
];

function isHighRiskMcpTool(toolName: string): boolean {
  return HIGH_RISK_MCP_PATTERNS.some((re) => re.test(toolName));
}
