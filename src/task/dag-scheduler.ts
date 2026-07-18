import { join, extname } from 'path';
import { homedir } from 'os';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync, existsSync, copyFileSync, statSync, rmdirSync } from 'fs';
import { TaskGraph, TaskNode, SubAgentRole, GraphMode } from './types.js';
import { SubAgentWorker } from './sub-agent-worker.js';
import { runQualityGate } from './task-tools.js';
import { ProgressTracker } from './progress-tracker.js';
import { preAuthorizeRoot, clearScope } from '../security/path-authorizer.js';

/** Project code is isolated from the agent's own directory under ~/.nexus/tasks/outputs */
const TASK_OUTPUTS_DIR = join(homedir(), '.nexus', 'tasks', 'outputs');

/**
 * Temp-file naming patterns.
 * Universal: matched in both cwd and projectDir (safe).
 * ProjectOnly: matched only in projectDir (more aggressive — it is a sandbox).
 */
const TEMP_UNIVERSAL = new Set([
  '_probe', '_scratch', '_tmp', '_smoke', '_baseline',
  'tmp_', '.tmp_', 'bench_', 'scratch_',
]);
const TEMP_PROJECT_ONLY = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.coverage', '.eggs', '.tox', '.nox',
  'dist', 'build',
  'node_modules', 'npm-debug.log',
  '.ipynb_checkpoints',
]);
/** Entries in TEMP_PROJECT_ONLY that must be an exact (not prefix) match */
const TEMP_PROJECT_EXACT = new Set([
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.coverage', '.eggs', '.tox', '.nox',
  'dist', 'build',
  'node_modules', 'npm-debug.log',
  '.ipynb_checkpoints',
]);

export class DAGScheduler {
  constructor(
    private worker: SubAgentWorker,
    private tracker: ProgressTracker,
  ) {}

  async execute(graph: TaskGraph): Promise<void> {
    const projectDir = graph.projectName
      ? join(TASK_OUTPUTS_DIR, graph.projectName)
      : TASK_OUTPUTS_DIR;
    mkdirSync(projectDir, { recursive: true });
    // Pre-authorize the outputs tree so sub-agents can list/write inside it
    // without triggering the security prompt. Scoped to 'dag' so the grant is
    // released when this run finishes (see finally below) instead of leaking to
    // unrelated tools/agents for the rest of the process.
    preAuthorizeRoot(TASK_OUTPUTS_DIR, 'dag');
    const levels = this.topologicalSort(graph);

    for (const level of levels) {
      await Promise.all(level.map(async (node) => {
        if (node.status === 'cancelled') return;
        if (node.status === 'completed') return;

        await this.markInProgress(graph, node);

        // Reset state for previously failed nodes
        if (node.status === 'failed') {
          node.retryCount = 0;
          node.error = undefined;
        }
        for (let attempt = 0; attempt <= node.maxRetries; attempt++) {
          try {
            const role = (node.agentHint === 'tester' || node.agentHint === 'committer')
              ? node.agentHint as SubAgentRole
              : 'general';
            const priorResults = this.collectPriorResults(graph, node);
            const result = await this.worker.execute(node, projectDir, role, priorResults, graph.rootRequest, graph.mode);
            node.result = result.output;
            node.status = 'completed';
            node.error = undefined;
            node.retryCount = 0;
            node.updatedAt = Date.now();

            // Quality gate: after a general implementation task, auto-run
            // tester -> committer as a coding规范流 (gated by config).
            if (role === 'general') {
              await runQualityGate(this.worker.parent, projectDir);
            }

            this.tracker.updateGraph(graph);
            this.tracker.appendEvent({
              graphId: graph.id,
              taskId: node.id,
              eventType: 'task_completed',
              timestamp: Date.now(),
            });
            break;
          } catch (err) {
            node.retryCount = attempt + 1;
            node.error = String(err);
            if (attempt < node.maxRetries) {
              this.tracker.appendEvent({
                graphId: graph.id,
                taskId: node.id,
                eventType: 'task_retry',
                payload: String(err),
                timestamp: Date.now(),
              });
            } else {
              node.status = 'failed';
              node.updatedAt = Date.now();
              this.tracker.updateGraph(graph);
              this.tracker.appendEvent({
                graphId: graph.id,
                taskId: node.id,
                eventType: 'task_failed',
                payload: String(err),
                timestamp: Date.now(),
              });
              this.cancelDownstream(graph, node.id);
            }
          }
        }
      }));
    }

    // 3. For 'modify' mode: commit changes as a rollback safety net
    if (graph.mode === 'modify') {
      await this.gitCommitSnapshot(projectDir, graph.rootRequest);
    }

    try {
      await this.finalize(graph, projectDir);
    } finally {
      // Release the scoped grant so the outputs tree is no longer silently
      // authorized for the rest of the process.
      clearScope('dag');
    }
  }

