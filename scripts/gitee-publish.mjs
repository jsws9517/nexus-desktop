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
  const body = await readFile(BODY_FILE, 'utf8');

  const existing = await findReleaseByTag();
  if (existing?.id) {
    console.log(`gitee release for ${TAG} already exists (id=${existing.id}), replacing it`);
    await request(`${API}/releases/${existing.id}?access_token=${TOKEN}`, { method: 'DELETE' });
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
  console.log(`gitee release created: id=${release.id} tag=${TAG} name=${NAME}`);

  const releaseId = release.id;
  const version = TAG.replace(/^v/, '');
  const candidates = [
    'latest.yml',
    `nexus-Setup-${version}.exe`,
    `nexus-Setup-${version}.exe.blockmap`,
    ...readdirSync(RELEASE_DIR).filter((f) => f.startsWith('core-') && f.endsWith('.tar.gz')),
    'latest-core.yml',
    ...readdirSync(RELEASE_DIR).filter((f) => f.endsWith('.sig')),
  ];

  for (const name of candidates) {
    const file = `${RELEASE_DIR}/${name}`;
    let info;
    try {
      info = await stat(file);
    } catch {
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
      const text = buffer.toString('utf8').replace(
        /^url: .*$/gm,
        `url: https://gitee.com/${REPO}/releases/download/${TAG}/${version}`,
      );
      buffer = Buffer.from(text);
      console.log(`rewrote ${name} url -> Gitee download`);
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
