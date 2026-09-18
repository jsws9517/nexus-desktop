/**
 * Project knowledge tools (adapted from Tolten Aegis — see docs/dsh-plugin-adoption-plan.md §3).
 *
 * Implements the `.nexus` project-knowledge standard — a single project-level
 * folder for all Nexus-side artifacts (rules, skills, temp):
 *
 *   <project-root>/
 *   └── .nexus/
 *       ├── skills/<skill-name>/SKILL.md   ← how to build X (markdown w/ front-matter)
 *       ├── rules/NEXUS.md                 ← project constitution (highest precedence)
 *       └── trash/                         ← temp/scratch files (never committed)
 *
 * User-level session memory stays in `~/.nexus/` (the global data dir) — it is
 * NEVER projected into a project `.nexus/` folder.
 *
 * `.agents/` remains only as a legacy compatibility fallback for the ecosystem
 * standard — never a primary location for new Nexus projects.
 *
 * The **constitution** is loaded by AgentService and injected into EVERY model
 * step under the `[Project Constitution]` marker (see §3.7 of the adoption plan),
 * so sub-agents inherit it explicitly from the Orchestrator in the parallel phase.
 *
 * Three read-only tools are exposed to the LLM:
 *   - agents_index   — list every skill / rule declared in the project
 *   - agents_read    — read any file under .nexus/** or the constitution
 *   - agents_search  — keyword search over skill/rule content
 *
 * Security model (§9.4 of the adoption plan):
 *   - Constitution text is SYSTEM-LEVEL instruction input. It is only honoured
 *     inside an authorized project root (worker cwd / path-authorizer grant),
 *     never for arbitrary directories.
 *   - All reads are read-only and size-capped (MAX_CONSTITUTION_BYTES) to avoid
 *     silent context bloat; every resolved path stays inside `<root>/.nexus`.
 *   - No interactive Approval gate is raised by these tools (unattended-safe).
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { getAuthorizedRoots, getSandboxRoots } from 'nexus-coder/dist/src/security/path-authorizer.js';
import type { ToolDef, ToolResult } from './types.js';

/** Marker delimiters used by AgentService for constitution prompt decoration. */
export const CONSTITUTION_MARKER = '[Project Constitution]';

/** Marker for the user-level (global) rules block injected into EVERY session. */
export const GLOBAL_RULES_MARKER = '[Global Rules]';

/** Filename of the user-level rules file, under `<data-dir>/rules/`. */
export const GLOBAL_RULES_FILENAME = 'GLOBAL.md';

/** Hard cap on constitution size — larger files are refused (no silent bloat). */
export const MAX_CONSTITUTION_BYTES = 32 * 1024;

/** Hard cap on a single tool result returned to the LLM. */
const MAX_TOOL_RESULT_CHARS = 30_000;

/**
 * Fallback chain, first existing file wins.
 *
 * `.nexus/rules/NEXUS.md` is the project constitution — the filename is
 * localized to Nexus (not copied from Aegis' DEEPSEEK.md / other agents' names).
 * The trailing generic entries (AGENTS.md, .clinerules) stay as low-priority
 * compatibility for open cross-tool conventions (not DSH-specific), so a project
 * that already documents itself for other agents still gets picked up last.
 * The legacy `.agents/` entries are kept ONLY so projects that adopted the
 * earlier `.agents/rules/NEXUS.md` convention (including this repo's pre-.nexus
 * state) keep loading their constitution — they must never be a primary path.
 */
const CONSTITUTION_FALLBACK = [
  '.nexus/rules/NEXUS.md',
  '.nexus/rules/AGENTS.md',
  '.clinerules',
  'AGENTS.md',
  '.agents/rules/NEXUS.md',
  '.agents/rules/AGENTS.md',
] as const;

/** Everything under the project's `.nexus/` directory is "knowledge". */
const AGENTS_DIR = '.nexus';

export interface SkillEntry {
  name: string;
  path: string; // absolute
  description: string;
}

export interface RuleEntry {
  name: string;
  path: string; // absolute
}

export interface AgentsIndex {
  root: string;
  constitution: string | null;
  skills: SkillEntry[];
  rules: RuleEntry[];
}

export interface ConstitutionLoad {
  file: string | null;
  text: string | null;
  reason: 'ok' | 'not-found' | 'too-large' | 'unauthorized';
}

function normalizeRoot(root: string): string {
  return resolve(root);
}

/**
 * True when `root` is an authorized project root. A root is acceptable when it
 * is the worker's live cwd (the user opened it), or appears in the
 * path-authorizer's authorized/sandbox roots. With no restrictions at all we
 * still require it to be the cwd — the constitution is a *project* concept.
 */
