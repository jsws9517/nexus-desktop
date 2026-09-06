/**
 * Built-in knowledge-graph memory (replaces the external `server-memory` MCP
 * dependency for the desktop app).
 *
 * Compatible with @modelcontextprotocol/server-memory's JSONL on disk, so the
 * existing `memory.jsonl` is reused as-is (no migration). Unlike the MCP
 * child-process route, this runs in-process in the main process:
 *   - single writer (no multi-instance temp-file/lock races on Windows),
 *   - mutations are serialized on an internal queue (same single-threaded
 *     semantics as the original server),
 *   - reads/writes are plain local I/O and fail fast with a readable error
 *     instead of hanging until a 30s MCP timeout.
 */

import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../shared/logger.js';

interface KgEntity {
  name: string;
  entityType: string;
  observations: string[];
}

interface KgRelation {
  from: string;
  to: string;
  relationType: string;
}

interface KnowledgeGraph {
  entities: KgEntity[];
  relations: KgRelation[];
}

const EMPTY_GRAPH: KnowledgeGraph = { entities: [], relations: [] };

/** Resolve the memory file the config used to pass via MEMORY_FILE_PATH. */
function defaultMemoryFilePath(): string {
  const base = process.env.LLMA_DATA_DIR
    ? join(process.env.LLMA_DATA_DIR, '.nexus')
    : join(homedir(), '.nexus');
  try {
    const cfg = JSON.parse(readFileSync(join(base, 'config.json'), 'utf-8')) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    const path = cfg.mcpServers?.memory?.env?.MEMORY_FILE_PATH;
    if (typeof path === 'string' && path) return path;
  } catch {
    /* fall through to default */
  }
  return join(base, 'native', 'data', 'memory.jsonl');
}

class KnowledgeGraphManager {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file?: string) {
    this.file = file ?? defaultMemoryFilePath();
  }

  get memoryFilePath(): string {
    return this.file;
  }

  /** Serialize every operation so read-modify-write never interleaves. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.file, 'utf-8');
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      const graph: KnowledgeGraph = { entities: [], relations: [] };
      for (const line of lines) {
        const item = JSON.parse(line) as {
          type?: string;
          name?: string;
          entityType?: string;
          observations?: string[];
          from?: string;
          to?: string;
          relationType?: string;
        };
        if (item.type === 'entity') {
          graph.entities.push({
            name: item.name ?? '',
            entityType: item.entityType ?? '',
            observations: item.observations ?? [],
          });
        } else if (item.type === 'relation') {
          graph.relations.push({
            from: item.from ?? '',
            to: item.to ?? '',
            relationType: item.relationType ?? '',
          });
        }
      }
      return graph;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_GRAPH;
      throw err;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map((e) =>
        JSON.stringify({ type: 'entity', name: e.name, entityType: e.entityType, observations: e.observations }),
      ),
      ...graph.relations.map((r) =>
        JSON.stringify({ type: 'relation', from: r.from, to: r.to, relationType: r.relationType }),
      ),
    ];
    const directory = dirname(this.file);
    await fs.mkdir(directory, { recursive: true });
    const tmp = join(directory, `${basename(this.file)}.${randomBytes(16).toString('hex')}.tmp`);
    try {
      await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  createEntities(entities: KgEntity[]): Promise<KgEntity[]> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const fresh = entities.filter(
        (e) => !graph.entities.some((existing) => existing.name === e.name),
      );
      graph.entities.push(...fresh);
      await this.saveGraph(graph);
      return fresh;
    });
  }

  createRelations(relations: KgRelation[]): Promise<KgRelation[]> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const fresh = relations.filter(
        (r) =>
          !graph.relations.some(
            (existing) =>
              existing.from === r.from && existing.to === r.to && existing.relationType === r.relationType,
          ),
      );
      graph.relations.push(...fresh);
      await this.saveGraph(graph);
      return fresh;
    });
  }

  addObservations(
    observations: Array<{ entityName: string; contents: string[] }>,
  ): Promise<Array<{ entityName: string; addedObservations: string[] }>> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const results = observations.map((o) => {
        const entity = graph.entities.find((e) => e.name === o.entityName);
        if (!entity) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        const added = o.contents.filter((c) => !entity.observations.includes(c));
        entity.observations.push(...added);
        return { entityName: o.entityName, addedObservations: added };
      });
      await this.saveGraph(graph);
      return results;
    });
  }

  deleteEntities(entityNames: string[]): Promise<void> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const doomed = new Set(entityNames);
      graph.entities = graph.entities.filter((e) => !doomed.has(e.name));
      graph.relations = graph.relations.filter((r) => !doomed.has(r.from) && !doomed.has(r.to));
      await this.saveGraph(graph);
    });
  }

  deleteObservations(deletions: Array<{ entityName: string; observations: string[] }>): Promise<void> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const drop = new Map<string, Set<string>>(
        deletions.map((d) => [d.entityName, new Set(d.observations)]),
      );
      for (const entity of graph.entities) {
        const set = drop.get(entity.name);
        if (set) entity.observations = entity.observations.filter((o) => !set.has(o));
      }
      await this.saveGraph(graph);
    });
  }

  deleteRelations(relations: KgRelation[]): Promise<void> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      graph.relations = graph.relations.filter(
        (r) =>
          !relations.some(
            (del) => del.from === r.from && del.to === r.to && del.relationType === r.relationType,
          ),
      );
      await this.saveGraph(graph);
    });
  }

  readGraph(): Promise<KnowledgeGraph> {
    return this.enqueue(() => this.loadGraph());
  }

  searchNodes(query: string): Promise<KnowledgeGraph> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const q = query.toLowerCase();
      const matched = graph.entities.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.entityType.toLowerCase().includes(q) ||
          e.observations.some((o) => o.toLowerCase().includes(q)),
      );
      const matchedNames = new Set(matched.map((e) => e.name));
      return {
        entities: matched,
        relations: graph.relations.filter((r) => matchedNames.has(r.from) || matchedNames.has(r.to)),
      };
    });
  }

  openNodes(names: string[]): Promise<KnowledgeGraph> {
    return this.enqueue(async () => {
      const graph = await this.loadGraph();
      const wanted = new Set(names);
      const matched = graph.entities.filter((e) => wanted.has(e.name));
      const matchedNames = new Set(matched.map((e) => e.name));
      return {
        entities: matched,
        relations: graph.relations.filter((r) => matchedNames.has(r.from) || matchedNames.has(r.to)),
      };
    });
  }
}

/** Singleton owned by the main process (single writer). */
export const memoryKg = new KnowledgeGraphManager();

