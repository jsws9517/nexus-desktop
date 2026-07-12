import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { TaskGraph, TaskNode, TaskStatus, TaskEvent } from './types.js';

const DB_PATH = (() => {
  const dir = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  return join(dir, 'sessions.db');
})();

const INIT_TASK_SQL = `
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS task_graphs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  root_request TEXT NOT NULL,
  project_name TEXT,
  nodes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id TEXT NOT NULL,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_graph ON task_events(graph_id);
CREATE INDEX IF NOT EXISTS idx_task_graphs_session ON task_graphs(session_id);
`;

export class ProgressTracker {
  private db: Database.Database;

  constructor(customDbPath?: string) {
    const dbPath = customDbPath || DB_PATH;
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(INIT_TASK_SQL);
    try { this.db.exec(`ALTER TABLE task_graphs ADD COLUMN project_name TEXT`); } catch { }
  }

  initGraph(graph: TaskGraph): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO task_graphs (id, session_id, root_request, project_name, nodes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      graph.id,
      graph.sessionId,
      graph.rootRequest,
      graph.projectName || null,
      JSON.stringify(graph.nodes),
      graph.createdAt,
      graph.updatedAt,
    );
  }

  updateGraph(graph: TaskGraph): void {
    const stmt = this.db.prepare(
      `UPDATE task_graphs SET nodes = ?, updated_at = ? WHERE id = ?`
    );
    stmt.run(JSON.stringify(graph.nodes), graph.updatedAt, graph.id);
  }

  getGraph(id: string): TaskGraph | undefined {
    const row = this.db.prepare('SELECT * FROM task_graphs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToGraph(row);
  }

  getGraphBySession(sessionId: string): TaskGraph | undefined {
    const row = this.db
      .prepare('SELECT * FROM task_graphs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToGraph(row);
  }

  listGraphs(): TaskGraph[] {
    const rows = this.db.prepare('SELECT * FROM task_graphs ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToGraph(r));
  }

  updateNodeStatus(graphId: string, taskId: string, status: TaskStatus, result?: string, error?: string): void {
    const graph = this.getGraph(graphId);
    if (!graph) return;

    const node = graph.nodes.find((n) => n.id === taskId);
    if (!node) return;

    node.status = status;
    node.updatedAt = Date.now();
    if (result !== undefined) node.result = result;
    if (error !== undefined) node.error = error;

    this.updateGraph(graph);
  }

  appendEvent(event: TaskEvent): void {
    const stmt = this.db.prepare(
      `INSERT INTO task_events (graph_id, task_id, event_type, payload, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(event.graphId, event.taskId || null, event.eventType, event.payload || null, event.timestamp);
  }

  getEvents(graphId: string, taskId?: string): TaskEvent[] {
    let query: string;
    const params: unknown[] = [graphId];
    if (taskId) {
      query = 'SELECT * FROM task_events WHERE graph_id = ? AND task_id = ? ORDER BY timestamp ASC';
      params.push(taskId);
    } else {
      query = 'SELECT * FROM task_events WHERE graph_id = ? ORDER BY timestamp ASC';
    }
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      graphId: String(r.graph_id),
      taskId: r.task_id ? String(r.task_id) : undefined,
      eventType: String(r.event_type),
      payload: r.payload ? String(r.payload) : undefined,
      timestamp: Number(r.timestamp),
    }));
  }

  deleteGraph(id: string): void {
    this.db.prepare('DELETE FROM task_events WHERE graph_id = ?').run(id);
    this.db.prepare('DELETE FROM task_graphs WHERE id = ?').run(id);
  }

  private rowToGraph(row: Record<string, unknown>): TaskGraph {
    const nodes: TaskNode[] = JSON.parse(String(row.nodes));
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      rootRequest: String(row.root_request),
      projectName: row.project_name ? String(row.project_name) : undefined,
      nodes,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  close(): void {
    this.db.close();
  }
}
