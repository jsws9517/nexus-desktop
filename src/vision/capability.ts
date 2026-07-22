/**
 * Vision Capability Registry
 *
 * Determines whether the current LLM model supports native vision (image input).
 * Uses a multi-layer detection strategy:
 *   1. Provider config `vision` flag (manual override)
 *   2. User-managed whitelist/blacklist
 *   3. Built-in pattern matching against known vision models
 *   4. Auto-detection via API probe (first call only, cached)
 */

import { ConfigManager } from '../config/index.js';

// ── Built-in Vision Model Patterns ──────────────────────────────────────────
// Models matching these patterns are known to support vision natively.
const BUILTIN_VISION_PATTERNS: RegExp[] = [
  // OpenAI
  /gpt-4o/i,
  /gpt-4-vision/i,
  /gpt-4-turbo/i,
  // Anthropic
  /claude-3/i,
  /claude-3\.5/i,
  /claude-opus-4/i,
  /claude-sonnet-4/i,
  // Zhipu
  /glm-4v/i,
  /glm-4\.6v/i,
  /cogview/i,
  // Qwen
  /qwen-vl/i,
  /qwen2-vl/i,
  /qwen-vl-plus/i,
  /qwen-vl-max/i,
  // Google
  /gemini.*vision/i,
  /gemini-pro-vision/i,
  /gemini-1\.5/i,
  /gemini-2/i,
  // Agnes
  /agnes-2v/i,
  // InternVL
  /internvl/i,
  // DeepSeek (some models)
  /deepseek-vl/i,
];

// Models matching these patterns are known to NOT support vision.
const BUILTIN_NO_VISION_PATTERNS: RegExp[] = [
  /deepseek-v4-flash/i,
  /deepseek-v3/i,
  /deepseek-coder/i,
  /gpt-3\.5/i,
  /gpt-4(?!o|vision|turbo)/i,
  /qwen-turbo/i,
  /qwen-plus/i,
  /qwen-max/i,
  /glm-4(?!v)/i,
  /glm-4-flash/i,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesAnyPattern(model: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(model));
}

function getCacheKey(providerName: string, model: string): string {
  return `${providerName}/${model}`;
}

// ── Detection ───────────────────────────────────────────────────────────────

/**
 * Check if a model supports vision, using the detection hierarchy:
 *   1. Provider config `vision` flag
 *   2. User whitelist/blacklist
 *   3. Built-in patterns
 *   4. Cached detection result
 *   5. Auto-detect via API probe (and cache result)
 */
export async function isVisionCapable(
  providerName: string,
  model: string,
  providerConfig?: { apiKey?: string; baseUrl?: string; type?: string },
): Promise<boolean> {
  const config = new ConfigManager();

  // 1. Check provider config `vision` flag (manual override)
  try {
    const provider = config.getProvider(providerName);
    if (provider.vision === true) return true;
    if (provider.vision === false) return false;
  } catch {
    // Provider not found, continue detection
  }

  // 2. Check user-managed whitelist/blacklist
  const userWhitelist = config.getVisionWhitelist();
  const userBlacklist = config.getVisionBlacklist();
  const modelLower = model.toLowerCase();

  for (const pattern of userWhitelist) {
    if (new RegExp(pattern, 'i').test(model)) return true;
  }
  for (const pattern of userBlacklist) {
    if (new RegExp(pattern, 'i').test(model)) return false;
  }

  // 3. Check built-in patterns
  if (matchesAnyPattern(model, BUILTIN_VISION_PATTERNS)) return true;
  if (matchesAnyPattern(model, BUILTIN_NO_VISION_PATTERNS)) return false;

  // 4. Check cache
  const cacheKey = getCacheKey(providerName, model);
  const cache = config.getVisionCapabilityCache();
  if (cacheKey in cache) return cache[cacheKey];

  // 5. Auto-detect via API probe (only if provider config available)
  if (providerConfig?.apiKey && providerConfig?.baseUrl) {
    const result = await probeVisionCapability(
      providerConfig.apiKey,
      providerConfig.baseUrl,
      model,
    );
    // Cache the result
    config.setVisionCapabilityCache(cacheKey, result);
    return result;
  }

  // Default: assume no vision capability
  return false;
}

/**
 * Probe a model's vision capability by sending a minimal image request.
 * Returns true if the model accepts image input, false otherwise.
 */
async function probeVisionCapability(
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<boolean> {
  try {
    // Create a minimal 1x1 white PNG image
    const minimalPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const dataUri = `data:image/png;base64,${minimalPng}`;

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUri } },
            { type: 'text', text: 'Describe this image in one word.' },
          ],
        }],
        max_tokens: 10,
      }),
      signal: AbortSignal.timeout(15000),
    });

    // If the request succeeds (200), the model supports vision
    if (response.ok) return true;

    // Check error response for vision-related errors
    const errText = await response.text().catch(() => '');
    // Some models return specific error messages for unsupported image input
    if (errText.includes('image') || errText.includes('vision') || errText.includes('multimodal')) {
      return false;
    }

    // For other errors (auth, rate limit, etc.), we can't determine — assume false
    return false;
  } catch {
    // Network error, timeout, etc. — can't determine
    return false;
  }
}

/**
 * Get the detection source for a model (for display purposes).
 */
export function getVisionDetectionSource(
  providerName: string,
  model: string,
): string {
  const config = new ConfigManager();

  // Check provider config
  try {
    const provider = config.getProvider(providerName);
    if (provider.vision !== undefined) {
      return provider.vision ? 'provider config (vision: true)' : 'provider config (vision: false)';
    }
  } catch {}

  // Check user whitelist/blacklist
  const userWhitelist = config.getVisionWhitelist();
  const userBlacklist = config.getVisionBlacklist();
  for (const pattern of userWhitelist) {
    if (new RegExp(pattern, 'i').test(model)) return `user whitelist (${pattern})`;
  }
  for (const pattern of userBlacklist) {
    if (new RegExp(pattern, 'i').test(model)) return `user blacklist (${pattern})`;
  }

  // Check built-in patterns
  if (matchesAnyPattern(model, BUILTIN_VISION_PATTERNS)) return 'built-in whitelist';
  if (matchesAnyPattern(model, BUILTIN_NO_VISION_PATTERNS)) return 'built-in blacklist';

  // Check cache
  const cacheKey = getCacheKey(providerName, model);
  const cache = config.getVisionCapabilityCache();
  if (cacheKey in cache) return cache[cacheKey] ? 'auto-detected (cached: yes)' : 'auto-detected (cached: no)';

  return 'unknown (not detected)';
}

/**
 * Get the list of built-in vision patterns (for display purposes).
 */
export function getBuiltinPatterns(): { whitelist: string[]; blacklist: string[] } {
  return {
    whitelist: BUILTIN_VISION_PATTERNS.map(r => r.source),
    blacklist: BUILTIN_NO_VISION_PATTERNS.map(r => r.source),
  };
}
