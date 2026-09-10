/**
 * In-process SQLite MCP tools — a faithful port of the
 * `mcp-server-sqlite` stdio server (dist/index.js) backed by better-sqlite3
 * (already a desktop dependency). Removes the node subprocess spawn and lets
 * write operations flow through the same interactive path-authorization /
 * approval gates as every other built-in tool.
 *
 * - Default database = the one configured in `mcpServers.sqlite.args`
 *   (config grant; opens rw so the very first query can create it, matching the
 *   original mcp-server-sqlite behavior).
 * - A custom `dbPath` must pass authorizePath first and is opened READ-ONLY with
 *   fileMustExist — a missing file yields a hint to create it via a write tool,
 *   never a silent file creation from a read tool.
 * - Read-only tools never prompt. Write tools ask for approval in prompt mode
 *   and go straight through in auto/unattended (mirrors the core's
 *   onPermissionRequest / audit-gate semantics).
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { isAbsolute, normalize, resolve as resolvePath } from 'node:path';
import { authorizePath, revalidateSymlinkGuard } from 'nexus-coder/dist/src/security/path-authorizer.js';
import type { ToolResult, ToolContext } from './types.js';

export type { ToolResult as SqliteToolResult, ToolContext as SqliteToolContext };

const err = (message: string, isError = true): ToolResult => ({
  content: JSON.stringify({ error: message }, null, 2),
  isError,
});

const ok = (payload: unknown, isError = false): ToolResult => ({
  content: JSON.stringify(payload, null, 2),
  isError,
});

// --- SQL safety screen (mirror of the original validateSqlQuery) ---
const DANGEROUS_PATTERNS = [
  /pragma\s+(?!table_info|schema_version|user_version)/,
  /attach\s+database/,
  /detach\s+database/,
] as const;
const READ_ONLY_PATTERNS = [
  /^select\s/,
  /^with\s.*select\s/,
  /^pragma\s+table_info/,
  /^pragma\s+schema_version/,
  /^pragma\s+user_version/,
] as const;

function validateSql(sql: string): { isReadOnly: boolean; error?: string } {
  const trimmed = sql.trim().toLowerCase();
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(trimmed)) return { isReadOnly: false, error: 'Dangerous SQL operation detected' };
  }
  return { isReadOnly: READ_ONLY_PATTERNS.some((p) => p.test(trimmed)) };
}

// --- identifier hardening (structured tools) ---
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Quote a SQL identifier so a crafted table/column name cannot break out of its position. */
function quoteIdent(name: string): string {
  return IDENT_RE.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}
/** Only accept conservative column DEFAULT literals (numbers, quoted strings, NULL, CURRENT_*). */
const SAFE_DEFAULT_RE = /^-?\d+(\.\d+)?$|^'(?:[^']|'')*'$|^NULL$|^CURRENT_(?:TIMESTAMP|DATE|TIME)$/i;

// --- database handles (per-process cache; WAL enables multi-process access) ---
const dbCache = new Map<string, Database.Database>();
function openDb(file: string, readonly = false): Database.Database {
  // Read-only calls must never create/inflate a database file — the sole job of
  // this branch is introspection, so require an existing file and stay RO.
  const key = readonly ? `ro:${file}` : file;
  let db = dbCache.get(key);
  if (db) return db;
  db = new Database(file, readonly ? { readonly: true, fileMustExist: true } : {});
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = 1000000');
    db.pragma('temp_store = memory');
  }
  dbCache.set(key, db);
  return db;
}

/** Close all cached handles (useful for clean shutdown / tests). */
export function closeSqliteDbs(): void {
  for (const [, db] of dbCache) {
    try {
      db.close();
    } catch { /* already closed */ }
  }
  dbCache.clear();
}

function resolveDbPath(args: unknown, ctx?: ToolContext): string {
  const a = (args ?? {}) as { dbPath?: unknown };
  if (typeof a.dbPath === 'string' && a.dbPath.trim()) {
    return normalize(isAbsolute(a.dbPath) ? a.dbPath : resolvePath(process.cwd(), a.dbPath));
  }
  const cfg = ctx?.getConfig?.() as { mcpServers?: Record<string, { args?: string[] }> } | undefined;
  const raw = cfg?.mcpServers?.sqlite?.args ?? [];
  const rest = raw.length > 1 ? raw.slice(1) : [];
  let db: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--db' || arg === '--database') {
      db = rest[i + 1];
      i++;
    } else if (!arg.startsWith('-')) {
      db = arg;
    }
  }
  const p = db ?? process.env.SQLITE_DB_PATH ?? './database.db';
  return normalize(isAbsolute(p) ? p : resolvePath(process.cwd(), p));
}

