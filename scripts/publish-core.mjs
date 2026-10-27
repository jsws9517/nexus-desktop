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
function readDesktopProtocol() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return Number.isInteger(pkg.nexusDesktopProtocol) && pkg.nexusDesktopProtocol >= 0
      ? pkg.nexusDesktopProtocol
      : 1;
  } catch {
    return 1;
  }
}

async function main() {
  const pkgFile = path.join(repoRoot, 'node_modules', 'nexus-coder', 'package.json');
  if (!fs.existsSync(pkgFile)) {
    console.error('[publish-core] nexus-coder/package.json not found; skipping.');
    return;
  }
  const { version } = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (!version) {
    console.error('[publish-core] no version field in nexus-coder/package.json');
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
    console.error(`[publish-core] source dist missing: ${srcDist}`);
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
      const yamlLines = [
        `version: ${version}`,
        `sha512: ${sha512}`,
        `size: ${sz}`,
        `url: https://github.com/jsws9517/nexus-desktop/releases/download/v${version}/${outFileName}`,
        `timestamp: ${isoNow}`,
        `protocol: ${coreProtocol}`,
        '',
      ];
      fs.writeFileSync(manifestPath, yamlLines.join('\n'));

      // Sign the manifest with ed25519 (one-shot API: sign(null, data, key)).
      const privKeyFile = path.join(keysDir, 'core-signing-private.pem');
      const sigPath = `${manifestPath}.sig`;
      if (fs.existsSync(privKeyFile)) {
        const privKey = fs.readFileSync(privKeyFile);
        const manifestData = fs.readFileSync(manifestPath);
        const sig = cryptoSign(null, manifestData, privKey);
        fs.writeFileSync(sigPath, sig.toString('hex'));
        console.log(`[publish-core] signed ${manifestPath} -> ${sigPath}`);
      } else {
        console.warn(`[publish-core] private key not found at ${privKeyFile}; skipping signature.`);
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
