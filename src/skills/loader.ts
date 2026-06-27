import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Skill } from './types.js';

const SKILLS_DIR = join(homedir(), '.llm-agent', 'skills');

export async function loadSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  if (!existsSync(SKILLS_DIR)) return skills;

  const entries = readdirSync(SKILLS_DIR);
  for (const entry of entries) {
    const fullPath = join(SKILLS_DIR, entry);
    const stat = statSync(fullPath);

    let modulePath: string | undefined;
    if (stat.isDirectory() && existsSync(join(fullPath, 'index.js'))) {
      modulePath = join(fullPath, 'index.js');
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      modulePath = fullPath;
    }

    if (modulePath) {
      try {
        const mod = await import(modulePath);
        const skill: Skill = mod.default || mod.skill || mod;
        if (skill.name && skill.version) {
          skills.push(skill);
        }
      } catch {
        // Skip invalid skill modules
      }
    }
  }
  return skills;
}
