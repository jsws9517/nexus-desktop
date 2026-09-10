/** Config masking for the config view (never ship live API keys over IPC). */

import type { Config } from 'nexus-coder/dist/src/config/types.js';
import { KEY_MASK } from '../shared/constants.js';

function maskKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return KEY_MASK;
}

type ProviderGroup = Record<string, { apiKey?: string; [k: string]: unknown }>;

export function redactConfig(cfg: Config): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(cfg)) as {
    providers?: ProviderGroup;
    visionProviders?: ProviderGroup;
    ocrProviders?: ProviderGroup;
    speechProviders?: ProviderGroup;
  };
  const maskGroups: Array<ProviderGroup | undefined> = [
    out.providers,
    out.visionProviders,
    out.ocrProviders,
    out.speechProviders,
  ];
  for (const group of maskGroups) {
    if (!group) continue;
    for (const p of Object.values(group)) {
      if (p.apiKey) p.apiKey = maskKey(p.apiKey);
    }
  }
  return out as unknown as Record<string, unknown>;
}