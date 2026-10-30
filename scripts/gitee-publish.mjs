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
const UPLOAD_TIMEOUT = 180_000;
const MAX_RETRIES = 3;

// GITEE_PRESERVE_ASSETS=1 → supplemental publish (e.g. core-only re-publish
// onto an existing desktop release): keep the existing release and its
// assets, only attach files that are missing. Default (unset) keeps the
// historical delete + recreate semantics for full desktop re-publishes.
const PRESERVE = process.env.GITEE_PRESERVE_ASSETS === '1';

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
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT);
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

  const candidates = [
    'latest.yml',
    exeName,
    `${exeName}.blockmap`,
    ...(coreTarball ? [coreTarball] : []),
    'latest-core.yml',
    ...readdirSync(RELEASE_DIR).filter((f) => f.endsWith('.sig')),
  ];

  // Will the installer be downloadable from Gitee after this run?
  let exeFitsGitee = false;
  try {
    exeFitsGitee = (await stat(`${RELEASE_DIR}/${exeName}`)).size <= MAX_ATTACH_BYTES;
  } catch { /* no exe in this run */ }
  const exeOnGiteeAfterRun = PRESERVE ? exeFitsGitee || existingAssets.has(exeName) : exeFitsGitee;

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
    // Point the manifests' `url:` fields at Gitee so Gitee-hosted updates stay
    // self-contained; re-sign latest-core.yml because the signature covers the
    // manifest bytes. The core tarball stays on GitHub (Gitee attachment limit
    // is 100 MiB, the NSIS installer is ~110 MiB) — clients reach it via GitHub
    // or gh-proxy mirrors.
    if (name === 'latest.yml') {
      // electron-builder emits a *relative* exe url (nexus-Setup-X.exe),
      // which electron-updater resolves against the feed that served the
      // manifest — the same file is therefore valid on both GitHub and
      // Gitee. Only when the installer will NOT be downloadable from Gitee
      // (Gitee attachment limit) do we pin the url to GitHub explicitly;
      // otherwise we keep the relative url untouched.
      if (!exeOnGiteeAfterRun) {
        const text = buffer.toString('utf8').replace(
          /^url: .*$/gm,
          `url: https://github.com/jsws9517/nexus-desktop/releases/download/${TAG}/${exeName}`,
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
    await uploadWithRetry(`${API}/releases/${releaseId}/attach_files?access_token=${TOKEN}`, form, info.size);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
