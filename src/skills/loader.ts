import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { Skill } from './types.js';

const SKILLS_DIR = join(homedir(), '.llm-agent', 'skills');

export async function loadSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  if (!existsSync(SKILLS_DIR)) return skills;

  // Load index.json if exists (Claude Code format)
  const indexPath = join(SKILLS_DIR, 'index.json');
  const indexData = existsSync(indexPath)
    ? JSON.parse(readFileSync(indexPath, 'utf-8')) as { skills?: Array<{ name: string; path: string; metadata?: { version?: string; description?: string } }> }
    : undefined;

  const entries = readdirSync(SKILLS_DIR);

  for (const entry of entries) {
    const fullPath = join(SKILLS_DIR, entry);
    const stat = statSync(fullPath);
    if (!stat.isDirectory()) continue;

    // Try to load as standard JS skill module
    const jsSkill = await tryLoadJsSkill(fullPath, entry);
    if (jsSkill) {
      skills.push(jsSkill);
      continue;
    }

    // Try to load as Claude Code SKILL.md skill
    const mdSkill = tryLoadMdSkill(fullPath, entry, indexData);
    if (mdSkill) {
      skills.push(mdSkill);
    }
  }

  return skills;
}

async function tryLoadJsSkill(dirPath: string, name: string): Promise<Skill | undefined> {
  const candidates = ['index.js', 'index.mjs', 'skill.js', 'skill.mjs'];
  let modulePath: string | undefined;
  for (const f of candidates) {
    const p = join(dirPath, f);
    if (existsSync(p)) {
      modulePath = p;
      break;
    }
  }
  if (!modulePath) return undefined;

  try {
    // Try ESM import first
    const mod = await import(modulePath);
    const skill: Skill = mod.default || mod.skill || mod;
    if (skill.name && skill.version) {
      return skill;
    }
  } catch {
    // ESM import failed, try CJS via createRequire
    try {
      const req = createRequire(import.meta.url);
      const mod = req(modulePath);
      const skill: Skill = mod.default || mod.skill || mod;
      if (skill.name && skill.version) {
        return skill;
      }
    } catch {
      // Neither format worked
    }
  }

  return undefined;
}

function tryLoadMdSkill(dirPath: string, name: string, indexData?: { skills?: Array<{ name: string; path: string; metadata?: { version?: string; description?: string } }> }): Skill | undefined {
  const mdPath = join(dirPath, 'SKILL.md');
  if (!existsSync(mdPath)) return undefined;

  // Find metadata from index.json
  const meta = indexData?.skills?.find((s) => s.name === name)?.metadata;

  const content = readFileSync(mdPath, 'utf-8');

  // Create a wrapper skill that injects SKILL.md as system context
  return {
    name,
    version: meta?.version || '1.0.0',
    description: meta?.description || `Claude Code skill: ${name}`,
    tools: [],
    async init(ctx) {
      // SKILL.md skills don't expose tools; they're prompt-based
      // The content can be used by the agent as system context if needed
    },
  };
}
