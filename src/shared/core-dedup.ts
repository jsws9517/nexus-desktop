/**
 * Source-level rules-dedup patch shared by the installed core and core overlays.
 *
 * The desktop is the sole authoritative injector of project rules
 * (`[Project Constitution]`). The core's own `ProjectContext.loadRules()` also
 * reads `.nexus/rules/*` and injects a second copy inside `[Project context]`.
 * This module rewrites that method to a no-op in whichever core copy is about
 * to run — the bundled dist at build time, every downloaded overlay at
 * activation time, and an already-active overlay at boot (self-heal for cores
 * installed by older builds).
 *
 * NOTE: `scripts/patch-core-rules-dedup.mjs` carries the same pure logic so the
 * build-time script stays standalone (it runs before dist exists). Keep both
 * copies in sync; `test/core-rules-dedup.test.mjs` asserts their marker matches.
 */

export const DEDUP_MARKER = 'NEXUS_RULES_DEDUP_PATCH';

const NOOP_METHOD = `    loadRules(_cwd) {
        // ${DEDUP_MARKER}: project rules are injected once by the desktop host
        // under [Project Constitution]; the core must not inject a second copy.
        // Patched at build time (scripts/patch-core-rules-dedup.mjs), overlay
        // activation (src/core-overlay/manager.ts) or boot self-heal
        // (src/bootstrap/overlay.ts).
        return;
    }`;

/** Locate `loadRules(...)` and its body by brace matching. */
function findLoadRulesMethod(src: string): { start: number; end: number } | null {
  const sig = /^(\s*)loadRules\s*\([^)]*\)\s*\{/m.exec(src);
  if (!sig) return null;
  const openBrace = sig.index + sig[0].length - 1;
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start: sig.index, end: i + 1 };
    }
  }
  return null;
}

export type PatchResult =
  | { code: string; patched: boolean; reason: 'patched' }
  | { code: string; patched: false; reason: 'already-patched' | 'signature-not-found' };

/** Pure patch: replace the `loadRules()` body with a no-op. */
export function patchProjectContextSource(src: string): PatchResult {
  if (src.includes(DEDUP_MARKER)) {
    return { code: src, patched: false, reason: 'already-patched' };
  }
  const span = findLoadRulesMethod(src);
  if (!span) {
    return { code: src, patched: false, reason: 'signature-not-found' };
  }
  const code = src.slice(0, span.start) + NOOP_METHOD + src.slice(span.end);
  return { code, patched: true, reason: 'patched' };
}

/** True when the given source already carries the dedup no-op. */
export function isDedupPatched(src: string): boolean {
  return typeof src === 'string' && src.includes(`${DEDUP_MARKER}: project rules are injected once`);
}
