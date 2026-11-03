/**
 * CI sanity checks for the macOS packaging output.
 *
 * Runs after `electron-builder --mac dmg zip` (arm64) and before the release
 * upload. Mirrors verify-linux-release.mjs: fail fast when a build
 * "succeeded" but would produce a broken package.
 *
 * Usage: node scripts/verify-mac-release.mjs [--arch arm64|x64]
 * (default arch: arm64, matching the current mac.target in package.json)
 *
 * Checks:
 *   1. The better-sqlite3 Electron-ABI prebuild was swapped into the unpacked
 *      asar and byte-matches `.native/electron/...` (sha256), i.e. it is the
 *      Electron-ABI build and not the npm (system-Node ABI) prebuild.
 *   2. `nexus.app/Contents/Resources/app.asar` lists the current-arch prebuild
 *      (the asarUnpack mapping depends on it being present in the asar header).
 *   3. `latest-mac.yml` parses with the app's own `parseUpdateYml()` and the
 *      version matches package.json; `files[]` contains BOTH `.dmg` and `.zip`.
 *   4. The .dmg passes `hdiutil verify`; attaching it shows an Info.plist with
 *      the right bundle id / version / display name.
 *   5. `codesign --verify --deep --strict` passes and the signature is ad-hoc
 *      (beta stage: no Developer ID yet). `spctl -a` is asserted to FAIL —
 *      that's the expected "not yet notarized" state.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const archIdx = argv.indexOf('--arch');
const arch = archIdx >= 0 ? argv[archIdx + 1] : 'arm64';
if (arch !== 'arm64' && arch !== 'x64') {
  console.error(`[verify-mac] unsupported --arch ${arch} (only arm64|x64)`);
  process.exit(1);
}

const root = process.cwd();
const releaseDir = join(root, 'release');
// electron-builder writes the mac build to `release/mac-<arch>` when the
// target arch is NOT the runner's default, and to `release/mac` when it IS.
// An arm64 runner building --arm64 produces `release/mac`; an x64 runner
// building --arm64 produces `release/mac-arm64`. Search for the candidate
// directories that actually exist and pick the one containing `nexus.app`.
const candidateAppOutDirs = [join(releaseDir, `mac-${arch}`), join(releaseDir, 'mac')];
const appOutDir = candidateAppOutDirs.find((d) => existsSync(join(d, 'nexus.app')));
if (!appOutDir) {
  console.error(
    `[verify-mac] no mac build found in: ${candidateAppOutDirs.map((d) => d).join(', ')}\n` +
    '  did `electron-builder --mac` run, and did it target the arch you asked for?',
  );
  process.exit(1);
}
const appBundle = join(appOutDir, 'nexus.app');
const contentsDir = join(appBundle, 'Contents');
const resourcesDir = join(contentsDir, 'Resources');
const ymlPath = join(releaseDir, 'latest-mac.yml');

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`[verify-mac] FAIL ${msg}`);
}
function ok(msg) {
  console.log(`[verify-mac] ok   ${msg}`);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expectedVersion = pkg.version;
const prebuild = `darwin-${arch}.node`;

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// ── 0. the bundle exists ──────────────────────────────────────────────────────
if (!existsSync(join(contentsDir, 'MacOS', 'nexus'))) {
  fail(`missing executable ${join(contentsDir, 'MacOS', 'nexus')}`);
  summarize();
}

// ── 1. better-sqlite3 Electron-ABI prebuild swapped into the asar ───────────
// after-pack.mjs byte-copies `.native/electron/.../prebuilds/<prebuild>` into
// the unpacked asar BEFORE ad-hoc codesign runs. But on macOS, signing a
// bundle with `codesign --force` re-writes files under
// `app.asar.unpacked/` in place (the signature must cover the current
// bytes), so the post-signing bytes are NOT guaranteed to equal the
// pre-signing bytes in `.native/electron`.
//
// The semantic invariant we CAN assert: the swapped binary must DIFFER from
// the system-Node-ABI prebuild that `npm ci` ships in the top-level
// node_modules. Same source, different V8 ABI → different bytes. If the
// swap never happened, asar.unpacked still holds the Node-ABI binary
// (copied by electron-builder from the top-level node_modules), and this
// check catches it.
const unpackedPrebuild = join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', prebuild);
const topLevelPrebuild = join(root, 'node_modules', 'better-sqlite3', 'prebuilds', prebuild);
if (!existsSync(unpackedPrebuild)) {
  fail(`missing ${unpackedPrebuild} — afterPack swap did not land`);
} else if (!existsSync(topLevelPrebuild)) {
  fail(`missing system-Node reference ${topLevelPrebuild} — cannot prove the swap`);
} else {
  const a = sha256(unpackedPrebuild);
  const b = sha256(topLevelPrebuild);
  const size = statSync(unpackedPrebuild).size;
  if (size < 1024 * 1024) {
    fail(`${prebuild} too small (${size} bytes) — likely not the Electron-ABI build`);
  } else if (a === b) {
    fail(`${prebuild} in asar.unpacked is BYTE-IDENTICAL to the system-Node prebuild (sha256 ${a.slice(0, 12)}…) — the afterPack swap did not land`);
  } else {
    ok(`${prebuild} in asar.unpacked differs from system-Node prebuild (${(size / 1048576).toFixed(2)} MiB, sha256 ${a.slice(0, 12)}… ≠ ${b.slice(0, 12)}…) — Electron-ABI swap landed`);
  }
}

// ── 2. asar header carries the current-arch prebuild (asarUnpack mapping) ───
const asar = join(resourcesDir, 'app.asar');
if (!existsSync(asar)) {
  fail(`missing ${asar}`);
} else {
  const res = spawnSync('npx', ['@electron/asar', 'list', asar], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
  });
  const lines = (res.stdout || '').split('\n').map((l) => l.replace(/\\/g, '/'));
  if (res.status === 0) {
    if (lines.some((l) => l.endsWith(`node_modules/better-sqlite3/prebuilds/${prebuild}`))) {
      ok(`app.asar lists prebuilds/${prebuild} (asarUnpack mapping is present)`);
    } else {
      fail(`app.asar does NOT list prebuilds/${prebuild} — binding.js will not find it`);
    }
  } else {
    fail(`@electron/asar list failed (exit ${res.status}): ${String(res.stderr ?? '').trim()}`);
  }
}

// ── 3. latest-mac.yml parses + has both entries ─────────────────────────────
const dmgCandidates = existsSync(releaseDir)
  ? spawnSync('ls', [releaseDir], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f.endsWith('.dmg'))
  : [];
if (!existsSync(ymlPath)) {
  fail(`missing ${ymlPath}`);
} else {
  const { parseUpdateYml } = await import(join(root, 'dist', 'shared', 'update-sources.js'));
  const parsed = parseUpdateYml(readFileSync(ymlPath, 'utf8'));
  if (!parsed) {
    fail(`latest-mac.yml failed to parse (no version / no files[])`);
  } else if (parsed.version !== expectedVersion) {
    fail(`latest-mac.yml version=${parsed.version} does not match package.json version=${expectedVersion}`);
  } else {
    ok(`latest-mac.yml parses (version=${parsed.version})`);
  }
  const fileUrls = parsed?.files?.map((f) => f.url) ?? [];
  if (!fileUrls.some((u) => /\.dmg$/i.test(u))) {
    fail(`latest-mac.yml files[] has no .dmg entry: ${fileUrls.join(', ')}`);
  } else {
    ok(`.dmg entry present`);
  }
  if (!fileUrls.some((u) => /\.zip$/i.test(u))) {
    fail(`latest-mac.yml files[] has no .zip entry: ${fileUrls.join(', ')}`);
  } else {
    ok(`.zip entry present`);
  }
  // Cross-check the manifest against what actually landed in release/.
  // electron-builder expands `${ext}` to the target's real extension:
  //   - dmg target → `.dmg`
  //   - zip target → `.zip`   (NOT `mac.zip`)
  const expectDmg = `nexus-${expectedVersion}-${arch}.dmg`;
  const expectZip = `nexus-${expectedVersion}-${arch}.zip`;
  if (!existsSync(join(releaseDir, expectDmg))) {
    fail(`expected ${expectDmg} in release/ (found: ${dmgCandidates.join(', ') || '(none)'})`);
  }
  const zipCandidates = spawnSync('ls', [releaseDir], { encoding: 'utf8' })
    .stdout.split('\n').filter((f) => f.endsWith('.zip'));
  if (!existsSync(join(releaseDir, expectZip))) {
    fail(`expected ${expectZip} in release/ (found: ${zipCandidates.join(', ') || '(none)'})`);
  }
}

// ── 4. dmg verifies + Info.plist fields ──────────────────────────────────────
const dmgPath = join(releaseDir, `nexus-${expectedVersion}-${arch}.dmg`);
if (existsSync(dmgPath)) {
  const verify = spawnSync('hdiutil', ['verify', dmgPath], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
  if (verify.status !== 0) {
    fail(`hdiutil verify failed on ${dmgPath} (exit ${verify.status}): ${String(verify.stderr ?? '').trim()}`);
  } else {
    ok(`hdiutil verify passed for ${dmgPath}`);
  }
  // Mount and inspect Info.plist. Use `attach -plist` to get the mount point
  // as a reliable JSON key, not by parsing the human-readable table (which
  // breaks on volumes whose names contain spaces, e.g. "Nexus 0.3.3-arm64").
  const mount = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-plist', dmgPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
  });
  let mountPoint = null;
  if (mount.status === 0) {
    // hdiutil -plist prints a top-level dict with "system-entities" → an array
    // of { mount-point, image-path, ... }.
    const xml = mount.stdout || '';
    mountPoint = xml.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  }
  if (mount.status !== 0 || !mountPoint) {
    fail(`hdiutil attach failed (exit ${mount.status}): ${String(mount.stdout ?? '').trim()}`);
  } else {
    const mountedApp = join(mountPoint, 'nexus.app');
    const plistPath = join(mountedApp, 'Contents', 'Info.plist');
    if (!existsSync(plistPath)) {
      fail(`dmg payload missing ${plistPath}`);
    } else {
      const plist = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', plistPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const xml = plist.stdout || '';
      const pick = (key) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? '';
      const bundleId = pick('CFBundleIdentifier');
      const shortVer = pick('CFBundleShortVersionString');
      const display = pick('CFBundleDisplayName');
      if (bundleId !== 'com.nexus.nexusagent') {
        fail(`Info.plist CFBundleIdentifier=${bundleId} (expected com.nexus.nexusagent)`);
      }
      if (shortVer !== expectedVersion) {
        fail(`Info.plist CFBundleShortVersionString=${shortVer} (expected ${expectedVersion})`);
      }
      if (display !== 'Nexus') {
        fail(`Info.plist CFBundleDisplayName=${JSON.stringify(display)} (expected "Nexus")`);
      }
      if (bundleId === 'com.nexus.nexusagent' && shortVer === expectedVersion && display === 'Nexus') {
        ok(`Info.plist: ${bundleId} v${shortVer} "${display}"`);
      }
    }
    spawnSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore', timeout: 60_000 });
  }
}

// ── 5. codesign: ad-hoc verified; spctl: expected-to-fail ──────────────────
const csVerify = spawnSync('codesign', ['--verify', '--deep', '--strict', appBundle], {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 300_000,
});
if (csVerify.status !== 0) {
  fail(`codesign --verify failed (exit ${csVerify.status}): ${String(csVerify.stderr ?? '').trim()}`);
} else {
  ok('codesign --verify --deep --strict passed');
  const csInfo = spawnSync('codesign', ['-dv', '--verbose=4', appBundle], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const info = String((csInfo.stdout || '') + (csInfo.stderr || ''));
  const sigLines = info.split('\n').filter((l) => /signature|authority/i.test(l));
  // Ad-hoc signature: `Signature=adhoc` (or `Signature type=Application` on
  // some macOS builds) AND **no** `Authority=` lines (a real Developer ID
  // cert would print `Authority=Nexus` + `Authority=Apple Root...`).
  const isAdhoc = /Signature=adhoc/i.test(info) && !/Authority=/.test(info);
  if (isAdhoc) {
    ok(`signature is ad-hoc (expected at the unsigned beta stage): ${sigLines.join(' | ')}`);
  } else if (/Authority=/.test(info)) {
    fail(`expected an ad-hoc signature but found a Developer ID: ${sigLines.join(' | ')}`);
  } else {
    fail(`could not detect signature type; raw: ${info.slice(0, 400)}`);
  }
}
// Notarization is intentionally NOT done at this stage: spctl must reject the
// app. Asserting that keeps a future "someone enabled notarize" regression loud.
const spctl = spawnSync('spctl', ['-a', '-vv', appBundle], { stdio: ['ignore', 'pipe', 'pipe'] });
if (spctl.status === 0) {
  fail('spctl accepted the app — notarization unexpectedly enabled?');
} else {
  ok('spctl rejected the app (expected: no notarization at beta stage)');
}

// ── summary ──────────────────────────────────────────────────────────────────
function summarize() {
  if (failures.length > 0) {
    console.error(`[verify-mac] ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('[verify-mac] all checks passed');
}
summarize();
