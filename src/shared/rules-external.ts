/**
 * Native rules-dedup handoff to nexus-coder (no source patching).
 *
 * The desktop is the sole injector of project rules ([Project Constitution],
 * src/tools/agents.ts). The core honours that by skipping its own
 * `ProjectContext.loadRules()` when NEXUS_PROJECT_RULES_EXTERNAL=1 — support
 * lives in the coder source, not in a string rewrite of the installed dist.
 *
 * `EXTERNAL_RULES_ENV` is spread into every core worker's environment;
 * `coreHonorsExternalRules()` is a READ-ONLY capability probe used by the rules
 * panel so an old overlay core (which predates the flag) still warns instead
 * of silently injecting every rule twice.
 */

/** Must match nexus-coder `src/context/project-context.ts` (NEXUS_RULES_EXTERNAL_ENV). */
export const NEXUS_RULES_EXTERNAL_ENV = 'NEXUS_PROJECT_RULES_EXTERNAL';

/** Spread into a worker's env. `launch.env` is merged AFTER this, so a host can A/B it back to '0'. */
export const EXTERNAL_RULES_ENV: Record<string, string> = { [NEXUS_RULES_EXTERNAL_ENV]: '1' };

/**
 * True when a core build honours the external-rules flag. The coder source
 * exports a constant with the same name, so its compiled project-context.js
 * contains the literal — no patch marker, no body rewrite.
 */
export function coreHonorsExternalRules(source: string): boolean {
  return typeof source === 'string' && source.includes(NEXUS_RULES_EXTERNAL_ENV);
}
