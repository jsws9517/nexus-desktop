import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';

const SKILLS_DIR = join(homedir(), '.nexus', 'skills');

export interface SkillValidation {
  valid: boolean;
  issues: SkillIssue[];
  /** What the skill looks like after fixing (dry-run or actual) */
  fixedStructure?: { name?: string; version?: string; description?: string; type: 'md' | 'js' | 'invalid' };
}

export interface SkillIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  fix?: string;
  autoFixable: boolean;
}

export interface SkillCreationResult {
  name: string;
  path: string;
  skillFile: string;
}

export interface FixResult {
  fixed: string[];
  remaining: SkillIssue[];
}

function ensureSkillsDir(): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

export function findSkillDir(nameOrPath: string): string | null {
  if (isAbsolute(nameOrPath)) return existsSync(nameOrPath) ? nameOrPath : null;
  const inSkills = join(SKILLS_DIR, nameOrPath);
  if (existsSync(inSkills)) return inSkills;
  const resolved = resolve(process.cwd(), nameOrPath);
  if (existsSync(resolved)) return resolved;
  return null;
}

const VALID_SKILL_JS = ['index.js', 'index.mjs', 'skill.js', 'skill.mjs'];
const VALID_SKILL_MD = ['SKILL.md', 'skill.md'];

function isJsSkillDir(dirPath: string): boolean {
  return VALID_SKILL_JS.some((f) => existsSync(join(dirPath, f)));
}

function findMdFile(dirPath: string): string | null {
  for (const f of VALID_SKILL_MD) {
    const p = join(dirPath, f);
    if (existsSync(p)) return p;
  }
  return null;
}

export function createSkillFromPrompt(
  name: string,
  description: string,
  instructions: string,
  version?: string,
): SkillCreationResult {
  const skillName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'my-skill';
  const skillDir = join(SKILLS_DIR, skillName);
  const mdPath = join(skillDir, 'SKILL.md');

  ensureSkillsDir();
  mkdirSync(skillDir, { recursive: true });

  const body = `---
name: ${skillName}
version: ${version || '1.0.0'}
description: ${description.replace(/[<>]/g, '')}
---

# ${skillName}

${instructions}
`;

  writeFileSync(mdPath, body, 'utf-8');
  return { name: skillName, path: skillDir, skillFile: mdPath };
}

