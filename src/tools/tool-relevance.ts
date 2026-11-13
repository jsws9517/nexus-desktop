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
 *
 * One channel is verbatim, not scored: the prompt NAMING a tool (`用
 * loadtest_add 计算`, case-insensitive, dot/underscore-variant) keeps that
 * tool and pins it against MAX_KEPT. Both language-neutral channels —
 * author keywords and bigram similarity — are structurally blind to external
 * MCP tools on a CJK prompt (no routing entry, English-only descriptions),
 * and an explicit name is the strongest intent signal we have.
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
 * Explicit-mention weight: the prompt names the tool verbatim. A strong intent
 * signal — below author keywords (the tool's own trigger words) and proven
 * usage, above raw similarity.
 */
const W_MENTION = 0.5;

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
 * Minimum slots reserved for the *unpinned* tail once the pinned floor alone
 * exceeds MAX_KEPT. `agent.mcp.getAllTools()` never carries the core's
 * agent-layer defs, so `service.ts` merges them in from the core's own
 * selection result; every one of those names is pinned (parity test), which
 * pushes the floor past MAX_KEPT. Without this floor the old tail budget
 * (`MAX_KEPT - kept.length`) collapses to zero and silently drops every
 * keyword-matched non-pinned tool — the data/DB families the routing table
 * exists to surface.
 */
const MAX_TAIL = 12;

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
  // media generation (core 1.2.3: generate_image / generate_video / media_task
  // are in the core's essentialTools, so they must be pinned here too)
  'generate_image', 'generate_video', 'media_task',
  // memory + recall
  'remember', 'recall', 'remember_project',
  // memory graph (knowledge-graph) tools — the core exposes these as
  // essentialTools too, so pinning them here keeps parity and stops the
  // selector from hiding them on a CJK prompt.
  'create_entities', 'create_relations', 'add_observations',
  'delete_entities', 'delete_observations', 'delete_relations',
  'read_graph', 'search_nodes', 'open_nodes',
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
  'vault_search', 'vault_open', 'vault_write', 'inline_search',
]);

/**
 * Office tool families pinned into every automation (headless) round.
 *
 * An automation prompt is a one-shot CJK/English string with no mid-turn
 * steering, and its intent ("生成当天的日报 Word 文档") may not literally
 * repeat a tool's keywords on every round, so the relevance selector can drop
 * the exact tools the run depends on (this is how the "no docx reader" dead
 * end showed up: the model stalled on reading and never reached docx.write).
 *
 * When AgentService runs with an automation profile set (setAutomationProfile
 * from the automation worker), this set is merged into the selector's `force`
 * for the run's lifetime — pinned tools survive the cap and keyword misses.
 * All names are deterministic native/file tools: no shell, no exec, no human
 * confirmation — consistent with the automation invariant (roadmap #6:
 * deny exec, prefer native office writers/readers in unattended runs).
 */
