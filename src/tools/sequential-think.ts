/**
 * In-process reimplementation of the @modelcontextprotocol/server-sequential-thinking
 * MCP server (behavior mirrored from the 2026.8.31 release `dist/lib.js`).
 *
 * Serving it in-process removes the desktop's ONLY autoStart:true external
 * spawn (`cmd /c npx -y @modelcontextprotocol/server-sequential-thinking`) —
 * npx cold-start / registry-network hang window disappears entirely.
 *
 * The tool is stateless toward the user's data: it only keeps a per-worker
 * thought history + branch registry to report how the reasoning chain evolved.
 */

import type { ToolResult } from './types.js';

export type { ToolResult as ThinkingResult };

function coerceInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

const err = (message: string): ToolResult => ({
  content: JSON.stringify({ error: message, status: 'failed' }, null, 2),
  isError: true,
});

const MAX_HISTORY = 1000;

class SequentialThinker {
  private thoughtHistory: Array<Record<string, unknown>> = [];
  // Map (not a plain object) so crafted branchId values like `__proto__` /
  // `constructor` can never touch the prototype chain.
  private branches = new Map<string, Array<Record<string, unknown>>>();
  private branchOrder: string[] = [];

  process(input: Record<string, unknown>): ToolResult {
    try {
      // Required args (mirror the server's zod coercions / validation layer).
      const thought = input.thought;
      if (typeof thought !== 'string' || thought.trim() === '' || (thought as string).length > 1_000_000) {
        return err('`thought` must be a non-empty string.');
      }
      const thoughtNumber = coerceInt(input.thoughtNumber);
      if (thoughtNumber === null) return err('`thoughtNumber` must be an integer >= 1.');
      let totalThoughts = coerceInt(input.totalThoughts);
      if (totalThoughts === null) return err('`totalThoughts` must be an integer >= 1.');
      const nextThoughtNeeded = coerceBool(input.nextThoughtNeeded);
      if (nextThoughtNeeded === null) return err('`nextThoughtNeeded` must be true/false or "true"/"false".');

      // Optional args — a provided value with the wrong type fails like zod would.
      if (input.isRevision !== undefined && coerceBool(input.isRevision) === null) {
        return err('`isRevision` must be a boolean or "true"/"false".');
      }
      if (input.needsMoreThoughts !== undefined && coerceBool(input.needsMoreThoughts) === null) {
        return err('`needsMoreThoughts` must be a boolean or "true"/"false".');
      }
      if (input.revisesThought !== undefined && coerceInt(input.revisesThought) === null) {
        return err('`revisesThought` must be an integer >= 1.');
      }
      if (input.branchFromThought !== undefined && coerceInt(input.branchFromThought) === null) {
        return err('`branchFromThought` must be an integer >= 1.');
      }
      if (input.branchId !== undefined && typeof input.branchId !== 'string') {
        return err('`branchId` must be a string.');
      }

      // Behavior from dist/lib.js processThought().
      if (thoughtNumber > totalThoughts) totalThoughts = thoughtNumber;
      this.thoughtHistory.push(input);
      if (this.thoughtHistory.length > MAX_HISTORY) {
        this.thoughtHistory.splice(0, this.thoughtHistory.length - MAX_HISTORY);
      }
      const branchFrom = coerceInt(input.branchFromThought);
      const branchId = input.branchId;
      if (branchFrom !== null && typeof branchId === 'string') {
        if (!this.branches.has(branchId)) {
          this.branches.set(branchId, []);
          this.branchOrder.push(branchId);
          // Bounded like history: drop the oldest branch registry when over cap.
          if (this.branchOrder.length > MAX_HISTORY) {
            const oldest = this.branchOrder.shift();
            if (oldest !== undefined) this.branches.delete(oldest);
          }
        }
        this.branches.get(branchId)!.push(input);
      }

      return {
        content: JSON.stringify(
          {
            thoughtNumber,
            totalThoughts,
            nextThoughtNeeded,
            branches: this.branchOrder,
            thoughtHistoryLength: this.thoughtHistory.length,
          },
          null,
          2,
        ),
      };
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }
}

// One thinker per worker process (each Desktop tab owns its reasoning chain),
// matching the per-process singleton nature of the external stdio server.
const thinker = new SequentialThinker();

export function callSequentialThinkTool(name: string, args: unknown): ToolResult {
  if (name !== 'sequentialthinking') {
    return err(`Tool "${name}" not found`);
  }
  return thinker.process((args ?? {}) as Record<string, unknown>);
}

const DESCR = [
  'A detailed tool for dynamic and reflective problem-solving through thoughts.',
  'Use it to break complex problems into steps, plan with room for revision, maintain context across steps,',
  'branch/backtrack, generate a solution hypothesis, verify it, then provide a single ideally-correct answer.',
  '',
  'Params: thought (current step, may revise/ask previous/branch/hypothesize), nextThoughtNeeded (true if more steps needed,',
  'even at what seemed like the end), thoughtNumber (current sequence number, may exceed total), totalThoughts (current estimate,',
  'adjustable), isRevision (whether this revises earlier thinking) + revisesThought (which number),',
  'branchFromThought + branchId (branching point + id), needsMoreThoughts (more steps needed at the end).',
  '',
  'Workflow: estimate totalThoughts, revise as you go, question/revise previous thoughts, mark revisions/branches,',
  'express uncertainty, ignore irrelevant info, generate + verify a hypothesis, repeat until satisfied,',
  'set nextThoughtNeeded=false only when a satisfactory final answer is reached.',
].join('\n');

export const SEQUENTIAL_THINK_TOOL_DEFS = [
  {
    name: 'sequentialthinking',
    description: DESCR,
    inputSchema: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your current thinking step (may revise, branch, or hypothesize)' },
        nextThoughtNeeded: { type: 'boolean', description: 'Whether another thought step is needed' },
        thoughtNumber: { type: 'integer', minimum: 1, description: 'Current thought number (e.g. 1, 2, 3)' },
        totalThoughts: { type: 'integer', minimum: 1, description: 'Estimated total thoughts needed' },
        isRevision: { type: 'boolean', description: 'Whether this revises previous thinking' },
        revisesThought: { type: 'integer', minimum: 1, description: 'Which thought is being reconsidered' },
        branchFromThought: { type: 'integer', minimum: 1, description: 'Branching point thought number' },
        branchId: { type: 'string', description: 'Branch identifier' },
        needsMoreThoughts: { type: 'boolean', description: 'Whether more thoughts are needed at the end' },
      },
      required: ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    server: 'sequential-thinking-internal',
  },
];

export const SEQUENTIAL_THINK_TOOLS = new Set(SEQUENTIAL_THINK_TOOL_DEFS.map((t) => t.name));