/**
 * Sync the latest nexus-coder core into this app's runtime copy.
 *
 * The desktop resolves the agent core at runtime via
 * `node_modules/nexus-coder/dist/...` (the installed npm package copy, not a
 * symlink). After changing the core source (`D:\agent-cli\nexus-coder`), the
 * freshly built `dist/` must be copied over that installed copy before the
 * desktop runs with the new logic.
 *
 * Usage:
 *   node scripts/sync-core.mjs                 one-shot copy (no build)
 *   node scripts/sync-core.mjs --build         build the core first, then copy
 *   node scripts/sync-core.mjs --watch         copy + watch for changes & resync
 *
 * Env: NEXUS_CODER_SRC overrides the core source root (default: ../nexus-coder).
 *       NEXUS_SKIP_CORE_BUILD=1 skips the --build step (core stays as-is).
 *
 * CI / packaging safety: if the source root is not present (e.g. GitHub
 * Actions `npm ci`), the copy and the --build step both skip with a notice
 * and exit 0 — they never fail a clean registry-based install/build.
 *
 * Local dev: a failing core build (source present, tsc errors) aborts with
 * exit 1 so the desktop never compiles against a stale dist.
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, watch, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = process.env.NEXUS_CODER_SRC || join(root, '..', 'nexus-coder');
const srcDist = join(srcRoot, 'dist');
const dstRoot = join(root, 'node_modules', 'nexus-coder');
const dstDist = join(dstRoot, 'dist');

const WATCH_DEBOUNCE_MS = 300;
const WATCH_FILTER = /\.(?:js|d\.ts|map)$|(?:^|[\\/])package\.json$/;

let watchTimer = null;

function srcOk() {
  return existsSync(join(srcDist, 'src', 'index.js'));
}

function fileCount(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) n += fileCount(full);
    else n += 1;
  }
  return n;
}

function syncOnce({ quiet = false } = {}) {
  if (!existsSync(srcRoot)) {
    if (!quiet) console.log(`[sync-core] core source not found at ${srcRoot} — skipping (registry copy stays as-is).`);
    return false;
  }
  if (!srcOk()) {
    console.error(`[sync-core] ${join(srcDist, 'src', 'index.js')} missing. Run \`npm run build\` in ${srcRoot} first (or pass --build).`);
    process.exitCode = 1;
    return false;
  }
  if (!existsSync(dstRoot)) {
    console.error(`[sync-core] target package missing at ${dstRoot}. Run \`npm install\` first.`);
    process.exitCode = 1;
    return false;
  }

  rmSync(dstDist, { recursive: true, force: true });
  cpSync(srcDist, dstDist, { recursive: true });

  syncCoreVersionField();

  if (!quiet) {
    const srcMtime = statSync(join(srcDist, 'src', 'index.js')).mtime.toISOString();
    console.log(`[sync-core] synced ${fileCount(srcDist)} files from ${srcDist} -> ${dstDist} (core src mtime ${srcMtime})`);
  }
  return true;
}

/**
 * Keep `package.json.nexusCoreVersion` equal to the version actually installed
 * under node_modules/nexus-coder, so the declared value never drifts from the
 * runtime copy (tooling + CI read it without resolving node_modules).
 */
function syncCoreVersionField() {
  const corePkgPath = join(dstRoot, 'package.json');
  const desktopPkgPath = join(root, 'package.json');
  try {
    const coreVersion = JSON.parse(readFileSync(corePkgPath, 'utf8')).version;
    if (!coreVersion) return;
    const pkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
    if (pkg.nexusCoreVersion === coreVersion) return;
    // Preserve the exact field order: replace the literal line in place.
    const text = readFileSync(desktopPkgPath, 'utf8');
    const next = text.replace(
      /"nexusCoreVersion":\s*"[^"]*"/,
      `"nexusCoreVersion": "${coreVersion}"`,
    );
    writeFileSync(desktopPkgPath, next);
    console.log(`[sync-core] nexusCoreVersion -> ${coreVersion}`);
  } catch (err) {
    console.warn(`[sync-core] could not sync nexusCoreVersion: ${err.message}`);
  }
}

function buildCore() {
  if (process.env.NEXUS_SKIP_CORE_BUILD === '1') {
    console.log('[sync-core] NEXUS_SKIP_CORE_BUILD=1 — skipping core build (using existing dist / registry copy).');
    return false;
  }
  if (!existsSync(srcRoot)) {
    // CI / clean-checkout safety: no sibling core source is expected, so a
    // missing source is a notice, not an error (mirrors syncOnce above).
    console.log(`[sync-core] core source not found at ${srcRoot} — skipping build (registry copy stays as-is).`);
    return false;
  }
  console.log(`[sync-core] building core in ${srcRoot} ...`);
  // Throws on failure — the caller aborts so the desktop never compiles
  // against a stale or broken dist.
  execSync('npm run build', { cwd: srcRoot, stdio: 'inherit' });
  return true;
}

function startWatch() {
  if (!existsSync(srcDist)) {
    console.error(`[sync-core] ${srcDist} missing. Run \`npm run build\` in ${srcRoot} first (or start with --build).`);
    process.exitCode = 1;
    return;
  }
  syncOnce({ quiet: true });
  console.log(`[sync-core] watching ${srcDist} for changes (Ctrl+C to stop)...`);

  let initialScan = true;
  let watchedDirs = new Set();

  function resync() {
    if (watchTimer) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
    if (syncOnce({ quiet: true })) {
      console.log(`[sync-core] resynced at ${new Date().toISOString()}`);
    }
  }

  function debounce() {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(resync, WATCH_DEBOUNCE_MS);
  }

  // Prefer native recursive watching (supported on Windows/macOS); fall back to
  // a manual per-directory walk when recursive:true is rejected.
  let recursiveSupported = false;
  try {
    watch(srcDist, { recursive: true }, () => {});
    recursiveSupported = true;
  } catch {
    recursiveSupported = false;
  }

  function watchDir(dir) {
    if (watchedDirs.has(dir)) return;
    watchedDirs.add(dir);
    try {
      watch(dir, { recursive: false }, (_event, filename) => {
        if (initialScan) return;
        if (!filename || !WATCH_FILTER.test(filename)) return;
        debounce();
      });
    } catch {
      /* ignore unsupported watches */
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) watchDir(join(dir, entry.name));
    }
  }

  if (recursiveSupported) {
    watch(srcDist, { recursive: true }, (_event, filename) => {
      if (initialScan) return;
      if (!filename || !WATCH_FILTER.test(filename)) return;
      debounce();
    });
  } else {
    watchDir(srcDist);
  }
  // After the recursive watchers are set up, allow events to trigger resyncs.
  setTimeout(() => {
    initialScan = false;
  }, 100);
}

const args = process.argv.slice(2);
const wantBuild = args.includes('--build');
const wantWatch = args.includes('--watch');

if (wantBuild) {
  try {
    buildCore();
  } catch (e) {
    // Source present but `npm run build` failed — aborting here is the
    // point: continuing would let the desktop compile against a stale dist.
    console.error(`[sync-core] core build failed: ${String(e.message ?? e).slice(0, 300)}`);
    console.error(`[sync-core] hint: fix the core build, or skip with NEXUS_SKIP_CORE_BUILD=1`);
    process.exit(1);
  }
}

if (wantWatch) {
  startWatch();
} else {
  syncOnce();
}
