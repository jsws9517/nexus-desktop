/**
 * Per-model capability declaration + vision-route hint.
 *
 * Borrowed from dsh-web's "Model Capabilities" editor and ModLens's
 * auto-detect-and-route strategy (see docs/dsh-plugin-adoption-plan.md §5.3 / §7.3).
 *
 * Config surface (~/.nexus/config.json, backward compatible):
 *
 *   "modelCapabilities": {
 *     "agnes-2.5-flash":  { "contextLimit": 524288, "vision": false, "thinking": true },
 *     "deepseek-v4-pro":  { "contextLimit": 131072, "vision": false, "thinking": true }
 *   }
 *
 * Semantics:
 *   - `contextLimit` replaces the manual `modelContextLimits` firefighting: the
 *     compression detector uses the declared value instead of guessing 128k.
 *   - `vision: false` (positively confirmed text-only) triggers the vision-route
 *     hint injected into the system prompt, telling the model to bridge through
 *     `ocr_extract` / `analyze_image`.
 *   - `vision: true` or ABSENT (`unknown`) preserves native behavior — the hint is
 *     never injected on models we cannot positively confirm as text-only
 *     (the same conservative rule as ModLens).
 */

/** Per-model capability record. Absent fields = "unknown / inherit default". */
export interface ModelCapability {
  /** Context window size in tokens. Replaces modelContextLimits when present. */
  contextLimit?: number;
  /** true = natively vision-capable; false = positively text-only; absent = unknown. */
  vision?: boolean;
  /** true = reasoning model; false = no thinking mode; absent = inherit. */
  thinking?: boolean;
}

/** Map of model id (or glob-ish suffix) → capability. */
export type ModelCapabilities = Record<string, ModelCapability>;

/** Marker used by AgentService for the vision-bridging hint. */
export const VISION_HINT_MARKER = '[Vision Bridging Hint]';

/** Well-known native-vision families that must NEVER get the text-only hint. */
const NATIVE_VISION_HINTS = ['-flash', '4v', 'vision', 'vl', 'omni'];

/**
 * Read the `modelCapabilities` block from a duck-typed config object.
 * Never throws; returns {} when missing or malformed.
 */
export function readModelCapabilities(config: Record<string, unknown> | undefined): ModelCapabilities {
  if (!config) return {};
  const raw = config.modelCapabilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ModelCapabilities = {};
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const cap = v as Record<string, unknown>;
    const entry: ModelCapability = {};
    if (typeof cap.contextLimit === 'number' && cap.contextLimit > 0) entry.contextLimit = cap.contextLimit;
    if (typeof cap.vision === 'boolean') entry.vision = cap.vision;
    if (typeof cap.thinking === 'boolean') entry.thinking = cap.thinking;
    out[model] = entry;
  }
  return out;
}

/**
 * Resolve capabilities for a concrete model id, honoring longest-suffix globs.
 * E.g. declared keys `deepseek-v4-pro` and `-pro` — `deepseek-v4-pro` wins; a
 * bare `*` acts as the catch-all default.
 */
export function getModelCapability(caps: ModelCapabilities, modelId: string): ModelCapability | undefined {
  if (!modelId) return undefined;
  const id = modelId.trim();
  if (caps[id]) return caps[id];
  // Longest matching suffix (e.g. key "-pro" matches "deepseek-v4-pro").
  let best: ModelCapability | undefined;
  let bestLen = -1;
  for (const [key, cap] of Object.entries(caps)) {
    if (key === '*') continue;
    if (id.endsWith(key) && key.length > bestLen) {
      best = cap;
      bestLen = key.length;
    }
  }
  if (best) return best;
  return caps['*'];
}

/**
 * Decide whether the vision-route hint applies to a model.
 * Only `vision: false` (positively text-only) triggers it; `true`/`unknown`
 * and native-vision name hints never do (ModLens conservative rule).
 */
export function shouldInjectVisionHint(caps: ModelCapabilities | undefined, modelId: string): boolean {
  if (!caps || !modelId) return false;
  const cap = getModelCapability(caps, modelId);
  if (!cap) {
    // Un-declared → unknown → preserve native behavior. Never guess.
    if (NATIVE_VISION_HINTS.some((h) => modelId.toLowerCase().includes(h))) return false;
    return false;
  }
  if (cap.vision === false) return true;
  return false;
}

/** Resolve the effective context limit: declared capability → modelContextLimits → undefined. */
export function resolveContextLimit(
  caps: ModelCapabilities | undefined,
  modelId: string,
  legacyLimits: Record<string, number> | undefined,
): number | undefined {
  if (!caps) return undefined;
  const cap = getModelCapability(caps, modelId);
  if (cap?.contextLimit) return cap.contextLimit;
  if (legacyLimits && modelId) {
    const v = legacyLimits[modelId] ?? legacyLimits['*'];
    if (typeof v === 'number' && v > 0) return v;
  }
  return undefined;
}

/** Build the exact hint text injected under [Vision Bridging Hint]. */
export function buildVisionHint(modelId: string): string {
  return (
    `IMPORTANT — model "${modelId}" is TEXT-ONLY and cannot see images natively.\n` +
    'When the user provides or references an image, you MUST bridge through a vision tool:\n' +
    '  - `ocr_extract`  — extract exact text from screenshots/documents/images\n' +
    '  - `analyze_image` — general image understanding (objects, layout, scene)\n' +
    '  - `read_media_file` — load the image for rendering\n' +
    'Never claim to see an image yourself. If OCR is incomplete, say what you actually ' +
    'recognized and do NOT fabricate the rest.\n'
  );
}