function isAuthorizedRoot(root: string, cwd = process.cwd()): boolean {
  const norm = normalizeRoot(root);
  if (norm === normalizeRoot(cwd)) return true;
  const roots = [...getAuthorizedRoots(), ...(getSandboxRoots() ?? [])].map(normalizeRoot);
  return roots.some((r) => r === norm);
}

/** Resolve the constitution file for a project root (first existing wins). */
export async function resolveConstitutionFile(root: string): Promise<string | null> {
  const base = normalizeRoot(root);
  for (const rel of CONSTITUTION_FALLBACK) {
    try {
      const p = join(base, rel);
      const st = await stat(p);
      if (st.isFile()) return p;
    } catch {
      // continue down the chain
    }
  }
  // Aegis fallback: any `.nexus/rules/*.md`.
  try {
    const rulesDir = join(base, AGENTS_DIR, 'rules');
    const entries = await readdir(rulesDir);
    const md = entries.filter((e) => e.toLowerCase().endsWith('.md')).sort();
    if (md.length > 0) {
      const p = join(rulesDir, md[0]);
      const st = await stat(p);
      if (st.isFile()) return p;
    }
  } catch {
    // no rules dir
  }
  return null;
}

/**
 * Load the project constitution for a root.
 *
 * @returns {ConstitutionLoad} — `reason` explains refusal (for audit/logging).
 */
export async function loadConstitution(root: string): Promise<ConstitutionLoad> {
  const base = normalizeRoot(root);
  if (!isAuthorizedRoot(base)) {
    return { file: null, text: null, reason: 'unauthorized' };
  }
  const file = await resolveConstitutionFile(base);
  if (!file) return { file: null, text: null, reason: 'not-found' };
  try {
    const st = await stat(file);
    if (st.size > MAX_CONSTITUTION_BYTES) {
      return { file, text: null, reason: 'too-large' };
    }
    const text = await readFile(file, 'utf8');
    return { file, text, reason: 'ok' };
  } catch {
    return { file: null, text: null, reason: 'not-found' };
  }
}

// ---------------------------------------------------------------------------
// User-level (global) rules — `~/.nexus/rules/GLOBAL.md`
//
// Unlike the project constitution, this file is user-scoped and applies to
// EVERY session the agent creates, regardless of the current project (or the
// absence of one). It is injected into every model step under the
// `[Global Rules]` marker and is deliberately NOT gated by `isAuthorizedRoot`
// (it lives in the user's own data directory). Sub-agents inherit it because
// the Orchestrator merges it into the constitution text it passes down.
// ---------------------------------------------------------------------------

/** User-level data dir; honours `LLMA_DATA_DIR` so tests can isolate. */
function globalDataDir(): string {
  return process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
}

/** Absolute path of the user-level rules file. */
export function globalRulesPath(): string {
  return join(globalDataDir(), 'rules', GLOBAL_RULES_FILENAME);
}

/**
 * Default user-level rules — the four working disciplines (file management,
 * git discipline, temp-file recycling, naming conventions). Written only when
 * the file is absent; user edits are never overwritten.
 */
export const DEFAULT_GLOBAL_RULES = `# Nexus Global Rules (user-level)

> Location: \`~/.nexus/rules/GLOBAL.md\`. Loaded by the Nexus agent into EVERY
> session's system prompt under the \`[Global Rules]\` marker, regardless of the
> active project. Edit freely. A project constitution (\`.nexus/rules/NEXUS.md\`)
> is layered on top and may override project-specific points.

## 1. File Management
- Before creating a file, search for an existing one that already does the job
  (grep/glob). Never duplicate a module that exists — extend it instead.
- Keep one responsibility per file; place new files in the idiomatic location
  for the project (src/, docs/, scripts/, test/) — never loose in the repo root.
- Never write outside the authorized project root without an explicit grant.
- Prefer editing existing files over creating near-duplicates (\`old/\`, \`new/\`,
  \`_backup\` variants are forbidden).

## 2. Git Discipline
- One coherent feature per commit; include its tests in the same commit.
- Commit messages: Conventional Commits — \`<type>(<scope>): <summary>\`
  (feat|fix|chore|docs|refactor|test|perf|build|ci). No bare version numbers.
- Do not commit unrelated changes together. Do not finish a task with a dirty
  working tree — commit or revert first.
- NEVER push automatically; push only on an explicit user request.
- Never rewrite shared history (no force-push) without explicit user approval.

## 3. Temporary File Recycling
- All scratch/temp/draft files go under \`.nexus/trash/\` (or the OS temp dir),
  date-prefixed; never into the repo root or any tracked path.
- Delete the temp artifacts you created before finishing a task.
- Temp files are never committed; \`.nexus/trash/\` stays git-ignored.

## 4. File Naming Conventions
- Follow the project's existing naming style; match the language conventions.
- Tests: \`*.test.mjs\` under \`test/\`; one-off scripts under \`scripts/*.mjs\`.
- Use \`.mjs\` by default; \`.cjs\` only when CommonJS is genuinely required.
- Forbidden suffixes: \`final\`, \`verify\`, \`tmp\`, \`temp\`, \`new\`, \`old\`, \`copy\`,
  \`backup\`, \`bak\`, \`_v2\`; no timestamp-named scratch files in tracked paths.
`;

