import { readFile, stat } from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';

const REPO = process.env.GITEE_REPO || 'cict_1_0/nexus-desktop';
const TOKEN = process.env.GITEE_TOKEN;
const TAG = process.env.GITEE_TAG;
const NAME = process.env.GITEE_NAME || TAG;
const BODY_FILE = process.env.GITEE_BODY_FILE || '.release_body.md';
const RELEASE_DIR = process.env.GITEE_RELEASE_DIR || 'release';
const MAX_ATTACH_BYTES = 100 * 1024 * 1024;

if (!TOKEN || !TAG) {
  console.error('usage: GITEE_TOKEN=... GITEE_TAG=vX.Y.Z node scripts/gitee-publish.mjs');
  process.exit(1);
}

const API = `https://gitee.com/api/v5/repos/${REPO}`;
const MAX_RETRIES = 3;

// A 98 MiB installer pushed over the US→Gitee intercontinental link used by
// GitHub runners can exceed 180s per attempt even on a healthy pipe (the
// v0.3.1 run aborted three times and left a dead Gitee feed whose latest.yml
// pointed at a missing installer), so the per-attempt timeout scales with
// file size; small manifests keep the short bound.
function uploadTimeoutFor(bytes) {
  return bytes > 50 * 1048576 ? 600_000 : 180_000;
}

// GITEE_PRESERVE_ASSETS=1 → supplemental publish (e.g. core-only re-publish
// onto an existing desktop release): keep the existing release and its
// assets, only attach files that are missing. Default (unset) keeps the
// historical delete + recreate semantics for full desktop re-publishes.
const PRESERVE = process.env.GITEE_PRESERVE_ASSETS === '1';

// The installer (~98 MiB) is deliberately NOT mirrored to Gitee: the
// attach_files API stalls on it (uploads complete but responses/processing
// can exceed any sane timeout, leaving a broken feed half-built), and it
// buys little — CN clients get the small manifests (fast, self-contained
// core channel) from Gitee and download the installer from GitHub. Set
// GITEE_UPLOAD_INSTALLER=1 to mirror the installer anyway (legacy behavior,
// keep the relative latest.yml url; if the upload fails the feed degrades
// to a GitHub-pinned url instead of aborting the run).
const UPLOAD_INSTALLER = process.env.GITEE_UPLOAD_INSTALLER === '1';

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gitee API ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function uploadWithRetry(url, form, size, retries = MAX_RETRIES) {
  const name = form.get('file')?.name || 'unknown';
  const timeout = uploadTimeoutFor(size);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      console.log(`attached ${name} (${(size / 1048576).toFixed(1)} MiB)`);
      return;
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.min(2 ** attempt * 5, 30);
        console.log(`upload ${name} attempt ${attempt} failed (${err.message}), retrying in ${delay}s...`);
        await new Promise((r) => setTimeout(r, delay * 1000));
      } else {
        throw new Error(`upload ${name} failed after ${retries} attempts: ${err.message}`);
      }
    }
  }
}

async function findReleaseByTag() {
  try {
    return await request(`${API}/releases/tags/${encodeURIComponent(TAG)}?access_token=${TOKEN}`);
  } catch {
    return null;
  }
}

