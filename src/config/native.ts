import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'fs';
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
const MARKETPLACES_FILE = join(NATIVE_DIR, 'marketplaces.json');

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

/** On Windows, npx must be wrapped with cmd /c for MCP stdio transport to work */
function mcpNpx(args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'npx', ...args] };
  }
  return { command: 'npx', args };
}

/**
 * Native npm deployment: install the pinned package into ~/.nexus/native/<dir>/
 * and return a direct `node <local entry>` command — no runtime `npx -y` fetch,
 * no supply-chain drift. Mirrors the pyright/ts-server install pattern.
 */
function nativeNpmServer(dirName: string, deps: Record<string, string>, entry: string, extraArgs: string[] = []): { command: string; args: string[] } {
  const dir = join(NATIVE_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `nexus-${dirName}-server`,
    version: '1.0.0',
    private: true,
    dependencies: deps,
  }, null, 2), 'utf-8');
  try {
    execSync('npm install --ignore-scripts --save-exact --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 180000 });
  }
  catch (err) {
    throw new Error(`npm install failed for native server "${dirName}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return { command: 'node', args: [join(dir, ...entry.split('/')), ...extraArgs] };
}

/** GitHub MCP server release asset suffix for the current platform/arch. */
function githubAssetSuffix(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'i386' : 'x86_64';
  if (process.platform === 'win32') return `Windows_${arch}.zip`;
  if (process.platform === 'darwin') return `Darwin_${arch}.tar.gz`;
  return `Linux_${arch}.tar.gz`;
}

/** Download a remote file to a local path. */
async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Extract a .zip (Windows) or .tar.gz (macOS/Linux) archive into destDir. */
function extractArchive(archive: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'pipe', timeout: 120000 }
    );
  } else {
    execSync(`tar -xzf "${archive}" -C "${destDir}"`, { stdio: 'pipe', timeout: 120000 });
  }
}

/** Recursively locate a file by name under a directory (release binaries nest in platform folders). */
function findFileRecursive(dir: string, fileName: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return null;
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
      const { command, args } = mcpNpx(['-y', '@modelcontextprotocol/server-filesystem', allowedDir]);
      config.addMcpServer('filesystem', { command, args, autoStart: true });
    },
  },
  github: {
    name: 'github',
    description: 'GitHub API integration (PR, Issues, Repos, Search)',
    longDescription: 'Full GitHub API integration: create/manage pull requests, issues, repositories, search code, manage workflows, and more. Uses the official github/github-mcp-server binary (read-only toolset when GITHUB_READ_ONLY=1).',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/github/github-mcp-server',
    options: [
      { flag: '--token', label: 'GitHub Personal Access Token (or set GITHUB_PAT env var)' },
    ],
    async install(params) {
      const dir = join(NATIVE_DIR, 'github-mcp-server');
      const exe = join(dir, 'github-mcp-server.exe');
      if (!existsSync(exe)) {
        // Auto-download the official binary from GitHub releases if missing.
        const assetSuffix = githubAssetSuffix();
        process.stderr.write(`[github] resolving latest release (asset: ${assetSuffix})...\n`);
        const relRes = await fetch(
          'https://api.github.com/repos/github/github-mcp-server/releases/latest',
          { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'nexus-coder' }, signal: AbortSignal.timeout(15000) }
        );
        if (!relRes.ok) {
          throw new Error(`Failed to resolve latest github-mcp-server release (HTTP ${relRes.status}). Download manually from https://github.com/github/github-mcp-server/releases and place github-mcp-server.exe at ~/.nexus/native/github-mcp-server/`);
        }
        const rel = await relRes.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
        const asset = rel.assets?.find(a => a.name && a.name.includes(assetSuffix));
        if (!asset?.browser_download_url) {
          throw new Error(`No "${assetSuffix}" asset found for release ${rel.tag_name ?? 'latest'}. Download manually from https://github.com/github/github-mcp-server/releases and place github-mcp-server.exe at ~/.nexus/native/github-mcp-server/`);
        }
        mkdirSync(dir, { recursive: true });
        const archivePath = join(dir, asset.name!);
        process.stderr.write(`[github] downloading ${rel.tag_name} (${asset.name})...\n`);
        await downloadFile(asset.browser_download_url, archivePath);
        process.stderr.write('[github] extracting...\n');
        extractArchive(archivePath, dir);
        rmSync(archivePath, { force: true });
        const found = findFileRecursive(dir, 'github-mcp-server.exe');
        if (!found) {
          throw new Error(`github-mcp-server.exe not found after extraction. Download manually from https://github.com/github/github-mcp-server/releases and place it at ~/.nexus/native/github-mcp-server/`);
        }
        if (found !== exe) {
          rmSync(exe, { force: true });
          renameSync(found, exe);
        }
        process.stderr.write('[github] binary ready.\n');
      }
      const env: Record<string, string> = { GITHUB_READ_ONLY: '1' };
      if (params.token) env.GITHUB_PERSONAL_ACCESS_TOKEN = params.token;
      new ConfigManager().addMcpServer('github', { command: exe, args: ['stdio'], env, autoStart: true });
    },
  },
  puppeteer: {
    name: 'puppeteer',
    description: 'Browser automation (screenshot, scrape, interact)',
    longDescription: 'Headless browser automation (Playwright): take screenshots, scrape dynamic content, fill forms, generate PDFs from web pages. Native npm deployment of @playwright/mcp.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    async install() {
      const { command, args } = nativeNpmServer('puppeteer', { '@playwright/mcp': '0.0.78' }, 'node_modules/@playwright/mcp/cli.js', ['--headless']);
      new ConfigManager().addMcpServer('puppeteer', { command, args, autoStart: true });
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
      const { command, args } = mcpNpx(['-y', '@modelcontextprotocol/server-sequential-thinking']);
      config.addMcpServer('sequential-thinking', { command, args, autoStart: true });
    },
  },
  sqlite: {
    name: 'sqlite',
    description: 'SQLite database querying and management',
    longDescription: 'Query, create, and manage SQLite databases directly. Supports DDL, DML, transactions, and schema inspection. Native npm deployment of mcp-server-sqlite.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/madnh/mcp-server-sqlite',
    options: [
      { flag: '--db', label: 'Database file path (default: ~/.nexus/native/data/default.db)', default: join(DATA_DIR, 'default.db') },
    ],
    async install(params) {
      mkdirSync(DATA_DIR, { recursive: true });
      const dbPath = params.db || join(DATA_DIR, 'default.db');
      const { command, args } = nativeNpmServer('sqlite', { 'mcp-server-sqlite': '0.0.2' }, 'node_modules/mcp-server-sqlite/dist/cli.js', [dbPath]);
      new ConfigManager().addMcpServer('sqlite', { command, args, autoStart: true });
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
       const { command, args } = mcpNpx(['-y', '@modelcontextprotocol/server-memory']);
       config.addMcpServer('memory', { command, args, autoStart: true, env: { MEMORY_FILE_PATH: join(DATA_DIR, 'memory.jsonl') } });
     },
  },

  git: {
    name: 'git',
    description: 'Git repository operations (log, diff, status, blame, branches)',
    longDescription: 'Full Git integration: view commit history, diffs, file status, blame annotations, branch management, and more. Native npm deployment of git-mcp (SDK + zod only, no lifecycle scripts).',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/onmyway133/git-mcp',
    options: [
      { flag: '--repository', label: 'Path to git repository (default: current working dir)', default: process.cwd() },
    ],
    async install(params) {
      const repo = params.repository || process.cwd();
      const { command, args } = nativeNpmServer('git-mcp', { 'git-mcp': '1.0.0' }, 'node_modules/git-mcp/dist/index.js', ['--repository', repo]);
      new ConfigManager().addMcpServer('git', { command, args, autoStart: true });
    },
  },
  postgres: {
    name: 'postgres',
    description: 'PostgreSQL database querying and schema management',
    longDescription: 'Query, explore, and manage PostgreSQL databases. Supports SQL queries, schema inspection, table listing, and more. Native npm deployment of @abiswas97/postgres-mcp.',
    type: 'mcp',
    version: '1.0.0',
    homepage: 'https://github.com/abiswas97/postgres-mcp',
    options: [
      { flag: '--conn', label: 'PostgreSQL connection string (e.g. postgresql://user:pass@localhost/mydb)' },
    ],
    async install(params) {
      const connStr = params.conn || 'postgresql://localhost/postgres';
      const { command, args } = nativeNpmServer('postgres', { '@abiswas97/postgres-mcp': '2.0.0' }, 'node_modules/@abiswas97/postgres-mcp/dist/index.js');
      new ConfigManager().addMcpServer('postgres', { command, args, env: { DATABASE_URL: connStr }, autoStart: true });
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
      try { execSync('npm install --ignore-scripts --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 120000 }); }
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
      try { execSync('npm install --ignore-scripts --loglevel=error', { cwd: dir, stdio: 'pipe', timeout: 120000 }); }
      catch (err) { throw new Error(`npm install failed: ${err instanceof Error ? err.message : String(err)}`); }
      new ConfigManager().addMcpServer('typescript-language-server', { command: 'node', args: [join(dir, 'server.mjs')], autoStart: true });
    },
  },

};

/**
 * Default marketplaces auto-registered on first use.
 * Metadata is static (no network fetch needed for listing).
 *
 * modelcontextprotocol is a virtual marketplace — its entries resolve to the
 * built-in CATALOG (npm-based MCP/LSP servers), not GitHub SKILL.md files.
 */
const DEFAULT_MARKETPLACES: RegisteredMarketplace[] = [
  {
    name: 'claude-code-plugins',
    source: 'anthropics/claude-plugins-official',
    plugins: [
      { name: 'code-review', description: 'Automated code review with diff analysis and best practices', source: './plugins/code-review', category: 'development', version: '1.0.0' },
      { name: 'git-flow', description: 'Streamlined Git workflow: commit, branch, merge, rebase', source: './plugins/git-flow', category: 'development', version: '1.0.0' },
      { name: 'test-runner', description: 'Auto-discover and run tests with coverage reporting', source: './plugins/test-runner', category: 'development', version: '1.0.0' },
      { name: 'deploy-check', description: 'Pre-deployment checklist: lint, test, build, security audit', source: './plugins/deploy-check', category: 'development', version: '1.0.0' },
    ],
  },
  {
    name: 'mattpocock',
    source: 'mattpocock/skills',
    plugins: [
      { name: 'mattpocock-skills', description: 'Matt Pocock\'s agent skills for real engineering — grilling, design, debugging, and more', source: './', category: 'engineering', version: '1.0.0' },
    ],
  },
  {
    name: 'modelcontextprotocol',
    source: 'modelcontextprotocol/servers',
    plugins: [
      { name: 'filesystem', description: 'Advanced filesystem operations (batch read, search, watch)', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'github', description: 'GitHub API integration (PR, Issues, Repos, Search)', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'puppeteer', description: 'Browser automation (screenshot, scrape, interact)', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'sequential-thinking', description: 'Structured multi-step reasoning', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'sqlite', description: 'SQLite database querying and management', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'memory', description: 'Knowledge graph memory with entities and relations', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'pyright', description: 'Python LSP — diagnostics, hover, format (Microsoft Pyright)', source: '', category: 'lsp', version: '1.0.0' },
      { name: 'typescript-language-server', description: 'TypeScript/JavaScript LSP — diagnostics, hover, format', source: '', category: 'lsp', version: '1.0.0' },
      { name: 'git', description: 'Git repository operations (log, diff, status, blame, branches)', source: '', category: 'mcp', version: '1.0.0' },
      { name: 'postgres', description: 'PostgreSQL database querying and schema management', source: '', category: 'mcp', version: '1.0.0' },
    ],
  },
];

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

/**
 * Per-market default-enabled lists.
 * Items NOT in a market's list are auto-disabled upon install.
 */
const MARKETPLACE_DEFAULT_ENABLED: Record<string, string[]> = {
  'claude-code-plugins': [
    'git-flow',
    'test-runner',
    'deploy-check',
  ],
  'mattpocock': [
    'diagnosing-bugs',
    'code-review',
    'tdd',
    'research',
    'resolving-merge-conflicts',
    'grill-me',
    'grilling',
    'handoff',
    'writing-great-skills',
    'codebase-design',
    'domain-modeling',
  ],
  'modelcontextprotocol': [
    'filesystem',
    'github',
    'puppeteer',
    'sequential-thinking',
    'sqlite',
    'memory',
    'pyright',
    'typescript-language-server',
    'git',
    'postgres',
  ],
};

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

  /** Load persisted marketplaces from ~/.nexus/native/marketplaces.json */
  private loadMarketplaces(): RegisteredMarketplace[] {
    try {
      if (!existsSync(MARKETPLACES_FILE)) return [];
      const raw = readFileSync(MARKETPLACES_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch { return []; }
  }

  /** Persist marketplaces to ~/.nexus/native/marketplaces.json */
  private saveMarketplaces(list: RegisteredMarketplace[]): void {
    mkdirSync(NATIVE_DIR, { recursive: true });
    writeFileSync(MARKETPLACES_FILE, JSON.stringify(list, null, 2), 'utf-8');
  }

  getMarketplaces(): RegisteredMarketplace[] {
    const persisted = this.loadMarketplaces();
    if (persisted.length === 0) {
      // First use — auto-register default marketplaces
      this.saveMarketplaces(DEFAULT_MARKETPLACES);
      return DEFAULT_MARKETPLACES;
    }
    // Merge any new plugins from DEFAULT_MARKETPLACES into persisted data
    // (covers newly added entries like git/postgres without requiring re-registration)
    let changed = false;
    for (const def of DEFAULT_MARKETPLACES) {
      const existing = persisted.find(m => m.name === def.name);
      if (existing) {
        for (const plugin of def.plugins) {
          if (!existing.plugins.some(p => p.name === plugin.name)) {
            existing.plugins.push(plugin);
            changed = true;
          }
        }
      }
    }
    if (changed) this.saveMarketplaces(persisted);
    return persisted;
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
    this.saveMarketplaces(existing);

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
    this.saveMarketplaces(list);
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
    this.saveMarketplaces(list);

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

    // Virtual marketplace entries (modelcontextprotocol) resolve to CATALOG.
    // Check BEFORE plugin lookup so stale marketplaces.json doesn't block install.
    if (CATALOG[pluginName]) {
      return this.installFromCatalog(pluginName, CATALOG[pluginName]!);
    }

    const plugin = mp.plugins.find(p => p.name === pluginName);
    if (!plugin) {
      // Not found in explicit list — try to fetch as a sub-skill from the repo
      // (common pattern: marketplace exposes one meta-plugin, real skills are under subdirs)
      const ghMatch2 = mp.source.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/);
      if (ghMatch2) {
        const [, o2, r2] = ghMatch2;
        const rawBase = ghRawBase(o2, r2);
        // Try common directory patterns used by Claude Code plugin repos
        for (const pattern of [
          `plugins/${pluginName}/SKILL.md`,
          `skills/${pluginName}/SKILL.md`,
          `external_plugins/${pluginName}/SKILL.md`,
        ]) {
          const body = await fetchRemoteText(`${rawBase}/${pattern}`);
          if (body) {
            const dir = join(PLUGIN_DIR, pluginName);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
            this.trackInstalled(pluginName); this.autoDisableIfNotDefault(pluginName, mpName);
            return `Plugin "${pluginName}@${mpName}" installed.\n  Fetched: ${pattern}\n  Restart the agent to activate.`;
          }
        }
        // Fallback: scan repo tree for any SKILL.md with matching directory
        const treeRes = await fetch(
          `https://api.github.com/repos/${o2}/${r2}/git/trees/main?recursive=1`,
          { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'nexus-coder' }, signal: AbortSignal.timeout(8000) }
        );
        if (treeRes.ok) {
          const tree = await treeRes.json() as { tree: Array<{ path: string }> };
          const re = new RegExp(`(?:^|/)(?:plugins/|skills/|external_plugins/)?${pluginName}/SKILL\\.md$`, 'i');
          const matchPath = tree.tree.find((t: { path: string }) => re.test(t.path));
          if (matchPath) {
            const body = await fetchRemoteText(`${ghRawBase(o2, r2)}/${matchPath.path}`);
            if (body) {
              const dir = join(PLUGIN_DIR, pluginName);
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
              this.trackInstalled(pluginName); this.autoDisableIfNotDefault(pluginName, mpName);
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
      this.trackInstalled(pluginName); this.autoDisableIfNotDefault(pluginName, mpName);
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
      this.trackInstalled(pluginName); this.autoDisableIfNotDefault(pluginName, mpName);
      return `Plugin "${pluginName}@${mpName}" registered (no SKILL.md found).\n  Source: ${mp.source}\n  Restart the agent to activate.`;
    }

    const tree = await treeRes.json() as { tree: Array<{ path: string; type: string }> };
    const skPaths = tree.tree.filter(t =>
      t.type === 'blob' &&
      /\/(?:plugins|skills|external_plugins)\/[^/]+\/SKILL\.md$/i.test(t.path)
    );

    if (skPaths.length === 0) {
      const dir = join(PLUGIN_DIR, pluginName);
      mkdirSync(dir, { recursive: true });
      this.trackInstalled(pluginName); this.autoDisableIfNotDefault(pluginName, mpName);
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
      if (r.status === 'fulfilled' && r.value !== null) {
        installedSkills.push(r.value);
        this.autoDisableIfNotDefault(r.value, mpName);
      }
      else failedCount++;
    }

    return `Plugin "${pluginName}@${mpName}" installed.\n` +
      `  Source: ${mp.source}\n` +
      `  Unpacked ${installedSkills.length} skill(s)` + (failedCount > 0 ? ` (${failedCount} failed)` : '') + ` into ~/.nexus/native/plugins/\n` +
      `  Restart the agent to activate.`;
  }

  /** Install a built-in CATALOG entry (MCP/LSP server) */
  private async installFromCatalog(name: string, pkg: PackageInfo, params?: Record<string, string>): Promise<string> {
    if (this.isInstalled(name)) {
      throw new Error(`Package "${name}" is already installed.`);
    }
    mkdirSync(NATIVE_DIR, { recursive: true });
    await pkg.install(params || {});
    // pkg.install() created its own ConfigManager and saved mcpServers.
    // Reload the outer config to pick those up before we save the installed list
    // (otherwise outer save would overwrite and lose the mcpServers).
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(join(homedir(), '.nexus', 'config.json'), 'utf-8'));
    } catch {
      raw = {};
    }
    const cfg = this.config.get();
    if (raw.mcpServers) {
      cfg.mcpServers = raw.mcpServers as any;
    }
    const installed = this.getInstalledList();
    installed.push(name);
    this.saveInstalledList(installed);
    const label = pkg.type === 'mcp' ? 'MCP Server' : 'Plugin';
    const mcpAdded = pkg.type === 'mcp' && cfg.mcpServers?.[name];
    return `${label} "${name}" installed.\n` +
      (mcpAdded ? `  Config: ~/.nexus/config.json → mcpServers.${name}\n` : '') +
      `  Restart the agent to activate.`;
  }

  /** Record installation in config, deduplicated and enabled by default */
  private trackInstalled(name: string): void {
    const installed = this.getInstalledList();
    if (!installed.includes(name)) {
      installed.push(name);
      this.saveInstalledList(installed);
    }
    // Ensure newly installed plugins are enabled by default
    const disabled = this.getDisabledList();
    if (disabled.includes(name)) {
      this.saveDisabledList(disabled.filter(n => n !== name));
    }
  }

  /**
   * Check if an item is in its market's default-enabled list.
   * If not, add it to nativeDisabled.
   * Has no effect if the market has no defaultEnabled list (all items stay enabled).
   */
  private autoDisableIfNotDefault(name: string, mpName: string): void {
    const defaultList = MARKETPLACE_DEFAULT_ENABLED[mpName];
    if (!defaultList) return;
    if (defaultList.includes(name)) return;
    const disabled = this.getDisabledList();
    if (!disabled.includes(name)) {
      disabled.push(name);
      this.saveDisabledList(disabled);
    }
  }

  async install(name: string, params?: Record<string, string>): Promise<string> {
    // Support <name>@<marketplace> syntax for marketplace plugins
    const atIdx = name.lastIndexOf('@');
    if (atIdx > 0 && atIdx < name.length - 1) {
      const pluginName = name.slice(0, atIdx);
      const mpName = name.slice(atIdx + 1);
      // Virtual marketplaces (modelcontextprotocol) resolve to built-in CATALOG entries
      // — no SKILL.md to fetch, just install via the catalog's npm-based method.
      if (CATALOG[pluginName]) {
        name = pluginName; // drop @market, fall through to CATALOG path below
      } else {
        return this.installFromMarketplace(pluginName, mpName);
      }
    }

    const pkg = CATALOG[name];
    if (!pkg) {
      // Fallback: search registered marketplaces for a matching plugin
      const matches: Array<{ marketplace: string }> = [];
      for (const mp of this.getMarketplaces()) {
        for (const plugin of mp.plugins) {
          if (plugin.name === name) {
            matches.push({ marketplace: mp.name });
          }
        }
      }
      if (matches.length > 0) {
        const result = await this.installFromMarketplace(name, matches[0].marketplace);
        if (matches.length > 1) {
          const others = matches.slice(1).map(m => `${name}@${m.marketplace}`).join(', ');
          return result + `\n  ⚠ Also available in: ${others}. Use \`install ${others}\` for the other variant.`;
        }
        return result;
      }
      // Also try as a sub-skill in any registered marketplace
      for (const mp of this.getMarketplaces()) {
        const ghMatch = mp.source.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/);
        if (!ghMatch) continue;
        const [, o, r] = ghMatch;
        const rawBase = ghRawBase(o, r);
        // Try common subdir patterns
        let found = false;
        for (const subdir of ['plugins', 'skills', 'external_plugins', '']) {
          const path = subdir ? `${subdir}/${name}/SKILL.md` : `${name}/SKILL.md`;
          const body = await fetchRemoteText(`${rawBase}/${path}`);
          if (body) { found = true; break; }
        }
        if (found) return this.installFromMarketplace(name, mp.name);
        // Broad tree scan
        const treeRes = await fetch(
          `https://api.github.com/repos/${o}/${r}/git/trees/main?recursive=1`,
          { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'nexus-coder' }, signal: AbortSignal.timeout(5000) }
        );
        if (treeRes.ok) {
          const tree = await treeRes.json() as { tree: Array<{ path: string }> };
          const re = new RegExp(`(?:^|/)${name}/SKILL\\.md$`, 'i');
          if (tree.tree.some((t: { path: string }) => re.test(t.path))) {
            return this.installFromMarketplace(name, mp.name);
          }
        }
      }
      throw new Error(
        `Package "${name}" not found in catalog or any registered marketplace.\n` +
        `  Available in catalog: ${this.getAvailableNames().join(', ')}\n` +
        `  Try: nexus config native marketplace add <owner/repo>\n` +
        `  Or: nexus config native install <name>@<marketplace>`
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
   * Deploy all default-enabled plugins from all registered marketplaces.
   * Installs any not yet installed and ensures all are enabled.
   */
  async deployDefaults(): Promise<string[]> {
    const results: string[] = [];
    for (const [mpName, defaultList] of Object.entries(MARKETPLACE_DEFAULT_ENABLED)) {
      const mp = this.getMarketplaces().find(m => m.name === mpName);
      if (!mp) {
        results.push(`⚠ marketplace "${mpName}" not registered — skipping`);
        continue;
      }
      for (const name of defaultList) {
        try {
          if (!this.isInstalled(name)) {
            await this.installFromMarketplace(name, mpName);
            results.push(`✓ ${name}@${mpName} installed`);
          } else if (CATALOG[name]) {
            // Already installed but might be missing mcpServers config
            // (prior bug: outer save overwrote inner ConfigManager's mcpServers).
            // Re-run catalog install to ensure config is present.
            const cfg = this.config.get();
            const pkg = CATALOG[name]!;
            if (pkg.type === 'mcp' && !cfg.mcpServers?.[name]) {
              await pkg.install({});
              const raw = JSON.parse(readFileSync(join(homedir(), '.nexus', 'config.json'), 'utf-8'));
              if (raw.mcpServers?.[name]) {
                cfg.mcpServers = raw.mcpServers;
                this.config.save();
                results.push(`✓ ${name}@${mpName} mcpServers config restored`);
              } else {
                results.push(`✗ ${name}@${mpName}: failed to restore mcpServers config`);
              }
            } else {
              results.push(`  ${name}@${mpName} already installed`);
            }
          } else {
            results.push(`  ${name}@${mpName} already installed`);
          }
        } catch (err) {
          results.push(`✗ ${name}@${mpName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Ensure all default items are enabled; disable everything else that's installed
    const disabled = this.getDisabledList();
    const allDefaultItems = Object.values(MARKETPLACE_DEFAULT_ENABLED).flat();
    const allInstalled = this.getInstalledList();
    const newDisabled = [...new Set([
      // Keep existing disabled items that aren't defaults
      ...disabled.filter(d => !allDefaultItems.includes(d)),
      // Add any installed item that's NOT a default
      ...allInstalled.filter(n => !allDefaultItems.includes(n) && !disabled.includes(n)),
    ])];
    this.saveDisabledList(newDisabled);
    const cleared = disabled.filter(d => allDefaultItems.includes(d));
    const added = newDisabled.filter(d => !disabled.includes(d));
    if (cleared.length > 0) results.push(`✓ ${cleared.length} default item(s) enabled (removed from disabled list)`);
    if (added.length > 0) results.push(`✓ ${added.length} non-default item(s) disabled`);
    return results;
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

    // 3. Registered marketplaces — match marketplace plugins against query
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

    const { command, args } = mcpNpx(['-y', pkgName]);
    config.addMcpServer(serverName, {
      command,
      args,
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
        execSync(`git clone --depth 1 "https://github.com/${parts[0]}/${parts[1]}.git" "${targetDir}"`, {
          stdio: 'pipe',
          timeout: 180000,
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

  getInstalledList(): string[] {
    try {
      return this.config.get().nativeInstalled || [];
    } catch {
      return [];
    }
  }

  private saveInstalledList(list: string[]): void {
    this.config.setNativeInstalled([...new Set(list)]);
  }

  getDisabledList(): string[] {
    try {
      return this.config.get().nativeDisabled || [];
    } catch {
      return [];
    }
  }

  private saveDisabledList(list: string[]): void {
    this.config.setNativeDisabled([...new Set(list)]);
  }

  isEnabled(name: string): boolean {
    return !this.getDisabledList().includes(name);
  }

  enable(name: string): string {
    const disabled = this.getDisabledList();
    if (!disabled.includes(name)) {
      return `"${name}" is already enabled.`;
    }
    this.saveDisabledList(disabled.filter(n => n !== name));
    return `"${name}" enabled. Restart the agent to activate.`;
  }

  disable(name: string): string {
    const disabled = this.getDisabledList();
    if (disabled.includes(name)) {
      return `"${name}" is already disabled.`;
    }
    disabled.push(name);
    this.saveDisabledList(disabled);
    return `"${name}" disabled. Restart the agent to deactivate.`;
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


