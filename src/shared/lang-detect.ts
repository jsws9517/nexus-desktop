/**
 * Lightweight CJK character-ratio language detector.
 *
 * Returns one of:
 *   'zh-CN'  — prompt contains ≥30% CJK characters
 *   'en'     — prompt contains <30% CJK characters
 *
 * Heuristic only — no external deps, no network call.  Sufficient for deciding
 * which language to use for decomposition descriptions and bg_job UI labels.
 */

/** CJK Unified Ideographs block range (basic multilingual plane). */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/;

export type PromptLang = 'zh-CN' | 'en';

/**
 * Classify a prompt as zh-CN or en based on CJK character density.
 * Empty or whitespace-only input defaults to 'en'.
 */
export function detectLanguage(prompt: string): PromptLang {
  if (!prompt) return 'en';
  const trimmed = prompt.trim();
  // Count total non-whitespace chars vs CJK chars.
  let total = 0;
  let cjk = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (/\s/.test(ch)) continue;
    total++;
    if (CJK_RE.test(ch)) cjk++;
  }
  if (total === 0) return 'en';
  return cjk / total >= 0.3 ? 'zh-CN' : 'en';
}

/**
 * Return the same string but translated-label style for UI display.
 * e.g. 'running' → '运行中' when lang is zh-CN.
 */
export function localizeStatus(status: string, lang: PromptLang): string {
  const map: Record<PromptLang, Record<string, string>> = {
    'en': {
      running: 'Running',
      succeeded: 'Succeeded',
      failed: 'Failed',
      timeout: 'Timeout',
      cancelled: 'Cancelled',
      queued: 'Queued',
      pending: 'Pending',
      stale: 'Stale',
      created: 'Created',
    },
    'zh-CN': {
      running: '运行中',
      succeeded: '已完成',
      failed: '失败',
      timeout: '超时',
      cancelled: '已取消',
      queued: '排队中',
      pending: '待执行',
      stale: '已废弃',
      created: '已创建',
    },
  };
  return map[lang][status.toLowerCase()] ?? status;
}
