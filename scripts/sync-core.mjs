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
 *   node scripts/sync-core.mjs --force         copy even when the source dist is unchanged
 *   node scripts/sync-core.mjs --watch         copy + watch for changes & resync
 *
 * Fast path: the source `dist/` is fingerprinted (relative path + size + mtime
 * of every file, hashed). The hash is stored in `.nexus-sync-stamp.json` under
 * the installed core package, so a repeat sync with an untouched `dist/` skips
 * the rm + copy entirely (`--force` overrides).
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
import { createHash } from 'node:crypto';
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

/** Stamp recording the fingerprint of the src dist that was last copied. */
const STAMP_FILE = join(dstRoot, '.nexus-sync-stamp.json');
const STAMP_VERSION = 1;

let watchTimer = null;

function srcOk() {
  return existsSync(join(srcDist, 'src', 'index.js'));
}

/**
 * Order-independent, cheap fingerprint of a dist tree: relative path + size +
 * mtime for every file, plus directory names (so empty dirs count too).
 * Rewriting a file always changes this hash; a pure byte-identical rebuild
 * that keeps mtimes is treated as unchanged too (that is the desired no-op).
 */
function fingerprint(dir) {
  const hash = createHash('sha256');
  let files = 0;
  const walk = (current, rel) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        hash.update(`d ${relPath}\n`);
        walk(full, relPath);
      } else if (entry.isFile()) {
        const st = statSync(full);
        files += 1;
        hash.update(`f ${relPath} ${st.size} ${Math.floor(st.mtimeMs)}\n`);
      }
    }
  };
  walk(dir, '');
  return { hash: hash.digest('hex'), files };
}

function readStamp() {
  try {
    const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'));
    if (stamp && stamp.version === STAMP_VERSION && typeof stamp.hash === 'string') return stamp;
  } catch {
    /* missing or corrupt stamp -> full sync */
  }
  return null;
}

function writeStamp(fp) {
  try {
    const stamp = { version: STAMP_VERSION, hash: fp.hash, files: fp.files, src: srcDist, at: new Date().toISOString() };
    writeFileSync(STAMP_FILE, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch (err) {
    // A read-only node_modules only costs us the fast path, never the sync.
    console.warn(`[sync-core] could not write ${STAMP_FILE}: ${err.message}`);
  }
}

function syncOnce({ quiet = false, force = false } = {}) {
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

  const fp = fingerprint(srcDist);

  // Fast path: same source dist as last time and the copy still exists.
  // The version field is still reconciled because it can drift independently
  // (e.g. a hand-edited package.json).
  if (!force && existsSync(dstDist)) {
    const stamp = readStamp();
    if (stamp && stamp.hash === fp.hash) {
      syncCoreVersionField();
      if (!quiet) {
        console.log(`[sync-core] up to date — ${fp.files} files unchanged (hash ${fp.hash.slice(0, 12)}), skipping copy`);
      }
      return false;
    }
  }

  rmSync(dstDist, { recursive: true, force: true });
  cpSync(srcDist, dstDist, { recursive: true });

  syncCoreVersionField();
  writeStamp(fp);

  if (!quiet) {
    const srcMtime = statSync(join(srcDist, 'src', 'index.js')).mtime.toISOString();
    console.log(`[sync-core] synced ${fp.files} files from ${srcDist} -> ${dstDist} (core src mtime ${srcMtime})`);
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

function startWatch({ force = false } = {}) {
  if (!existsSync(srcDist)) {
    console.error(`[sync-core] ${srcDist} missing. Run \`npm run build\` in ${srcRoot} first (or start with --build).`);
    process.exitCode = 1;
    return;
  }
  syncOnce({ quiet: true, force });
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
const wantForce = args.includes('--force');

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
  startWatch({ force: wantForce });
} else {
  syncOnce({ force: wantForce });
}
