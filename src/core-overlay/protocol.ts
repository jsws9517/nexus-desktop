/**
 * Core/desktop protocol gate.
 *
 * The desktop owns the IPC / tool contract it exposes to the core. A core
 * overlay may only be installed when it speaks the same protocol as the running
 * desktop; otherwise the overlay could silently break IPC (renamed worker
 * methods, changed params, new tools the desktop cannot route).
 *
 * Protocol source of truth: `package.json` → `nexusDesktopProtocol` (integer).
 * Bump it whenever the desktop↔core contract changes.
 *
 * A core artifact declares the protocol it was built against in its own
 * `package.json` (`nexusDesktopProtocol`), stamped into `latest-core.yml` by
 * `scripts/publish-core.mjs`. A core that predates the field (protocol absent)
 * is treated as compatible so legacy artifacts keep working.
 */
import fs from 'node:fs';

/** Must match `package.json` → `nexusDesktopProtocol` (test-enforced). */
export const DESKTOP_PROTOCOL_FALLBACK = 1;

/** The protocol the running desktop speaks. Env override is for tests. */
export function desktopProtocol(): number {
  const env = process.env.NEXUS_DESKTOP_PROTOCOL;
  if (env && /^\d+$/.test(env)) return Number(env);
  return DESKTOP_PROTOCOL_FALLBACK;
}

/**
 * Read `nexusDesktopProtocol` from a package.json file.
 * Returns null when the file is missing or the field is absent/invalid.
 */
export function readPackageProtocol(pkgJsonPath: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { nexusDesktopProtocol?: unknown };
    const v = raw.nexusDesktopProtocol;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/** Read the protocol declared by a core overlay directory (its package.json). */
export function readCoreDirProtocol(coreDir: string): number | null {
  return readPackageProtocol(`${coreDir}/package.json`);
}

/**
 * Whether a core declaring `coreProtocol` may run on this desktop.
 * `null` (field absent) means the core predates the gate → allowed.
 */
export function isProtocolCompatible(coreProtocol: number | null): boolean {
  if (coreProtocol === null) return true;
  return coreProtocol === desktopProtocol();
}