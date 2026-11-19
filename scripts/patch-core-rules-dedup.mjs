/**
 * Source-level dedup patch for the installed nexus-coder core.
 *
 * The desktop is the single authoritative injector of project rules
 * (`[Project Constitution]`, see src/tools/agents.ts#loadConstitutionBundle).
 * The core's ProjectContext.loadRules() ALSO reads `.nexus/rules/*` and injects
 * them again inside the untrusted `[Project context]` block — a second copy of
 * every rule. This script makes that core method a no-op in the INSTALLED copy
 * (node_modules/nexus-coder/dist), so rules appear exactly once.
 *
 * Why patch the installed dist instead of the core-overlay activeCore slot:
 *   - activeCore is the online core-update channel; using it here would be
 *     overwritten the moment a user updates the core, silently losing dedup.
 *   - the installed dist is re-created by `sync-core.mjs`, so patching at the
 *     end of every sync makes the patch version-bound automatically: a core
 *     upgrade re-copies the file and this script re-patches the new source.
 *
 * If the core changes shape and the patch can no longer be applied, the script
 * exits non-zero (CI fails loudly) instead of silently shipping double rules.
 *
 * Usage:
 *   node scripts/patch-core-rules-dedup.mjs            patch the default path
 *   node scripts/patch-core-rules-dedup.mjs --check     verify patch is present,
 *                                                       no writes (CI assertion)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEDUP_MARKER = 'NEXUS_RULES_DEDUP_PATCH';
const DEFAULT_TARGET = join(ROOT, 'node_modules', 'nexus-coder', 'dist', 'src', 'context', 'project-context.js');

const NOOP_METHOD = `    loadRules(_cwd) {
        // ${DEDUP_MARKER}: project rules are injected once by the desktop host
        // under [Project Constitution]; the core must not inject a second copy.
        // Patched at build time (scripts/patch-core-rules-dedup.mjs), overlay
        // activation (src/core-overlay/manager.ts) or boot self-heal
        // (src/bootstrap/overlay.ts).
        return;
    }`;

/**
 * Find the `loadRules(...)` method and the extent of its body via brace matching.
 * Returns { start, end } (end exclusive) or null when not found / unbalanced.
 */
function findLoadRulesMethod(src) {
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

/** Pure patch function (exported for unit tests). */
export function patchProjectContextSource(src) {
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

/** True when the given source has the dedup no-op applied. */
export function isDedupPatched(src) {
  return typeof src === 'string' && src.includes(`${DEDUP_MARKER}: project rules are injected once`);
}

function run() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const target = args.find((a) => a.endsWith('project-context.js')) || DEFAULT_TARGET;

  if (!existsSync(target)) {
    console.error(`[patch-core-dedup] target missing: ${target}`);
    process.exitCode = 1;
    return;
  }
  const src = readFileSync(target, 'utf8');
  const present = isDedupPatched(src);

  if (checkOnly) {
    if (present) {
      console.log('[patch-core-dedup] OK — dedup patch present');
    } else {
      console.error('[patch-core-dedup] CHECK FAILED — dedup patch missing; rule injection is duplicated');
      process.exitCode = 1;
    }
    return;
  }

  const result = patchProjectContextSource(src);
  if (result.reason === 'signature-not-found') {
    console.error(
      `[patch-core-dedup] FAILED: loadRules() signature not found in ${target}. ` +
      'The core layout changed — update patch-core-rules-dedup.mjs. Refusing to ship duplicate rules.',
    );
    process.exitCode = 1;
    return;
  }
  if (result.reason === 'already-patched') {
    console.log('[patch-core-dedup] already patched — no-op');
    return;
  }
  writeFileSync(target, result.code, 'utf8');
  console.log(`[patch-core-dedup] patched loadRules() -> no-op in ${target}`);
}

// Run only when invoked as a script (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