/**
 * Ensure the user-level rules file exists, writing the default template on
 * first run. Never overwrites user-edited content. Best-effort (errors are
 * swallowed — prompt decoration must never break a turn).
 */
export function ensureGlobalRules(): void {
  const p = globalRulesPath();
  if (existsSync(p)) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, DEFAULT_GLOBAL_RULES, 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * Load the user-level rules file. Mirrors {@link loadConstitution} but is not
 * gated by project-root authorization (it lives in the user's own data dir).
 */
export async function loadGlobalRules(): Promise<ConstitutionLoad> {
  const p = globalRulesPath();
  try {
    const st = await stat(p);
    if (st.size > MAX_CONSTITUTION_BYTES) {
      return { file: p, text: null, reason: 'too-large' };
    }
    const text = await readFile(p, 'utf8');
    return { file: p, text, reason: 'ok' };
  } catch {
    return { file: null, text: null, reason: 'not-found' };
  }
}

/**
 * Reset the user-level rules file to its default template, backing up the
 * existing file to `<path>.bak` first.
 */
export function resetGlobalRules(): { ok: boolean; path: string; backup?: string } {
  const p = globalRulesPath();
  let backup: string | undefined;
  try {
    if (existsSync(p)) {
      backup = `${p}.bak`;
      renameSync(p, backup);
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, DEFAULT_GLOBAL_RULES, 'utf8');
    return { ok: true, path: p, backup };
  } catch {
    return { ok: false, path: p };
  }
}

/** True when a path sits strictly inside `<root>/.nexus`. Guards traversal. */
function isInsideAgents(root: string, p: string): boolean {
  const base = normalizeRoot(root);
  const agentsRoot = join(base, AGENTS_DIR);
  const rel = relative(agentsRoot, p);
  return !rel.startsWith('..') && !rel.includes('..\\') && rel !== '' && !isAbsolutePath(rel);
}

/** resolve() accepts relative input; guard against absolute rel paths. */
function isAbsolutePath(p: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);
}

/** List .nexus/skills and .nexus/rules for a root. */
export async function indexAgents(root: string): Promise<AgentsIndex> {
  const base = normalizeRoot(root);
  const skills: SkillEntry[] = [];
  const rules: RuleEntry[] = [];
  const skillsRoot = join(base, AGENTS_DIR, 'skills');
  const rulesRoot = join(base, AGENTS_DIR, 'rules');

  try {
    const skillDirs = await readdir(skillsRoot, { withFileTypes: true });
    for (const d of skillDirs) {
      if (!d.isDirectory()) continue;
      const skillDir = join(skillsRoot, d.name);
      const skillFile = join(skillDir, 'SKILL.md');
      try {
        const st = await stat(skillFile);
        if (!st.isFile()) continue;
        const content = await readFile(skillFile, 'utf8');
        skills.push({
          name: d.name,
          path: skillFile,
          description: extractDescription(content),
        });
      } catch {
        // no SKILL.md — skip
      }
    }
  } catch {
    // no skills dir
  }

  try {
    const ruleFiles = await readdir(rulesRoot, { withFileTypes: true });
    for (const d of ruleFiles) {
      if (!d.isFile()) continue;
      if (!d.name.toLowerCase().endsWith('.md')) continue;
      rules.push({ name: d.name, path: join(rulesRoot, d.name) });
    }
  } catch {
    // no rules dir
  }

  rules.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const constitution = await resolveConstitutionFile(base);
  return { root: base, constitution, skills, rules };
}

/** Extract a one-line description from SKILL.md front-matter or first heading. */
function extractDescription(content: string): string {
  const firstLines = content.slice(0, 2_000);
  // front-matter: `description: ...`
  const fm = firstLines.match(/^---\s*\n([\s\S]*?)^---\s*$/m);
  if (fm) {
    const desc = fm[1].match(/^description\s*:\s*(.+)$/mi);
    if (desc) return desc[1].trim().slice(0, 200);
  }
  const heading = firstLines.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim().slice(0, 200) : '';
}

/** Read one knowledge file (must be inside `.nexus/**` or the constitution). */
export async function readAgentsFile(root: string, relPath: string): Promise<ToolResult> {
  const base = normalizeRoot(root);
  if (!isAuthorizedRoot(base)) {
    return denied('project root is not authorized for .nexus discovery');
  }
  const p = resolve(base, relPath);
  if (!isInsideAgents(base, p)) {
    return denied('path must stay inside the project .nexus/ directory');
  }
  try {
    const st = await stat(p);
    if (!st.isFile()) return denied('not a file');
    if (st.size > MAX_CONSTITUTION_BYTES) {
      return {
        content: `File is ${st.size} bytes (> ${MAX_CONSTITUTION_BYTES} cap). Refused to avoid context bloat.`,
        isError: true,
      };
    }
    const text = await readFile(p, 'utf8');
    return { content: text };
  } catch (e) {
    return denied(`cannot read ${relPath}: ${(e as Error).message}`);
  }
}

/** Keyword search over skill/rule content — returns matched entries + snippets. */
export async function searchAgents(root: string, query: string): Promise<ToolResult> {
  const base = normalizeRoot(root);
  if (!isAuthorizedRoot(base)) {
    return denied('project root is not authorized for .nexus discovery');
  }
  const q = query.trim().toLowerCase();
  if (!q) {
    return { content: 'Provide a non-empty `query`.', isError: true };
  }
  const index = await indexAgents(base);
  const hits: Array<{ kind: 'skill' | 'rule'; name: string; path: string; snippet: string }> = [];

  const consider = async (kind: 'skill' | 'rule', name: string, p: string) => {
    try {
      const text = await readFile(p, 'utf8');
      const idx = text.toLowerCase().indexOf(q);
      if (idx === -1) return;
      const start = Math.max(0, idx - 120);
      const snippet = text.slice(start, start + 240).replace(/\s+/g, ' ').trim();
      hits.push({ kind, name, path: p, snippet });
    } catch {
      // unreadable — skip
    }
  };

  for (const s of index.skills) await consider('skill', s.name, s.path);
  for (const r of index.rules) await consider('rule', r.name, r.path);

  const payload = {
    query,
    matches: hits.slice(0, 20),
    total: hits.length,
  };
  return { content: JSON.stringify(payload, null, 2) };
}

function denied(reason: string): ToolResult {
  return { content: `agents_* access denied: ${reason}`, isError: true };
}

// ---------------------------------------------------------------------------
// Tool definitions (ToolDef contract — registered in src/tools/index.ts)
// ---------------------------------------------------------------------------

const rootHint =
  '`root` is optional; defaults to the worker working directory (the project root). ' +
  'Must be an authorized project root.';

const AGENTS_INDEX_TOOL: ToolDef = {
  name: 'agents_index',
  description:
    'List every skill and rule declared in the project .nexus directory (skills + rules + resolved constitution). ' +
    'Use this before agents_read to discover what the project knows.',
  inputSchema: {
    type: 'object',
    properties: { root: { type: 'string', description: rootHint } },
  },
};

const AGENTS_READ_TOOL: ToolDef = {
  name: 'agents_read',
  description:
    'Read a file from the project .nexus directory (e.g. skills/foo/SKILL.md, rules/NEXUS.md) or the resolved constitution.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the project root (must stay inside .nexus/).' },
      root: { type: 'string', description: rootHint },
    },
    required: ['path'],
  },
};

