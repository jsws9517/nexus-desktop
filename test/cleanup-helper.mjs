// P0 test — cleanup glue. Wrap rmSync with a cwd escape so Windows can delete
// the directory even when a chdir() pointed at it (EPERM guard).
import { rmSync } from 'node:fs';

export function rmWithCwdEscape(target, backup) {
  try {
    process.chdir(backup); // never delete a dir that is the live cwd on Windows
  } catch {
    /* keep going */
  }
  rmSync(target, { recursive: true, force: true });
}