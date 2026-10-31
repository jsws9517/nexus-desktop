/**
 * Core version selection: pick the newest nexus-coder among the `latest`
 * and `beta` dist-tags.
 *
 * Pure functions only (no I/O) so the selection rules stay unit-testable:
 *   node --test test/core-version-select.test.mjs
 *
 * Rules:
 *  - only `latest` and `beta` are considered; any other dist-tag is ignored
 *  - the larger of the two wins (semver comparison, prereleases included)
 *  - when `beta` is absent, `latest` wins by default
 *  - when neither is present, the caller decides (we throw)
 */

/**
 * Parse a semver string into {major, minor, patch, pre: string[]}.
 * Accepts an optional leading "v" (dist-tags are plain, but be tolerant).
 */
export function parseVersion(v) {
  const text = String(v ?? '').trim().replace(/^v/i, '');
  const m = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) {
    throw new Error(`core-version-select: not a semver string: ${JSON.stringify(v)}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

/**
 * Compare two version strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Follows semver prerelease ordering:
 *  - 1.2.0 (no prerelease) > 1.2.0-beta
 *  - numeric identifiers compare as integers, alphanumeric ones as strings,
 *    and a numeric identifier is always < an alphanumeric one
 *  - when all shared identifiers are equal, the longer list is greater
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  const A = pa.pre;
  const B = pb.pre;
  if (A.length === 0 && B.length === 0) return 0;
  if (A.length === 0) return 1; // release > prerelease
  if (B.length === 0) return -1;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn) {
      return -1;
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Pick the newest core version from a dist-tags object.
 * Only `latest` and `beta` are considered.
 * @param {{latest?: string, beta?: string, [k: string]: string}} distTags
 * @returns {string} the winning version
 * @throws when neither `latest` nor `beta` is present
 */
export function pickNewestCore(distTags) {
  const candidates = [];
  if (distTags.latest) candidates.push(distTags.latest);
  if (distTags.beta) candidates.push(distTags.beta);
  if (candidates.length === 0) {
    throw new Error('core-version-select: neither latest nor beta dist-tag present');
  }
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (compareVersions(c, best) > 0) best = c;
  }
  return best;
}

// ---- CLI -------------------------------------------------------------------
// node scripts/core-version-select.mjs [--registry URL]
// Prints the newest nexus-coder among the `latest`/`beta` dist-tags.
// publish-core-only.yml uses this instead of `npm view nexus-coder version`,
// which reads only `latest` and would silently publish a stale core once a
// newer `beta` is out (e.g. latest=1.1.25, beta=1.1.26-3).
//
// Runs only when executed directly (`node scripts/core-version-select.mjs`),
// never when imported (set-core-version.mjs imports pickNewestCore).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const isCliMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCliMain) {
  const { execSync } = await import('node:child_process');
  const regIdx = process.argv.indexOf('--registry');
  const registry = regIdx !== -1 ? process.argv[regIdx + 1] : 'https://registry.npmjs.org/';
  const out = execSync(
    `npm view nexus-coder dist-tags --json --registry ${registry}`,
    { stdio: 'pipe' },
  ).toString();
  try {
    console.log(pickNewestCore(JSON.parse(out)));
  } catch {
    const m = out.match(/\{[\s\S]*\}/); // tolerate stray npm notice lines
    if (!m) {
      console.error(`core-version-select: cannot parse dist-tags: ${out.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(pickNewestCore(JSON.parse(m[0])));
  }
}
