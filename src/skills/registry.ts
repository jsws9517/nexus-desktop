import { ToolDefinition } from '../types.js';
import { Skill, AgentContext } from './types.js';
import { loadSkills } from './loader.js';

export class SkillRegistry {
  private skills: Skill[] = [];
  private ctx?: AgentContext;

  async load(ctx?: AgentContext): Promise<void> {
    this.ctx = ctx;
    this.skills = await loadSkills();
    if (ctx) {
      for (const skill of this.skills) {
        if (skill.init) {
          try {
            await skill.init(ctx);
          } catch {
            // Init errors are non-fatal
          }
        }
      }
    }
  }

  reload(ctx?: AgentContext): Promise<void> {
    return this.load(ctx);
  }

  list(): Skill[] {
    return this.skills;
  }

  getTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const skill of this.skills) {
      if (skill.tools) {
        tools.push(...skill.tools);
      }
    }
    return tools;
  }

  async handleCommand(skillName: string, cmd: string, args: string[]): Promise<string | undefined> {
    const skill = this.skills.find((s) => s.name === skillName);
    if (skill?.handleCommand) {
      return skill.handleCommand(cmd, args);
    }
    return undefined;
  }
}
