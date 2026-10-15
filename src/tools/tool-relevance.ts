/**
 * Per-round tool relevance selection.
 *
 * Replaces the core's binary keyword filter on the desktop side. The core
 * (nexus-coder/src/agent.ts getToolsForContext) keeps a tool when a token
 * derived from the user message appears verbatim in `name + description`. That
 * has two failure modes:
 *
 *   1. False negative — a Chinese prompt yields CJK bigrams, which can never
 *      substring-match an English description, so the tool silently vanishes and
 *      the model is never offered it. (This is what broke `spawn_subagent`.)
 *   2. No ranking — the survivors are unordered and uncapped, so 48 always-tagged
 *      main-process tools and 23 flat skill tools ride along on every round.
 *
 * This module scores instead of matching, and fails open: see `selectTools`.
 * It is called once per LLM round (the core re-enters runLlmTurn after tool
 * results), so mid-turn intent changes re-select automatically.
 *
 * Scoring is deliberately local and deterministic. An extra LLM call to pick
 * tools would cost more than the tokens it saves and add latency.
 */

import type { ToolDef } from './types.js';

/**
 * Language-agnostic similarity, lifted from the core's ACP intent matcher
 * (nexus-coder/src/acp/bridge/intent.ts tokenOverlap). Character bigrams need
 * no tokenizer and degrade gracefully on CJK, which is the whole point: the
 * core's whitespace-token approach cannot see Chinese at all.
 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length === 0) return out;
  if (t.length === 1) {
    out.add(t);
    return out;
  }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Jaccard overlap of two bigram sets, 0..1. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Weights. Keyword hits dominate because they are the only language-neutral signal. */
const W_KEYWORD = 1.0;
const W_MEMORY = 0.6;
const W_GROUP = 0.25;
const W_SIMILARITY = 0.8;

/**
 * Bigram overlap required to keep a tool on similarity alone.
 *
 * This has to be a real threshold, not `> 0`. Jaccard on a short mixed
 * CJK/ASCII prompt leaks badly at the low end: "修复 acp-router 里的路径校验 bug"
 * shares the bigrams "ac","cp" with almost any description containing "acp", and
 * a `> 0` rule then keeps essentially the whole catalogue — measurably worse than
 * the core's binary filter it replaces.
 */
const SIMILARITY_KEEP = 0.22;

/**
 * Never drop below this many tools, whatever the scores say. Guarantees the
 * model always has something to reach for, so a mis-scored turn degrades to
 * "a few plausible options" rather than "nothing".
 */
const MIN_KEPT = 24;

/**
 * Hard cap. Deliberately well below the ~118-tool unfiltered surface: the point
 * of the selector is that a round carries a working set, not the whole catalogue.
 */
const MAX_KEPT = 48;

/**
 * Always-available floor. Mirrors the core's own `essentialTools` allowlist
 * (nexus-coder/src/agent.ts) plus the desktop's own load-bearing tools, so the
 * selector never fights the core's plan-mode / role-allowlist narrowing.
 */
export const ESSENTIAL_TOOLS: ReadonlySet<string> = new Set([
  // files
  'file_read', 'read_text_file', 'read_multiple_files', 'list_directory',
  'directory_tree', 'get_file_info', 'file_write', 'write_file', 'edit_file',
  'file_edit', 'create_file', 'append_file', 'read_media_file',
  'list_directory_with_sizes', 'list_allowed_directories',
  // exec
  'exec_command',
  // web
  'fetch_url', 'web_search', 'web_fetch',
  // task / sub-agent
  'decompose_task', 'query_tasks',
  'spawn_subagent', 'spawn_tester', 'spawn_committer', 'spawn_skill_fixer', 'spawn_office',
  'bg_job',
  // media
  'analyze_image', 'ocr_extract', 'transcribe_audio', 'synthesize_speech',
  // memory + recall
  'remember', 'recall', 'remember_project',
  // session
  'last_session', 'search_sessions', 'set_project_location',
  // meta: the model must always be able to widen its own toolset
  'refresh_tools',
  'skills_index', 'skills_search', 'skills_load',
  // One-time attachment RAG: the ONLY way to reach the current session's
  // indexed attachments. Relevance scoring drops it even for prompts that say
  // "附件" outright (the corpus of Chinese triggers is far smaller than the
  // pool), and with the Hybrid auto-inject capped it is the retrieval path for
  // every larger set. It is inert (returns "nothing indexed") when the session
  // has no attachments, so pinning costs nothing.
  'attachments_search',
  // Mirrors the core's own essentialTools (src/agent.ts). The desktop replaces
  // the core's tool list with this selector's output, so anything the core
  // pins must be pinned here too — otherwise it becomes hideable in
  // practice: `vault_search` was silently dropped from every round, and a user
  // who typed "use vault_search" was told the tool did not exist.
  // test/tool-relevance.test.mjs guards this parity in both directions.
  'vault_search', 'vault_open', 'vault_write',
]);

