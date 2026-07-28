import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { ConfigManager } from './index.js';

/**
 * Native Package Directory Structure:
 *   ~/.nexus/native/
 *     mcp/        — MCP server wrapper scripts (used as command entry points)
 *     plugins/    — SKILL.md-based plugin directories (auto-loaded by skill loader)
 *     data/       — Runtime data files needed by installed packages
 *                   (e.g., SQLite database files for `sqlite` MCP server)
 *     pyright/    — Python LSP MCP server (package.json + server.mjs + node_modules)
 *     ts-server/  — TypeScript/JavaScript LSP MCP server (package.json + server.mjs + node_modules)
 *     bin/        — Future: binary/executable wrappers
 */

const NATIVE_DIR = join(homedir(), '.nexus', 'native');
const MCP_DIR = join(NATIVE_DIR, 'mcp');
const PLUGIN_DIR = join(NATIVE_DIR, 'plugins');
const DATA_DIR = join(NATIVE_DIR, 'data');

export interface PackageInfo {
  name: string;
  description: string;
  longDescription: string;
  type: 'mcp' | 'plugin';
  version: string;
  homepage?: string;
  options?: Array<{ flag: string; label: string; default?: string }>;
  install(params: Record<string, string>): Promise<void>;
}

export interface SearchResult {
  name: string;
  description: string;
  version: string;
  source: 'npm' | 'github' | 'curated';
  url: string;
  pkgType: 'mcp' | 'plugin' | 'unknown';
  installHint: string;
}

export interface MarketplacePlugin {
  name: string;
  description: string;
  /** relative path from repo root (e.g. "./skills/engineering/diagnosing-bugs") */
  source: string;
  category?: string;
  version?: string;
}

export interface RegisteredMarketplace {
  /** short slug used in install command: install <name>@<marketplace> */
  name: string;
  /** source specifier: "owner/repo" | git URL | local path | remote URL */
  source: string;
  plugins: MarketplacePlugin[];
}

/** Fetch a remote URL's text content using the global fetch */
async function fetchRemoteText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

