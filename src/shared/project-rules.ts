/**
 * Metadata-only projection of a project's rule files for the `@Rule` mention
 * source (T1-2/FR-2.3).
 *
 * The authoritative scanner stays in `src/tools/agents.ts`
 * (`resolveConstitutionFiles`, shared with T1-1). This module only turns the
 * resolved absolute paths into renderer-safe metadata: NO rule BODY is ever
 * returned — the body is either injected as `[Project Constitution]` or read
 * by the core from an `@path` attachment line, never sent twice.
 *
 * Kept dependency-free and injected with file sizes so it can be unit-tested
 * without Electron or a filesystem.
 */

/** Max size of one rule file offered as an @Rule candidate (matches the
 *  desktop constitution's per-file cap, src/tools/agents.ts). */
export const MAX_RULE_ENTRY_BYTES = 32 * 1024;

export interface ProjectRuleEntry {
  /** Project-relative, forward-slash path, e.g. `.nexus/rules/NEXUS.md`. */
  name: string;
  /** Absolute path (passed to the existing attachment bridge). */
  path: string;
  size: number;
}

/**
 * Build renderer-safe rule entries from resolved paths + their sizes.
 *
 * - Only paths already returned by `resolveConstitutionFiles()` are accepted
 *   (that scanner owns the fixed whitelist of rule locations);
 * - files above `MAX_RULE_ENTRY_BYTES` are skipped silently so a huge rule
 *   cannot blow up the mention panel or the prompt when attached;
 * - a path that does not resolve to a child of `base` is skipped (defense in
 *   depth against a symlinked rules directory pointing outside the project);
 * - order is preserved (the scanner's deterministic precedence order).
 */
export function buildProjectRuleEntries(
  base: string,
  paths: readonly string[],
  sizes: ReadonlyMap<string, number>,
  maxBytes = MAX_RULE_ENTRY_BYTES,
): ProjectRuleEntry[] {
  const root = normalize(base);
  const rootPrefix = root.endsWith('/') ? root : root + '/';
  const out: ProjectRuleEntry[] = [];

  for (const p of paths) {
    const norm = normalize(p);
    // Containment check is case-insensitive on Windows (same rule as the
    // main-process `isWithin` helper used by every other path IPC).
    const inRoot = process.platform === 'win32'
      ? norm.toLowerCase().startsWith(rootPrefix.toLowerCase())
      : norm.startsWith(rootPrefix);
    if (!inRoot || norm === root) continue;

    const size = sizes.get(p);
    if (size === undefined || !Number.isFinite(size) || size > maxBytes) continue;

    out.push({
      name: norm.slice(rootPrefix.length).split('/').join('/'),
      path: p,
      size,
    });
  }
  return out;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
