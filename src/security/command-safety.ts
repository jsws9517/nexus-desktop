// Shared command-safety checks used by both the exec tool (builtin-tools) and
// the permission layer (hooks/permissions) so dangerous-command detection is
// identical regardless of which code path evaluates a command.

export const DANGEROUS_COMMANDS = new Set([
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

export const INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh',
  'python', 'python3', 'python2', 'node', 'nodejs', 'perl', 'ruby', 'php',
]);

export function containsSubshell(command: string): boolean {
  // Detect command substitution $(...), `...`, ${...}, and process
  // substitution <(...). A backtick starts a subshell even without trailing
  // whitespace, so we do NOT require whitespace after the backtick.
  return /(?:\$\(|`|\$\{|<\(|>\()/.test(command);
}

/**
 * Detect base64/hex encoded payloads used to smuggle arbitrary commands past a
 * keyword filter, e.g. `powershell -enc <base64>` or `bash -c "$(echo <b64> | base64 -d)"`.
 */
export function containsEncodedPayload(command: string): boolean {
  const lowered = command.toLowerCase();
  if (/(?:^|\s)(?:-enc(?:odedcommand)?|-e(?:64)?)\b/.test(lowered)) return true;
  if (/base64\s+-?d/.test(lowered) && /(bash|sh|zsh|powershell|pwsh|cmd)\b/.test(lowered)) return true;
  return false;
}

export function extractAllCommands(command: string): string[] {
  const commands: string[] = [];
  const segments = command.split(/\s*(?:\|\||&&|[|&;]|\n)\s*/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const withoutPrefix = trimmed.replace(/^(?:sudo|nohup|time|env|stdbuf|nice|ionice|setsid|watch)\s+/i, '');
    if (!withoutPrefix) continue;

    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    for (const char of withoutPrefix) {
      if (inQuote) {
        if (char === inQuote) inQuote = null;
        else current += char;
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (/\s/.test(char)) {
        if (current) { tokens.push(current); current = ''; }
      } else {
        current += char;
      }
    }
    if (current) tokens.push(current);
    if (tokens.length === 0) continue;

    const cmd = tokens[0].toLowerCase();
    commands.push(cmd);

    // If an interpreter is invoked with inline code, recursively extract the
    // embedded script so `bash -c "rm -rf /"` is still inspected.
    if (INTERPRETERS.has(cmd) && tokens.length >= 3) {
      const dashC = tokens.findIndex((t) => t === '-c' || t === '--command' || t === '/c');
      if (dashC !== -1 && dashC + 1 < tokens.length) {
        commands.push(...extractAllCommands(tokens[dashC + 1]));
      }
    }
  }
  return commands;
}

export function isDangerousCommand(command: string): { blocked: boolean; reason?: string } {
  if (containsSubshell(command)) {
    return { blocked: true, reason: 'subshell/command substitution is not allowed' };
  }
  if (containsEncodedPayload(command)) {
    return { blocked: true, reason: 'encoded/obfuscated command payload is not allowed' };
  }

  const commands = extractAllCommands(command);
  for (const cmd of commands) {
    if (DANGEROUS_COMMANDS.has(cmd)) {
      return { blocked: true, reason: `"${cmd}" is not allowed` };
    }
  }

  const first = commands[0];
  if (first && INTERPRETERS.has(first)) {
    const lowered = command.toLowerCase();
    const hasInline = /(^|\s)(bash|sh|zsh|python|python3|node|perl|ruby|php)\s+.*(-c\s|--command\s|\/c\s|eval\s|exec\s|<\()/.test(lowered);
    if (hasInline) {
      return { blocked: true, reason: 'inline script execution via interpreter is not allowed' };
    }
    const oneShot = /(^|\s)(?:node|perl|ruby|php|python|python3)\s+.*\s-(?:e|e64|enc)\b/.test(lowered);
    if (oneShot) {
      return { blocked: true, reason: 'inline script evaluation via interpreter is not allowed' };
    }
  }

  return { blocked: false };
}
