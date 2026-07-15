/**
 * OpenCode Zen provider knowledge base.
 *
 * OpenCode Zen is an Anthropic-compatible gateway curated by the OpenCode team
 * for coding-agent workloads. See: https://opencode.ai/docs/zen/
 *
 * Authentication flow:
 *   1. User visits https://opencode.ai/auth and signs in / adds billing.
 *   2. User copies the API key (`sk-...`) and provides it to Nexus.
 *   3. Nexus stores it (encrypted at rest) and routes chat through the gateway
 *      using `type=anthropic` + `baseUrl=https://opencode.ai/zen`.
 *
 * Env vars honored at runtime (in addition to the stored key):
 *   - OPENCODE_API_KEY
 *   - OPENCODE_ZEN_API_KEY
 */

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen';
export const OPENCODE_ZEN_AUTH_URL = 'https://opencode.ai/auth';
export const OPENCODE_ZEN_DOCS_URL = 'https://opencode.ai/docs/zen/';

/** Provider name used in `providers.<name>` and `activeProvider` in config.json. */
export const OPENCODE_ZEN_PROVIDER_NAME = 'opencode-zen';

export const OPENCODE_ZEN_ENV_VARS = ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'] as const;

/**
 * Curated models list. This is a starting set — Zen exposes additional models
 * that can be selected by name via `nexus config opencode-zen use <model>`.
 *
 * Sources: opencode.ai/docs/zen and community reports (big-pickle, minimax-m2.5-free
 * were widely reported as reliable, but Zen rotates its line-up periodically).
 */
export interface OpencodeZenModelInfo {
  id: string;
  label: string;
  tier: 'recommended' | 'free' | 'paid';
  notes?: string;
}

export const OPENCODE_ZEN_MODELS: OpencodeZenModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    tier: 'paid',
    notes: 'Highest quality; best for complex logic and long-form reasoning.',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    tier: 'paid',
    notes: 'Strong all-rounder; default for most coding tasks.',
  },
  {
    id: 'big-pickle',
    label: 'Big Pickle',
    tier: 'recommended',
    notes: 'OpenCode-curated coding-specific routing.',
  },
  {
    id: 'minimax-m2.5-free',
    label: 'minimax M2.5 (Free)',
    tier: 'free',
    notes: 'Free tier. Prompts may be used for model training — avoid sensitive data.',
  },
];

export function getDefaultModelId(): string {
  return OPENCODE_ZEN_MODELS[0]!.id;
}

export function findModel(id: string): OpencodeZenModelInfo | undefined {
  return OPENCODE_ZEN_MODELS.find((m) => m.id === id);
}

/**
 * Build the provider config that Nexus should persist after a successful login.
 *
 * We deliberately use `type: 'anthropic'` because Zen speaks the Anthropic
 * Messages protocol. `baseUrl` overrides the SDK endpoint.
 */
export function buildOpencodeZenProviderConfig(opts: {
  apiKey: string;
  model?: string;
  maxContextTokens?: number;
}): {
  type: 'anthropic';
  apiKey: string;
  baseUrl: string;
  model: string;
  maxContextTokens?: number;
} {
  return {
    type: 'anthropic',
    apiKey: opts.apiKey,
    baseUrl: OPENCODE_ZEN_BASE_URL,
    model: opts.model ?? getDefaultModelId(),
    ...(opts.maxContextTokens ? { maxContextTokens: opts.maxContextTokens } : {}),
  };
}