export function validateSkill(nameOrPath: string): SkillValidation {
  const dirPath = findSkillDir(nameOrPath);
  const issues: SkillIssue[] = [];

  if (!dirPath) {
    issues.push({ severity: 'error', message: `Skill directory not found: ${nameOrPath}`, autoFixable: false });
    return { valid: false, issues, fixedStructure: { type: 'invalid' } };
  }

  const skillName = dirPath.split(/[/\\]/).pop() || '';

  // Check for JS or MD entry
  const hasJs = isJsSkillDir(dirPath);
  const mdFile = findMdFile(dirPath);

  if (!hasJs && !mdFile) {
    issues.push({
      severity: 'error',
      message: 'No SKILL.md or JS module found in directory. A skill must have either SKILL.md (preferred) or index.js/skill.js.',
      autoFixable: false,
    });
  }

  if (mdFile) {
    const content = readFileSync(mdFile, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);

    if (!frontmatterMatch) {
      issues.push({
        severity: 'error',
        message: 'SKILL.md is missing YAML frontmatter (--- delimited block at the top with name/version/description).',
        fix: 'Add frontmatter: ---\nname: <skill-name>\nversion: 1.0.0\ndescription: <description>\n---',
        autoFixable: true,
      });
    } else {
      const fmRaw = frontmatterMatch[1];
      const fm = parseSimpleYaml(fmRaw);

      // === Frontmatter field validation ===
      if (!fm.name) {
        issues.push({
          severity: 'error',
          message: 'Frontmatter missing required field: name',
          fix: `Add "name: <skill-name>" to frontmatter`,
          autoFixable: true,
        });
      }
      if (fm.name && fm.name !== skillName) {
        issues.push({
          severity: 'warning',
          message: `Frontmatter name "${fm.name}" differs from directory name "${skillName}". This may cause confusion.`,
          autoFixable: false,
        });
      }
      if (!fm.version) {
        issues.push({
          severity: 'warning',
          message: 'Frontmatter missing recommended field: version',
          fix: 'Add "version: 1.0.0" to frontmatter',
          autoFixable: true,
        });
      } else if (!/^\d+\.\d+\.\d+/.test(fm.version)) {
        issues.push({
          severity: 'warning',
          message: `Version "${fm.version}" is not valid semver. Expected format: major.minor.patch (e.g. 1.0.0)`,
          autoFixable: false,
        });
      }
      if (!fm.description) {
        issues.push({
          severity: 'warning',
          message: 'Frontmatter missing description — skill will use directory name as fallback description',
          fix: `Add a brief description, e.g.: description: Local TTS using Kokoro engine`,
          autoFixable: true,
        });
      } else if (fm.description === '|') {
        issues.push({
          severity: 'warning',
          message: 'Frontmatter description uses YAML block scalar (|) but the multi-line text was not parsed fully. Consider an inline description instead.',
          autoFixable: false,
        });
      }

      // === Body content validation ===
      const bodyAfterFm = content.slice(frontmatterMatch[0].length).trim();
      if (!bodyAfterFm) {
        issues.push({
          severity: 'warning',
          message: 'SKILL.md has frontmatter but no body content — skill instructions are empty',
          autoFixable: true,
        });
      } else {
        if (bodyAfterFm.length < 100) {
          issues.push({
            severity: 'info',
            message: `SKILL.md body is very short (${bodyAfterFm.length} chars) — may lack sufficient instructions for the LLM`,
            autoFixable: false,
          });
        }
        // Check for hardcoded paths referencing old namespace
        const oldPaths = bodyAfterFm.match(/~\/\.claude\/skills\//g);
        if (oldPaths) {
          issues.push({
            severity: 'warning',
            message: `SKILL.md body contains ${oldPaths.length} reference(s) to ~/.claude/skills/. Skills are now under ~/.nexus/skills/.`,
            autoFixable: true,
          });
        }
        // Check for tool-calling conventions
        const KNOWN_TOOLS = new Set([
          'read_text_file', 'read_multiple_files', 'file_write', 'edit_file',
          'create_directory', 'list_directory', 'directory_tree',
          'move_file', 'copy_file', 'get_file_info', 'delete_file',
          'exec_command', 'fetch_url', 'web_search', 'web_fetch',
          'create_skill', 'validate_skill', 'fix_skill_smart',
          'remember', 'recall', 'remember_project', 'analyze_image',
          'decompose_task', 'query_tasks',
        ]);
        const hasToolRefs =
          // Pattern: call read_text_file / 使用 read_text_file 工具
          /(?:使用|调用|call|invoke)\s+[`"']?[\w_]+[`"']?\s*(?:工具|tool)?/i.test(bodyAfterFm)
          // Pattern: mcp__xxx__xxx
          || /mcp__[\w_]+__[\w_]+/.test(bodyAfterFm)
          // Pattern: bare tool name in code blocks or backtick references
          || [...KNOWN_TOOLS].some((name) =>
            new RegExp('`' + name + '`|' + name.replace(/_/g, '[\\\\ _]') + '\\s*\\(', 'i').test(bodyAfterFm)
          );
        if (!hasToolRefs) {
          issues.push({
            severity: 'info',
            message: 'No tool-calling references detected in instructions. The LLM may not know which builtin tools to use. Consider adding call examples.',
            autoFixable: false,
          });
        }
      }
    }

    if (hasJs) {
      issues.push({
        severity: 'info',
        message: 'Both SKILL.md and JS module found. JS module takes priority during loading.',
        autoFixable: false,
      });
    }
  }

  if (hasJs && !mdFile) {
    const skillJsonPath = join(dirPath, 'skill.json');
    if (existsSync(skillJsonPath)) {
      try {
        const meta = JSON.parse(readFileSync(skillJsonPath, 'utf-8'));
        if (!meta.name) {
          issues.push({
            severity: 'warning',
            message: 'skill.json missing "name" field — directory name will be used as fallback',
            autoFixable: true,
          });
        }
        if (!meta.version) {
          issues.push({
            severity: 'info',
            message: 'skill.json missing "version" field — defaults to 1.0.0',
            autoFixable: true,
          });
        }
      } catch {
        issues.push({
          severity: 'error',
          message: 'skill.json exists but is not valid JSON',
          autoFixable: false,
        });
      }
    } else {
      issues.push({
        severity: 'info',
        message: 'JS skill without skill.json — metadata falls back to directory name / 1.0.0',
        autoFixable: false,
      });
    }
  }

  // === Directory structure conventions ===
  const entries = readdirSync(dirPath);
  if (entries.length === 0) {
    issues.push({ severity: 'error', message: 'Skill directory is empty', autoFixable: false });
  } else {
    const hasReadme = entries.some((e) => e.toLowerCase() === 'readme.md');
    const hasChangelog = entries.some((e) => e.toLowerCase() === 'changelog.md');
    const hasEvals = entries.some((e) => e === 'evals');
    if (!hasReadme) {
      issues.push({
        severity: 'info',
        message: 'No README.md found — recommended for documenting skill usage and setup',
        autoFixable: true,
      });
    }
    if (!hasChangelog) {
      issues.push({
        severity: 'info',
        message: 'No CHANGELOG.md found — recommended for tracking version history',
        autoFixable: true,
      });
    }
    if (!hasEvals) {
      issues.push({
        severity: 'info',
        message: 'No evals/ directory found — recommended for quality evaluation cases',
        autoFixable: true,
      });
    }
    if (hasEvals) {
      const evalsPath = join(dirPath, 'evals');
      try {
        const evalsFiles = readdirSync(evalsPath);
        const hasEvalsJson = evalsFiles.some((f) => f.toLowerCase() === 'evals.json');
        if (!hasEvalsJson) {
          issues.push({
            severity: 'info',
            message: 'evals/ directory exists but no evals.json found',
            autoFixable: false,
          });
        } else {
          try {
            const evalContent = JSON.parse(readFileSync(join(evalsPath, 'evals.json'), 'utf-8'));
            const evalCount = Array.isArray(evalContent) ? evalContent.length : Object.keys(evalContent).length;
            issues.push({
              severity: 'info',
              message: `Found evals.json with ${evalCount} test case(s)`,
              autoFixable: false,
            });
          } catch {
            issues.push({
              severity: 'warning',
              message: 'evals/evals.json exists but is not valid JSON',
              autoFixable: false,
            });
          }
        }
      } catch { /* ignore read error */ }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return {
    valid: errors.length === 0,
    issues,
    fixedStructure: {
      type: mdFile ? 'md' : hasJs ? 'js' : 'invalid',
    },
  };
}

export function fixSkill(nameOrPath: string): FixResult {
  const dirPath = findSkillDir(nameOrPath);
  const fixed: string[] = [];
  const remaining: SkillIssue[] = [];

  if (!dirPath) {
    remaining.push({ severity: 'error', message: `Cannot fix: skill directory not found: ${nameOrPath}`, autoFixable: false });
    return { fixed, remaining };
  }

  const skillName = dirPath.split(/[/\\]/).pop() || 'skill';
  const mdFile = findMdFile(dirPath);
  const hasJs = isJsSkillDir(dirPath);

  // 1. Create SKILL.md if neither MD nor JS exists
  if (!mdFile && !hasJs) {
    const newMd = join(dirPath, 'SKILL.md');
    writeFileSync(newMd, `---
name: ${skillName}
version: 1.0.0
description: Skill: ${skillName}
---

# ${skillName}

Instructions for this skill.
`, 'utf-8');
    fixed.push(`Created SKILL.md: ${newMd}`);
  }

  // 2. Fix SKILL.md frontmatter and body
  const currentMd = findMdFile(dirPath);
  if (currentMd) {
    let content = readFileSync(currentMd, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    let bodyStart = frontmatterMatch ? frontmatterMatch[0].length : 0;
    let body = content.slice(bodyStart);

    if (!frontmatterMatch) {
      // No frontmatter — prepend one
      content = `---
name: ${skillName}
version: 1.0.0
description: Skill: ${skillName}
---

${content}`;
      fixed.push('Added missing YAML frontmatter to SKILL.md');
      body = content.slice(content.indexOf('---', 3) + 4); // after second ---
    } else {
      const fmRaw = frontmatterMatch[1];
      const fm = parseSimpleYaml(fmRaw);
      const lines = fmRaw.split('\n');
      let modified = false;

      if (!fm.name) {
        lines.push(`name: ${skillName}`);
        modified = true;
        fixed.push('Added missing "name" to frontmatter');
      }
      if (!fm.version) {
        lines.push('version: 1.0.0');
        modified = true;
        fixed.push('Added missing "version" to frontmatter');
      }
      if (!fm.description) {
        lines.push(`description: Skill: ${skillName}`);
        modified = true;
        fixed.push('Added missing "description" to frontmatter');
      }

      if (modified) {
        content = `---\n${lines.join('\n')}\n---\n${body}`;
        body = content.slice(content.indexOf('---', 3) + 4);
      }
    }

    // Replace old namespace paths in body
    const oldPathCount = (body.match(/~\/\.claude\/skills\//g) || []).length;
    if (oldPathCount > 0) {
      body = body.replace(/~\/\.claude\/skills\//g, '~/.nexus/skills/');
      const fmEnd = content.indexOf('---', 3);
      content = content.slice(0, fmEnd + 3) + body;
      fixed.push(`Replaced ${oldPathCount} reference(s) from ~/.claude/skills/ to ~/.nexus/skills/`);
    }

    writeFileSync(currentMd, content, 'utf-8');
  }

  // 3. Create README.md if missing
  const entries = readdirSync(dirPath);
  const hasReadme = entries.some((e) => e.toUpperCase() === 'README.md');
  if (!hasReadme && currentMd) {
    const mdContent = readFileSync(currentMd, 'utf-8');
    const fm = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    const desc = fm ? parseSimpleYaml(fm[1]).description || '' : '';
    writeFileSync(join(dirPath, 'README.md'), `# ${skillName}

${desc}

## Usage

See [SKILL.md](./SKILL.md) for detailed instructions.
`, 'utf-8');
    fixed.push('Created README.md with basic documentation');
  }

  // 4. Create CHANGELOG.md if missing
  const hasChangelog = entries.some((e) => e.toUpperCase() === 'CHANGELOG.md');
  if (!hasChangelog) {
    writeFileSync(join(dirPath, 'CHANGELOG.md'), `# Changelog

## 1.0.0

- Initial release
`, 'utf-8');
    fixed.push('Created CHANGELOG.md with initial entry');
  }

  // 5. Create evals/ with evals.json if missing
  const hasEvals = entries.some((e) => e === 'evals');
  if (!hasEvals) {
    mkdirSync(join(dirPath, 'evals'), { recursive: true });
    writeFileSync(join(dirPath, 'evals', 'evals.json'), JSON.stringify([], null, 2), 'utf-8');
    fixed.push('Created evals/ directory with empty evals.json');
  }

  // Collect remaining unfixable issues
  const validation = validateSkill(dirPath);
  for (const issue of validation.issues) {
    if (!issue.autoFixable) {
      remaining.push(issue);
    }
  }

  return { fixed, remaining };
}

function parseSimpleYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}
