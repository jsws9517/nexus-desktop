/**
 * `attachments_search` — retrieve from the current session's one-time RAG store.
 *
 * The desktop RAG-add flow indexes attachments into a per-session store (see
 * src/agent/attachment-rag.ts). Three retrieval modes, because top-k alone is
 * not enough for the single-file case: a document split into dozens of chunks
 * usually holds the answer in a chunk that top-k misses, and a model that
 * cannot name that chunk falls back to grepping the file from a shell.
 *
 *   search   — relevance-ranked passages (default)
 *   outline  — the file's chunk map, to locate the passage worth reading
 *   chunk    — whole chunks back verbatim, by number
 *
 * The store is session-scoped, so the callable is supplied per-call by
 * AgentService through the ToolContext (a module-level singleton cannot know
 * which session is active).
 */

import type { ToolDef, ToolResult, ToolContext } from './types.js';

export const ATTACHMENT_RAG_TOOL_DEFS: ToolDef[] = [
  {
    name: 'attachments_search',
    description:
      'Search files the user attached to THIS session (they were indexed into a per-session store, not inlined into the chat). ' +
      'Use it to answer questions grounded in those files. This is NOT the knowledge vault — use vault_search for the persistent knowledge library. ' +
      'Recommended flow: (1) call with a query to get ranked passages; (2) if the answer is not there, call with mode="outline" to see the file\'s chunk map; ' +
      '(3) then call with chunk=<n> to read that passage in full. Every result is labelled "file · chunk N/M". ' +
      'If nothing matches, the file catalogue is returned — re-query with terms from it rather than guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (required for mode="search"; omit otherwise).' },
        mode: { type: 'string', enum: ['search', 'outline'], description: 'Retrieval mode (default "search").' },
        chunk: { type: 'integer', minimum: 1, description: '1-based chunk number to read verbatim; combine with count for a range.' },
        count: { type: 'integer', minimum: 1, maximum: 5, description: 'How many chunks to read (default 1, max 5).' },
        file: { type: 'string', description: 'Which attached file; omit when only one is attached.' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, description: 'Passages to return in search mode (default 8).' },
      },
      required: [],
    },
    server: 'attachment-rag-internal',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export const ATTACHMENT_RAG_TOOLS = new Set(ATTACHMENT_RAG_TOOL_DEFS.map((t) => t.name));

function intArg(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

export function callAttachmentRagTool(name: string, args: unknown, ctx?: ToolContext): ToolResult {
  if (name !== 'attachments_search') {
    return { content: `Tool "${name}" not found`, isError: true };
  }
  const a = (args ?? {}) as Record<string, unknown>;
  if (!ctx?.attachmentsSearch) {
    return { content: 'No attachments are available in this context.', isError: false };
  }
  const mode = a.mode === 'outline' ? 'outline' : 'search';
  const query = typeof a.query === 'string' ? a.query.trim() : '';
  const chunk = typeof a.chunk === 'number' ? a.chunk : undefined;
  const count = intArg(a.count, 1, 1, 5);
  const file = typeof a.file === 'string' && a.file.trim() ? a.file.trim() : undefined;
  const topK = intArg(a.top_k, 8, 1, 20);

  // Explicit chunk read wins; it is the "read the passage I just located" call.
  if (chunk !== undefined) {
    if (!Number.isFinite(chunk)) {
      return { content: 'attachments_search: `chunk` must be a number.', isError: true };
    }
    return ctx.attachmentsSearch({ kind: 'chunk', chunk, count, file });
  }
  if (mode === 'outline') {
    return ctx.attachmentsSearch({ kind: 'outline', file });
  }
  if (!query) {
    return {
      content:
        'attachments_search: `query` is required in search mode. Use mode="outline" to list the file\'s chunk map, or chunk=<n> to read a passage.',
      isError: true,
    };
  }
  return ctx.attachmentsSearch({ kind: 'search', query, topK });
}