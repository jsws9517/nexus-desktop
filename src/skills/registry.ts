import { ToolDefinition, ToolResult } from '../types.js';
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

  /** Execute a tool belonging to a skill. Returns undefined if no skill owns the tool. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
    for (const skill of this.skills) {
      // Check if this tool belongs to the skill
      if (skill.tools?.some((t) => t.name === name) || skill.name === name) {
        if (skill.callTool) {
          return skill.callTool(name, args);
        }
        // Fallback: skill has tool definition but no callTool — return instructions to use its SKILL.md content
        return { content: `Skill "${skill.name}" is loaded but does not support direct tool invocation.` };
      }
    }
    return undefined; // Not a skill tool
  }

  async handleCommand(skillName: string, cmd: string, args: string[]): Promise<string | undefined> {
    const skill = this.skills.find((s) => s.name === skillName);
    if (skill?.handleCommand) {
      return skill.handleCommand(cmd, args);
    }
    return undefined;
  }
}
