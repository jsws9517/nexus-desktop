/**
 * Pin the desktop's nexus-coder dependency to the newest published core.
 *
 * Called by .github/workflows/release.yml after Setup Node and before
 * `npm ci`: it resolves the newest version among the `latest` and `beta`
 * dist-tags on the npm registry, verifies its desktop-protocol
 * compatibility, and writes the pinned version into package.json (exact,
 * no caret) + package-lock.json. The following `npm ci` then installs the
 * pinned version, and `publish-core.mjs` (which reads node_modules) ships
 * it as the baseline.
 *
 * Usage:
 *   node scripts/set-core-version.mjs                  resolve + apply
 *   node scripts/set-core-version.mjs --dry-run         resolve + print, no writes
 *   node scripts/set-core-version.mjs --version 1.2.3   pin an explicit version
 *   node scripts/set-core-version.mjs --check           verify no drift; exit 1
 *                                                        if anything lags
 *
 * The lockfile is updated with --package-lock-only so node_modules is left
 * untouched (CI installs from the lock a moment later; locally, run
 * `npm install` to materialize the pinned version).
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickNewestCore, compareVersions } from './core-version-select.mjs';

const NPM_REGISTRY = 'https://registry.npmjs.org/';
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const PKG_PATH = join(root, 'package.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const check = args.includes('--check');
const versionIdx = args.indexOf('--version');
const explicitVersion = versionIdx !== -1 ? args[versionIdx + 1] : undefined;

if (versionIdx !== -1 && !explicitVersion) {
  console.error('set-core-version: --version requires a value');
  process.exit(1);
}

function fail(msg) {
  console.error(`[set-core-version] ${msg}`);
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { cwd: root, stdio: 'pipe' }).toString();
}

function installedVersion() {
  const p = join(root, 'node_modules', 'nexus-coder', 'package.json');
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Protocol pre-gate: the pinned core must speak the desktop's protocol,
 * otherwise the installer would ship a baseline the client refuses to run
 * (mirror of the client-side gate in src/core-overlay/protocol.ts). A
 * missing field on the published package means the core predates the
 * field and is treated as legacy-compatible, same as the client.
 */
function verifyProtocol(target) {
  const desktopPkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const desktop = desktopPkg.nexusDesktopProtocol;
  let raw;
  try {
    raw = run(`npm view nexus-coder@${target} nexusDesktopProtocol --json --registry ${NPM_REGISTRY}`).trim();
  } catch (e) {
    fail(`cannot read nexus-coder@${target} metadata: ${String(e.message ?? e).slice(0, 300)}`);
  }
  let protocol = null;
  try {
    protocol = JSON.parse(raw);
  } catch {
    protocol = null; // npm prints plain "undefined"/"" for absent fields
  }
  if (protocol !== null && protocol !== undefined && Number(protocol) !== Number(desktop)) {
    fail(
      `nexus-coder@${target} speaks desktop protocol ${protocol}, ` +
      `this desktop speaks ${desktop} — refusing to pin an incompatible baseline. ` +
      `Ship a core that matches nexusDesktopProtocol first.`,
    );
  }
  return desktop;
}

function isDrifted(target) {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const spec = pkg.dependencies?.['nexus-coder'];
  const field = pkg.nexusCoreVersion;
  const installed = installedVersion();
  return {
    spec,
    field,
    installed,
    drifted:
      spec !== target ||
      field !== target ||
      (installed !== null && compareVersions(installed, target) !== 0),
  };
}