/** Parse owner/repo shorthand into GitHub raw base URL */
function ghRawBase(owner: string, repo: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/main`;
}

/** Fetch marketplace.json from a GitHub repo (.claude-plugin/marketplace.json) */
async function fetchMarketplaceFromRepo(source: string): Promise<RegisteredMarketplace | null> {
  // Support owner/repo shorthand
  const match = source.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/);
  if (!match) return null; // only owner/repo format for now
  const [, owner, repo] = match;
  const rawBase = ghRawBase(owner, repo);
  const jsonText = await fetchRemoteText(`${rawBase}/.claude-plugin/marketplace.json`);
  if (!jsonText) return null;
  try {
    const data = JSON.parse(jsonText) as {
      name?: string;
      plugins?: Array<{
        name: string;
        description: string;
        source: string;
        category?: string;
        version?: string;
      }>;
    };
    if (!data.name || !data.plugins) return null;
    return {
      name: data.name,
      source,
      plugins: data.plugins.map(p => ({
        name: p.name,
        description: p.description || 'Claude Code plugin',
        source: p.source,
        category: p.category,
        version: p.version || '1.0.0',
      })),
    };
  } catch { return null; }
}

const CATALOG: Record<string, PackageInfo> = {
  // ═══════════════════════════════════════════
  // MCP Servers
  // ═══════════════════════════════════════════
  filesystem: {
    name: 'filesystem',
    description: 'Advanced filesystem operations (batch read, search, watch)',
    longDescription: 'Provides advanced filesystem access: recursive file search, glob matching, file watching, and batch read/write operations.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    options: [
      { flag: '--dir', label: 'Allowed directory (default: current working dir)', default: process.cwd() },
    ],
    async install(params) {
      const allowedDir = params.dir || process.cwd();
      const config = new ConfigManager();
      config.addMcpServer('filesystem', {
        command: 'npx',
        args: ['-y', '@anthropic/mcp-server-filesystem', allowedDir],
        autoStart: true,
      });
    },
  },
  github: {
    name: 'github',
    description: 'GitHub API integration (PR, Issues, Repos, Search)',
    longDescription: 'Full GitHub API integration: create/manage pull requests, issues, repositories, search code, manage workflows, and more.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    options: [
      { flag: '--token', label: 'GitHub Personal Access Token (or set GITHUB_TOKEN env var)' },
    ],
    async install(params) {
      const config = new ConfigManager();
      const env: Record<string, string> = {};
      if (params.token) env.GITHUB_TOKEN = params.token;
      config.addMcpServer('github', {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env,
        autoStart: true,
      });
    },
  },
  puppeteer: {
    name: 'puppeteer',
    description: 'Browser automation (screenshot, scrape, interact)',
    longDescription: 'Headless Chrome browser automation: take screenshots, scrape dynamic content, fill forms, generate PDFs from web pages.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    async install() {
      const config = new ConfigManager();
      config.addMcpServer('puppeteer', {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
        autoStart: true,
      });
    },
  },
  'sequential-thinking': {
    name: 'sequential-thinking',
    description: 'Structured multi-step reasoning and problem solving',
    longDescription: 'Enables structured thinking through sequential reasoning steps. Useful for complex problem decomposition, multi-step analysis, and systematic exploration.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequential-thinking',
    async install() {
      const config = new ConfigManager();
      config.addMcpServer('sequential-thinking', {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        autoStart: true,
      });
    },
  },
  sqlite: {
    name: 'sqlite',
    description: 'SQLite database querying and management',
    longDescription: 'Query, create, and manage SQLite databases directly. Supports DDL, DML, transactions, and schema inspection.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    options: [
      { flag: '--db', label: 'Database file path (default: ~/.nexus/native/data/default.db)', default: join(DATA_DIR, 'default.db') },
    ],
    async install(params) {
      mkdirSync(DATA_DIR, { recursive: true });
      const dbPath = params.db || join(DATA_DIR, 'default.db');
      const config = new ConfigManager();
      config.addMcpServer('sqlite', {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite', dbPath],
        autoStart: true,
      });
    },
  },
  memory: {
    name: 'memory',
    description: 'Knowledge graph memory with entities and relations',
    longDescription: 'Persistent knowledge graph memory: store and retrieve entities, relations, and observations across sessions. Enables long-term context retention.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    async install() {
      const config = new ConfigManager();
      config.addMcpServer('memory', {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory', '--file', join(DATA_DIR, 'memory.json')],
        autoStart: true,
      });
    },
  },

  // ═══════════════════════════════════════════
  // Language Server Protocol (LSP) Packages
  // Each installs its own MCP wrapper + language server via npm
  // ═══════════════════════════════════════════
  pyright: {
    name: 'pyright',
    description: 'Python LSP — diagnostics, hover, format (Microsoft Pyright)',
    longDescription: 'Python language server powered by Microsoft Pyright. Provides type checking, diagnostics, hover information, and code formatting. Auto-installed via npm.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/microsoft/pyright',
    async install() {
      const dir = join(NATIVE_DIR, 'pyright');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'nexus-pyright-server',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.29.0',
          'pyright': '^1.1.396',
        },
      }, null, 2), 'utf-8');
      writeFileSync(join(dir, 'server.mjs'), genLspServerScript({
        serverName: 'nexus-pyright-server',
        serverVersion: '1.0.0',
        toolPrefix: 'pyright',
        binary: 'pyright-langserver',
        binaryArgs: ['--stdio'],
        langId: 'python',
        languageLabel: 'Python',
      }), 'utf-8');
      try { execSync('npm install --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 120000 }); }
      catch (err) { throw new Error(`npm install failed: ${err instanceof Error ? err.message : String(err)}`); }
      new ConfigManager().addMcpServer('pyright', { command: 'node', args: [join(dir, 'server.mjs')], autoStart: true });
    },
  },
  'typescript-language-server': {
    name: 'typescript-language-server',
    description: 'TypeScript/JavaScript LSP — diagnostics, hover, format',
    longDescription: 'TypeScript/JavaScript language server. Provides type checking, diagnostics, hover info, and code formatting. Auto-installed via npm.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/typescript-language-server/typescript-language-server',
    async install() {
      const dir = join(NATIVE_DIR, 'ts-server');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'nexus-ts-server',
        version: '1.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@modelcontextprotocol/sdk': '^1.29.0',
          'typescript': '^5.6.0',
          'typescript-language-server': '^5.0.0',
        },
      }, null, 2), 'utf-8');
      writeFileSync(join(dir, 'server.mjs'), genLspServerScript({
        serverName: 'nexus-ts-server',
        serverVersion: '1.0.0',
        toolPrefix: 'ts',
        binary: 'typescript-language-server',
        binaryArgs: ['--stdio'],
        langId: 'typescript',
        languageLabel: 'TypeScript/JavaScript',
      }), 'utf-8');
      try { execSync('npm install --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 120000 }); }
      catch (err) { throw new Error(`npm install failed: ${err instanceof Error ? err.message : String(err)}`); }
      new ConfigManager().addMcpServer('ts-server', { command: 'node', args: [join(dir, 'server.mjs')], autoStart: true });
    },
  },

  // ═══════════════════════════════════════════
  // Plugins (SKILL.md-based skills)
  // ═══════════════════════════════════════════
  'code-review': {
    name: 'code-review',
    description: 'Automated code review with diff analysis and best practices',
    longDescription: 'Reviews code changes by analyzing diffs, checking for common issues, security vulnerabilities, style violations, and suggesting improvements.',
    type: 'plugin',
    version: '1.0.0',
    async install() {
      mkdirSync(join(PLUGIN_DIR, 'code-review'), { recursive: true });
      writeFileSync(join(PLUGIN_DIR, 'code-review', 'SKILL.md'), SKILL_CODE_REVIEW, 'utf-8');
    },
  },
  'git-flow': {
    name: 'git-flow',
    description: 'Streamlined Git workflow: commit, branch, merge, rebase',
    longDescription: 'Guides through Git best practices: semantic commits, branching strategies, interactive rebase, conflict resolution, and changelog generation.',
    type: 'plugin',
    version: '1.0.0',
    async install() {
      mkdirSync(join(PLUGIN_DIR, 'git-flow'), { recursive: true });
      writeFileSync(join(PLUGIN_DIR, 'git-flow', 'SKILL.md'), SKILL_GIT_FLOW, 'utf-8');
    },
  },
  'test-runner': {
    name: 'test-runner',
    description: 'Auto-discover and run tests with coverage reporting',
    longDescription: 'Automatically discovers test files in the project, runs them with the appropriate framework, and reports results with coverage summaries.',
    type: 'plugin',
    version: '1.0.0',
    async install() {
      mkdirSync(join(PLUGIN_DIR, 'test-runner'), { recursive: true });
      writeFileSync(join(PLUGIN_DIR, 'test-runner', 'SKILL.md'), SKILL_TEST_RUNNER, 'utf-8');
    },
  },
  'deploy-check': {
    name: 'deploy-check',
    description: 'Pre-deployment checklist: lint, test, build, security audit',
    longDescription: 'Runs a comprehensive pre-deployment verification checklist: linting, type checking, tests, build verification, dependency audit, and security scan.',
    type: 'plugin',
    version: '1.0.0',
    async install() {
      mkdirSync(join(PLUGIN_DIR, 'deploy-check'), { recursive: true });
      writeFileSync(join(PLUGIN_DIR, 'deploy-check', 'SKILL.md'), SKILL_DEPLOY_CHECK, 'utf-8');
    },
  },

};

/** Known plugin repositories to enumerate individual plugins from */
const KNOWN_PLUGIN_REPOS = [
  {
    owner: 'anthropics',
    repo: 'claude-plugins-official',
    skillsPath: 'skills',
    label: 'Claude Code Official Plugins',
    matchTerms: ['claude', 'anthropic', 'plugins'],
  },
  {
    owner: 'modelcontextprotocol',
    repo: 'servers',
    skillsPath: 'src',
    label: 'Official MCP Servers',
    matchTerms: ['mcp', 'modelcontextprotocol', 'server'],
  },
] as const;

/** Built-in curated packages for search fallback */
const CURATED_PACKAGES: SearchResult[] = [
  { name: 'filesystem', description: 'Advanced filesystem operations (batch read, search, watch)', version: '1.0.0', source: 'curated', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem', pkgType: 'mcp', installHint: 'nexus config native install filesystem' },
  { name: 'github', description: 'GitHub API integration (PR, Issues, Repos, Search)', version: '1.0.0', source: 'curated', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github', pkgType: 'mcp', installHint: 'nexus config native install github --token <pat>' },
  { name: 'puppeteer', description: 'Browser automation (screenshot, scrape, interact)', version: '1.0.0', source: 'curated', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer', pkgType: 'mcp', installHint: 'nexus config native install puppeteer' },
  { name: 'sequential-thinking', description: 'Structured multi-step reasoning', version: '1.0.0', source: 'curated', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequential-thinking', pkgType: 'mcp', installHint: 'nexus config native install sequential-thinking' },
  { name: 'sqlite', description: 'SQLite database querying and management', version: '1.0.0', source: 'curated', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite', pkgType: 'mcp', installHint: 'nexus config native install sqlite --db <path>' },
  { name: 'memory', description: 'Knowledge graph memory with entities and relations', version: '1.0.0', source: 'curated', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory', pkgType: 'mcp', installHint: 'nexus config native install memory' },
  { name: 'pyright', description: 'Python LSP — diagnostics, hover, format (Microsoft Pyright)', version: '1.0.0', source: 'curated', url: 'https://github.com/microsoft/pyright', pkgType: 'mcp', installHint: 'nexus config native install pyright' },
  { name: 'typescript-language-server', description: 'TypeScript/JavaScript LSP — diagnostics, hover, format', version: '1.0.0', source: 'curated', url: 'https://github.com/typescript-language-server/typescript-language-server', pkgType: 'mcp', installHint: 'nexus config native install typescript-language-server' },
  { name: 'code-review', description: 'Automated code review with diff analysis', version: '1.0.0', source: 'curated', url: '', pkgType: 'plugin', installHint: 'nexus config native install code-review' },
  { name: 'git-flow', description: 'Streamlined Git workflow', version: '1.0.0', source: 'curated', url: '', pkgType: 'plugin', installHint: 'nexus config native install git-flow' },
  { name: 'test-runner', description: 'Auto-discover and run tests', version: '1.0.0', source: 'curated', url: '', pkgType: 'plugin', installHint: 'nexus config native install test-runner' },
  { name: 'deploy-check', description: 'Pre-deployment checklist', version: '1.0.0', source: 'curated', url: '', pkgType: 'plugin', installHint: 'nexus config native install deploy-check' },
];

export class NativeManager {
  private config: ConfigManager;

  constructor() {
    this.config = new ConfigManager();
  }

  listAvailable(): PackageInfo[] {
    return Object.values(CATALOG);
  }

  getPackage(name: string): PackageInfo | undefined {
    return CATALOG[name];
  }

  getAvailableNames(): string[] {
    return Object.keys(CATALOG);
  }

  // ── Marketplace management ─────────────────────────────────────────────────

  getMarketplaces(): RegisteredMarketplace[] {
    try { return this.config.get().registeredMarketplaces || []; }
    catch { return []; }
  }

  async marketplaceAdd(source: string): Promise<string> {
    // Check if already registered
    const existing = this.getMarketplaces();
    const shorthand = source.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (existing.some(m => m.source === shorthand || m.source === source)) {
      throw new Error(`Marketplace "${shorthand}" is already registered.`);
    }

    const marketplace = await fetchMarketplaceFromRepo(shorthand);
    if (!marketplace) {
      throw new Error(
        `Could not fetch marketplace from "${shorthand}".\n` +
        `  Ensure the repo exists and has .claude-plugin/marketplace.json at root.`
      );
    }

    existing.push(marketplace);
    this.config.setRegisteredMarketplaces(existing);

    const pluginLines = marketplace.plugins.map(p =>
      `    ${p.name}${p.category ? ' (' + p.category + ')' : ''} — ${p.description.slice(0, 60)}`
    ).join('\n');

    return `Marketplace "${marketplace.name}" registered from ${shorthand}.\n` +
      `  ${marketplace.plugins.length} plugin(s) available:\n${pluginLines}\n\n` +
      `  Install with: nexus config native install <name>@${marketplace.name}`;
  }

  marketplaceList(): RegisteredMarketplace[] {
    return this.getMarketplaces();
  }

  marketplaceRemove(name: string): string {
    const list = this.getMarketplaces();
    const idx = list.findIndex(m => m.name === name);
    if (idx === -1) {
      throw new Error(`Marketplace "${name}" not found. Registered: ${list.map(m => m.name).join(', ') || '(none)'}`);
    }
    const removed = list.splice(idx, 1)[0]!;
    this.config.setRegisteredMarketplaces(list);
    return `Marketplace "${removed.name}" (${removed.source}) removed.`;
  }

  async marketplaceUpdate(name: string): Promise<string> {
    const list = this.getMarketplaces();
    const existing = list.find(m => m.name === name);
    if (!existing) {
      throw new Error(`Marketplace "${name}" not found. Registered: ${list.map(m => m.name).join(', ') || '(none)'}`);
    }

    const marketplace = await fetchMarketplaceFromRepo(existing.source);
    if (!marketplace) {
      throw new Error(`Failed to re-fetch marketplace "${name}" from ${existing.source}.`);
    }

    existing.plugins = marketplace.plugins;
    this.config.setRegisteredMarketplaces(list);

    return `Marketplace "${name}" updated — ${marketplace.plugins.length} plugin(s) available.`;
  }

  /** Get all available plugins from registered marketplaces */
  getMarketplacePlugins(): Array<{ name: string; description: string; marketplace: string; category?: string }> {
    const results: Array<{ name: string; description: string; marketplace: string; category?: string }> = [];
    for (const mp of this.getMarketplaces()) {
      for (const p of mp.plugins) {
        results.push({ name: p.name, description: p.description, marketplace: mp.name, category: p.category });
      }
    }
    return results;
  }

  /** Install a plugin from a registered marketplace */
  private async installFromMarketplace(pluginName: string, mpName: string): Promise<string> {
    const marketplaces = this.getMarketplaces();
    const mp = marketplaces.find(m => m.name === mpName);
    if (!mp) {
      throw new Error(`Marketplace "${mpName}" not found. Run \`nexus config native marketplace add <repo>\` first.`);
    }

    const plugin = mp.plugins.find(p => p.name === pluginName);
    if (!plugin) {
      // Not found in explicit list — try to fetch as a sub-skill from the repo
      // (common pattern: marketplace exposes one meta-plugin, real skills are under skills/)
      const ghMatch2 = mp.source.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/);
      if (ghMatch2) {
        const [, o2, r2] = ghMatch2;
        // Try common patterns: skills/<name>/SKILL.md, skills/<category>/<name>/SKILL.md
        const skillBody = await fetchRemoteText(`${ghRawBase(o2, r2)}/skills/${pluginName}/SKILL.md`);
        if (skillBody) {
          const dir = join(PLUGIN_DIR, pluginName);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'SKILL.md'), skillBody, 'utf-8');
          this.trackInstalled(pluginName);
          return `Plugin "${pluginName}@${mpName}" installed.\n  Source: ${mp.source}/skills/${pluginName}\n  Fetched: SKILL.md\n  Restart the agent to activate.`;
        }
        // Try skills/<category>/<pluginName>/SKILL.md by listing categories
        const treeRes = await fetch(
          `https://api.github.com/repos/${o2}/${r2}/git/trees/main?recursive=1`,
          { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'nexus-coder' }, signal: AbortSignal.timeout(8000) }
        );
        if (treeRes.ok) {
          const tree = await treeRes.json() as { tree: Array<{ path: string }> };
          const matchPath = tree.tree.find((t: { path: string }) =>
            new RegExp(`^skills/[^/]+/${pluginName}/SKILL\\.md$`, 'i').test(t.path)
          );
          if (matchPath) {
            const body = await fetchRemoteText(`${ghRawBase(o2, r2)}/${matchPath.path}`);
            if (body) {
              const dir = join(PLUGIN_DIR, pluginName);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
              this.trackInstalled(pluginName);
              return `Plugin "${pluginName}@${mpName}" installed.\n  Source: ${mp.source}/${matchPath.path}\n  Fetched: SKILL.md\n  Restart the agent to activate.`;
            }
          }
        }
      }
      const available = mp.plugins.map(p => p.name).join(', ');
      throw new Error(`Plugin "${pluginName}" not found in marketplace "${mpName}". Available: ${available}`);
    }

    // Resolve the plugin source path to raw GitHub URLs
    const ghMatch = mp.source.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/);
    if (!ghMatch) {
      throw new Error(`Marketplace source "${mp.source}" is not a GitHub repo. Only GitHub repos are supported for install.`);
    }
    const [, owner, repo] = ghMatch;
    const rawBase = ghRawBase(owner, repo);
    const srcBase = plugin.source.replace(/^\.\//, ''); // strip leading ./

    // Fetch SKILL.md at plugin source root
    const rootSkUrl = `${rawBase}/${srcBase}/SKILL.md`;
    const rootBody = await fetchRemoteText(rootSkUrl);

    if (rootBody) {
      // Plugin has its own SKILL.md — install as single plugin
      const dir = join(PLUGIN_DIR, pluginName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), rootBody, 'utf-8');
      this.trackInstalled(pluginName);
      return `Plugin "${pluginName}@${mpName}" installed.\n  Source: ${mp.source}/${srcBase}\n  Fetched: SKILL.md\n  Restart the agent to activate.`;
    }

    // No root SKILL.md — use Git Trees API to list all files recursively in one call
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
    const treeRes = await fetch(treeUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'nexus-coder' },
      signal: AbortSignal.timeout(10000),
    });

    if (!treeRes.ok) {
      const dir = join(PLUGIN_DIR, pluginName);
      mkdirSync(dir, { recursive: true });
      this.trackInstalled(pluginName);
      return `Plugin "${pluginName}@${mpName}" registered (no SKILL.md found).\n  Source: ${mp.source}\n  Restart the agent to activate.`;
    }

    const tree = await treeRes.json() as { tree: Array<{ path: string; type: string }> };
    const skPaths = tree.tree.filter(t =>
      t.type === 'blob' &&
      /^skills\/[^/]+\/[^/]+\/SKILL\.md$/i.test(t.path)
    );

    if (skPaths.length === 0) {
      const dir = join(PLUGIN_DIR, pluginName);
      mkdirSync(dir, { recursive: true });
      this.trackInstalled(pluginName);
      return `Plugin "${pluginName}@${mpName}" installed (no skills found).\n  Source: ${mp.source}`;
    }

    // Fetch all SKILL.md files in parallel
    const results = await Promise.allSettled(skPaths.map(async (entry) => {
      const body = await fetchRemoteText(`${rawBase}/${entry.path}`);
      if (!body) return null;
      const parts = entry.path.split('/');
      const skillName = parts[parts.length - 2]!; // .../<skill-name>/SKILL.md
      const category = parts[parts.length - 3]!; // skills/<category>/
      const skillDir = join(PLUGIN_DIR, skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf-8');
      // Fetch extra files in parallel
      const extras = ['tests.md', 'GLOSSARY.md', 'DEEPENING.md', 'DESIGN-IT-TWICE.md', 'CONTEXT-FORMAT.md', 'ADR-FORMAT.md'];
      await Promise.allSettled(extras.map(async (extra) => {
        const prefix = entry.path.replace(/\/SKILL\.md$/i, '');
        const content = await fetchRemoteText(`${rawBase}/${prefix}/${extra}`);
        if (content) writeFileSync(join(skillDir, extra), content, 'utf-8');
      }));
      this.trackInstalled(skillName);
      return skillName;
    }));

    const installedSkills: string[] = [];
    let failedCount = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value !== null) installedSkills.push(r.value);
      else failedCount++;
    }

    return `Plugin "${pluginName}@${mpName}" installed.\n` +
      `  Source: ${mp.source}\n` +
      `  Unpacked ${installedSkills.length} skill(s)` + (failedCount > 0 ? ` (${failedCount} failed)` : '') + ` into ~/.nexus/native/plugins/\n` +
      `  Restart the agent to activate.`;
  }

  /** Record installation in config, deduplicated */
  private trackInstalled(name: string): void {
    const installed = this.getInstalledList();
    if (!installed.includes(name)) {
      installed.push(name);
      this.saveInstalledList(installed);
    }
  }

  async install(name: string, params?: Record<string, string>): Promise<string> {
    // Support <name>@<marketplace> syntax for marketplace plugins
    const atIdx = name.lastIndexOf('@');
    if (atIdx > 0 && atIdx < name.length - 1) {
      const pluginName = name.slice(0, atIdx);
      const mpName = name.slice(atIdx + 1);
      return this.installFromMarketplace(pluginName, mpName);
    }

    const pkg = CATALOG[name];
    if (!pkg) {
      throw new Error(
        `Package "${name}" not found. Available: ${this.getAvailableNames().join(', ')}`
      );
    }
    if (this.isInstalled(name)) {
      throw new Error(`Package "${name}" is already installed. Use \`nexus config native list\` to see installed packages.`);
    }

    mkdirSync(NATIVE_DIR, { recursive: true });

    await pkg.install(params || {});

    // Record installation in config's nativeInstalled tracker
    const installed = this.getInstalledList();
    installed.push(name);
    this.saveInstalledList(installed);

    const label = pkg.type === 'mcp' ? 'MCP Server' : 'Plugin';

    // Verify the MCP server was actually added to config
    const cfg = this.config.get();
    const mcpAdded = pkg.type === 'mcp' && cfg.mcpServers?.[name];

    return `${label} "${name}" installed.\n` +
      (mcpAdded ? `  Config: ~/.nexus/config.json → mcpServers.${name}\n` : '') +
      `  Restart the agent to activate.`;
  }

  async installAll(): Promise<string[]> {
    const results: string[] = [];
    for (const pkg of this.listAvailable()) {
      try {
        if (!this.isInstalled(pkg.name)) {
          await this.install(pkg.name);
          results.push(`✓ ${pkg.name}`);
        } else {
          results.push(`  ${pkg.name} (already installed)`);
        }
      } catch (err) {
        results.push(`✗ ${pkg.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return results;
  }

  listInstalled(): PackageInfo[] {
    const names = this.getInstalledList();
    return names.map(n => CATALOG[n]).filter(Boolean);
  }

  isInstalled(name: string): boolean {
    return this.getInstalledList().includes(name);
  }

  /**
   * Search for MCP tools and plugins from:
   *   1. npm registry (mcp-server-* packages)
   *   2. GitHub (mcp-server repositories)
   *   3. Known plugin repos — enumerate individual plugins (Claude Code, MCP Servers, etc.)
   *   4. Built-in curated list (fallback)
   */
  async search(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const errors: string[] = [];

    // 1. Search npm registry
    try {
      const npmResults = await this.searchNpm(query);
      results.push(...npmResults);
    } catch (err) {
      errors.push(`npm: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Search GitHub
    try {
      const ghResults = await this.searchGitHub(query);
      results.push(...ghResults);
    } catch (err) {
      errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Known plugin repos — enumerate individual plugins
    try {
      const repoResults = await this.searchPluginRepos(query);
      results.push(...repoResults);
    } catch (err) {
      errors.push(`plugins: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Registered marketplaces — match marketplace plugins against query
    {
      const lower = query.toLowerCase();
      for (const mp of this.getMarketplaces()) {
        for (const p of mp.plugins) {
          if (p.name.includes(lower) || p.description.toLowerCase().includes(lower)) {
            results.push({
              name: p.name,
              description: p.description.slice(0, 120),
              version: p.version || '1.0.0',
              source: 'curated',
              url: `https://github.com/${mp.source}/tree/main/${p.source.replace(/^\.\//, '')}`,
              pkgType: 'plugin',
              installHint: `nexus config native install ${p.name}@${mp.name}`,
            });
          }
        }
      }
    }

    // 5. Curated fallback — only if no external results found
    if (results.length === 0) {
      const lower = query.toLowerCase();
      for (const pkg of CURATED_PACKAGES) {
        if (pkg.name.includes(lower) || pkg.description.toLowerCase().includes(lower)) {
          results.push(pkg);
        }
      }
    }

    return results;
  }

  private async searchNpm(query: string): Promise<SearchResult[]> {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent('mcp-server ' + query)}&size=15`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);

    const data = await res.json() as {
      objects: Array<{
        package: {
          name: string;
          description: string;
          version: string;
          links: { npm: string; homepage?: string };
          keywords?: string[];
        };
      }>;
    };

    return data.objects.map(o => {
      const isPlugin = o.package.keywords?.some(k =>
        /skill|plugin/i.test(k)
      );
      return {
        name: o.package.name,
        description: (o.package.description || '(no description)').slice(0, 120),
        version: o.package.version,
        source: 'npm' as const,
        url: o.package.links.npm,
        pkgType: isPlugin ? 'plugin' as const : 'mcp' as const,
        installHint: `npm: npx -y ${o.package.name}`,
      };
    });
  }

  private async searchGitHub(query: string): Promise<SearchResult[]> {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query + ' mcp-server')}&sort=stars&per_page=10`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'nexus-coder' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

    const data = await res.json() as {
      items: Array<{
        full_name: string;
        description: string;
        stargazers_count: number;
        html_url: string;
        homepage: string;
        topics?: string[];
      }>;
    };

    return data.items.map(item => {
      const isPlugin = item.topics?.some(t => /skill|plugin/i.test(t));
      return {
        name: item.full_name,
        description: (item.description || '(no description)').slice(0, 120),
        version: `★ ${item.stargazers_count}`,
        source: 'github' as const,
        url: item.html_url,
        pkgType: isPlugin ? 'plugin' as const : 'mcp' as const,
        installHint: item.homepage || item.html_url,
      };
    });
  }

  /**
   * Search known plugin repositories and enumerate individual plugins.
   * Only fetches repos whose label/name matches the query (e.g. "claude" → Claude Plugins)..
   * For each matching repo, fetches the directory listing and parses SKILL.md frontmatter.
   */
  private async searchPluginRepos(query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const lower = query.toLowerCase();

    for (const repo of KNOWN_PLUGIN_REPOS) {
      const matches = repo.matchTerms.some(t => lower.includes(t) || t.includes(lower))
        || repo.label.toLowerCase().includes(lower)
        || repo.repo.includes(lower);
      if (!matches) continue;

      try {
        const plugins = await this.fetchRepoPlugins(repo);
        results.push(...plugins);
      } catch {
        // Skip repos that fail to fetch
      }
    }

    return results;
  }

  /**
   * Fetch individual plugin/skill entries from a known GitHub repository.
   * 1. Lists the repo contents at the skills path
   * 2. Filters to directories only
   * 3. Fetches SKILL.md for each directory and parses frontmatter
   */
  private async fetchRepoPlugins(repo: typeof KNOWN_PLUGIN_REPOS[number]): Promise<SearchResult[]> {
    const listUrl = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${repo.skillsPath}`;
    const listRes = await fetch(listUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'nexus-coder' },
      signal: AbortSignal.timeout(8000),
    });
    if (!listRes.ok) throw new Error(`${repo.repo}: HTTP ${listRes.status}`);

    const items = await listRes.json() as Array<{ name: string; path: string; type: string }>;
    const dirs = items.filter(i => i.type === 'dir').slice(0, 30);
    if (dirs.length === 0) return [];

    const rawBase = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main`;

    const pluginPromises = dirs.map(async (dir): Promise<SearchResult | null> => {
      try {
        const rawRes = await fetch(`${rawBase}/${dir.path}/SKILL.md`, { signal: AbortSignal.timeout(5000) });
        if (rawRes.ok) {
          const content = await rawRes.text();
          const meta = parseSimpleFrontmatter(content);
          const pluginName = meta.name || dir.name;
          const description = meta.description || `Claude Code plugin: ${dir.name}`;
          return {
            name: pluginName,
            description: description.slice(0, 120),
            version: meta.version || '1.0.0',
            source: 'github',
            url: `https://github.com/${repo.owner}/${repo.repo}/tree/main/${dir.path}`,
            pkgType: 'plugin',
            installHint: `Copy to ~/.nexus/skills/${dir.name}/ or use: git clone https://github.com/${repo.owner}/${repo.repo}.git`,
          };
        }
        // No SKILL.md — still list the directory as a candidate
        if (rawRes.status === 404) {
          return {
            name: dir.name,
            description: `${repo.label} entry (no SKILL.md found)`,
            version: '-',
            source: 'github',
            url: `https://github.com/${repo.owner}/${repo.repo}/tree/main/${dir.path}`,
            pkgType: 'plugin',
            installHint: `Explore at: https://github.com/${repo.owner}/${repo.repo}/tree/main/${dir.path}`,
          };
        }
      } catch {
        // Timeout or network error — skip this plugin
      }
      return null;
    });

    const plugins = await Promise.all(pluginPromises);
    return plugins.filter((p): p is SearchResult => p !== null);
  }

  /**
   * Install an npm package as an MCP server.
   * Adds a config entry: npx -y <package-name>
   */
  async installFromNpm(pkgName: string, params?: Record<string, string>): Promise<string> {
    // Only allow plain package-name specifiers. Reject anything that could run
    // an install script or point at an arbitrary URL/tarball (supply-chain RCE).
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkgName) || /[&|;`$()<>]/.test(pkgName)) {
      throw new Error(`Refusing to install "${pkgName}": only simple package names are allowed (no URLs, tarballs, tags, or shell metacharacters).`);
    }
    // Validate via npm registry — check if package exists
    try {
      const checkUrl = `https://registry.npmjs.org/${encodeURIComponent(pkgName).replace(/%2F/g, '/')}/latest`;
      const checkRes = await fetch(checkUrl, { signal: AbortSignal.timeout(8000) });
      if (!checkRes.ok) {
        throw new Error(`npm registry: package "${pkgName}" not found (HTTP ${checkRes.status}).`);
      }
      const pkgMeta = await checkRes.json() as { description?: string; name?: string; deprecated?: string | boolean };
      const desc = (pkgMeta.description || '').toLowerCase();
      const isLikelyMcp = desc.includes('mcp') || desc.includes('model context protocol') || desc.includes('language server');
      const realName = pkgMeta.name || pkgName;

      if (pkgMeta.deprecated) {
        throw new Error(`Refusing to install "${pkgName}": the package is deprecated on npm.`);
      }

      if (!isLikelyMcp) {
        // Warn but still allow install (user knows what they're doing)
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) throw err;
      // Network error — continue anyway (offline mode)
    }

    const config = new ConfigManager();
    const safeName = pkgName.replace(/^@/, '').replace(/[/|]/g, '-').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
    const serverName = safeName || 'npm-package';

    const env: Record<string, string> = {};
    if (params?.token) env.TOKEN = params.token;

    config.addMcpServer(serverName, {
      command: 'npx',
      args: ['-y', pkgName],
      env,
      autoStart: true,
    });

    const installed = this.getInstalledList();
    installed.push(`npm:${pkgName}`);
    this.saveInstalledList(installed);

    return `Installed MCP Server "${pkgName}" from npm marketplace.\n` +
           `  Config: ~/.nexus/config.json → mcpServers.${serverName}\n` +
           `  Command: npx -y ${pkgName}\n` +
           `  Restart the agent to activate.`;
  }

  /**
   * Install a GitHub repo as an MCP server.
   * Clones the repo to ~/.nexus/native/mcp/<name>/, detects entry point, adds config.
   */
  async installFromGitHub(repo: string, params?: Record<string, string>): Promise<string> {
    const parts = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
    if (parts.length < 2) {
      throw new Error('Invalid GitHub repo format. Use: owner/repo');
    }
    const owner = parts[0]!;
    const repoName = parts[parts.length - 1]!;
    // Reject shell metacharacters / traversal that could break the git clone
    // command or escape to arbitrary code execution.
    if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repoName) || /[&|;`$()<>'"\\]/.test(repo)) {
      throw new Error(`Refusing to install "${repo}": only simple owner/repo names are allowed.`);
    }
    const targetDir = join(MCP_DIR, repoName);

    if (existsSync(targetDir) && existsSync(join(targetDir, '.git'))) {
      // Already cloned — pull latest
      execSync(`git -C "${targetDir}" pull --ff-only`, { stdio: 'pipe', timeout: 60000 });
    } else {
      mkdirSync(MCP_DIR, { recursive: true });
      if (existsSync(targetDir)) {
        throw new Error(`Directory already exists: ${targetDir}. Remove it first or use a different name.`);
      }
      try {
        execSync(`git clone "https://github.com/${parts[0]}/${parts[1]}.git" "${targetDir}"`, {
          stdio: 'pipe',
          timeout: 120000,
        });
      } catch (err) {
        throw new Error(`Failed to clone ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Install dependencies. Use --ignore-scripts so a malicious/compromised
    // repo cannot run arbitrary code via postinstall/preinstall hooks.
    if (existsSync(join(targetDir, 'package.json'))) {
      try {
        execSync('npm install --ignore-scripts --loglevel=error', { cwd: targetDir, stdio: 'pipe', timeout: 120000 });
      } catch (err) {
        // Non-fatal — the server might still work
      }
    }

    // Detect entry point
    const entryPoint = detectMcpEntryPoint(targetDir);
    if (!entryPoint) {
      throw new Error(
        `Could not detect entry point for ${repoName}.\n` +
        `  Cloned to: ${targetDir}\n` +
        `  Manually add the MCP server config in ~/.nexus/config.json`
      );
    }

    const config = new ConfigManager();
    const env: Record<string, string> = {};
    if (params?.token) env.GITHUB_TOKEN = params.token;

    config.addMcpServer(repoName, {
      command: 'node',
      args: [entryPoint],
      env,
      autoStart: true,
    });

    const installed = this.getInstalledList();
    installed.push(`gh:${parts[0]}/${parts[1]}`);
    this.saveInstalledList(installed);

    return `Installed MCP Server "${repoName}" from GitHub.\n` +
           `  Clone path: ${targetDir}\n` +
           `  Config: ~/.nexus/config.json → mcpServers.${repoName}\n` +
           `  Entry: node ${entryPoint}\n` +
           `  Restart the agent to activate.`;
  }

  private getInstalledList(): string[] {
    try {
      return this.config.get().nativeInstalled || [];
    } catch {
      return [];
    }
  }

  private saveInstalledList(list: string[]): void {
    this.config.setNativeInstalled([...new Set(list)]);
  }
}

