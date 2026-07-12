import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join, extname } from 'path';
import { ContextManager } from '../llm/context-manager.js';

interface ProjectContextConfig {
  systemPrompt: string;
  rules: Array<{ name: string; content: string }>;
  knowledge: Array<{ key: string; value: string }>;
}

const PROJECT_MD_CANDIDATES = [
  '.nexus/PROJECT.md',
  '.nexus/project.md',
  '.nexus/CLAUDE.md',
  'CLAUDE.md',
];

export class ProjectContext {
  private config: ProjectContextConfig = { systemPrompt: '', rules: [], knowledge: [] };
  private baseDir = '';

  async load(cwd: string): Promise<ProjectContextConfig> {
    this.baseDir = cwd;
    this.config = { systemPrompt: '', rules: [], knowledge: [] };

    this.loadProjectMd(cwd);
    this.loadRules(cwd);
    this.loadKnowledge(cwd);

    return this.config;
  }

  async inject(context: ContextManager): Promise<void> {
    if (!this.config.systemPrompt && this.config.rules.length === 0 && this.config.knowledge.length === 0) {
      return;
    }

    const parts: string[] = [];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
    }

    if (this.config.rules.length > 0) {
      const rulesText = this.config.rules.map((r) => `## ${r.name}\n${r.content}`).join('\n\n');
      parts.push(`[项目规则]:\n${rulesText}`);
    }

    if (this.config.knowledge.length > 0) {
      const knowledgeText = this.config.knowledge.map((k) => `- ${k.key}: ${k.value}`).join('\n');
      parts.push(`[项目知识]:\n${knowledgeText}`);
    }

    if (parts.length === 0) return;

    const contextBlock = parts.join('\n\n');

    const msgs = context.getMessages();
    const sysIdx = msgs.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0) {
      const sys = msgs[sysIdx];
      if (!sys.content.includes('[项目上下文]')) {
        sys.content = sys.content.replace(
          /(你是一个智能助手)/,
          `$1\n\n[项目上下文]:\n${contextBlock}`,
        );
      }
    }
  }

  async saveKnowledge(key: string, value: string): Promise<void> {
    if (!this.baseDir) return;
    const knowledgeDir = resolve(this.baseDir, '.nexus', 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    const filename = `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
    writeFileSync(join(knowledgeDir, filename), value, 'utf-8');
  }

  private loadProjectMd(cwd: string): void {
    for (const candidate of PROJECT_MD_CANDIDATES) {
      const path = resolve(cwd, candidate);
      if (existsSync(path)) {
        try {
          this.config.systemPrompt = readFileSync(path, 'utf-8');
          return;
        } catch {
          // Try next candidate
        }
      }
    }
  }

  private loadRules(cwd: string): void {
    const rulesDir = resolve(cwd, '.nexus', 'rules');
    if (!existsSync(rulesDir)) return;

    try {
      const files = readdirSync(rulesDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && (file.name.endsWith('.md') || file.name.endsWith('.txt'))) {
          try {
            const content = readFileSync(join(rulesDir, file.name), 'utf-8');
            this.config.rules.push({
              name: file.name.replace(/\.(md|txt)$/, ''),
              content: content.trim(),
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Rules directory not accessible
    }
  }

  private loadKnowledge(cwd: string): void {
    const knowledgeDir = resolve(cwd, '.nexus', 'knowledge');
    if (!existsSync(knowledgeDir)) return;

    try {
      const files = readdirSync(knowledgeDir, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.md')) {
          try {
            const content = readFileSync(join(knowledgeDir, file.name), 'utf-8');
            const key = file.name.replace(/\.md$/, '');
            this.config.knowledge.push({ key, value: content.trim() });
          } catch {
            // Skip unreadable files
          }
        }
      }
    } catch {
      // Knowledge directory not accessible
    }
  }
}
