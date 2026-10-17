/**
 * Desktop thin wrapper for the core memory-kg module.
 *
 * Re-exports everything from nexus-coder's built-in knowledge-graph memory
 * implementation so that callers in mcp-hub.ts and service.ts remain unchanged.
 * The only desktop-specific behaviour is the singleton `memoryKg`, initialised
 * with the same path resolution logic (reads MEMORY_FILE_PATH from config.json
 * as a fallback before delegating to the core's default dataPath).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  INTERNAL_MEMORY_TOOLS,
  MEMORY_WRITE_TOOLS,
  MEMORY_TOOL_DEFS,
  callMemoryTool,
  KnowledgeGraphManager,
} from 'nexus-coder/dist/src/mcp/memory-kg.js';

export { INTERNAL_MEMORY_TOOLS, MEMORY_WRITE_TOOLS, MEMORY_TOOL_DEFS, callMemoryTool };

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

/** Singleton owned by the main process (single writer). */
export const memoryKg = new KnowledgeGraphManager(defaultMemoryFilePath());
