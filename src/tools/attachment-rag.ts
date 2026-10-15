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

/** Knowledge-vault tools the session store takes precedence over. */
export const VAULT_TOOLS = ['vault_search', 'vault_open', 'vault_write'] as const;

export interface HideVaultToolsInput {
  /** Plan mode or a role-scoped allowlist is a deliberate core restriction. */
  respectNarrowing: boolean;
  /** The session has RAG attachments indexed. */
  hasAttachments: boolean;
  /** This round's input actually retrieves from those attachments. */
  hasHits: boolean;
  /** The user named a vault tool outright in this round's input. */
  namesVaultTool: boolean;
  /** Tool names the model explicitly asked for via refresh_tools. */
  force: ReadonlySet<string>;
}

/**
 * Whether the knowledge-vault tools should be withheld for this round.
 *
 * `vault_search` is pinned in the core's `essentialTools`, so it is offered on
 * every round regardless of relevance, and its description reads like a generic
 * document search. With a one-time attachment actually matching, that steals the
 * round: the model reaches for the vault, gets an empty library back, and only
 * then tries the attachments. Hiding is therefore conditional and deliberately
 * narrow — the vault is withheld only when the session store both holds files
 * and answers THIS input, and never when the user asked for it by name or the
 * model requested it via refresh_tools, so both escape hatches stay real.
 */
export function shouldHideVaultTools(input: HideVaultToolsInput): boolean {
  if (input.respectNarrowing) return false;
  if (!input.hasAttachments || !input.hasHits) return false;
  // An explicit request outranks an inferred intent: silently dropping a tool
  // the user just named is how "I have no vault_search tool" gets said out loud.
  if (input.namesVaultTool) return false;
  return !VAULT_TOOLS.some((name) => input.force.has(name));
}

/** Did this round's input name a vault tool outright? */
export function inputNamesVaultTool(input: string): boolean {
  const lower = input.toLowerCase();
  return VAULT_TOOLS.some((name) => lower.includes(name));
}

function intArg(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

export function callAttachmentRagTool(
  name: string,
  args: unknown,
  ctx?: ToolContext,
): ToolResult | Promise<ToolResult> {
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