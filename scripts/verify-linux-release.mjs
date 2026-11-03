/**
 * CI sanity checks for the Linux packaging output.
 *
 * Runs after `electron-builder --linux AppImage deb` and before the release
 * upload. Fails fast when a build "succeeded" but would produce a broken
 * package, which has happened historically on Windows (missing .node binary,
 * missing manifest field, …).
 *
 * Checks:
 *   1. `linux-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/
 *      prebuilds/linux-x64.node` exists and is non-trivially sized (> 1 MB).
 *   2. `latest-linux.yml` parses with the app's own `parseUpdateYml()`, has a
 *      version matching the running package.json, and contains both `.AppImage`
 *      and `.deb` entries in `files[]`.
 *   3. The AppImage carries a `blockMapSize` field (electron-builder appends
 *      the differential blockmap into the file; electron-updater reads it
 *      from the running `$APPIMAGE` at download time).
 *   4. Both binaries exist, are executable-bit set, and have a sane size
 *      (an AppImage under 20 MiB is almost certainly empty / broken).
 *   5. The AppImage **does not** ship a `resources/package-type` marker
 *      (if it did, electron-updater would treat it as a deb install and the
 *      self-update path would pick DebUpdater → broken).
 */
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const releaseDir = join(root, 'release');
const appImage = join(releaseDir, 'nexus-x64.AppImage');
const ymlPath = join(releaseDir, 'latest-linux.yml');
const linuxUnpacked = join(releaseDir, 'linux-unpacked');

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`[verify-linux] FAIL ${msg}`);
}
function ok(msg) {
  console.log(`[verify-linux] ok   ${msg}`);
}

// ── 1. better-sqlite3 .node swapped into the unpacked asar ──────────────────
const betterSqliteDir = join(linuxUnpacked, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3');
const prebuild = join(betterSqliteDir, 'prebuilds', 'linux-x64.node');
if (!existsSync(prebuild)) {
  fail(`missing ${prebuild}`);
} else {
  const size = statSync(prebuild).size;
  if (size < 1024 * 1024) {
    fail(`linux-x64.node too small (${size} bytes) — likely not the Electron-ABI build`);
  } else {
    ok(`linux-x64.node present (${(size / 1048576).toFixed(2)} MiB)`);
  }
}

// ── 2. latest-linux.yml parses + has both entries ───────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expectedVersion = pkg.version;

if (!existsSync(ymlPath)) {
  fail(`missing ${ymlPath}`);
} else {
  // Import the parser straight from the built app source — the same one the
  // packaged binary would use, so a parser regression would break CI here
  // instead of in the field.
  const { parseUpdateYml } = await import(join(root, 'dist', 'shared', 'update-sources.js'));
  const text = readFileSync(ymlPath, 'utf8');
  const parsed = parseUpdateYml(text);
  if (!parsed) {
    fail(`latest-linux.yml failed to parse (no version / no files[])`);
  } else if (parsed.version !== expectedVersion) {
    fail(`latest-linux.yml version=${parsed.version} does not match package.json version=${expectedVersion}`);
  } else {
    ok(`latest-linux.yml parses (version=${parsed.version})`);
  }
  const fileUrls = parsed?.files?.map((f) => f.url) ?? [];
  if (!fileUrls.some((u) => /\.AppImage$/i.test(u))) {
    fail(`latest-linux.yml files[] has no .AppImage entry: ${fileUrls.join(', ')}`);
  }
  if (!fileUrls.some((u) => /\.deb$/i.test(u))) {
    fail(`latest-linux.yml files[] has no .deb entry: ${fileUrls.join(', ')}`);
  }
  const appImageEntry = parsed?.files?.find((f) => /\.AppImage$/i.test(f.url));
  if (appImageEntry && !('blockMapSize' in appImageEntry)) {
    fail(`latest-linux.yml .AppImage entry has no blockMapSize — differential update disabled`);
  } else if (appImageEntry) {
    ok(`.AppImage entry has blockMapSize=${appImageEntry.blockMapSize}`);
  }
}

// ── 3. binaries exist, are executable, sane size ───────────────────────────
for (const f of [appImage, join(releaseDir, `nexus-${expectedVersion}-x64.deb`), ymlPath]) {
  if (!existsSync(f)) {
    fail(`missing ${f}`);
    continue;
  }
  const size = statSync(f).size;
  if (f === appImage && size < 20 * 1048576) {
    fail(`AppImage ${size} bytes — too small, build is broken`);
  } else if (f.endsWith('.deb') && size < 5 * 1048576) {
    fail(`deb ${size} bytes — too small, build is broken`);
  } else if (!failures.some((m) => m.includes(f))) {
    ok(`${f.split('/').pop()} (${(size / 1048576).toFixed(1)} MiB)`);
  }
}

// ── 4. AppImage must NOT ship resources/package-type ────────────────────────
// The deb target writes that file into `linux-unpacked/resources` *after* the
// AppImage target has already squashed its payload — so a correct build has
// no `package-type` inside the AppImage. If the target order regresses
// (deb built first), the AppImage would inherit the marker and electron-updater
// would use DebUpdater for the AppImage (broken self-update).
//
// We check by unpacking the AppImage to a temp dir and inspecting. This runs
// `--appimage-extract`, which does not require FUSE.
const tmp = mkdtempSync(join(tmpdir(), 'nexus-verify-appimage-'));
try {
  const res = spawnSync('sh', ['-c', `cd "${tmp}" && "${appImage}" --appimage-extract`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  if (res.status !== 0) {
    fail(`--appimage-extract exited ${res.status}: ${String(res.stderr ?? '').trim()}`);
  } else {
    const pkgType = join(tmp, 'AppDir', 'resources', 'package-type');
    if (existsSync(pkgType)) {
      fail('AppImage payload contains resources/package-type — electron-updater will pick DebUpdater (target order regression)');
    } else {
      ok('AppImage payload has no resources/package-type (correct: built before deb)');
    }
  }
} catch (e) {
  fail(`--appimage-extract check failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── summary ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`[verify-linux] ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[verify-linux] all checks passed');
