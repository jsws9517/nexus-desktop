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
// electron-builder lays out the mac build as release/mac/<app>.app (the arch
// suffix is omitted when the built arch is the runner's default arch).
const appOutDir = join(releaseDir, 'mac');
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

// ── 1. better-sqlite3 Electron-ABI prebuild swapped + byte-matches ──────────
const unpackedPrebuild = join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', prebuild);
const electronPrebuild = join(root, '.native', 'electron', 'node_modules', 'better-sqlite3', 'prebuilds', prebuild);
if (!existsSync(unpackedPrebuild)) {
  fail(`missing ${unpackedPrebuild}`);
} else if (!existsSync(electronPrebuild)) {
  fail(`missing Electron-ABI source ${electronPrebuild} — prepare:electron-native did not run?`);
} else {
  const a = sha256(unpackedPrebuild);
  const b = sha256(electronPrebuild);
  const size = statSync(unpackedPrebuild).size;
  if (size < 1024 * 1024) {
    fail(`${prebuild} too small (${size} bytes) — likely not the Electron-ABI build`);
  } else if (a !== b) {
    fail(`${prebuild} does NOT match the Electron-ABI build (sha256 ${a.slice(0, 12)}… vs ${b.slice(0, 12)}…)`);
  } else {
    ok(`${prebuild} swapped into asar.unpacked (${(size / 1048576).toFixed(2)} MiB, sha256 ${a.slice(0, 12)}…)`);
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
  const expectDmg = `nexus-${expectedVersion}-${arch}.dmg`;
  if (!existsSync(join(releaseDir, expectDmg))) {
    fail(`expected ${expectDmg} in release/ (found: ${dmgCandidates.join(', ') || '(none)'})`);
  }
  if (!existsSync(join(releaseDir, `nexus-${expectedVersion}-${arch}-mac.zip`))) {
    fail(`expected nexus-${expectedVersion}-${arch}-mac.zip in release/`);
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
  const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    encoding: 'utf8',
  });
  const attachOut = String(attach.stdout ?? '');
  const volume = attachOut.split('\n').find((l) => l.includes('/Volumes/'));
  const detach = (code) => {
    if (volume) {
      const mountPoint = volume.split(/\s+/).at(-1);
      spawnSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore', timeout: 60_000 });
    }
  };
  if (attach.status !== 0 || !volume) {
    fail(`hdiutil attach failed (exit ${attach.status}): ${attachOut}`);
  } else {
    const mountPoint = volume.split(/\s+/).at(-1);
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
    detach();
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
  const csInfo = spawnSync('codesign', ['-vv', appBundle], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const info = String((csInfo.stdout || '') + (csInfo.stderr || ''));
  if (/Signature=adhoc/i.test(info) || /adhoc/i.test(info)) {
    ok('signature is ad-hoc (expected for the unsigned beta stage)');
  } else {
    fail(`expected an ad-hoc signature, got: ${info.split('\n').filter((l) => /signature/i.test(l)).join(' ')}`);
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