  /**
   * Create a git commit snapshot of all changes for rollback safety.
   * Only commits tracked/modified files — does NOT push.
   */
  private async gitCommitSnapshot(projectDir: string, rootRequest: string): Promise<void> {
    const { execSync } = await import('child_process');
    const cwd = process.cwd();
    try {
      // Check if we're in a git repo
      execSync('git rev-parse --git-dir', { cwd, stdio: 'pipe', encoding: 'utf-8' });
    } catch {
      console.log('[snapshot] Not a git repository, skipping commit');
      return;
    }

    try {
      const status = execSync('git status --porcelain', { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
      if (!status) {
        console.log('[snapshot] No changes to commit');
        return;
      }

      // Stage all modified tracked files
      execSync('git add -A', { cwd, stdio: 'pipe', encoding: 'utf-8' });

      // Extract a short summary from the root request for the commit message
      const summary = rootRequest
        .replace(/@[^\s]+/g, '').trim()
        .slice(0, 72);
      const msg = `feat(agent): auto-snapshot before task "${summary}"\n\n[nexus task snapshot — rollback with: git reset --hard HEAD@{1}]`;

      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd, stdio: 'pipe', encoding: 'utf-8' });
      console.log(`[snapshot] Created rollback commit for "${summary.slice(0, 50)}"`);
    } catch (err) {
      console.log(`[snapshot] Failed to create snapshot commit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async markInProgress(graph: TaskGraph, node: TaskNode): Promise<void> {
    node.status = 'in_progress';
    node.updatedAt = Date.now();
    this.tracker.updateGraph(graph);
    this.tracker.appendEvent({
      graphId: graph.id,
      taskId: node.id,
      eventType: 'task_started',
      timestamp: Date.now(),
    });
  }

  private collectPriorResults(graph: TaskGraph, node: TaskNode): Record<string, string> {
    const results: Record<string, string> = {};
    for (const depId of node.dependencies) {
      const depNode = graph.nodes.find((n) => n.id === depId);
      if (depNode?.status === 'completed' && depNode.result) {
        results[depNode.id] = depNode.result;
      }
    }
    return results;
  }

  /**
   * Post-execution finalization: cleanup temp files and write completion report.
   */
  private async finalize(graph: TaskGraph, projectDir: string): Promise<void> {
    const cwd = process.cwd();
    const cleaned: string[] = [];
    const copyLog: string[] = [];

    /**
     * Check if a file/directory name should be treated as temporary.
     * @param entry  bare file/directory name (no path)
     * @param inProjectDir  true when scanning the project output sandbox
     */
    function isTempName(entry: string, inProjectDir: boolean): boolean {
      // .pyc / .pyo / .egg-info are always temp
      if (entry.endsWith('.pyc') || entry.endsWith('.pyo') || entry.endsWith('.egg-info')) return true;
      // CLI flag leak in project dir only
      if (inProjectDir && entry.startsWith('-')) return true;
      // Universal patterns
      for (const pat of TEMP_UNIVERSAL) {
        if (entry.startsWith(pat)) return true;
      }
      // Project-only patterns
      if (inProjectDir) {
        for (const pat of TEMP_PROJECT_ONLY) {
          if (TEMP_PROJECT_EXACT.has(pat)) {
            if (entry === pat) return true;
          } else {
            if (entry.startsWith(pat)) return true;
          }
        }
      }
      return false;
    }

    /** Recursively remove a directory tree. */
    function rmTree(dir: string): void {
      try {
        for (const e of readdirSync(dir)) {
          const fp = join(dir, e);
          if (statSync(fp).isDirectory()) rmTree(fp);
          else unlinkSync(fp);
        }
        rmdirSync(dir);
      } catch { /* race or permission */ }
    }

    // 1. Clean up temp/probe files from project dir (aggressive) and parent cwd (conservative)
    for (const dir of [projectDir, cwd]) {
      const inProject = dir === projectDir;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        if (!isTempName(entry, inProject)) continue;
        try {
          if (statSync(fullPath).isDirectory()) {
            rmTree(fullPath);
            cleaned.push(fullPath + '/');
          } else {
            unlinkSync(fullPath);
            cleaned.push(fullPath);
          }
        } catch { /* race: already deleted */ }
      }
    }

    // 2. Collect deliverables
    const DELIVERABLE_EXTS = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.css', '.html', '.htm']);
    const isDeliverable = (name: string): boolean => {
      if (isTempName(name, false)) return false;
      if (name.startsWith('.') || name === 'node_modules') return false;
      const ext = extname(name).toLowerCase();
      return DELIVERABLE_EXTS.has(ext);
    };

    let deliverables: string[] = [];

    // 2a. Collect from parent CWD: files created by parent agent (copy into projectDir)
    try {
      const taskStart = graph.createdAt;
      deliverables = readdirSync(cwd).filter((f) => {
        if (!isDeliverable(f)) return false;
        const outPath = join(projectDir, f);
        if (existsSync(outPath)) return false;
        try {
          const st = statSync(join(cwd, f));
          if (!st.isFile()) return false;
          // Only collect files created/modified during this task execution,
          // not leftover files from previous runs
          if (st.mtimeMs < taskStart) return false;
          return true;
        } catch { return false; }
      });
    } catch { /* ignore */ }

    for (const f of deliverables) {
      const src = join(cwd, f);
      const dst = join(projectDir, f);
      try {
        copyFileSync(src, dst);
        copyLog.push(f);
      } catch { /* permission or race */ }
    }

    // 2b. Collect from projectDir: files written by sub-agents (already in sandbox)
    try {
      const taskStart = graph.createdAt;
      const sandboxFiles = readdirSync(projectDir).filter((f) => {
        if (f === '.task-complete.json') return false;
        const fullPath = join(projectDir, f);
        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) return true;
          if (isDeliverable(f) && st.mtimeMs >= taskStart) return true;
          return false;
        } catch { return false; }
      });
      for (const f of sandboxFiles) {
        if (!copyLog.includes(f)) copyLog.push(f);
      }
    } catch { /* ignore */ }

    // 3. Write completion report
    const summary = {
      graphId: graph.id,
      projectName: graph.projectName,
      rootRequest: graph.rootRequest,
      completedAt: Date.now(),
      taskCount: graph.nodes.length,
      completedTasks: graph.nodes.filter((n) => n.status === 'completed').length,
      failedTasks: graph.nodes.filter((n) => n.status === 'failed').length,
      cleanedTempFiles: cleaned.length,
      deliverablesCollected: copyLog,
      outputDir: projectDir,
    };

    try {
      writeFileSync(
        join(projectDir, '.task-complete.json'),
        JSON.stringify(summary, null, 2),
        'utf-8',
      );
    } catch { /* write error */ }

    if (cleaned.length > 0) {
      console.log(`[finalize] Cleaned ${cleaned.length} temp file(s):`);
      for (const f of cleaned) console.log(`         ${f}`);
    }
    if (copyLog.length > 0) {
      console.log(`[finalize] Collected ${copyLog.length} deliverable(s) → ${projectDir}`);
    }
  }

  private cancelDownstream(graph: TaskGraph, failedId: string): void {
    const downstream = this.findDownstream(graph, failedId);
    for (const nodeId of downstream) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node && node.status === 'pending') {
        node.status = 'cancelled';
        node.updatedAt = Date.now();
      }
    }
    this.tracker.updateGraph(graph);
  }

  private findDownstream(graph: TaskGraph, nodeId: string): Set<string> {
    const visited = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const node of graph.nodes) {
        if (node.dependencies.includes(current) && !visited.has(node.id)) {
          visited.add(node.id);
          queue.push(node.id);
        }
      }
    }
    return visited;
  }

  topologicalSort(graph: TaskGraph): TaskNode[][] {
    const nodes = graph.nodes;
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjList.set(node.id, []);
    }

    for (const node of nodes) {
      for (const depId of node.dependencies) {
        const list = adjList.get(depId);
        if (list) list.push(node.id);
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    const levels: TaskNode[][] = [];
    let queue = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id);

    while (queue.length > 0) {
      const level: TaskNode[] = [];
      const nextQueue: string[] = [];

      for (const nodeId of queue) {
        const node = nodes.find((n) => n.id === nodeId);
        if (node) level.push(node);

        for (const neighbor of adjList.get(nodeId) || []) {
          const deg = (inDegree.get(neighbor) || 1) - 1;
          inDegree.set(neighbor, deg);
          if (deg === 0) nextQueue.push(neighbor);
        }
      }

      if (level.length > 0) levels.push(level);
      queue = nextQueue;
    }

    return levels;
  }
}
