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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { execSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(root, '..');

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const NPM_REGISTRY = 'https://registry.npmjs.org/';
// How long to keep waiting for a just-published nexus-coder version to become
// visible on the registry. The auto repository_dispatch that triggers this
// path fires seconds after `npm publish` in the core repo, while the new
// version's metadata can still be propagating across npm's CDN — in that
// window both `npm view` and `npm pack` fail with ETARGET.
const NPM_WAIT_DEADLINE_MS = 9 * 60_000;
const NPM_VIEW_POLL_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the registry until nexus-coder@<version> is visible.
 *
 * A version that is not (yet) in the metadata fails with ETARGET /
 * "No matching version found" (npm pack) or E404 / "No match found for
 * version" (npm view on a not-yet-visible prerelease) — so waiting on
 * `npm view` with both treated as transient means `npm pack` after this
 * point succeeds. Anything else (auth, network, ...) fails fast instead
 * of polling for the whole window.
 */
async function waitForNpmVersion(version) {
  const deadline = Date.now() + NPM_WAIT_DEADLINE_MS;
  for (;;) {
    try {
      execSync(
        `npm view nexus-coder@${version} version --registry ${NPM_REGISTRY}`,
        { stdio: 'pipe' },
      );
      return;
    } catch (e) {
      const detail = String(e.message ?? '').slice(0, 300);
      // "version not visible on the registry yet" — `npm view` reports a
      // missing version as E404, `npm pack` as ETARGET.
      const transient = /ETARGET|No matching version|No match found for version|E404/i.test(detail);
      if (!transient) {
        throw new Error(
          `nexus-coder@${version} unavailable on npm (not a registry lag): ${detail}`,
        );
      }
      if (Date.now() + NPM_VIEW_POLL_MS > deadline) {
        throw new Error(
          `nexus-coder@${version} still not visible on npm after ${NPM_WAIT_DEADLINE_MS / 60000} min`,
        );
      }
      console.log(
        `[publish-core] nexus-coder@${version} not on registry yet; retrying in ${NPM_VIEW_POLL_MS / 1000}s...`,
      );
      await sleep(NPM_VIEW_POLL_MS);
    }
  }
}

/** `npm pack nexus-coder@<version>` into cwd, with a few retries. */
async function packFromNpm(version, cwd) {
  for (let attempt = 1; ; attempt++) {
    try {
      // npm pack writes `<name>-<version>.tgz` into cwd — capture the exact
      // filename from stdout rather than hardcoding it.
      const out = execSync(
        `npm pack nexus-coder@${version} --registry ${NPM_REGISTRY}`,
        { cwd, stdio: 'pipe' },
      ).toString();
      return out.trim().split('\n').filter((l) => l.endsWith('.tgz')).pop();
    } catch (e) {
      if (attempt >= 3) {
        throw new Error(`npm pack nexus-coder@${version} failed: ${String(e.message ?? '').slice(0, 300)}`);
      }
      console.log(`[publish-core] npm pack attempt ${attempt} failed; retrying in 15s...`);
      await sleep(15_000);
    }
  }
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

/**
 * Normalize a core `nexusDesktopProtocol` declaration into a range:
 *   - integer N           -> { min: N, max: N } (legacy exact-match shape)
 *   - { min, max } object -> the range
 *   - anything else       -> null (undeclared / malformed)
 */
function parseProtocolRange(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { min: raw, max: raw };
  }
  if (
    raw && typeof raw === 'object'
    && Number.isInteger(raw.min) && Number.isInteger(raw.max)
    && raw.min >= 0 && raw.max >= raw.min
  ) {
    return { min: raw.min, max: raw.max };
  }
  return null;
}

// ── §2.5 dependency-neutrality check ────────────────────────────────────────
//
// The overlay ships ONLY the core's dist. Bare specifiers in those files
// resolve from the BASE app's node_modules (bootstrap/resolve-hook.ts), so a
// core patch that starts importing an npm package the desktop does not
// install blows up at runtime with ERR_MODULE_NOT_FOUND — after the user
// updated. This static gate refuses to publish such a core.
//
// Baseline = the desktop's own package.json dependency keys (the stable
// contract) + CORE_BUNDLE_ALLOWLIST below (packages the core manages itself:
// transitive installs under the desktop's node_modules, or dependencies
// bundled by the office-native skill package, which carries its own
// node_modules when it ships).
const CORE_BUNDLE_ALLOWLIST = [
  // Installed transitively under the desktop's node_modules via the
  // nexus-coder dependency (npm hoists them next to the desktop's own deps):
  '@anthropic-ai/sdk',
  '@huggingface/transformers',
  '@larksuiteoapi/node-sdk',
  '@modelcontextprotocol/sdk',
  // SMTP transport introduced by the nodemailer mail backend (nexus-coder
  // 1.2.9-x): a direct core dependency, hoisted into the desktop baseline by
  // npm ci after set-core-version pins the newest core. The overlay imports
  // it from src/desktop/smtp-send.js only.
  'nodemailer',
  'openai',
  'tiktoken',
  // Core-owned / CLI-side packages that appear in dist but never on the
  // desktop's runtime path (statically present, not import-reachable from
  // the desktop entry points):
  'chalk',
  'commander',
  'https-proxy-agent',
  'qrcode',
  'zod',
  // Bundled by the office-native skill package (its own node_modules):
  'docx',
  'pdf-parse',
  'pdfkit',
  'pptxgenjs',
];

/** Top-level package name of a bare specifier (`@scope/pkg/x` -> `@scope/pkg`). */
function topOf(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
}

/**
 * Collect the bare import specifiers a set of dist files reference.
 *
 * A small state machine instead of a regex: a bare `require('pdf-parse')`
 * inside a STRING LITERAL (the office-write skill scripts are shipped as
 * template strings in dist/src/config/native.js) must not count, while a
 * real import statement must. The machine tracks string/template/comment
 * state and captures a literal only when the code just before it ends in
 * `from`, `import(` or `require(`.
 */
export function collectBareSpecifiers(files) {
  const found = new Map(); // top-level package -> first file that imports it
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let state = 'code'; // code | sq | dq | tpl | lc | bc
    let tplDepth = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      const n = src[i + 1];
      if (state === 'code') {
        if (c === '/' && n === '/') { state = 'lc'; i++; continue; }
        if (c === '/' && n === '*') { state = 'bc'; i++; continue; }
        if (c === "'") {
          if (/[^A-Za-z0-9_$](from|import\s*\(|require\s*\()\s*$/.test(src.slice(Math.max(0, i - 24), i))) {
            const strEnd = src.indexOf("'", i + 1);
            if (strEnd !== -1) {
              const spec = src.slice(i + 1, strEnd);
              if (spec && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) {
                const top = topOf(spec);
                if (/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z][a-z0-9._-]*)$/.test(top)) {
                  if (!found.has(top)) found.set(top, file);
                }
              }
              i = strEnd;
              continue;
            }
          }
          state = 'sq'; continue;
        }
        if (c === '"') {
          if (/[^A-Za-z0-9_$](from|import\s*\(|require\s*\()\s*$/.test(src.slice(Math.max(0, i - 24), i))) {
            const strEnd = src.indexOf('"', i + 1);
            if (strEnd !== -1) {
              const spec = src.slice(i + 1, strEnd);
              if (spec && !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:')) {
                const top = topOf(spec);
                if (/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z][a-z0-9._-]*)$/.test(top)) {
                  if (!found.has(top)) found.set(top, file);
                }
              }
              i = strEnd;
              continue;
            }
          }
          state = 'dq'; continue;
        }
        if (c === '`') { state = 'tpl'; tplDepth = 0; continue; }
      } else if (state === 'sq') {
        if (c === '\\') i++;
        else if (c === "'") state = 'code';
      } else if (state === 'dq') {
        if (c === '\\') i++;
        else if (c === '"') state = 'code';
      } else if (state === 'tpl') {
        if (c === '\\') i++;
        else if (c === '$' && n === '{') { tplDepth++; i++; state = 'code'; }
        else if (c === '}' && tplDepth > 0) { tplDepth--; state = tplDepth > 0 ? 'code' : 'tpl'; }
        else if (c === '`') state = 'code';
      } else if (state === 'lc') {
        if (c === '\n') state = 'code';
      } else if (state === 'bc') {
        if (c === '*' && n === '/') { state = 'code'; i++; }
      }
    }
  }
  return found;
}