export type MemoryToolResult = { content: string; isError: boolean };

/** Names handled by the built-in engine (not the external MCP server). */
export const INTERNAL_MEMORY_TOOLS = new Set([
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_observations',
  'delete_relations',
  'read_graph',
  'search_nodes',
  'open_nodes',
]);

/** Memory tools that mutate the knowledge graph (need an approval gate). */
export const MEMORY_WRITE_TOOLS = new Set([
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_observations',
  'delete_relations',
]);

export interface MemToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  server: string;
}

const STR = (description: string): unknown => ({ type: 'string', description });
const STRARRAY = (description: string): unknown => ({
  type: 'array',
  items: { type: 'string', description },
  description,
});

export const MEMORY_TOOL_DEFS: MemToolDef[] = [
  {
    name: 'create_entities',
    description: 'Create multiple new entities in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: STR('The name of the entity'),
              entityType: STR('The type of the entity'),
              observations: STRARRAY('An array of observation contents associated with the entity'),
            },
            required: ['name', 'entityType', 'observations'],
          },
        },
      },
      required: ['entities'],
    },
    server: 'memory-internal',
  },
  {
    name: 'create_relations',
    description: 'Create multiple new relations between entities in the knowledge graph. Relations should be in active voice',
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: STR('The name of the entity where the relation starts'),
              to: STR('The name of the entity where the relation ends'),
              relationType: STR('The type of the relation'),
            },
            required: ['from', 'to', 'relationType'],
          },
        },
      },
      required: ['relations'],
    },
    server: 'memory-internal',
  },
  {
    name: 'add_observations',
    description: 'Add new observations to existing entities in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entityName: STR('The name of the entity to add the observations to'),
              contents: STRARRAY('An array of observation contents to add'),
            },
            required: ['entityName', 'contents'],
          },
        },
      },
      required: ['observations'],
    },
    server: 'memory-internal',
  },
  {
    name: 'delete_entities',
    description: 'Delete multiple entities and their associated relations from the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        entityNames: STRARRAY('An array of entity names to delete'),
      },
      required: ['entityNames'],
    },
    server: 'memory-internal',
  },
  {
    name: 'delete_observations',
    description: 'Delete specific observations from entities in the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        deletions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entityName: STR('The name of the entity containing the observations'),
              observations: STRARRAY('An array of observations to delete'),
            },
            required: ['entityName', 'observations'],
          },
        },
      },
      required: ['deletions'],
    },
    server: 'memory-internal',
  },
  {
    name: 'delete_relations',
    description: 'Delete multiple relations from the knowledge graph',
    inputSchema: {
      type: 'object',
      properties: {
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: STR('The name of the entity where the relation starts'),
              to: STR('The name of the entity where the relation ends'),
              relationType: STR('The type of the relation'),
            },
            required: ['from', 'to', 'relationType'],
          },
        },
      },
      required: ['relations'],
    },
    server: 'memory-internal',
  },
  {
    name: 'read_graph',
    description: 'Read the entire knowledge graph',
    inputSchema: { type: 'object', properties: {} },
    server: 'memory-internal',
  },
  {
    name: 'search_nodes',
    description: 'Search for nodes in the knowledge graph based on a query',
    inputSchema: {
      type: 'object',
      properties: {
        query: STR('The search query to match against entity names, types, and observation content'),
      },
      required: ['query'],
    },
    server: 'memory-internal',
  },
  {
    name: 'open_nodes',
    description: 'Open specific nodes in the knowledge graph by their names',
    inputSchema: {
      type: 'object',
      properties: {
        names: STRARRAY('An array of entity names to retrieve'),
      },
      required: ['names'],
    },
    server: 'memory-internal',
  },
];