const AGENTS_SEARCH_TOOL: ToolDef = {
  name: 'agents_search',
  description:
    'Keyword search over project skills/rules to find which rule or skill covers a topic. Returns matched files with snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword / phrase to search for.' },
      root: { type: 'string', description: rootHint },
    },
    required: ['query'],
  },
};

export const AGENTS_TOOL_DEFS: ToolDef[] = [AGENTS_INDEX_TOOL, AGENTS_READ_TOOL, AGENTS_SEARCH_TOOL];
export const AGENTS_TOOLS: Set<string> = new Set(AGENTS_TOOL_DEFS.map((d) => d.name));

/** Dispatch a single agents_* call. */
export async function callAgentsTool(name: string, args: unknown): Promise<ToolResult> {
  const a = (args ?? {}) as { root?: unknown; path?: unknown; query?: unknown };
  const root =
    typeof a.root === 'string' && a.root.trim() !== '' ? a.root : process.cwd();

  try {
    switch (name) {
      case 'agents_index': {
        const index = await indexAgents(root);
        return { content: JSON.stringify(index, null, 2).slice(0, MAX_TOOL_RESULT_CHARS) };
      }
      case 'agents_read': {
        if (typeof a.path !== 'string' || a.path.trim() === '') {
          return { content: '`path` must be a non-empty string.', isError: true };
        }
        return await readAgentsFile(root, a.path);
      }
      case 'agents_search': {
        if (typeof a.query !== 'string') {
          return { content: '`query` must be a string.', isError: true };
        }
        return await searchAgents(root, a.query);
      }
      default:
        return { content: `Unknown agents tool: ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `${name} failed: ${(e as Error).message}`, isError: true };
  }
}

/** Convenience: absolute dirname of a constitution file (for audit/marker hygiene). */
export function constitutionDir(file: string): string {
  return dirname(file);
}