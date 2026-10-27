/**
 * Publish a core update artifact for GitHub / Gitee releases.
 *
 * Packages `node_modules/nexus-coder/dist` into `core-<version>.tar.gz`,
 * includes the package.json with the release version, computes SHA-512, and
 * writes `latest-core.yml` alongside the release artifacts.
 *
 * Usage:
 *   node scripts/publish-core.mjs [--out <dir>]
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
  const pkgFile = path.join(repoRoot, 'node_modules', 'nexus-coder', 'package.json');
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

  const srcDist = path.join(repoRoot, 'node_modules', 'nexus-coder', 'dist');
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
      const envTag = process.env.GITHUB_REF_NAME || process.env.NEXUS_RELEASE_TAG || '';
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
      fs.writeFileSync(manifestPath, yamlLines.join('\n'));

      // Sign the manifest with ed25519. CI provides the key via the
      // CORE_SIGNING_KEY secret (the file is gitignored and never committed).
      const privKeyFile = path.join(keysDir, 'core-signing-private.pem');
      const sigPath = `${manifestPath}.sig`;
      let privKey = null;
      if (fs.existsSync(privKeyFile)) {
        privKey = fs.readFileSync(privKeyFile);
      } else if (process.env.CORE_SIGNING_KEY) {
        privKey = Buffer.from(process.env.CORE_SIGNING_KEY);
      }
      if (privKey) {
        const manifestData = fs.readFileSync(manifestPath);
        const sig = cryptoSign(null, manifestData, privKey);
        fs.writeFileSync(sigPath, sig.toString('hex'));
        // Mark the manifest signed so clients hard-refuse it if the .sig
        // sidecar is missing (downgrade attack: deleting the signature to
        // bypass verification).
        fs.appendFileSync(manifestPath, 'signed: true\n');
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
  }
}

main().catch((e) => {
  console.error(`[publish-core] failed: ${e.message}`);
  process.exitCode = 1;
});
