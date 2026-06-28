import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { Skill } from './types.js';
import { ToolResult } from '../types.js';

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

    // Try to load as standard JS skill module (with skill.json metadata)
    const jsSkill = await tryLoadJsSkill(fullPath, entry, indexData);
    if (jsSkill) {
      skills.push(jsSkill);
      continue;
    }

    // Try to load as SKILL.md skill (prompt-based with callable tool)
    const mdSkill = tryLoadMdSkill(fullPath, entry, indexData);
    if (mdSkill) {
      skills.push(mdSkill);
    }
  }

  return skills;
}

async function tryLoadJsSkill(dirPath: string, name: string, indexData?: { skills?: Array<{ name: string; path: string; metadata?: { version?: string; description?: string } }> }): Promise<Skill | undefined> {
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

  // Try to load skill.json for metadata
  const skillJsonPath = join(dirPath, 'skill.json');
  const jsonMeta = existsSync(skillJsonPath)
    ? JSON.parse(readFileSync(skillJsonPath, 'utf-8')) as { name?: string; version?: string; description?: string; modes?: unknown[] }
    : undefined;

  let mod: Record<string, unknown>;
  try {
    mod = await import(modulePath);
  } catch {
    try {
      const req = createRequire(import.meta.url);
      mod = req(modulePath);
    } catch {
      return undefined;
    }
  }

  // Standard Skill object: { name, version, ... }
  const standardSkill: Skill = (mod.default || mod.skill || mod) as Skill;
  if (standardSkill.name && standardSkill.version) {
    return standardSkill;
  }

  // { execute } pattern (common for video/image skills) — wrap with skill.json metadata
  const executeFn = mod.execute;
  if (typeof executeFn !== 'function') return undefined;

  const metaName = jsonMeta?.name || name;
  const metaVersion = jsonMeta?.version || '1.0.0';
  const metaDescription = jsonMeta?.description || `Skill: ${name}`;

  // Build a tool from skill.json modes (if present) or fall back to single execute tool
  if (jsonMeta?.modes && Array.isArray(jsonMeta.modes) && jsonMeta.modes.length > 0) {
    const tools = jsonMeta.modes.map((mode) => {
      const m = mode as { name?: string; description?: string; input?: { type?: string; properties?: Record<string, { type?: string; description?: string }> }; mode?: string };
      const inputProps = m.input?.properties || {};
      const required = Object.keys(inputProps);

      return {
        name: `${metaName}_${m.mode || m.name?.toLowerCase().replace(/\s+/g, '_') || 'run'}`,
        description: m.description || metaDescription,
        inputSchema: {
          type: 'object',
          properties: inputProps,
          required: required.length > 0 ? required : undefined,
        } as Record<string, unknown>,
      };
    });

    return {
      name: metaName,
      version: metaVersion,
      description: metaDescription,
      tools,
      async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const result = await executeFn(args, {});
          return { content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
        } catch (err) {
          return { content: `Skill execution error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    };
  }

  // Fallback: single tool that delegates to execute()
  return {
    name: metaName,
    version: metaVersion,
    description: metaDescription,
    tools: [{
      name: metaName,
      description: metaDescription,
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Input to the skill' },
        },
      } as Record<string, unknown>,
    }],
    async callTool(_toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await executeFn(args, {});
        return { content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
      } catch (err) {
        return { content: `Skill execution error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}

function parseFrontmatter(content: string): { metadata: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { metadata: {}, body: content };

  const metadata: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      metadata[key] = value;
    }
  }
  return { metadata, body: match[2] };
}

function findMdSkillFile(dirPath: string): string | undefined {
  // Check both uppercase and lowercase SKILL.md
  for (const name of ['SKILL.md', 'skill.md']) {
    const p = join(dirPath, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function tryLoadMdSkill(dirPath: string, name: string, indexData?: { skills?: Array<{ name: string; path: string; metadata?: { version?: string; description?: string } }> }): Skill | undefined {
  const mdPath = findMdSkillFile(dirPath);
  if (!mdPath) return undefined;

  // Check if this dir also has a skill.js (would have been loaded by tryLoadJsSkill)
  const hasJs = ['skill.js', 'skill.mjs', 'index.js', 'index.mjs'].some((f) => existsSync(join(dirPath, f)));
  if (hasJs) return undefined;

  const meta = indexData?.skills?.find((s) => s.name === name)?.metadata;

  const content = readFileSync(mdPath, 'utf-8');
  const { metadata, body } = parseFrontmatter(content);

  const skillName = metadata.name || name;
  const skillVersion = meta?.version || metadata.version || '1.0.0';
  const skillDescription = meta?.description || metadata.description || `Skill: ${name}`;

  return {
    name: skillName,
    version: skillVersion,
    description: skillDescription,
    tools: [{
      name: skillName,
      description: `Invoke the "${skillName}" skill. ${skillDescription}`,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What you want the skill to do' },
        },
        required: ['task'],
      } as Record<string, unknown>,
    }],
    async callTool(_toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
      // Return the SKILL.md content as instructions for the LLM to follow
      const userTask = String(args.task || '');
      return {
        content: `Skill "${skillName}" instructions:\n\n${body}\n\nUser task: ${userTask}`,
      };
    },
  };
}
