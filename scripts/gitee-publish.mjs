import { readFile, stat } from 'node:fs/promises';

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

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gitee API ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const body = await readFile(BODY_FILE, 'utf8');

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
  const candidates = ['latest.yml', `nexus-Setup-${version}.exe`, `nexus-Setup-${version}.exe.blockmap`];

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
    const buffer = await readFile(file);
    const form = new FormData();
    form.append('file', new Blob([buffer]), name);
    const res = await fetch(`${API}/releases/${releaseId}/attach_files?access_token=${TOKEN}`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      console.error(`attach ${name} failed: ${res.status} ${await res.text()}`);
    } else {
      console.log(`attached ${name} (${(info.size / 1048576).toFixed(1)} MiB)`);
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
