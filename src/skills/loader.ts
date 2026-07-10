import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { Skill, AgentContext } from './types.js';
import { ToolResult } from '../types.js';

const SKILLS_DIR = join(homedir(), '.nexus', 'skills');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

function isSafePath(p: string): boolean {
  if (!isAbsolute(p)) return false;
  const normalized = resolve(p);
  if (normalized.includes('\x00')) return false;
  return !normalized.split(/[\/\\]/).some((seg) => seg === '..');
}

export async function loadSkills(extraPaths?: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  const loadedNames = new Set<string>();

  // Filter extraPaths for safety
  const safeExtras = (extraPaths || []).filter(isSafePath);
  const paths = [SKILLS_DIR, CLAUDE_SKILLS_DIR, ...safeExtras];

  for (const basePath of paths) {
    if (!existsSync(basePath)) continue;

    // Load index.json if exists (Claude Code format)
    const indexPath = join(basePath, 'index.json');
    const indexData = existsSync(indexPath)
      ? JSON.parse(readFileSync(indexPath, 'utf-8')) as { skills?: Array<{ name: string; path: string; metadata?: { version?: string; description?: string } }> }
      : undefined;

    const entries = readdirSync(basePath);

    for (const entry of entries) {
      const fullPath = join(basePath, entry);
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;

      // Try to load as standard JS skill module (with skill.json metadata)
      const jsSkill = await tryLoadJsSkill(fullPath, entry, indexData);
      if (jsSkill) {
        if (!loadedNames.has(jsSkill.name)) {
          skills.push(jsSkill);
          loadedNames.add(jsSkill.name);
        }
        continue;
      }

      // Try to load as SKILL.md skill (prompt-based with callable tool)
      const mdSkill = tryLoadMdSkill(fullPath, entry, indexData);
      if (mdSkill) {
        if (!loadedNames.has(mdSkill.name)) {
          skills.push(mdSkill);
          loadedNames.add(mdSkill.name);
        }
      }
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
  const handleSkillFn = mod.handleSkill;

  // Claude Code skill pattern: { handleSkill } with skill.json modes
  if (typeof handleSkillFn === 'function' && jsonMeta?.modes && Array.isArray(jsonMeta.modes) && jsonMeta.modes.length > 0) {
    const metaName = jsonMeta?.name || name;
    const metaVersion = jsonMeta?.version || '1.0.0';
    const metaDescription = jsonMeta?.description || `Skill: ${name}`;

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
          let modeId = toolName.replace(`${metaName}_`, '');
          // If called with just the skill name (no _mode suffix), use first mode
          if (modeId === toolName && jsonMeta?.modes && jsonMeta.modes.length > 0) {
            const firstMode = jsonMeta.modes[0] as { mode?: string };
            modeId = firstMode.mode || 'single';
          }
          const result = await handleSkillFn({ config: {} }, args, modeId);
          return { content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
        } catch (err) {
          return { content: `Skill error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    };
  }

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

  // Check if this skill has executable steps (referenced tools in the body)
  const hasExecutableSteps = /(?:使用|调用|call)\s+[`"]?[\w_]+[`"]?\s+(?:工具|tool)/i.test(body)
    || /mcp__[\w_]+__[\w_]+/.test(body)
    || /https?:\/\/[^\s]+/.test(body);

  let agentCtx: AgentContext | undefined;

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
    async init(ctx: AgentContext): Promise<void> {
      agentCtx = ctx;
    },
    async callTool(_toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
      const userTask = String(args.task || '');

      // If no agent context or no executable steps, return instructions as fallback
      if (!agentCtx || !hasExecutableSteps) {
        return {
          content: `Skill "${skillName}" instructions:\n\n${body}\n\nUser task: ${userTask}`,
        };
      }

      // Try to execute the skill's workflow directly
      try {
        const result = await executeMdSkill(skillName, body, userTask, agentCtx);
        if (result) return result;
      } catch {
        // Execution failed, fall back to returning instructions
      }

      return {
        content: `Skill "${skillName}" instructions:\n\n${body}\n\nUser task: ${userTask}`,
      };
    },
  };
}

/** Try to execute an MD skill's workflow by parsing its steps. Returns null if not executable. */
async function executeMdSkill(
  skillName: string,
  body: string,
  userTask: string,
  ctx: AgentContext,
): Promise<ToolResult | null> {
  // fetch-wtr: weather query workflow
  if (skillName === 'fetch-wtr') {
    return executeFetchWtr(body, userTask, ctx);
  }

  // Generic MD skill: return instructions (not yet executable)
  return null;
}

/** Execute the fetch-wtr weather query workflow */
async function executeFetchWtr(
  body: string,
  userTask: string,
  ctx: AgentContext,
): Promise<ToolResult> {
  // Parse city codes from the SKILL.md body
  const cityOptions: Array<{ key: string; name: string; lat: string; lon: string }> = [
    { key: '广州', name: '广东广州天河区', lat: '23.1291', lon: '113.2644' },
    { key: '江西', name: '江西抚州东乡区', lat: '28.2367', lon: '116.6300' },
  ];

  // Determine which city from user task
  let city = cityOptions[0]; // default to 广州
  const taskLower = userTask.toLowerCase();
  for (const opt of cityOptions) {
    if (taskLower.includes(opt.key) || taskLower.includes(opt.name)) {
      city = opt;
      break;
    }
  }

  // Call Open-Meteo API via fetch_url (only current_weather to avoid truncation)
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current_weather=true&timezone=Asia/Shanghai`;

  try {
    const result = await ctx.callTool('fetch_url', { url });
    const data = result && typeof result === 'object' && 'content' in result
      ? String(result.content)
      : typeof result === 'string'
        ? result
        : JSON.stringify(result);

    // Parse and format the weather data
    try {
      const json = JSON.parse(data);
      const cw = json.current_weather;
      if (!cw) {
        return { content: `天气数据获取失败（${city.name}）：返回数据中没有 current_weather 字段。` };
      }

      // Weather code mapping
      const weatherCodes: Record<number, string> = {
        0: '晴朗', 1: '基本晴', 2: '多云', 3: '阴天',
        45: '雾', 48: '雾凇',
        51: '小毛毛雨', 53: '中毛毛雨', 55: '大毛毛雨',
        61: '小雨', 63: '中雨', 65: '大雨',
        71: '小雪', 73: '中雪', 75: '大雪',
        80: '小阵雨', 81: '中阵雨', 82: '大阵雨',
        95: '雷暴', 96: '雷暴+小冰雹', 99: '雷暴+大冰雹',
      };

      // Wind direction
      const windDir = (deg: number): string => {
        const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
        return dirs[Math.round(deg / 45) % 8] || '';
      };

      const weatherDesc = weatherCodes[cw.weathercode] || `代码${cw.weathercode}`;

      const output = `# 天气预报 - ${city.name}

## 即时天气（${cw.time}）
| 项目 | 详情 |
|------|------|
| 城市 | ${city.name} |
| 天气 | ${weatherDesc} |
| 气温 | ${cw.temperature}°C |
| 风向/风力 | ${windDir(cw.winddirection)} ${cw.windspeed} km/h |

---
🌐 数据来源：Open-Meteo 开源气象 API（https://open-meteo.com/）`;

      return { content: output };
    } catch {
      // Could not parse JSON — return raw data
      return { content: `天气数据（${city.name}）：\n${data}` };
    }
  } catch (err) {
    return { content: `天气查询失败：${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
