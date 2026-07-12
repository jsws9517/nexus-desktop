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
  // Collapse runs of 2+ U+FFFD into a single '.'
  return content.replace(/\uFFFD{2,}/g, '.');
}
