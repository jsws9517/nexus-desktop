/**
 * Publish a core update artifact for GitHub / Gitee releases.
 *
 * Packages nexus-coder dist into `core-<version>.tar.gz`, includes the
 * package.json with the release version, computes SHA-512, and writes
 * `latest-core.yml` alongside the release artifacts.
 *
 * Usage:
 *   node scripts/publish-core.mjs                        # uses node_modules/nexus-coder
 *   node scripts/publish-core.mjs --version 1.2.3        # fetch from npm into temp dir
 *   node scripts/publish-core.mjs --version 1.2.3 --out <dir>
 *
 * When --version is given, the package is fetched from npm into a transient
 * directory without touching the desktop's node_modules or package-lock.json.
 * This is the independent-publish path for nexus-coder releases.
 *
 * Defaults: --out release (same directory electron-builder emits into).
 */
import { createHash, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(root, '..');

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const outDir = flag('out') || path.join(repoRoot, 'release');
const keysDir = flag('keys-dir') || path.join(repoRoot, 'keys');
// --version <semver>  publishes a specific nexus-coder version fetched from npm
// without touching the desktop's node_modules or package-lock.json. The package
// is installed into a transient temp dir and discarded after the artifacts are
// produced. Omit this flag to use the version already resident in
// node_modules/nexus-coder (the desktop-release path).
const explicitVersion = flag('version');
// --release-tag <tag>  overrides the release tag the manifest URL points to.
// Required for independent publishes where the target desktop release differs
// from the version in package.json (which may be stale).
const explicitReleaseTag = flag('release-tag');

/** The desktop protocol declared in this repo's own package.json. */
function readDesktopPackage() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readDesktopProtocol() {
  const pkg = readDesktopPackage();
  return Number.isInteger(pkg.nexusDesktopProtocol) && pkg.nexusDesktopProtocol >= 0
    ? pkg.nexusDesktopProtocol
    : 1;
}

/**
 * A release must never silently ship without a core artifact: in CI a skip is
 * a failure, locally it is only a warning.
 */
function skip(reason) {
  console.error(`[publish-core] ${reason}`);
  if (process.env.GITHUB_ACTIONS === 'true') process.exitCode = 1;
}

async function main() {
  let pkgFile;
  let srcDist;
  let tempDir = null;

  if (explicitVersion) {
    // Independent-publish mode: fetch nexus-coder@<version> from npm into a
    // transient directory. The desktop's node_modules and lockfile are
    // deliberately untouched so this can run on a CI runner that does not
    // carry the matching package-lock.json.
    console.log(`[publish-core] fetching nexus-coder@${explicitVersion} from npm...`);
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'nexus-coder-pkg-'));
    // npm pack writes `<name>-<version>.tgz` into cwd — capture the exact filename
    // from stdout rather than hardcoding it.
    const packedName = execSync(
      `npm pack nexus-coder@${explicitVersion} --registry https://registry.npmjs.org/`,
      { cwd: tempDir, stdio: 'pipe' },
    ).toString().trim().split('\n').filter((l) => l.endsWith('.tgz')).pop();
    if (!packedName || !fs.existsSync(path.join(tempDir, packedName))) {
      skip(`npm pack failed for nexus-coder@${explicitVersion}; output: ${packedName ?? 'empty'}`);
      return;
    }
    const tgz = path.join(tempDir, packedName);
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar xzf "${tgz}" -C "${extractDir}"`, { stdio: 'pipe' });
    // npm pack places the package contents under "package/" (npm v9+) or at the
    // root (older npm); handle both.
    const pkgDir = fs.existsSync(path.join(extractDir, 'package')) ? path.join(extractDir, 'package') : extractDir;
    pkgFile = path.join(pkgDir, 'package.json');
    srcDist = path.join(pkgDir, 'dist');
    if (!fs.existsSync(pkgFile)) {
      skip(`npm pack did not yield package.json for nexus-coder@${explicitVersion}`);
      return;
    }
    console.log(`[publish-core] using transient copy at ${pkgDir}`);
  } else {
    pkgFile = path.join(repoRoot, 'node_modules', 'nexus-coder', 'package.json');
    srcDist = path.join(repoRoot, 'node_modules', 'nexus-coder', 'dist');
  }

  if (!fs.existsSync(pkgFile)) {
    skip(`nexus-coder/package.json not found at ${pkgFile}; no core artifact published.`);
    return;
  }
  const { version } = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (!version) {
    skip('no version field in nexus-coder/package.json');
    return;
  }

  // Resolve the protocol this core is compatible with. The core's own
  // declaration wins (an independently released core); otherwise the companion
  // desktop's protocol is used (this CI publishes them together). The value is
  // written both into the artifact's package.json (so the client's activation
  // and boot gates can read it) and into the manifest.
  const corePkgRaw = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const declaredProtocol = Number.isInteger(corePkgRaw.nexusDesktopProtocol)
    && corePkgRaw.nexusDesktopProtocol >= 0 ? corePkgRaw.nexusDesktopProtocol : null;
  const envProtocol = parseInt(process.env.NEXUS_CORE_PROTOCOL ?? '', 10);
  const coreProtocol = declaredProtocol
    ?? (Number.isInteger(envProtocol) ? envProtocol : readDesktopProtocol());

  if (!fs.existsSync(srcDist)) {
    skip(`source dist missing: ${srcDist}; no core artifact published.`);
    return;
  }

  const outFileName = `core-${version}.tar.gz`;
  const outPath = path.join(outDir, outFileName);
  const manifestPath = path.join(outDir, 'latest-core.yml');
  fs.mkdirSync(outDir, { recursive: true });

  // Staging dir: copy srcDist contents + patched package.json at root.
  const staging = path.join(tmpdir(), `core-publish-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    // Copy all dist contents.
    for (const entry of fs.readdirSync(srcDist, { withFileTypes: true })) {
      const src = path.join(srcDist, entry.name);
      const dst = path.join(staging, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true });
      } else {
        fs.copyFileSync(src, dst);
      }
    }
    // Write patched package.json at staging root.
    const rawPkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    rawPkg.version = version;
    rawPkg.nexusDesktopProtocol = coreProtocol;
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(rawPkg, null, 2));

    // Pack tar.gz.
    const tmpTar = path.join(tmpdir(), `core-${Date.now()}.tar`);
    try {
      execSync(`tar cf "${tmpTar}" -C "${staging}" .`, { stdio: 'pipe' });
      const gzOut = fs.createWriteStream(outPath);
      const rs = createReadStream(tmpTar);
      const gs = createGzip({ level: 9 });
      await pipeline(rs, gs, gzOut);
      const sz = fs.statSync(outPath).size;

      // SHA-512 of the final gzipped artifact.
      const hash = createHash('sha512');
      const gzRs = createReadStream(outPath);
      await new Promise((resolve, reject) => {
        gzRs.on('data', (d) => hash.update(d));
        gzRs.on('end', resolve);
        gzRs.on('error', reject);
      });
      const sha512 = hash.digest('hex');

      const isoNow = new Date().toISOString();
      // The artifact is uploaded as an asset of THIS release, whose tag is the
      // DESKTOP version (e.g. v0.2.21) -- not the core version. The manifest URL
      // must resolve, so build it from the release tag.
      const desktopVersion = readDesktopPackage().version;
      const envTag = explicitReleaseTag || process.env.GITHUB_REF_NAME || process.env.NEXUS_RELEASE_TAG || '';
      const releaseTag = envTag || (desktopVersion ? `v${desktopVersion}` : `v${version}`);
      if (envTag && !/^v/.test(envTag)) {
        console.warn(`[publish-core] release tag "${envTag}" does not look like a version tag; manifest URL may 404.`);
      }
      const yamlLines = [
        `version: ${version}`,
        `sha512: ${sha512}`,
        `size: ${sz}`,
        `url: https://github.com/jsws9517/nexus-desktop/releases/download/${releaseTag}/${outFileName}`,
        `timestamp: ${isoNow}`,
        `protocol: ${coreProtocol}`,
        '',
      ];

      // Determine if we'll be signing BEFORE writing the manifest, so the
      // `signed: true` marker can be included in the signed bytes themselves.
      const privKeyFile = path.join(keysDir, 'core-signing-private.pem');
      const sigPath = `${manifestPath}.sig`;
      let privKey = null;
      if (fs.existsSync(privKeyFile)) {
        privKey = fs.readFileSync(privKeyFile);
      } else if (process.env.CORE_SIGNING_KEY) {
        privKey = Buffer.from(process.env.CORE_SIGNING_KEY);
      }
      const willSign = !!privKey;
      if (willSign) yamlLines.push('signed: true');

      fs.writeFileSync(manifestPath, yamlLines.join('\n'));

      // Sign the manifest with ed25519. The signature must cover the exact
      // bytes that get uploaded, including the `signed: true` line.
      if (willSign) {
        const manifestData = fs.readFileSync(manifestPath);
        const sig = cryptoSign(null, manifestData, privKey);
        fs.writeFileSync(sigPath, sig.toString('hex'));
        console.log(`[publish-core] signed ${manifestPath} -> ${sigPath}`);
      } else if (process.env.GITHUB_ACTIONS === 'true') {
        console.error('[publish-core] CORE_SIGNING_KEY secret is required to sign in CI.');
        process.exitCode = 1;
      } else {
        console.warn(`[publish-core] no signing key (${privKeyFile} or CORE_SIGNING_KEY); skipping signature.`);
      }

      console.log(
        `[publish-core] core v${version} => ${outFileName} (${(sz / 1048576).toFixed(1)} MiB)` +
        `  sha512=${sha512.slice(0, 16)}…  manifest=${manifestPath}`,
      );
    } finally {
      try { fs.unlinkSync(tmpTar); } catch {}
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch((e) => {
  console.error(`[publish-core] failed: ${e.message}`);
  process.exitCode = 1;
});