/** Detect MCP server entry point in a cloned repo directory */
function detectMcpEntryPoint(dir: string): string | null {
  // 1. Check package.json for bin or main
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.bin) {
        const binPath = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0] as string;
        if (binPath && existsSync(join(dir, binPath))) return join(dir, binPath);
      }
      if (pkg.main && existsSync(join(dir, pkg.main))) return join(dir, pkg.main);
    } catch { /* ignore parse errors */ }
  }

  // 2. Check common entry point filenames
  const candidates = [
    'server.mjs', 'server.js', 'index.mjs', 'index.js',
    'dist/server.mjs', 'dist/server.js',
    'dist/index.mjs', 'dist/index.js',
    'src/server.mjs', 'src/server.js',
    'src/index.mjs', 'src/index.js',
    'build/server.mjs', 'build/server.js',
  ];
  for (const c of candidates) {
    if (existsSync(join(dir, c))) return join(dir, c);
  }

  // 3. Heuristic: find the first .mjs or .js that imports MCP SDK
  try {
    const files = [readFileSync];
    const entries = readdirSync(dir);
    for (const e of entries) {
      if (/\.(mjs|js)$/i.test(e)) {
        const content = readFileSync(join(dir, e), 'utf-8').slice(0, 2000);
        if (content.includes('Server(') && content.includes('callTool')) {
          return join(dir, e);
        }
      }
    }
  } catch { /* ignore */ }

  return null;
}