/** True when the caller explicitly passed a `dbPath` argument (vs. the configured default). */
function isCustomDbArg(args: unknown): boolean {
  const a = (args ?? {}) as { dbPath?: unknown };
  return typeof a.dbPath === 'string' && a.dbPath.trim() !== '';
}

/** Custom dbPath must pass the interactive path authorization. */
async function guardCustomDb(dbPath: string): Promise<string | null> {
  const authorized = await authorizePath(dbPath);
  if (!authorized) return null;
  if (!revalidateSymlinkGuard(dbPath)) return null;
  return dbPath;
}

/**
 * A custom dbPath is discretionary path use, so read tools stay strict:
 * they open readonly and NEVER create a file. Give a clear hint instead of a
 * bare "unable to open database file" so users know to create it via a write
 * tool first.
 */
function missingDbHint(file: string): ToolResult {
  return err(
    `No SQLite database at ${file}. Point dbPath at an existing database file, ` +
      'or create the database first with `execute` / `create-table` (e.g. "CREATE TABLE x (id INTEGER PRIMARY KEY)")',
  );
}

async function writeGate(ctx: ToolContext | undefined, label: string): Promise<boolean> {
  if (!ctx?.requestWriteApproval) return true;
  return ctx.requestWriteApproval(label);
}

// --- tools ---

