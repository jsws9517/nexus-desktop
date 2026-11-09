import { compareVersions, isNewer } from '../dist/shared/update-sources.js';

// compareVersions tests
const cmpCases = [
  // [a, b, expected]
  ['0.3.5', '0.3.4', 1],
  ['0.3.4', '0.3.4', 0],
  ['0.3.4', '0.3.5', -1],
  ['0.3.5-beta.1', '0.3.4', 1],  // beta of next baseline > current stable
  ['0.3.4-beta.1', '0.3.4', -1],  // beta of current baseline < stable
  ['0.3.4-beta.2', '0.3.4-beta.1', 1],  // later beta > earlier beta
  ['0.3.4-beta.10', '0.3.4-beta.9', 1], // numeric compare, not lexicographic
  ['1.0.0', '0.99.99', 1],
];
for (const [a, b, expected] of cmpCases) {
  const r = compareVersions(a, b);
  const ok = (r > 0) === (expected > 0) && (r === 0) === (expected === 0);
  if (!ok) throw new Error(`compareVersions(${a}, ${b}) = ${r}, expected sign ${expected}`);
}
console.log('compareVersions: OK');

// isNewer tests
const isNewerCases = [
  // [candidate, current, allowBeta, expected]
  ['0.3.5', '0.3.4', false, true],
  ['0.3.5', '0.3.4', true, true],
  ['0.3.5-beta.1', '0.3.4', false, true],  // 0.3.5 baseline > 0.3.4: strictly newer, offered even without beta channel
  ['0.3.5-beta.1', '0.3.4', true, true],     // stable→beta allowed
  ['0.3.4-beta.2', '0.3.4-beta.1', false, true],  // beta→newer beta always allowed
  ['0.3.4-beta.2', '0.3.4-beta.1', true, true],
  ['0.3.4', '0.3.4', true, false],          // same version: never offered
  ['0.3.4-beta.1', '0.3.4-beta.1', true, false],
  ['0.3.4', '0.3.4-beta.1', true, false],   // stable < beta (not newer)
  ['0.3.4-beta.1', '0.3.4', true, true],     // stable → same-baseline beta: the beta-channel offer
];
for (const [cand, cur, allow, expected] of isNewerCases) {
  const r = isNewer(cand, cur, allow);
  if (r !== expected) throw new Error(`isNewer(${cand}, ${cur}, allow=${allow}) = ${r}, expected ${expected}`);
}
console.log('isNewer: OK');

// desktop-state persistence
const { createDesktopState } = await import('../dist/main/desktop-state.js');
const fs = await import('node:fs');
const os = await import('node:os');
const { join } = await import('node:path');

const tmp = fs.mkdtempSync(join(os.tmpdir(), 'nexus-desktop-test-'));
process.env.NEXUS_CONFIG_DIR = tmp;

let store = createDesktopState();
// absent → default ON
if (store.getAllowBetaUpdates() !== true) throw new Error('default should be true (ON)');
// explicit false → off
store.setAllowBetaUpdates(false);
if (store.getAllowBetaUpdates() !== false) throw new Error('explicit false should be off');
// explicit true → on
store.setAllowBetaUpdates(true);
if (store.getAllowBetaUpdates() !== true) throw new Error('explicit true should be on');
// persisted file round-trips
let store2 = createDesktopState();
if (store2.getAllowBetaUpdates() !== true) throw new Error('re-read should preserve true');

fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.NEXUS_CONFIG_DIR;
console.log('desktop-state allowBetaUpdates: OK');