/** Minimal frontmatter parser for SKILL.md files */
function parseSimpleFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return meta;
}

// ══════════════════════════════════════════════════════════
// genLspServerScript — generates a single-language MCP server script
// Each language server gets its own script for independent install
// ══════════════════════════════════════════════════════════

interface LspServerOpts {
  serverName: string;
  serverVersion: string;
  toolPrefix: string;       // e.g. "pyright" → tools named pyright_status, pyright_diagnostics, etc.
  binary: string;           // e.g. "pyright-langserver", "typescript-language-server"
  binaryArgs: string[];     // e.g. ["--stdio"]
  langId: string;           // e.g. "python", "typescript"
  languageLabel: string;    // e.g. "Python", "TypeScript/JavaScript"
}

function genLspServerScript(opts: LspServerOpts): string {
  const { toolPrefix, binary, binaryArgs, langId, languageLabel } = opts;
  const prefix = toolPrefix;
  const sn = JSON.stringify(opts.serverName);
  const sv = JSON.stringify(opts.serverVersion);
  const binJson = JSON.stringify(binary);
  const argsJson = JSON.stringify(binaryArgs);
  const langIdJson = JSON.stringify(langId);
  const labelJson = JSON.stringify(languageLabel);

  return [
    '#!/usr/bin/env node',
    `import { Server } from "@modelcontextprotocol/sdk/server/index.js";`,
    `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
    `import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";`,
    `import { spawn } from "child_process";`,
    `import { readFileSync, existsSync } from "fs";`,
    `import { join, dirname } from "path";`,
    `import { fileURLToPath } from "url";`,
    ``,
    `const __dirname = dirname(fileURLToPath(import.meta.url));`,
    `const binPath = join(__dirname, "node_modules", ".bin", ${binJson} + (process.platform === "win32" ? ".cmd" : ""));`,
    `const available = existsSync(binPath) ? binPath : null;`,
    ``,
    `console.error("[${prefix}] " + (available ? "ready: " + binPath : "NOT available"));`,
    ``,
    `const TOOLS = [`,
    `  { name: "${prefix}_status", description: "MUST CALL FIRST. Shows ${labelJson} language server status. Do NOT use exec_command to search.", inputSchema: { type: "object", properties: {} } },`,
    `  { name: "${prefix}_diagnostics", description: "Get code diagnostics for a file. Call ${prefix}_status first.", inputSchema: { type: "object", properties: { file_path: { type: "string", description: "Absolute path to the file" } }, required: ["file_path"] } },`,
    `  { name: "${prefix}_hover", description: "Get type/hover info at a position. Call ${prefix}_status first.", inputSchema: { type: "object", properties: { file_path: { type: "string", description: "Absolute path to the file" }, line: { type: "number", description: "Zero-based line" }, character: { type: "number", description: "Zero-based character offset" } }, required: ["file_path", "line", "character"] } },`,
    `  { name: "${prefix}_format", description: "Format a file. Call ${prefix}_status first.", inputSchema: { type: "object", properties: { file_path: { type: "string", description: "Absolute path to the file" } }, required: ["file_path"] } },`,
    `];`,
    ``,
    `function encodeMsg(obj) { const body = JSON.stringify(obj); return "Content-Length: " + Buffer.byteLength(body, "utf-8") + "\\r\\n\\r\\n" + body; }`,
    `function parseMsgs(buf) {`,
    `  const msgs = []; let pos = 0; const s = buf.toString("utf-8");`,
    `  while (pos < s.length) {`,
    `    const hdrEnd = s.indexOf("\\r\\n\\r\\n", pos);`,
    `    if (hdrEnd === -1) break;`,
    `    const hdr = s.slice(pos, hdrEnd);`,
    `    const m = hdr.match(/Content-Length: (\\d+)/);`,
    `    if (!m) break;`,
    `    const len = parseInt(m[1], 10);`,
    `    const bodyStart = hdrEnd + 4;`,
    `    if (bodyStart + len > s.length) break;`,
    `    msgs.push(JSON.parse(s.slice(bodyStart, bodyStart + len)));`,
    `    pos = bodyStart + len;`,
    `  }`,
    `  return { msgs, rest: s.slice(pos) };`,
    `}`,
    `async function lspCall(filePath, action, extra) {`,
    `  if (!available) throw new Error(${binJson} + " not found");`,
    `  if (!existsSync(filePath)) throw new Error("File not found: " + filePath);`,
    `  const content = readFileSync(filePath, "utf-8");`,
    `  const uri = "file://" + filePath.replace(/\\\\/g, "/");`,
    `  return new Promise((resolve, reject) => {`,
    `    const proc = spawn(available, ${argsJson}, { stdio: ["pipe", "pipe", "pipe"] });`,
    `    let buf = ""; let rid = 1; const pending = new Map(); let diags = null;`,
    `    const timer = setTimeout(() => { proc.kill(); reject(new Error("LSP timeout")); }, 15000);`,
    `    proc.stdout.on("data", (chunk) => {`,
    `      buf += chunk.toString("utf-8");`,
    `      const { msgs, rest } = parseMsgs(Buffer.from(buf, "utf-8"));`,
    `      buf = rest;`,
    `      for (const msg of msgs) {`,
    `        if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }`,
    `        if (msg.method === "textDocument/publishDiagnostics") { diags = msg.params.diagnostics; }`,
    `      }`,
    `    });`,
    `    proc.stderr.on("data", () => {});`,
    `    function send(m) { proc.stdin.write(encodeMsg(m)); }`,
    `    function req(method, params) {`,
    `      const id = rid++;`,
    `      return new Promise((r) => { pending.set(id, { resolve: r }); send({ jsonrpc: "2.0", id, method, params }); });`,
    `    }`,
    `    proc.on("error", (e) => { clearTimeout(timer); reject(e); });`,
    `    proc.on("close", () => { clearTimeout(timer); resolve(null); });`,
    `    req("initialize", { processId: null, capabilities: {}, rootUri: null, workspaceFolders: null })`,
    `      .then(() => {`,
    `        send({ jsonrpc: "2.0", method: "initialized", params: {} });`,
    `        send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {`,
    `          textDocument: { uri, languageId: ${langIdJson}, version: 1, text: content },`,
    `        }});`,
    `        return action === "diagnostics"`,
    `          ? new Promise((r) => {`,
    `              let waited = false;`,
    `              const iv = setInterval(() => {`,
    `                if (diags) { clearInterval(iv); clearTimeout(timer); r(diags); }`,
    `                else if (!waited) { waited = true; setTimeout(() => { clearInterval(iv); r([]); }, 2000); }`,
    `              }, 100);`,
    `            })`,
    `          : req(action === "hover" ? "textDocument/hover" : "textDocument/formatting",`,
    `              action === "hover"`,
    `                ? { textDocument: { uri }, position: { line: extra.line, character: extra.character } }`,
    `                : { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });`,
    `      })`,
    `      .then(async (result) => {`,
    `        try { await req("shutdown", null); } catch {}`,
    `        proc.stdin.end();`,
    `        resolve(result);`,
    `      })`,
    `      .catch((e) => { clearTimeout(timer); proc.kill(); reject(e); });`,
    `  });`,
    `}`,
    `const server = new Server({ name: ${sn}, version: ${sv} }, { capabilities: { tools: {} } });`,
    `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));`,
    `server.setRequestHandler(CallToolRequestSchema, async (req) => {`,
    `  const { name, arguments: args } = req.params;`,
    `  try {`,
    `    if (name === "${prefix}_status") {`,
    `      const text = available ? ${labelJson} + " -- ready (" + binPath + ")" : ${labelJson} + " -- NOT installed. Run: npm install";`,
    `      return { content: [{ type: "text", text }] };`,
    `    }`,
    `    const filePath = String(args?.file_path || "");`,
    `    if (name === "${prefix}_diagnostics") {`,
    `      const items = (await lspCall(filePath, "diagnostics", {})) || [];`,
    `      const text = items.length === 0 ? "No diagnostics found." : items.map((d) => {`,
    `        const sev = ["", "Error", "Warning", "Info", "Hint"][d.severity] || "Unknown";`,
    `        const r = d.range;`,
    `        return "[" + sev + "] " + r.start.line + ":" + r.start.character + "-" + r.end.line + ":" + r.end.character + " " + d.message;`,
    `      }).join("\\n");`,
    `      return { content: [{ type: "text", text }] };`,
    `    }`,
    `    if (name === "${prefix}_hover") {`,
    `      const line = Number(args?.line ?? 0);`,
    `      const character = Number(args?.character ?? 0);`,
    `      const result = await lspCall(filePath, "hover", { line, character });`,
    `      if (!result || !result.contents) return { content: [{ type: "text", text: "No hover info." }] };`,
    `      const parts = Array.isArray(result.contents) ? result.contents : [result.contents];`,
    `      const text = parts.map((p) => (typeof p === "string" ? p : p.value || JSON.stringify(p))).join("\\n---\\n");`,
    `      return { content: [{ type: "text", text }] };`,
    `    }`,
    `    if (name === "${prefix}_format") {`,
    `      const result = await lspCall(filePath, "format", {});`,
    `      if (!result || result.length === 0) return { content: [{ type: "text", text: "No formatting changes." }] };`,
    `      return { content: [{ type: "text", text: result[0]?.newText || "(no changes)" }] };`,
    `    }`,
    `    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };`,
    `  } catch (err) {`,
    `    return { content: [{ type: "text", text: "LSP error: " + err.message }], isError: true };`,
    `  }`,
    `});`,
    `const transport = new StdioServerTransport();`,
    `await server.connect(transport);`,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════
// Plugin SKILL.md templates
// ══════════════════════════════════════════════════════════

const SKILL_CODE_REVIEW = `---
name: code-review
version: 1.0.0
description: Automated code review with diff analysis and best practices
---

# Code Review Skill

Analyzes code changes and provides comprehensive review feedback.

## Capabilities

### 1. Review Changes
Analyze a diff or set of files for:
- Code quality issues
- Security vulnerabilities
- Performance concerns
- Style and consistency
- Error handling gaps
- Testing coverage

### 2. Best Practices
Check adherence to:
- SOLID principles
- DRY / KISS / YAGNI
- Language-specific idioms
- Framework conventions
- Security best practices (OWASP)

### 3. Improvement Suggestions
For each issue found, provide:
- Specific file and line number
- Why it's a concern
- Concrete fix suggestion with code example
- Estimated impact (high/medium/low)

## Usage
Call this skill with a task like:
- "Review the changes in this PR"
- "Check this file for security issues"
- "Analyze this code for performance problems"
`;

const SKILL_GIT_FLOW = `---
name: git-flow
version: 1.0.0
description: Streamlined Git workflow: commit, branch, merge, rebase
---

# Git Flow Skill

Guides through Git best practices for everyday development.

## Capabilities

### 1. Smart Commits
- Analyze staged changes and suggest meaningful commit messages (Conventional Commits)
- Help split large changes into logical atomic commits
- Verify commit message formatting

### 2. Branch Management
- Create feature/bugfix/hotfix branches from correct base
- Merge/rebase strategy advice
- Detect stale branches
- Suggest branch naming conventions

### 3. Conflict Resolution
- Identify merge conflict patterns
- Suggest conflict resolution strategies
- Verify resolved conflicts maintain logical consistency

### 4. Changelog Generation
- Generate changelog from commit history
- Categorize changes (feat, fix, docs, refactor, test, chore)
- Prepare release notes

## Usage
Call this skill with a task like:
- "Help me write a commit message for these staged changes"
- "Create a release branch for v2.1.0"
- "Generate a changelog from the last 10 commits"
- "Help me resolve this merge conflict"
`;

const SKILL_TEST_RUNNER = `---
name: test-runner
version: 1.0.0
description: Auto-discover and run tests with coverage reporting
---

# Test Runner Skill

Automatically discovers and runs tests in your project.

## Capabilities

### 1. Test Discovery
- Scan project for test files (*.test.ts, *.spec.js, __tests__/, etc.)
- Identify test framework being used (jest, mocha, vitest, node:test, pytest, etc.)
- List all available test suites

### 2. Run Tests
- Run all tests with appropriate framework command
- Support for watch mode, specific file, or test name pattern
- Generate coverage report

### 3. Analyze Results
- Parse test output for failures
- Summarize pass/fail/skip counts
- Identify flaky tests
- Suggest fixes for failing tests

## Usage
Call this skill with a task like:
- "Run all tests in this project"
- "Find and run tests related to auth module"
- "Check test coverage for the src/ directory"
- "Debug these failing tests"
`;

const SKILL_DEPLOY_CHECK = `---
name: deploy-check
version: 1.0.0
description: Pre-deployment checklist: lint, test, build, security audit
---

# Deploy Check Skill

Runs a comprehensive pre-deployment verification checklist.

## Capabilities

### 1. Code Quality
- Run linter (ESLint, ruff, etc.)
- Check TypeScript/Python/Go types
- Verify no TODO/FIXME/DEBUG left in code

### 2. Testing
- Run full test suite
- Verify minimum coverage threshold (>80%)
- Check integration tests pass

### 3. Build Verification
- Clean build (delete dist/, rebuild)
- Verify bundle size hasn't regressed
- Check for dependency version mismatches

### 4. Security
- Run \`npm audit\` or \`pip audit\` for vulnerable deps
- Check for exposed secrets/API keys in code
- Verify CORS, auth, and rate limiting configs

### 5. Configuration
- Verify environment variables are documented
- Check production configs match staging
- Validate CI/CD pipeline config

## Usage
Call this skill with a task like:
- "Run pre-deploy checks for this project"
- "Verify we're ready to deploy to production"
- "Check for security issues before release"
- "Run the deployment readiness checklist"
`;