async function toolQuery(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const sql = typeof args.sql === 'string' ? args.sql : '';
  if (!sql.trim()) return err('Provide a `sql` query.');
  const file = resolveDbPath(args, ctx);
  const custom = isCustomDbArg(args);
  if (custom && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  if (custom && !existsSync(file)) return missingDbHint(file);
  const v = validateSql(sql);
  if (v.error) return err(v.error);
  if (!v.isReadOnly) return err('Only read-only queries are allowed. Use `execute` for write operations.');
  try {
    return ok(openDb(file, custom).prepare(sql).all());
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolExecute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const sql = typeof args.sql === 'string' ? args.sql : '';
  if (!sql.trim()) return err('Provide a `sql` statement.');
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  const v = validateSql(sql);
  if (v.error) return err(v.error);
  if (!(await writeGate(ctx, `execute`))) return err('Write operation denied.');
  try {
    const result = openDb(file).prepare(sql).run();
    return ok({
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
      message: `Statement executed successfully. ${result.changes} row(s) affected.`,
    });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolListTables(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const file = resolveDbPath(args, ctx);
  const custom = isCustomDbArg(args);
  if (custom && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  if (custom && !existsSync(file)) return missingDbHint(file);
  try {
    return ok(openDb(file, custom).prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all());
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function describeTable(file: string, tableName: string, custom: boolean): ToolResult {
  try {
    const db = openDb(file, custom);
    const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
    if (!exists) return err(`Table '${tableName}' does not exist`);
    const q = quoteIdent(tableName);
    const columns = db.prepare(`PRAGMA table_info(${q})`).all();
    const indexes = db.prepare(`PRAGMA index_list(${q})`).all();
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${q})`).all();
    const formatted = (columns as Array<{ name: string; type: string; notnull: number; pk: number; dflt_value?: string | null }>)
      .map((c) => `${c.name}: ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PRIMARY KEY' : ''}${c.dflt_value ? ` DEFAULT ${c.dflt_value}` : ''}`)
      .join('\n');
    return ok({ tableName, columns, indexes, foreignKeys, columnCount: columns.length, formattedColumns: formatted });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolDescribeTable(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const tableName = typeof args.tableName === 'string' ? args.tableName : '';
  if (!tableName) return err('Provide a `tableName`.');
  const file = resolveDbPath(args, ctx);
  const custom = isCustomDbArg(args);
  if (custom && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  if (custom && !existsSync(file)) return missingDbHint(file);
  return describeTable(file, tableName, custom);
}

async function toolCreateTable(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  const columns = Array.isArray(args.columns) ? (args.columns as Array<Record<string, unknown>>) : [];
  if (!name || columns.length === 0) return err('`name` and a non-empty `columns` array are required.');
  if (!(await writeGate(ctx, 'create-table'))) return err('Write operation denied.');
  let defs: string[];
  try {
    const spans = columns.map((col) => {
      let def = `${quoteIdent(String(col.name ?? ''))} ${String(col.type ?? '')}`;
      if (col.primaryKey) def += ' PRIMARY KEY';
      if (col.notNull) def += ' NOT NULL';
      if (col.unique) def += ' UNIQUE';
      if (col.defaultValue !== undefined && col.defaultValue !== null) {
        const lit = String(col.defaultValue);
        if (!SAFE_DEFAULT_RE.test(lit)) throw new Error(`Unsafe defaultValue literal: ${lit}`);
        def += ` DEFAULT ${lit}`;
      }
      return def;
    });
    defs = spans;
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  const ifNotExists = args.ifNotExists === false ? false : true;
  const statement = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quoteIdent(name)} (${defs.join(', ')})`;
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  try {
    const result = openDb(file).prepare(statement).run();
    return ok({ message: `Table '${name}' created successfully`, sql: statement, changes: result.changes });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolDropTable(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) return err('Provide a `name`.');
  if (!(await writeGate(ctx, 'drop-table'))) return err('Write operation denied.');
  const statement = `DROP TABLE ${args.ifExists === false ? '' : 'IF EXISTS '}${quoteIdent(name)}`;
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  try {
    const result = openDb(file).prepare(statement).run();
    return ok({ message: `Table '${name}' dropped successfully`, sql: statement, changes: result.changes });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolInsertRecord(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const table = typeof args.table === 'string' ? args.table : '';
  const data = (args.data ?? {}) as Record<string, unknown>;
  if (!table || Object.keys(data).length === 0) return err('`table` and `data` are required.');
  if (!(await writeGate(ctx, 'insert-record'))) return err('Write operation denied.');
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map(() => '?').join(', ');
  const statement = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  try {
    const result = openDb(file).prepare(statement).run(...values);
    return ok({ message: 'Record inserted successfully', insertedId: result.lastInsertRowid, changes: result.changes, sql: statement });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolUpdateRecord(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const table = typeof args.table === 'string' ? args.table : '';
  const data = (args.data ?? {}) as Record<string, unknown>;
  const where = typeof args.where === 'string' ? args.where : '';
  if (!table || Object.keys(data).length === 0 || where.trim() === '') return err('`table`, `data` and `where` are required.');
  if (!(await writeGate(ctx, 'update-record'))) return err('Write operation denied.');
  const setClause = Object.keys(data).map((k) => `${quoteIdent(k)} = ?`).join(', ');
  const statement = `UPDATE ${quoteIdent(table)} SET ${setClause} WHERE ${where}`;
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  try {
    const result = openDb(file).prepare(statement).run(...Object.values(data));
    return ok({ message: 'Records updated successfully', changes: result.changes, sql: statement });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolDeleteRecord(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const table = typeof args.table === 'string' ? args.table : '';
  const where = typeof args.where === 'string' ? args.where : '';
  if (!table || where.trim() === '') return err('`table` and `where` are required.');
  if (!(await writeGate(ctx, 'delete-record'))) return err('Write operation denied.');
  const statement = `DELETE FROM ${quoteIdent(table)} WHERE ${where}`;
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  try {
    const result = openDb(file).prepare(statement).run();
    return ok({ message: 'Records deleted successfully', changes: result.changes, sql: statement });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function toolTransaction(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const statements = Array.isArray(args.statements) ? (args.statements as string[]) : [];
  if (statements.length === 0) return err('`statements` must be a non-empty array of SQL.');
  if (!(await writeGate(ctx, 'transaction'))) return err('Write operation denied.');
  for (const stmt of statements) {
    const v = validateSql(stmt);
    if (v.error) return err(`Invalid SQL: ${v.error}`);
  }
  const file = resolveDbPath(args, ctx);
  if (isCustomDbArg(args) && (await guardCustomDb(file)) === null) {
    return err(`Database path denied by permissions system: ${file}`);
  }
  try {
    const db = openDb(file);
    const results = db.transaction((stmts: string[]) => {
      return stmts.map((stmt) => {
        const r = db.prepare(stmt).run();
        return { sql: stmt, changes: r.changes, lastInsertRowid: r.lastInsertRowid };
      });
    })(statements);
    return ok({ message: 'Transaction completed successfully', results, totalStatements: statements.length });
  } catch (e) {
    return err(`Database error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function callSqliteTool(
  name: string,
  args: unknown,
  ctx?: ToolContext,
): Promise<ToolResult> | ToolResult {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'query':
      return toolQuery(a, ctx);
    case 'execute':
      return toolExecute(a, ctx);
    case 'list-tables':
      return toolListTables(a, ctx);
    case 'describe-table':
      return toolDescribeTable(a, ctx);
    case 'create-table':
      return toolCreateTable(a, ctx);
    case 'drop-table':
      return toolDropTable(a, ctx);
    case 'insert-record':
      return toolInsertRecord(a, ctx);
    case 'update-record':
      return toolUpdateRecord(a, ctx);
    case 'delete-record':
      return toolDeleteRecord(a, ctx);
    case 'transaction':
      return toolTransaction(a, ctx);
    default:
      return err(`Tool "${name}" not found`);
  }
}

const DB_PROP = { type: 'string', description: 'Optional SQLite database file path (absolute or cwd-relative). Defaults to the configured sqlite MCP database; a custom path must be authorized (may raise an Allow/Deny prompt).' };

export const SQLITE_TOOL_DEFS = [
  {
    name: 'query',
    description: 'Execute a read-only SQL query (SELECT / WITH … SELECT / safe PRAGMA) and return the result rows as JSON. Dangerous SQL (PRAGMA mutation, ATTACH/DETACH) is rejected. Add `dbPath` to target another database.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'Read-only SQL query' }, dbPath: DB_PROP }, required: ['sql'] },
    server: 'sqlite-internal',
  },
  {
    name: 'execute',
    description: 'Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE, CREATE, DROP). Validated against dangerous SQL (PRAGMA mutation / ATTACH / DETACH are blocked). Requires approval in interactive mode; auto/unattended run it directly.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'SQL statement' }, dbPath: DB_PROP }, required: ['sql'] },
    server: 'sqlite-internal',
  },
  {
    name: 'list-tables',
    description: 'List all tables (name + CREATE SQL) in the database.',
    inputSchema: { type: 'object', properties: { dbPath: DB_PROP } },
    server: 'sqlite-internal',
  },
  {
    name: 'describe-table',
    description: 'Describe a table: columns, indexes, foreign keys (JSON).',
    inputSchema: { type: 'object', properties: { tableName: { type: 'string', description: 'Table name' }, dbPath: DB_PROP }, required: ['tableName'] },
    server: 'sqlite-internal',
  },
  {
    name: 'create-table',
    description: 'Create a table with a structured column list. Write tool (approval in interactive mode).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Table name' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', description: 'TEXT/INTEGER/REAL/BLOB' },
              primaryKey: { type: 'boolean' },
              notNull: { type: 'boolean' },
              unique: { type: 'boolean' },
              defaultValue: { type: 'string', description: 'SQL default value literal' },
            },
            required: ['name', 'type'],
          },
        },
        ifNotExists: { type: 'boolean', description: 'Add IF NOT EXISTS (default true)' },
        dbPath: DB_PROP,
      },
      required: ['name', 'columns'],
    },
    server: 'sqlite-internal',
  },
  {
    name: 'drop-table',
    description: 'Drop a table. Write tool (approval in interactive mode).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Table to drop' }, ifExists: { type: 'boolean', description: 'Add IF EXISTS (default true)' }, dbPath: DB_PROP }, required: ['name'] },
    server: 'sqlite-internal',
  },
  {
    name: 'insert-record',
    description: 'Insert a record into a table. Write tool (approval in interactive mode).',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, data: { type: 'object', additionalProperties: true, description: 'Column → value map' }, dbPath: DB_PROP }, required: ['table', 'data'] },
    server: 'sqlite-internal',
  },
  {
    name: 'update-record',
    description: 'Update records. Write tool (approval in interactive mode).',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, data: { type: 'object', additionalProperties: true }, where: { type: 'string', description: 'WHERE clause (mandatory)' }, dbPath: DB_PROP }, required: ['table', 'data', 'where'] },
    server: 'sqlite-internal',
  },
  {
    name: 'delete-record',
    description: 'Delete records matching a mandatory WHERE clause. Write tool (approval in interactive mode).',
    inputSchema: { type: 'object', properties: { table: { type: 'string' }, where: { type: 'string', description: 'WHERE clause (mandatory)' }, dbPath: DB_PROP }, required: ['table', 'where'] },
    server: 'sqlite-internal',
  },
  {
    name: 'transaction',
    description: 'Execute multiple SQL statements atomically in a transaction. Write tool (approval in interactive mode).',
    inputSchema: { type: 'object', properties: { statements: { type: 'array', items: { type: 'string' } }, dbPath: DB_PROP }, required: ['statements'] },
    server: 'sqlite-internal',
  },
];

export const SQLITE_TOOLS = new Set(SQLITE_TOOL_DEFS.map((t) => t.name));