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
 * Fuzz geographic coordinates (latitude, longitude) in file content by adding
 * a small random offset — preserving the numeric shape so downstream code that
 * parses or processes these columns (float casts, dtype inference, distance
 * math) keeps working, while the exact real coordinates are not exposed.
 *
 * Offsets are generated once per call (≈ ±0.01°, ~±1km) and differ between
 * lat and lng. The same original value within a call maps to the same shifted
 * value, so location identity / relative structure is preserved. Output keeps
 * the original decimal precision and is clamped to valid coordinate ranges.
 *
 * Matches both English and Chinese key names in JSON, YAML, CSV, and plain-text
 * formats.
 */
export function redactGeoData(content: string): string {
  if (!content) return content;

  // Per-call random offsets, ~±0.01° (~1km). Different for lat vs lng.
  const latOffset = (Math.random() - 0.5) * 0.02;
  const lngOffset = (Math.random() - 0.5) * 0.02;

  const shift = (val: string, offset: number): string => {
    const num = Number(val);
    if (!isFinite(num)) return val;
    const decimals = (val.split('.')[1] || '').length;
    const shifted = Math.max(-180, Math.min(180, num + offset));
    return String(Number(shifted.toFixed(decimals)));
  };

  // Pass 1 — JSON / YAML / .env patterns. Each entry: [regex, offset].
  // Group 1 captures the key+separator; the trailing number is the coordinate.
  const patterns: Array<[RegExp, number]> = [
    [/("latitude"\s*:\s*)-?[\d.]+/gi, latOffset],
    [/("longitude"\s*:\s*)-?[\d.]+/gi, lngOffset],
    [/("lat"\s*:\s*)-?[\d.]+/gi, latOffset],
    [/("lng"\s*:\s*)-?[\d.]+/gi, lngOffset],
    [/("lon"\s*:\s*)-?[\d.]+/gi, lngOffset],
    [/([纬][：:])\s*-?[\d.]+/gi, latOffset],
    [/([经][：:])\s*-?[\d.]+/gi, lngOffset],
    [/((?:latitude|lat)=)-?[\d.]+/gi, latOffset],
    [/((?:longitude|lng|lon)=)-?[\d.]+/gi, lngOffset],
  ];

  let result = content;
  for (const [re, offset] of patterns) {
    result = result.replace(re, (match, prefix) => {
      const p = prefix as string;
      return p + shift(match.slice(p.length), offset);
    });
  }

  // Pass 2 — CSV files: detect coordinate column headers then fuzz values in
  // the same columns of subsequent data rows. Headers distinguish lat (纬) vs
  // lng (经) columns so each gets its own offset.
  const lines = result.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(',');
    // A line is a CSV header if it has ≥ 3 cells and contains coordinate terms
    // (possibly with prefix like 栅格中心经度).
    const coordCols: Array<{ col: number; offset: number }> = [];
    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j].trim();
      if (/经度|longitude/i.test(cell)) coordCols.push({ col: j, offset: lngOffset });
      else if (/纬度|latitude/i.test(cell)) coordCols.push({ col: j, offset: latOffset });
    }
    if (coordCols.length === 0 || cells.length < 3) continue;

    // Fuzz values at the identified columns in subsequent data rows.
    for (let k = i + 1; k < lines.length; k++) {
      const dataCells = lines[k].split(',');
      if (dataCells.length <= Math.max(...coordCols.map(c => c.col))) break;
      // Skip lines that don't look like CSV data (no numbers)
      if (!/\d/.test(lines[k])) break;
      let changed = false;
      for (const { col, offset } of coordCols) {
        const raw = dataCells[col].trim();
        if (raw && /^-?[\d.]+$/.test(raw)) {
          dataCells[col] = shift(raw, offset);
          changed = true;
        }
      }
      if (changed) lines[k] = dataCells.join(',');
    }
    break; // Only process the first header line found
  }
  result = lines.join('\n');

  return result;
}

/**
 * Obfuscate sensitive field values (passwords, tokens, keys, credentials) in
 * file content by replacing the value with ***REDACTED***. Matches common
 * JSON, YAML, .env, and Chinese config formats.
 */
export function redactSensitiveData(content: string): string {
  if (!content) return content;

  const eng = '(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?token|credential|credentials|connection[_-]?string|ssh[_-]?key|jwt|refresh[_-]?token|client[_-]?secret|consumer[_-]?secret|session[_-]?id|authorization|wallet|mnemonic|seed[_-]?phrase|passphrase|certificate|encryption[_-]?key|master[_-]?key|consumer[_-]?key|consumer_key)';
  const chn = '(?:密码|口令|密钥|秘钥|令牌|凭证|账号|账户|私钥)';

  const patterns: Array<[RegExp, string]> = [
    // JSON quoted value: "field": "secret123" → "field": "***REDACTED***"
    [new RegExp(`("(?:${eng}|${chn})"\\s*:\\s*)"[^"]*"`, 'gi'), '$1***REDACTED***'],
    // JSON unquoted value: "field": 12345 → "field": ***REDACTED***
    [new RegExp(`("(?:${eng}|${chn})"\\s*:\\s*)[^,\\s}\\]]+`, 'gi'), '$1***REDACTED***'],
    // Chinese plain: 密码: value  or  密钥：value
    [new RegExp(`((?:${chn})\\s*[:：]\\s*)[^\\n]+`, 'gi'), '$1***REDACTED***'],
    // Env-var style (case-insensitive): PASSWORD=abc  or  API_KEY=xyz
    [new RegExp(`\\b(${eng})\\s*=\\s*[^\\n\\s]+`, 'gi'), '$1=***REDACTED***'],
    // Chinese env: 密码=abc
    [new RegExp(`(${chn})\\s*=\\s*[^\\n\\s]+`, 'gi'), '$1=***REDACTED***'],
  ];

  let result = content;
  for (const [re, replacement] of patterns) {
    result = result.replace(re, replacement);
  }
  return result;
}
