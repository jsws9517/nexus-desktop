import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MEMORIES_DIR = (() => {
  const base = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  return join(base, 'session-memories');
})();

export class SessionMemory {
  constructor() {
    mkdirSync(MEMORIES_DIR, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return join(MEMORIES_DIR, `${sessionId}.md`);
  }

  exists(sessionId: string): boolean {
    return existsSync(this.filePath(sessionId));
  }

  load(sessionId: string): string | null {
    try {
      return readFileSync(this.filePath(sessionId), 'utf-8');
    } catch {
      return null;
    }
  }

  save(sessionId: string, sessionName: string, content: string): void {
    const header = `# ${sessionName}\n<!-- sessionId: ${sessionId} -->\n\n`;
    // Strip any pre-existing header from content to avoid duplication
    const body = content.replace(/^# .+\n<!-- sessionId: [a-f0-9-]+ -->\n*\n*/gm, '').trimStart();
    writeFileSync(this.filePath(sessionId), header + body.trimEnd() + '\n', 'utf-8');
  }

  append(sessionId: string, sessionName: string, userMessage: string, assistantSummary: string): void {
    const existing = this.load(sessionId) || '';
    const line = `- **${userMessage}** → ${assistantSummary}\n`;
    this.save(sessionId, sessionName, existing + line);
  }

  remove(sessionId: string): void {
    try {
      unlinkSync(this.filePath(sessionId));
    } catch {}
  }

  list(): { sessionId: string; name: string; preview: string }[] {
    try {
      if (!existsSync(MEMORIES_DIR)) return [];
      return readdirSync(MEMORIES_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const sessionId = f.replace(/\.md$/, '');
          const raw = readFileSync(join(MEMORIES_DIR, f), 'utf-8');
          const firstLine = raw.split('\n')[0]?.replace(/^#\s*/, '') || sessionId;
          return { sessionId, name: firstLine, preview: raw.slice(0, 200) };
        });
    } catch {
      return [];
    }
  }

  aggregateAll(): string {
    const all = this.list();
    if (all.length === 0) return '(no session memories yet)';
    return all
      .map((m) => {
        const raw = readFileSync(join(MEMORIES_DIR, `${m.sessionId}.md`), 'utf-8');
        return raw.trim();
      })
      .join('\n\n---\n\n');
  }
}
