import { readFileSync, existsSync, mkdirSync, cpSync, writeFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ConfigManager } from './index.js';

const CLAUDE_JSON = join(homedir(), '.claude.json');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const AGENT_SKILLS_DIR = join(homedir(), '.nexus', 'skills');
const IMPORT_FLAG = join(homedir(), '.nexus', '.claude-imported');

export interface ImportResult {
  mcpImported: number;
  mcpSkipped: number;
  skillsImported: number;
  skillsSkipped: number;
  wasAutoImport: boolean;
}

export function hasClaudeConfig(): boolean {
  return existsSync(CLAUDE_JSON);
}

export function hasBeenAutoImported(): boolean {
  return existsSync(IMPORT_FLAG);
}

export function markAutoImported(): void {
  writeFileSync(IMPORT_FLAG, new Date().toISOString(), 'utf-8');
}

export function importFromClaude(config: ConfigManager, silent = false): ImportResult {
  const result: ImportResult = {
    mcpImported: 0,
    mcpSkipped: 0,
    skillsImported: 0,
    skillsSkipped: 0,
    wasAutoImport: silent,
  };

  // ---- Import MCP Servers ----
  if (existsSync(CLAUDE_JSON)) {
    try {
      const claudeConfig = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
      const mcpServers = claudeConfig.mcpServers || {};

      for (const [name, srv] of Object.entries(mcpServers)) {
        const server = srv as Record<string, unknown>;
        const command = String(server.command || '');
        if (!command) {
          result.mcpSkipped++;
          continue;
        }
        const existing = config.getMcpServers();
        if (existing && name in existing) {
          result.mcpSkipped++;
          continue;
        }
        config.addMcpServer(name, {
          command,
          args: Array.isArray(server.args) ? server.args.map(String) : undefined,
          env: server.env && typeof server.env === 'object'
            ? Object.fromEntries(Object.entries(server.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
            : undefined,
          autoStart: true,
        });
        result.mcpImported++;
      }
    } catch {
      // Silently fail on parse errors during auto-import
    }
  }

  // ---- Import Skills ----
  if (existsSync(CLAUDE_SKILLS_DIR)) {
    mkdirSync(AGENT_SKILLS_DIR, { recursive: true });
    const importedNames = new Set<string>();

    // Phase 1: Import skills listed in index.json
    const indexPath = join(CLAUDE_SKILLS_DIR, 'index.json');
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
        const skills = index.skills || [];

        try {
          cpSync(indexPath, join(AGENT_SKILLS_DIR, 'index.json'));
        } catch {
          // Non-fatal
        }

        for (const skill of skills) {
          const skillName = skill.name;
          const skillPath = join(CLAUDE_SKILLS_DIR, skill.path.replace(/^\.\//, ''));
          const targetDir = join(AGENT_SKILLS_DIR, skillName);

          importedNames.add(skillName);

          if (existsSync(targetDir)) {
            result.skillsSkipped++;
            continue;
          }

          try {
            cpSync(skillPath, targetDir, { recursive: true });
            result.skillsImported++;
          } catch {
            result.skillsSkipped++;
          }
        }
      } catch {
        // Silently fail
      }
    }

    // Phase 2: Fallback — scan for skill directories not recorded in index.json
    try {
      const entries = readdirSync(CLAUDE_SKILLS_DIR);
      for (const entry of entries) {
        const fullPath = join(CLAUDE_SKILLS_DIR, entry);
        if (!statSync(fullPath).isDirectory()) continue;
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        if (importedNames.has(entry)) continue;

        // Only import directories that are recognizable skills
        const skillIndicators = ['SKILL.md', 'skill.md', 'skill.json', 'index.js', 'index.mjs', 'skill.js', 'skill.mjs'];
        const isSkill = skillIndicators.some(f => existsSync(join(fullPath, f)));
        if (!isSkill) continue;

        const targetDir = join(AGENT_SKILLS_DIR, entry);
        if (existsSync(targetDir)) {
          result.skillsSkipped++;
          continue;
        }

        try {
          cpSync(fullPath, targetDir, { recursive: true });
          result.skillsImported++;
        } catch {
          result.skillsSkipped++;
        }
      }
    } catch {
      // Silently fail
    }
  }

  return result;
}