/** Recursively list the .js/.mjs/.cjs files under dir. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * §2.5 gate: every bare import in the overlay's dist must be resolvable from
 * the base app. Returns a list of offending `pkg (first file)` strings;
 * an empty list means the core is dependency-neutral.
 */
export function dependencyNeutralityOffenders(distDir) {
  const desktopPkg = readDesktopPackage();
  const baseline = new Set([
    ...Object.keys(desktopPkg.dependencies ?? {}),
    ...Object.keys(desktopPkg.devDependencies ?? {}),
    ...CORE_BUNDLE_ALLOWLIST,
    // node: builtins also appear in dist without the prefix (older ESM).
    ...builtinModules,
  ]);
  const found = collectBareSpecifiers(listJsFiles(distDir));
  return [...found.entries()]
    .filter(([top]) => !baseline.has(top))
    .map(([top, file]) => `${top} (first seen in ${path.relative(distDir, file)})`);
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
  let pkgDir = null;
  let tempDir = null;

  if (explicitVersion) {
    // Independent-publish mode: fetch nexus-coder@<version> from npm into a
    // transient directory. The desktop's node_modules and lockfile are
    // deliberately untouched so this can run on a CI runner that does not
    // carry the matching package-lock.json.
    //
    // When the auto dispatch fires seconds after the core publish, the
    // version may not be visible on the registry yet; waitForNpmVersion
    // polls it into existence so the chain self-heals (no manual
    // escape-hatch re-trigger needed for the propagation lag).
    console.log(`[publish-core] fetching nexus-coder@${explicitVersion} from npm...`);
    await waitForNpmVersion(explicitVersion);
    tempDir = fs.mkdtempSync(path.join(tmpdir(), 'nexus-coder-pkg-'));
    const packedName = await packFromNpm(explicitVersion, tempDir);
    if (!packedName || !fs.existsSync(path.join(tempDir, packedName))) {
      skip(`npm pack failed for nexus-coder@${explicitVersion}; output: ${packedName ?? 'empty'}`);
      return;
    }
    const tgz = path.join(tempDir, packedName);
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    execSync(`tar xzf "${tgz}" -C "${extractDir}"`, { stdio: 'pipe' });
    pkgDir = fs.existsSync(path.join(extractDir, 'package')) ? path.join(extractDir, 'package') : extractDir;
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

  // Resolve the protocol range this core serves. The core's own declaration
  // is the single source of truth — there is deliberately no fallback to the
  // desktop's protocol: an unstamped artifact would parse as "legacy /
  // allowed" on the client and mask a real contract mismatch, so a core that
  // does not declare the range fails the publish instead of shipping blind.
  // The range is written both into the artifact's package.json (so the
  // client's activation and boot gates can read it) and into the manifest.
  const corePkgRaw = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const declaredRange = parseProtocolRange(corePkgRaw.nexusDesktopProtocol);
  if (!declaredRange) {
    console.error(
      `[publish-core] nexus-coder@${version} does not declare nexusDesktopProtocol ` +
        `(integer or {min,max}); refusing to publish an unstamped core artifact. ` +
        'Declare the range in the core repo first.',
    );
    process.exit(1);
  }

  if (!fs.existsSync(srcDist)) {
    skip(`source dist missing: ${srcDist}; no core artifact published.`);
    return;
  }

  // §2.5 dependency neutrality: the overlay ships ONLY the core's dist and the
  // resolve hook resolves its bare imports from the base app's node_modules.
  // A package the baseline does not cover is a runtime ERR_MODULE_NOT_FOUND
  // for every user who updates — refuse the publish instead of shipping it.
  const offenders = dependencyNeutralityOffenders(srcDist);
  if (offenders.length > 0) {
    console.error(
      `[publish-core] dependency-neutrality violation: ${path.basename(srcDist)} imports ` +
        `bare packages the desktop baseline does not cover:\n  ` +
        offenders.join('\n  ') +
        '\nEither add the package to the desktop package.json dependencies, or to ' +
        `CORE_BUNDLE_ALLOWLIST in this script with a justification — then re-run.`,
    );
    process.exit(1);
  }
  console.log(
    `[publish-core] dependency check: all bare imports in ${path.basename(srcDist)} ` +
      `covered by the desktop baseline.`,
  );

  const outFileName = `core-${version}.tar.gz`;
  const outPath = path.join(outDir, outFileName);
  const manifestPath = path.join(outDir, 'latest-core.yml');
  fs.mkdirSync(outDir, { recursive: true });

  // Staging dir: mirror the full npm package layout (package.json at root,
  // dist/ + scripts/ alongside) so the resolve hook's `nexus-coder/<rel>` →
  // `<overlayDir>/<rel>` mapping matches package.json "main" exactly.
  //
  // In --version mode pkgDir is the extracted package root (has package.json +
  // dist/). In desktop-release mode the equivalent is node_modules/nexus-coder/.
  const srcRoot = explicitVersion ? pkgDir : path.dirname(pkgFile);
  const staging = path.join(tmpdir(), `core-publish-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      // No nested node_modules in the overlay: bare specifiers resolve from the
      // base app by design (resolve-hook), and the npm-pack artifact used in
      // --version mode never carries them either.
      if (entry.name === 'node_modules') continue;
      const src = path.join(srcRoot, entry.name);
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
    rawPkg.nexusDesktopProtocol = declaredRange; // range object: the canonical shape
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
        `protocolMin: ${declaredRange.min}`,
        `protocolMax: ${declaredRange.max}`,
      ];
      // Legacy exact-match line for pre-range clients: they only read
      // `protocol:` and treat an absent/malformed field as legacy-allowed, so
      // only emit it when the range collapses to a single version.
      if (declaredRange.min === declaredRange.max) {
        yamlLines.push(`protocol: ${declaredRange.min}`);
      }
      // NOTE: no blank lines in the manifest. The client parser treats a blank
      // line as the end of the entry block, so `signed: true` after a blank
      // line would land in an unparsed orphan block and silently disable the
      // signature enforcement on the client.

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

      fs.writeFileSync(manifestPath, `${yamlLines.join('\n')}\n`);

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

// Run as a script (node scripts/publish-core.mjs) but NOT when imported for
// unit tests, which import the exported helpers above.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error(`[publish-core] failed: ${e.message}`);
    process.exitCode = 1;
  });
}
