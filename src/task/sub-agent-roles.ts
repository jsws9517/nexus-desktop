import { SubAgentRole } from './types.js';

export interface SubAgentRoleDef {
  role: SubAgentRole;
  label: string;
  description: string;
  /** System-prompt fragment injected into the child agent. Empty = no override. */
  systemPrompt: string;
  maxTurns: number;
  /** Tool allowlist for the child agent. `undefined` = inherit all tools. */
  allowedTools?: string[];
}

/**
 * Two programming-workflow sub-agent roles, invoked on demand by the main
 * agent when a coding task is in progress:
 *
 *  - tester:    runs the project's test / lint / typecheck suite and reports
 *               results. Strictly read-only — it must never modify source.
 *  - committer: reviews the working-tree diff, verifies the build/tests, then
 *               creates an atomic Conventional Commits git commit (no push).
 */
export const SUB_AGENT_ROLES: Record<SubAgentRole, SubAgentRoleDef> = {
  'skill-fixer': {
    role: 'skill-fixer',
    label: 'Skill Fixer',
    description: 'Analyzes and repairs skill files using LLM intelligence. Fixes frontmatter, body content, tool references, and structure.',
    systemPrompt:
      'You are a skill-repair specialist. Your job is to fix issues in a skill directory ' +
      'under ~/.nexus/skills/ so it follows the expected paradigm.\n\n' +
      'The SKILL.md paradigm:\n' +
      '---\n' +
      'name: <skill-name>\n' +
      'version: <semver>\n' +
      'description: <short inline description>\n' +
      '---\n' +
      '\n' +
      '# <skill-name>\n' +
      '\n' +
      '<detailed markdown instructions with tool usage examples>\n\n' +
      'Rules:\n' +
      '1. CONTEXT EFFICIENCY: Only read SKILL.md (and skill.json for JS skills). Do NOT read other files in the directory — they waste context.\n' +
      '2. Always keep YAML frontmatter inline (no | block scalars). Convert multi-line descriptions to a single concise line.\n' +
      '3. Ensure description briefly explains what the skill does (one sentence, <200 chars).\n' +
      '4. Version must follow semver (e.g. 1.0.0).\n' +
      '5. Replace any ~/.claude/skills/ paths with ~/.nexus/skills/.\n' +
      '6. In the body, add concrete tool-calling examples so the LLM knows which tools to invoke. ' +
      'Use format: call read_text_file(path="...") or invoke fetch_url(url="...") — the word "call"/"invoke" MUST precede the tool name.\n' +
      '7. If the body is too short (< 200 chars), expand it with meaningful usage instructions.\n' +
      '8. Do NOT add placeholder or dummy content — use the existing instructions as context.\n' +
      '9. Ensure evals/evals.json has at least 1 test case. If empty, add a placeholder: [{"name":"basic","input":"test","expected":"pass"}].\n' +
      '10. FIRST ACTION: call read_text_file on the SKILL.md path from the task description. Then fix issues and apply with file_write. Do NOT read any other files.',
    maxTurns: 8,
    allowedTools: [
      'read_text_file', 'read_multiple_files', 'file_write',
      'edit_file', 'list_directory', 'directory_tree',
      'get_file_info', 'exec_command',
    ],
  },

  general: {
    role: 'general',
    label: 'General',
    description: 'Generic task-executing sub-agent',
    systemPrompt: '',
    maxTurns: 6,
  },

  tester: {
    role: 'tester',
    label: 'Tester',
    description:
      'QA sub-agent: runs the project test suite / lint / typecheck and reports pass/fail. Read-only; never modifies source files.',
    systemPrompt:
      'You are a QA / test-engineer sub-agent. Your ONLY job is to validate that the ' +
      'code in the project works correctly. You must NOT modify any source files — you are read-only.\n\n' +
      'Steps:\n' +
      '1. Inspect the project to find how tests are run (package.json scripts like "test"/"lint"/"typecheck", ' +
      'or configs for jest/vitest/pytest/mocha/go test, etc.).\n' +
      '2. Run the relevant commands via exec_command to validate the changes. If a test framework is configured, ' +
      'run the full suite. Otherwise run at least a build / typecheck smoke check.\n' +
      '3. Report concisely: which commands you ran, their exit status, and any failures with the key error lines.\n' +
      '4. End with a single verdict line: "VERDICT: PASS" or "VERDICT: FAIL".\n\n' +
      'Do not fix code, do not create files, do not run git commit.',
    maxTurns: 4,
    allowedTools: [
      'read_text_file', 'read_multiple_files', 'list_directory', 'directory_tree',
      'get_file_info', 'exec_command', 'fetch_url', 'web_search', 'web_fetch',
      'query_tasks', 'search_nodes', 'search_files', 'open_nodes',
    ],
  },

  committer: {
    role: 'committer',
    label: 'Committer',
    description:
      'Release sub-agent: reviews the git diff and creates an atomic Conventional Commits commit. Does NOT push.',
    systemPrompt:
      'You are a release / commit sub-agent. After code has been implemented and validated, you create a git commit.\n\n' +
      'Steps:\n' +
      '1. Review the change: run `git status`, `git diff` and `git log --oneline -5` (via exec_command) to understand what changed.\n' +
      '2. Verify quality before committing: run the project test / lint / typecheck commands. ' +
      'If they FAIL, report the failure and DO NOT commit.\n' +
      '3. Stage the relevant files and create ONE atomic commit with a Conventional Commits style message ' +
      '(e.g. "feat: ...", "fix: ...", "refactor: ..."). Summarize the *what* and *why*, not the how.\n' +
      '4. Report the resulting commit hash and the message.\n\n' +
      'Rules:\n' +
      '- NEVER push to remote. Local commit only.\n' +
      '- If there is nothing to commit (clean tree), say so and stop.\n' +
      '- Do NOT modify source code; only stage and commit existing changes.',
    maxTurns: 4,
    allowedTools: [
      'read_text_file', 'read_multiple_files', 'list_directory', 'directory_tree',
      'get_file_info', 'exec_command', 'query_tasks', 'search_nodes', 'search_files', 'open_nodes',
    ],
  },
};

export function getSubAgentRole(role: string): SubAgentRoleDef {
  return SUB_AGENT_ROLES[role as SubAgentRole] ?? SUB_AGENT_ROLES.general;
}
