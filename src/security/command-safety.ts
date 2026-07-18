// Shared command-safety checks used by both the exec tool (builtin-tools) and
// the permission layer (hooks/permissions) so dangerous-command detection is
// identical regardless of which code path evaluates a command.

// Commands that may destroy data, move/overwrite files, or change permissions.
export const DANGEROUS_COMMANDS = new Set([
  // File destruction
  'rm', 'del', 'rmdir', 'unlink', 'erase', 'rd',
  // Disk/formatting
  'format', 'mkfs', 'fdisk', 'dd', 'shred', 'newfs', 'mkfs.ext4', 'mkfs.ntfs',
  // File movement (destructive overwrite)
  'mv', 'move', 'ren', 'rename',
  // Permission changes
  'chmod', 'chown', 'chgrp', 'attrib', 'icacls', 'setfacl', 'cacls', 'takeown',
]);

// Interpreters / shells. Running any of these — whether with -c/-e, against a
// script file, or interactively — is treated as arbitrary code execution.
export const INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'cmd.exe', 'powershell.exe',
  'python', 'python3', 'python2', 'node', 'nodejs', 'perl', 'ruby', 'php', 'lua', 'tclsh',
]);

// Network exfiltration / remote-code primitives. Blocked outright — they have
// no legitimate use inside a sandboxed agent exec call and are the standard
// building blocks for "curl ... | sh" supply-chain RCE.
export const NETWORK_EXFIL = new Set([
  'curl', 'wget', 'nc', 'netcat', 'ncat', 'telnet', 'ftp', 'tftp', 'scp',
  'rsync', 'ssh', 'sftp',
]);

// The full set of commands that may NEVER be auto-approved / silently run.
export const BLOCKED_COMMANDS = new Set<string>([
  ...DANGEROUS_COMMANDS,
  ...INTERPRETERS,
  ...NETWORK_EXFIL,
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
    if (BLOCKED_COMMANDS.has(cmd)) {
      return { blocked: true, reason: `"${cmd}" is not allowed` };
    }
  }

  // Interpreter chaining: `curl … | sh`, `cat x | bash`, `… | python`, etc.
  // Even if no single token is a known interpreter, a pipeline whose final
  // stage is an interpreter must be blocked (the script comes from the pipe).
  const lowered = command.toLowerCase();
  const pipeToInterpreter = /[|]\s*(?:bash|sh|zsh|python|python3|node|perl|ruby|php|powershell|pwsh)\b/;
  if (pipeToInterpreter.test(lowered)) {
    return { blocked: true, reason: 'piping data into an interpreter is not allowed' };
  }
  const inlineInterpreter = /(^|\s)(bash|sh|zsh|python|python3|node|perl|ruby|php|powershell|pwsh)\s+.*(-c\s|--command\s|\/c\s|eval\s|exec\s|<\()/;
  if (inlineInterpreter.test(lowered)) {
    return { blocked: true, reason: 'inline script execution via interpreter is not allowed' };
  }
  const oneShot = /(^|\s)(?:node|perl|ruby|php|python|python3)\s+.*\s-(?:e|e64|enc)\b/;
  if (oneShot.test(lowered)) {
    return { blocked: true, reason: 'inline script evaluation via interpreter is not allowed' };
  }

  return { blocked: false };
}
