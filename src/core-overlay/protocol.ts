/**
 * Core/desktop protocol gate.
 *
 * The desktop owns the IPC / tool contract it exposes to the core. A core
 * overlay may only be installed when it speaks a protocol the running desktop
 * can serve; otherwise the overlay could silently break IPC (renamed worker
 * methods, changed params, new tools the desktop cannot route).
 *
 * Protocol source of truth (desktop side): `package.json` →
 * `nexusDesktopProtocol` (integer). The desktop speaks ONE protocol version —
 * the wire contract.
 *
 * A core artifact declares the RANGE of desktop protocols it was built to run
 * against in its own `package.json` (`nexusDesktopProtocol`):
 *
 *   - legacy integer `N`  → { min: N, max: N } (exact-match semantics, the
 *     pre-P0 declaration shape; kept for old artifacts)
 *   - range object        → { "min": 2, "max": 4 } (a core can serve several
 *     desktop protocol versions, so coder patches aren't gated by a single
 *     desktop release)
 *
 * `scripts/publish-core.mjs` normalizes that declaration and stamps
 * `protocolMin` / `protocolMax` into `latest-core.yml` (plus a legacy
 * `protocol:` line when min === max, so pre-range manifests and pre-range
 * clients keep parsing it).
 *
 * A core that declares nothing (field absent, or predates the gate) is
 * treated as compatible so legacy artifacts keep working.
 */
import fs from 'node:fs';

/** Must match `package.json` → `nexusDesktopProtocol` (test-enforced). */
export const DESKTOP_PROTOCOL_FALLBACK = 4;

/** The protocol the running desktop speaks. Env override is for tests. */
export function desktopProtocol(): number {
  const env = process.env.NEXUS_DESKTOP_PROTOCOL;
  if (env && /^\d+$/.test(env)) return Number(env);
  return DESKTOP_PROTOCOL_FALLBACK;
}

/** A declared range of desktop protocols a core was built to serve. */
export interface ProtocolRange {
  min: number;
  max: number;
}

/**
 * Normalize a raw `nexusDesktopProtocol` value into a range.
 *
 *   - integer N            → { min: N, max: N }
 *   - { min, max } object → the range (both must be valid non-negative ints,
 *     min ≤ max)
 *   - anything else        → null (absent / malformed → legacy, allowed)
 */
export function parseCoreProtocol(raw: unknown): ProtocolRange | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { min: raw, max: raw };
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { min?: unknown; max?: unknown };
    if (
      typeof o.min === 'number' && Number.isInteger(o.min) && o.min >= 0 &&
      typeof o.max === 'number' && Number.isInteger(o.max) && o.max >= o.min
    ) {
      return { min: o.min, max: o.max };
    }
  }
  return null;
}

/**
 * Read `nexusDesktopProtocol` from a package.json file as a protocol range.
 * Returns null when the file is missing or the field is absent/invalid.
 */
export function readCorePackageProtocol(pkgJsonPath: string): ProtocolRange | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { nexusDesktopProtocol?: unknown };
    return parseCoreProtocol(raw.nexusDesktopProtocol);
  } catch {
    return null;
  }
}

/** Read the protocol range declared by a core overlay directory (its package.json). */
export function readCoreDirProtocol(coreDir: string): ProtocolRange | null {
  return readCorePackageProtocol(`${coreDir}/package.json`);
}

/**
 * Normalize a manifest entry's `protocolMin` / `protocolMax` fields into a
 * range. The legacy `protocol:` line is already folded into min=max=N by the
 * manifest parser, so: both sides present and ordered → the range; anything
 * partial or malformed → null (legacy / undeclared → allowed, matching the
 * artifact-side `parseCoreProtocol` semantics).
 */
export function protocolRangeFromManifest(
  protocolMin: number | null,
  protocolMax: number | null,
): ProtocolRange | null {
  if (protocolMin === null || protocolMax === null) return null;
  if (protocolMin > protocolMax) return null;
  return { min: protocolMin, max: protocolMax };
}

/**
 * Whether a core declaring range `core` may run on this desktop.
 *
 * `null` (field absent / malformed) means the core predates the gate →
 * allowed. Otherwise containment: the desktop's single version must lie
 * inside the core's declared range: `core.min <= desktop <= core.max`.
 */
export function isProtocolCompatible(core: ProtocolRange | null): boolean {
  if (core === null) return true;
  const d = desktopProtocol();
  return core.min <= d && d <= core.max;
}

/**
 * Human-readable reason for an incompatible core range, or null when the core
 * is compatible / legacy. Distinguishes the two directions so a user can act:
 * "too old" (update the core) vs "too new" (update the desktop).
 */
export function protocolMismatch(core: ProtocolRange | null, version: string): string | null {
  if (core === null || isProtocolCompatible(core)) return null;
  const d = desktopProtocol();
  if (core.max < d) {
    return `core ${version} supports desktop protocol ${core.min}–${core.max}, ` +
      `but this desktop speaks ${d} (core is too old)`;
  }
  return `core ${version} requires desktop protocol ≥ ${core.min}, ` +
    `but this desktop speaks ${d} (core is too new)`;
}