function asEntities(v: unknown): KgEntity[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      name: typeof e.name === 'string' ? e.name : '',
      entityType: typeof e.entityType === 'string' ? e.entityType : '',
      observations: Array.isArray(e.observations) ? e.observations.map(String) : [],
    }));
}

function asRelations(v: unknown): KgRelation[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      from: typeof r.from === 'string' ? r.from : '',
      to: typeof r.to === 'string' ? r.to : '',
      relationType: typeof r.relationType === 'string' ? r.relationType : '',
    }));
}

function asObservations(v: unknown): Array<{ entityName: string; contents: string[] }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      entityName: typeof o.entityName === 'string' ? o.entityName : '',
      contents: Array.isArray(o.contents) ? o.contents.map(String) : [],
    }));
}

function asNames(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function asDeletions(v: unknown): Array<{ entityName: string; observations: string[] }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      entityName: typeof o.entityName === 'string' ? o.entityName : '',
      observations: Array.isArray(o.observations) ? o.observations.map(String) : [],
    }));
}

/** Dispatch an internal memory tool call, mirroring the MCP `{content,isError}` shape. */
export async function callMemoryTool(name: string, args: Record<string, unknown>): Promise<MemoryToolResult> {
  try {
    switch (name) {
      case 'read_graph':
        return ok(JSON.stringify(await memoryKg.readGraph(), null, 2));
      case 'search_nodes':
        return ok(JSON.stringify(await memoryKg.searchNodes(args.query ? String(args.query) : ''), null, 2));
      case 'open_nodes':
        return ok(JSON.stringify(await memoryKg.openNodes(asNames(args.names)), null, 2));
      case 'create_entities':
        return ok(JSON.stringify(await memoryKg.createEntities(asEntities(args.entities)), null, 2));
      case 'create_relations':
        return ok(JSON.stringify(await memoryKg.createRelations(asRelations(args.relations)), null, 2));
      case 'add_observations':
        return ok(JSON.stringify(await memoryKg.addObservations(asObservations(args.observations)), null, 2));
      case 'delete_entities':
        await memoryKg.deleteEntities(asNames(args.entityNames));
        return ok('Entities deleted successfully');
      case 'delete_observations':
        await memoryKg.deleteObservations(asDeletions(args.deletions));
        return ok('Observations deleted successfully');
      case 'delete_relations':
        await memoryKg.deleteRelations(asRelations(args.relations));
        return ok('Relations deleted successfully');
      default:
        return { content: `Tool "${name}" is not an internal memory tool`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[memory-kg] "${name}" failed: ${msg}`);
    return { content: `Memory tool "${name}" failed: ${msg}`, isError: true };
  }
}

function ok(content: string): MemoryToolResult {
  return { content, isError: false };
}