async function main() {
  // The release body only matters when creating a fresh release; a missing
  // body file must not abort a supplemental (preserve) publish.
  let body = '';
  try {
    body = await readFile(BODY_FILE, 'utf8');
  } catch {
    body = '';
  }

  const existing = await findReleaseByTag();
  let releaseId;
  const existingAssets = new Set((existing?.assets ?? []).map((a) => a.name));

  if (existing?.id && PRESERVE) {
    // Supplemental publish: never delete the release, keep its body and all
    // existing assets; below we only attach files that are still missing.
    releaseId = existing.id;
    console.log(
      `gitee release for ${TAG} exists (id=${releaseId}); preserving its ${existingAssets.size} existing asset(s)`,
    );
  } else if (existing?.id) {
    console.log(`gitee release for ${TAG} already exists (id=${existing.id}), replacing it`);
    await request(`${API}/releases/${existing.id}?access_token=${TOKEN}`, { method: 'DELETE' });
  }

  if (!releaseId) {
    if (PRESERVE) {
      console.error(
        `gitee-publish: GITEE_PRESERVE_ASSETS=1 but no existing gitee release for ${TAG}. ` +
        'A supplemental publish has nothing to supplement; refusing to create a bare release. ' +
        'Publish the desktop tag first, or run without the preserve flag.',
      );
      process.exit(1);
    }
    const release = await request(`${API}/releases?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        tag_name: TAG,
        name: NAME,
        body,
        target_commitish: 'main',
        prerelease: false,
      }),
    });
    releaseId = release.id;
    console.log(`gitee release created: id=${release.id} tag=${TAG} name=${NAME}`);
  }

  const version = TAG.replace(/^v/, '');
  const exeName = `nexus-Setup-${version}.exe`;

  // Only the core tarball referenced by the current manifest belongs on the
  // release: stale core-*.tar.gz files left behind in a local release dir
  // must not leak onto Gitee.
  let manifestVersion = '';
  try {
    manifestVersion =
      (await readFile(`${RELEASE_DIR}/latest-core.yml`, 'utf8')).match(/^version:\s*(.+)$/m)?.[1]?.trim() || '';
  } catch { /* no manifest yet */ }
  const coreTarball = manifestVersion ? `core-${manifestVersion}.tar.gz` : null;

  // Order matters: the installer (when opted in via GITEE_UPLOAD_INSTALLER)
  // is by far the largest asset and the one most likely to fail on the
  // US→CN link, so it goes FIRST and its outcome decides how latest.yml is
  // written. latest.yml therefore goes LAST; the core channel ships
  // regardless. The .blockmap always mirrors: electron-updater resolves
  // it against the feed that served latest.yml (Gitee), while the exe
  // itself may be pinned at GitHub.
  const candidates = [
    ...(UPLOAD_INSTALLER ? [exeName] : []),
    `${exeName}.blockmap`,
    ...(coreTarball ? [coreTarball] : []),
    'latest-core.yml',
    ...readdirSync(RELEASE_DIR).filter((f) => f.endsWith('.sig')),
    'latest.yml',
  ];

  // Will the installer be downloadable from Gitee after this run? Starts
  // true only when opted in AND already attached (preserve mode); the
  // upload loop below confirms it after a successful upload, and keeps it
  // false when the upload fails, the file is too big to attach, or the
  // installer is not mirrored at all (the default).
  let exeOnGiteeAfterRun = UPLOAD_INSTALLER && PRESERVE && existingAssets.has(exeName);
  if (!UPLOAD_INSTALLER) {
    console.log(`installer not mirrored to Gitee (default; latest.yml will pin GitHub); opt in with GITEE_UPLOAD_INSTALLER=1`);
  }

  for (const name of candidates) {
    const file = `${RELEASE_DIR}/${name}`;
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (PRESERVE && existingAssets.has(name)) {
      console.log(`skip ${name}: already attached to the gitee release (preserved)`);
      continue;
    }
    if (info.size > MAX_ATTACH_BYTES) {
      console.log(`skip ${file}: ${(info.size / 1048576).toFixed(1)} MiB > 100 MiB Gitee limit`);
      continue;
    }
    let buffer = await readFile(file);
    // For latest-core.yml: point the artifact url at Gitee so the mirror is
    // self-contained for CN clients (the core tarball is ~1.4 MiB, far below
    // Gitee's 100 MiB attachment cap) and re-sign, because the signature
    // covers the manifest bytes. latest.yml is handled in its own branch
    // below (relative url vs. GitHub-pinned, depending on the installer).
    if (name === 'latest.yml') {
      // electron-builder emits a *relative* exe url (nexus-Setup-X.exe),
      // which electron-updater resolves against the feed that served the
      // manifest — the same file is therefore valid on both GitHub and
      // Gitee. Only when the installer will NOT be downloadable from Gitee
      // (Gitee attachment limit) do we pin the url to GitHub explicitly;
      // otherwise we keep the relative url untouched.
      if (!exeOnGiteeAfterRun) {
        // electron-builder puts the exe url inside the `files:` entry as
        // `  - url: ...` (no top-level url line), so the anchor must allow
        // the list-dash indentation; pin only that line to GitHub.
        const text = buffer.toString('utf8').replace(
          /^(\s*-?\s*)url: .*$/gm,
          `$1url: https://github.com/jsws9517/nexus-desktop/releases/download/${TAG}/${exeName}`,
        );
        buffer = Buffer.from(text);
        console.log(`rewrote ${name} url -> GitHub download (installer not on Gitee)`);
      } else {
        console.log(`kept ${name} url relative (resolves on the serving host; installer on Gitee)`);
      }
    } else if (name === 'latest-core.yml') {
      // Rewriting the artifact URL invalidates the signature (it covers the
      // manifest bytes), so re-sign on the rewritten text. The `signed: true`
      // marker is kept: clients hard-refuse a signed manifest without its
      // .sig sidecar.
      const raw = buffer.toString('utf8');
      const m = raw.match(/^url: .*\/([^\n]+)$/m);
      const fileName = m?.[1] || '';
      const text = raw.replace(/^url: .*$/m, `url: https://gitee.com/${REPO}/releases/download/${TAG}/${fileName}`);
      buffer = Buffer.from(text, 'utf8');
      if (process.env.CORE_SIGNING_KEY) {
        const { sign: cryptoSign } = await import('node:crypto');
        const sig = cryptoSign(null, buffer, Buffer.from(process.env.CORE_SIGNING_KEY)).toString('hex');
        writeFileSync(`${RELEASE_DIR}/${name}.sig`, sig);
        console.log(`re-signed ${name} for the Gitee URL`);
      } else {
        console.log(`re-pointed ${name} at Gitee; manifest is now unsigned`);
      }
    }
    const form = new FormData();
    form.append('file', new Blob([buffer]), name);
    try {
      await uploadWithRetry(`${API}/releases/${releaseId}/attach_files?access_token=${TOKEN}`, form, buffer.length);
      if (name === exeName) exeOnGiteeAfterRun = true;
    } catch (err) {
      if (name !== exeName) throw err;
      // The installer is the only asset that may fail without aborting the
      // whole publish: latest.yml is uploaded LAST and will pin its url at
      // the GitHub download, and the core channel still ships complete.
      // (A broken Gitee app feed that aborts the run is the v0.3.1 bug.)
      console.error(
        `upload ${exeName} failed (${err.message}); degrading: latest.yml will pin GitHub, core assets still attached`,
      );
      continue;
    }
    // The latest-core.yml branch above re-signs in place, which can create
    // a .sig sidecar that the initial readdir did not see; pick it up.
    if (name === 'latest-core.yml' && process.env.CORE_SIGNING_KEY) {
      const sigName = `${name}.sig`;
      if (!candidates.includes(sigName)) candidates.push(sigName);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