export const AUTOMATION_OFFICE_PINS: ReadonlySet<string> = new Set([
  // office read (doc-extract extractor)
  'docx.read',
  'office.read',
  // office write (office-write native package)
  'docx.write',
  'pptx.write',
  'pdf.write',
  // tabular read/write (exceljs, in-process)
  'sheet.read',
  'sheet.write',
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
  inputLower?: string,
): number {
  const lower = inputLower ?? (opts.input ?? '').toLowerCase();
  let score = 0;
  if (keywordHit(def, opts.input)) score += W_KEYWORD;
  if (opts.used.has(def.name)) score += W_MEMORY;
  if (opts.force?.has(def.name)) score += W_KEYWORD;
  if (nameMention(def, lower)) score += W_MENTION;

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

/**
 * True when the prompt names the tool verbatim (case-insensitive, with the
 * dot/underscore alias either the user or the model may type: `sheet.read` ↔
 * `sheet_read`).
 *
 * Both language-neutral channels — author keywords and bigram similarity —
 * miss EXTERNAL MCP tools on a CJK prompt: the hub's tool defs carry no
 * keywords (the routing table is desktop-owned, builtins only) and their
 * English-only descriptions never clear SIMILARITY_KEEP against a Chinese
 * bigram set. So "用 loadtest_add 计算…" silently becomes a text-only answer
 * — the vault_search incident ("a user who typed 'use vault_search' was told
 * the tool did not exist"), generalized to every server-qualified tool. An
 * explicit name is the strongest per-round intent signal we have; it must
 * keep that tool on every round.
 *
 * The length-3 floor keeps a two-character name from matching as a substring
 * of ordinary prose.
 */
function nameMention(def: ToolDef, inputLower: string): boolean {
  const n = def.name.toLowerCase();
  if (n.length < 3 || !inputLower) return false;
  if (inputLower.includes(n)) return true;
  const alt = n.includes('.') ? n.replace(/\./g, '_') : n.replace(/_/g, '.');
  return alt !== n && inputLower.includes(alt);
}

/** Bigram overlap between the prompt and the tool's name + description. */
function similarity(def: ToolDef, inputBigrams: Set<string>): number {
  return jaccard(inputBigrams, bigrams(`${def.name} ${def.description ?? ''}`));
}

/**
 * The keep/drop decision, with each signal on its own threshold.
 *
 * A tool survives if it is essential, already used this session, explicitly
 * requested via `refresh_tools`, NAMED verbatim in the prompt (mention
 * channel), matches an author keyword, or clears the similarity bar. Nothing
 * else keeps it — in particular a negligible similarity does not, which is
 * what an aggregate `score > 0` would have done.
 */
function isRelevant(
  def: ToolDef,
  inputBigrams: Set<string>,
  opts: ScoreOptions,
  inputLower: string,
): boolean {
  if (ESSENTIAL_TOOLS.has(def.name)) return true;
  if (opts.used.has(def.name)) return true;
  if (opts.force?.has(def.name)) return true;
  if (nameMention(def, inputLower)) return true;
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
 *   - Everything NAMED verbatim in the prompt survives AND is pinned against
 *     the cap: an explicit intent to reach a capability ("用 loadtest_add
 *     计算") must not be dropped by scoring or truncated by MAX_KEPT — the
 *     vault_search incident, closed for every tool, external MCP included.
 *
 * Pure: returns a new array, never mutates its input.
 */
export function selectTools<T extends ToolDef>(candidates: T[], opts: ScoreOptions): T[] {
  if (candidates.length === 0) return candidates;
  if (opts.respectNarrowing) return candidates.slice();

  const inputBigrams = bigrams(opts.input ?? '');
  const inputLower = (opts.input ?? '').toLowerCase();
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
    .map((def) => ({ def, keep: isRelevant(def, inputBigrams, opts, inputLower), score: scoreTool(def, inputBigrams, opts, inputLower) }))
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
    //
    // The tail budget is floored at MAX_TAIL: the pinned floor now exceeds
    // MAX_KEPT (the agent-layer merge added ~21 pinned tools), and the old
    // `MAX_KEPT - kept.length` budget went negative — zeroing the tail and
    // cutting every matched non-pinned tool from the round.
    const pinned = (d: T) =>
      ESSENTIAL_TOOLS.has(d.name) ||
      opts.used.has(d.name) ||
      opts.force?.has(d.name) === true ||
      nameMention(d, inputLower);
    const kept = out.filter((d) => pinned(d));
    const tail = out.filter((d) => !pinned(d));
    const budget = Math.max(MAX_TAIL, MAX_KEPT - kept.length);
    out = [...kept, ...tail.slice(0, budget)];
  }
  return out;
}

/**
 * Merge the core's own agent-layer tool definitions into the desktop candidate
 * pool.
 *
 * The core assembles ~21 tools that never appear in `agent.mcp.getAllTools()`
 * — media generation (`generate_image` / `generate_video` / `media_task`),
 * `remember` / `recall` / `remember_project`, `bg_job`, the task/spawn family,
 * image/audio analysis and session history — and adds them statically in its
 * own `getToolsForContext` (nexus-coder/src/agent.ts). The desktop replaced
 * that method, so its candidate pool never contained them: every
 * ESSENTIAL_TOOLS pin for those names (all of them are pinned, and must be per
 * the parity test) was a silent no-op. The model was never offered
 * `generate_video` even though the core can dispatch it, `refresh_tools`
 * intents could not resolve to it, and quota billing never ran.
 *
 * Desktop defs win on a name clash — `have` is seeded from the pool, so
 * INTERNAL_TOOLS shadowing and MCP server-qualified aliases stay authoritative
 * and a duplicate schema never ships. `hidden` keeps skill progressive
 * disclosure intact for merged skill tools.
 */
export function mergeCoreAgentTools<T extends ToolDef>(
  pool: T[],
  coreTools: ReadonlyArray<T>,
  hidden?: ReadonlySet<string>,
): T[] {
  const have = new Set(pool.map((t) => t.name));
  const merged = [...pool];
  for (const def of coreTools) {
    if (have.has(def.name)) continue;
    if (hidden?.has(def.name)) continue;
    have.add(def.name);
    merged.push(def);
  }
  return merged;
}