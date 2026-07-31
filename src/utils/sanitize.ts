/**
 * Replace UTF-8 replacement characters (U+FFFD) appearing where multi-byte
 * sequences were corrupted.  This does NOT fix the root cause (LLM output),
 * but prevents garbled text from persisting to disk.
 *
 * Heuristic: a sequence of 2+ consecutive U+FFFD characters almost always
 * indicates a corrupted multi-byte sequence (e.g. 构 → ���).  We replace
 * the entire run of U+FFFD with the ASCII fallback '.' to keep layout
 * intact without introducing false Unicode.
 */
export function sanitizeContent(content: string): string {
  if (!content) return content;
  // Collapse runs of 2+ U+FFFD into a single '.'
  let out = content.replace(/\uFFFD{2,}/g, '.');
  // Strip raw null bytes and other control characters (except common whitespace)
  // that could smuggle instructions or break downstream parsers.
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return out;
}

/**
 * Neutralize instruction-like patterns in untrusted data (e.g. knowledge-graph
 * content) so it cannot spoof system directives when injected into the prompt.
 * Returns the scrubbed text plus a flag indicating whether anything was removed.
 */
export function neutralizeInstructions(input: string): { text: string; redacted: boolean } {
  if (!input) return { text: input, redacted: false };
  let redacted = false;
  let text = input;
  // Remove common "jailbreak"/instruction-injection framing markers.
  const patterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)/gi,
    /disregard\s+(the|all)\s+(above|previous)\s+(instructions|prompts?)/gi,
    /\byou\s+are\s+(now\s+)?(a|an)\s+\w+/gi,
    /\bsystem\s*:\s*/gi,
    /\bassistant\s*:\s*/gi,
    /\[system\s*\]/gi,
    /<system>/gi,
    /<\/system>/gi,
  ];
  for (const re of patterns) {
    if (re.test(text)) redacted = true;
    text = text.replace(re, '');
  }
  return { text: text.trim(), redacted };
}

/**
 * Replace absolute paths and home-directory references in error/diagnostic
 * output with non-sensitive placeholders so file paths are never leaked to the
 * user or the model context.
 */
export function redactPaths(input: string): string {
  if (!input) return input;
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/[\\/]$/, '');
  let out = input;
  if (home) {
    out = out.split(home).join('~');
  }
  // Windows drive roots and absolute paths → <path>. The leading-segment allow
  // list below covers the common sensitive Unix roots; anything matching a
  // known root (or any Windows drive) is redacted so secrets/paths never leak
  // into model context or user-facing output.
  const SENSITIVE_ROOTS = /^(?:tmp|dev|proc|sys|etc|var|usr|Users|home|root|opt|srv|mnt|media|data|secret|secrets|private|net|run|credentials|app|config|cache|log|spool|share|local|bin|sbin|lib|lib64|include|backup|archive|export|exchange|volumes|vol|sw|stage|staging)\b/i;
  out = out.replace(/(?:[A-Za-z]:[\\/][^\s"'`,;|]+)|(?:[\\/][^\s"'`,;|]*)/g, (m) =>
    SENSITIVE_ROOTS.test(m) || /^[A-Za-z]:[\\/]/i.test(m) ? '<path>' : m,
  );
  return out;
}

/**
 * Replace geographic coordinates (latitude, longitude) in file content with
 * stable per-call UUID-style placeholders. Each unique coordinate value gets
 * a deterministic placeholder (geo-0001, geo-0002, …) so the LLM can still
 * reason about location identity without seeing real coordinates.
 *
 * Matches both English and Chinese key names in JSON, YAML, and plain-text
 * formats.
 */
export function redactGeoData(content: string): string {
  if (!content) return content;

  const cache = new Map<string, string>();
  let counter = 0;
  const nextId = (val: string): string => {
    if (!cache.has(val)) {
      cache.set(val, `geo-${String(++counter).padStart(4, '0')}`);
    }
    return cache.get(val)!;
  };

  // Each regex captures the key+separator in group 1; the full match includes
  // the trailing numeric value. Replacement keeps the prefix and swaps the
  // value for a stable geo-NNNN placeholder.
  const patterns: RegExp[] = [
    /("(?:latitude|longitude)"\s*:\s*)-?[\d.]+/gi,
    /("(?:lat|lng|lon)"\s*:\s*)-?[\d.]+/gi,
    /([纬度经度][：:])\s*-?[\d.]+/gi,
    /((?:latitude|longitude|lat|lng|lon)=)-?[\d.]+/gi,
  ];

  let result = content;
  for (const re of patterns) {
    result = result.replace(re, (match, prefix) => {
      const p = prefix as string;
      return p + nextId(match.slice(p.length));
    });
  }
  return result;
}
