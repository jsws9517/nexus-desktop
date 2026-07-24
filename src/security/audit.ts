import { createInterface } from 'readline';
import chalk from 'chalk';

export type AuditAction =
  | { type: 'user_info'; detail: string }
  | { type: 'dangerous_command'; command: string }
  | { type: 'file_access'; path: string; mode: 'read' | 'write' }
  | { type: 'config_change'; key: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> };

export type AuditDecision = 'allow' | 'deny';

export class AuditManager {
  private pendingApprovals = new Set<string>();
  private askUser?: (question: string) => Promise<string>;

  setAskUser(cb: (question: string) => Promise<string>): void {
    this.askUser = cb;
  }

  /** Clear the session-level approval cache (called on nexus restart). */
  clearCache(): void {
    this.pendingApprovals.clear();
  }

  async requestApproval(action: AuditAction): Promise<AuditDecision> {
    if (action.type === 'user_info') {
      const detail = action.detail.slice(0, 200);
      const cacheKey = `user_info:${detail}`;
      if (this.pendingApprovals.has(cacheKey)) return 'allow';
      const allowed = await this.promptYesNo(
        chalk.yellow(`\n⚠ Agent wants to remember: "${detail}"\n  Allow? (y/N): `)
      );
      if (allowed) this.pendingApprovals.add(cacheKey);
      return allowed ? 'allow' : 'deny';
    }

    if (action.type === 'dangerous_command') {
      const allowed = await this.promptYesNo(
        chalk.red(`\n⚠ The agent wants to execute a command:\n  $ ${action.command}\n  Allow? (y/N): `)
      );
      return allowed ? 'allow' : 'deny';
    }

    if (action.type === 'tool_call' && action.name === 'remember') {
      const cacheKey = `tool_call:${action.name}`;
      if (this.pendingApprovals.has(cacheKey)) return 'allow';
      const allowed = await this.promptYesNo(
        chalk.yellow(`\n⚠ Agent wants to call "remember" to save information\n  Allow? (y/N): `)
      );
      if (allowed) this.pendingApprovals.add(cacheKey);
      return allowed ? 'allow' : 'deny';
    }

    return 'allow';
  }

  private async promptYesNo(question: string): Promise<boolean> {
    if (this.askUser) {
      const answer = await this.askUser(question);
      return answer.trim().toLowerCase() === 'y';
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<boolean>(resolve => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });
  }
}

const DANGEROUS_COMMANDS = new Set([
  'rm', 'del', 'rmdir', 'unlink', 'erase', 'rd',
  'format', 'mkfs', 'fdisk', 'dd', 'shred', 'newfs',
  'mv', 'move', 'ren', 'rename',
  'chmod', 'chown', 'chgrp', 'attrib', 'icacls', 'setfacl', 'cacls', 'takeown',
  'nc', 'netcat', 'ncat',
  'sudo', 'su', 'doas',
]);

function extractFirstWords(command: string): string[] {
  const words: string[] = [];
  const segments = command.split(/\s*[|&;]+\s*/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length > 0 && tokens[0]) {
      words.push(tokens[0].toLowerCase());
    }
  }
  return words;
}

export function isDangerousBash(cmd: string): boolean {
  const firstWords = extractFirstWords(cmd);
  return firstWords.some(w => DANGEROUS_COMMANDS.has(w));
}