function writePinned(target) {
  // package.json: dependencies["nexus-coder"] -> exact version (idempotent)
  let text = readFileSync(PKG_PATH, 'utf8');
  const spec = JSON.parse(text).dependencies?.['nexus-coder'];
  if (spec !== target) {
    const next = text.replace(/("nexus-coder":\s*")[^"]*(")/, `$1${target}$2`);
    if (next === text) fail('could not locate the nexus-coder dependency line in package.json');
    text = next;
    writeFileSync(PKG_PATH, text);
  }

  // Keep nexusCoreVersion in lockstep (test/core-protocol.test.mjs enforces
  // equality with node_modules; tooling reads it without resolving it).
  const field = JSON.parse(readFileSync(PKG_PATH, 'utf8')).nexusCoreVersion;
  if (field !== target) {
    text = readFileSync(PKG_PATH, 'utf8').replace(
      /"nexusCoreVersion":\s*"[^"]*"/,
      `"nexusCoreVersion": "${target}"`,
    );
    writeFileSync(PKG_PATH, text);
  }

  // Lockfile only: descriptor + resolved + integrity. node_modules stays as
  // it was so `npm ci` (CI) or `npm install` (local) picks it up cleanly.
  run(
    `npm install nexus-coder@${target} --save-exact --package-lock-only --no-audit --no-fund`,
  );
  console.log(`[set-core-version] pinned nexus-coder@${target} (exact) into package.json + package-lock.json`);
}

function summaryLine(target, distTags, protocol) {
  return (
    `\n## Core version pin\n\n` +
    `- Pinned **nexus-coder @ ${target}** (newest of latest \`${distTags?.latest ?? '-'}\` / beta \`${distTags?.beta ?? '-'}\`)\n` +
    `- Desktop protocol: ${protocol}\n`
  );
}

// ---- main -----------------------------------------------------------------

if (explicitVersion) {
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(explicitVersion)) {
    fail(`--version value looks invalid: ${explicitVersion}`);
  }
  const target = explicitVersion;
  console.log(`[set-core-version] explicit target ${target}`);
  const protocol = verifyProtocol(target);
  const { drifted } = isDrifted(target);

  if (check) {
    if (drifted) fail(`nexus-coder lags behind ${target} (run \`npm install nexus-coder@${target} --save-exact\` and sync)`);
    console.log(`[set-core-version] everything matches ${target}`);
  } else if (drifted && !dryRun) {
    writePinned(target);
  } else if (drifted) {
    console.log(`[set-core-version] would pin nexus-coder@${target} (dry-run, no change)`);
  } else {
    console.log(`[set-core-version] nexus-coder already at ${target} — no change needed`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLine(target, null, protocol));
  }
} else {
  let distTags;
  try {
    const out = run(`npm view nexus-coder dist-tags --json --registry ${NPM_REGISTRY}`).trim();
    try {
      distTags = JSON.parse(out);
    } catch {
      // Tolerate stray npm notice lines: grab the first {...} block.
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) fail(`could not parse npm dist-tags output: ${out.slice(0, 300)}`);
      distTags = JSON.parse(m[0]);
    }
  } catch (e) {
    fail(`cannot read dist-tags: ${String(e.message ?? e).slice(0, 300)}`);
  }

  const target = pickNewestCore(distTags);
  const protocol = verifyProtocol(target);
  const { spec, field, installed, drifted } = isDrifted(target);

  console.log(
    `[set-core-version] latest=${distTags.latest ?? '-'} beta=${distTags.beta ?? '-'} -> ${target} ` +
    `(desktop protocol ${protocol}; spec \`${spec ?? '-'}\`, nexusCoreVersion ${field ?? '-'}, installed ${installed ?? 'n/a'})`,
  );

  if (check) {
    if (drifted) {
      fail(
        `nexus-coder resolves to ${target} but ` +
        [spec !== target && `spec is ${spec}`, field !== target && `nexusCoreVersion is ${field}`,
         installed !== null && compareVersions(installed, target) !== 0 && `installed is ${installed}`]
          .filter(Boolean).join('; ') +
        ` — run \`npm install nexus-coder@${target} --save-exact\` and sync`,
      );
    }
    console.log(`[set-core-version] no drift — resolved ${target} is current everywhere`);
  } else if (!dryRun && drifted) {
    writePinned(target);
  } else {
    console.log(`[set-core-version] nexus-coder already at ${target} — ${dryRun ? 'dry-run, no change' : 'no change needed'}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLine(target, distTags, protocol));
  }
}
