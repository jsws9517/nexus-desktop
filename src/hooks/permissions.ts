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
): Promise<HookResult> {
  if (!ctx.toolCall) return 'allow';

  const toolName = ctx.toolCall.name;
  const args = ctx.toolCall.arguments || {};
  const perm = getToolPermission(toolName);

  if (perm.level === PermissionLevel.Allow) return 'allow';

  if (perm.level === PermissionLevel.Deny) {
    return { verdict: 'deny', reason: `Tool "${toolName}" is denied by security policy.` };
  }

  if (perm.level === PermissionLevel.Prompt) {
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