export interface ScoreOptions {
  /** Raw user input for this round (already includes any mid-turn steer). */
  input: string;
  /** Tool names already invoked this session — a proven-useful prior. */
  used: ReadonlySet<string>;
  /** Extra names to force in, e.g. from a pending `refresh_tools` request. */
  force?: ReadonlySet<string>;
  /** Set when the core has already narrowed for plan mode / a role allowlist. */
  respectNarrowing?: boolean;
}

/**
 * Per-tool relevance score. Used for *ranking* only — the keep/drop decision is
 * `isRelevant`, which thresholds each channel separately. Exported for tests.
 */
export function scoreTool(
  def: ToolDef,
  inputBigrams: Set<string>,
  opts: ScoreOptions,
): number {
  let score = 0;
  if (keywordHit(def, opts.input)) score += W_KEYWORD;
  if (opts.used.has(def.name)) score += W_MEMORY;
  if (opts.force?.has(def.name)) score += W_KEYWORD;

  const sim = similarity(def, inputBigrams);
  score += W_SIMILARITY * sim;
  if (sim >= SIMILARITY_KEEP) score += W_GROUP;
  return score;
}

/** True when an author-supplied keyword appears in the input, any language. */
function keywordHit(def: ToolDef, input: string): boolean {
  if (!def.keywords?.length) return false;
  const lower = input.toLowerCase();
  return def.keywords.some((kw) => kw.length > 0 && lower.includes(kw.toLowerCase()));
}

/** Bigram overlap between the prompt and the tool's name + description. */
function similarity(def: ToolDef, inputBigrams: Set<string>): number {
  return jaccard(inputBigrams, bigrams(`${def.name} ${def.description ?? ''}`));
}

/**
 * The keep/drop decision, with each signal on its own threshold.
 *
 * A tool survives if it is essential, already used this session, explicitly
 * requested via `refresh_tools`, matches an author keyword, or clears the
 * similarity bar. Nothing else keeps it — in particular a negligible similarity
 * does not, which is what an aggregate `score > 0` would have done.
 */
function isRelevant(
  def: ToolDef,
  inputBigrams: Set<string>,
  opts: ScoreOptions,
): boolean {
  if (ESSENTIAL_TOOLS.has(def.name)) return true;
  if (opts.used.has(def.name)) return true;
  if (opts.force?.has(def.name)) return true;
  if (keywordHit(def, opts.input)) return true;
  return similarity(def, inputBigrams) >= SIMILARITY_KEEP;
}

/**
 * Select the tools to offer for one round.
 *
 * Fail-open contract, in order:
 *   - `respectNarrowing` short-circuits to the core's list untouched (plan mode
 *     and role-scoped sub-agents are deliberate restrictions).
 *   - Everything in `ESSENTIAL_TOOLS` and in `used` always survives.
 *   - At least `MIN_KEPT` tools survive, so the list is never empty.
 *   - Everything in `force` always survives (the `refresh_tools` escape hatch).
 *
 * Pure: returns a new array, never mutates its input.
 */
export function selectTools<T extends ToolDef>(candidates: T[], opts: ScoreOptions): T[] {
  if (candidates.length === 0) return candidates;
  if (opts.respectNarrowing) return candidates.slice();

  const inputBigrams = bigrams(opts.input ?? '');
  const hasSignal = inputBigrams.size > 0 || (opts.force?.size ?? 0) > 0;

  // Nothing to go on (empty input, e.g. a synthetic first turn): keep the full
  // surface rather than guessing.
  if (!hasSignal) return candidates.slice();

  // A duplicated def would ship two copies of the same schema to the model.
  // getAllTools already de-duplicates the MCP cache against INTERNAL_TOOLS, but
  // that is a separate layer and this one is cheap.
  const seen = new Set<string>();
  const unique = candidates.filter((d) => {
    if (seen.has(d.name)) return false;
    seen.add(d.name);
    return true;
  });

  const scored = unique
    .map((def) => ({ def, keep: isRelevant(def, inputBigrams, opts), score: scoreTool(def, inputBigrams, opts) }))
    // Highest score first among the kept, so the cap drops the weakest.
    .sort((a, b) => Number(b.keep) - Number(a.keep) || b.score - a.score);

  let out = scored.filter((s) => s.keep).map((s) => s.def);

  if (out.length < MIN_KEPT) {
    // Backfill by score so a mis-scored turn still offers plausible options.
    const have = new Set(out.map((d) => d.name));
    for (const s of scored) {
      if (out.length >= MIN_KEPT) break;
      if (!have.has(s.def.name)) {
        have.add(s.def.name);
        out.push(s.def);
      }
    }
  }

  if (out.length > MAX_KEPT) {
    // The fail-open contract says pinned tools always survive — so the cap is
    // applied to the *unpinned tail* only. Slicing the kept list blindly let a
    // low-scoring essential (e.g. attachments_search on a prompt that never
    // repeats its keywords) get truncated away, which is exactly the case the
    // pin exists to protect.
    const pinned = (d: T) =>
      ESSENTIAL_TOOLS.has(d.name) || opts.used.has(d.name) || opts.force?.has(d.name) === true;
    const kept = out.filter((d) => pinned(d));
    const tail = out.filter((d) => !pinned(d));
    out = [...kept, ...tail.slice(0, Math.max(0, MAX_KEPT - kept.length))];
  }
  return out;
}