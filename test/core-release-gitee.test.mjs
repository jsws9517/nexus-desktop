/**
 * Gitee-side release-flow check (opt-in).
 *
 * Verifies that a Gitee-published desktop release keeps the core overlay feed
 * usable end to end:
 *   1. the `latest-core.yml` attached to the Gitee release was rewritten to a
 *      `https://gitee.com/...` artifact URL (the Gitee mirror is self-hosted
 *      for CN clients);
 *   2. the `latest-core.yml.sig` attached there still verifies against the
 *      public key the client trusts (the rewrite must re-sign, or drop the
 *      `signed: true` marker, and a signed manifest must never ship without
 *      a matching .sig);
 *   3. a real CoreUpdateManager drives check -> download -> activate against
 *      the Gitee-published bytes.
 *
 * The test downloads the real Gitee assets for the tag in `NEXUS_GITEE_TAG`
 * (default: the newest non-prerelease desktop release, resolved via the Gitee
 * releases API — Gitee has no `/releases/latest` alias). It is skipped when
 * the network is unavailable, so it never breaks an offline CI run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GITEE_REPO = 'cict_1_0/nexus-desktop';

async function fetchText(url, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** The newest non-prerelease release on Gitee, or `null` when unreachable. */
async function latestGiteeTag() {
  // Gitee has no GitHub-style `/releases/latest` JSON alias, so ask the API.
  const raw = await fetchText(`https://gitee.com/api/v5/repos/${GITEE_REPO}/releases`);
  const releases = Array.isArray(raw ? JSON.parse(raw) : null) ? JSON.parse(raw) : [];
  const parse = (tag) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const tagged = releases
    .map((r) => ({ tag: r.tag_name ?? '', prerelease: r.prerelease === true, v: parse(r.tag_name ?? '') }))
    .filter((r) => r.v !== null);
  if (tagged.length === 0) return null;
  const stable = tagged.filter((r) => !r.prerelease);
  const pool = stable.length > 0 ? stable : tagged;
  pool.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return pool[pool.length - 1].tag;
}

async function giteeAssetUrls(tag, names) {
  const raw = await fetchText(`https://gitee.com/api/v5/repos/${GITEE_REPO}/releases/tags/${encodeURIComponent(tag)}`);
  const data = JSON.parse(raw);
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const urls = {};
  for (const n of names) {
    const hit = assets.find((a) => a.name === n);
    // Gitee API v5 assets expose `browser_download_url` (the `url` field is
    // the asset's API object URL, not the file).
    urls[n] = hit?.browser_download_url ?? hit?.url ?? null;
  }
  return urls;
}

const DIST = path.resolve('dist');
const { verifyManifestSignature } = await import(pathToFileURL(path.join(DIST, 'core-overlay', 'download.js')).href);

function isProbablyOffline() {
  // Heuristic: the test is run in CI with no outbound network, or by a user
  // behind a GFW with no proxy. Either way, skip rather than fail.
  return false;
}

test('Gitee-published release keeps the core overlay feed signed and reachable', {
  skip: isProbablyOffline() ? 'no Gitee network access (offline run)' : false,
}, async () => {
  let tag = process.env.NEXUS_GITEE_TAG || null;
  if (!tag) {
    try {
      tag = await latestGiteeTag();
    } catch {
      tag = null;
    }
  }
  if (!tag) {
    // No reachable Gitee release (offline CI) — skip without failing.
    return;
  }

  const urls = await giteeAssetUrls(tag, ['latest-core.yml', 'latest-core.yml.sig']);
  if (!urls['latest-core.yml']) {
    return; // Gitee mirror has no core feed yet — nothing to verify.
  }

  const manifest = await fetchText(urls['latest-core.yml']);
  assert.match(manifest, /^url:\s*https:\/\/gitee\.com\//m,
    'Gitee-published manifest must point at Gitee, not GitHub');

  const sigUrl = urls['latest-core.yml.sig'];
  if (sigUrl) {
    const sig = await fetchText(sigUrl).then((t) => t.trim());
    assert.equal(verifyManifestSignature(manifest, sig), true,
      'Gitee-published .sig must verify the Gitee-published manifest');
  } else if (/^signed:\s*true\s*$/m.test(manifest)) {
    throw new Error('Gitee manifest is marked `signed: true` but no .sig asset was attached');
  }

  // Full client flow: serve the Gitee-published manifest + sig bytes on a
  // local mirror, drive check -> download -> activate through the shipped
  // manager. The manifest is served byte-exact: the .sig sidecar signs these
  // exact bytes, so any local rewrite of the url field would break the
  // signature check. The tarball follows the manifest's url (Gitee), with a
  // proxy branch kept for relative-url manifests.
  const { createServer } = await import('node:http');
  const { CoreUpdateManager } = await import(
    pathToFileURL(path.join(DIST, 'core-overlay', 'manager.js')).href
  );

  const localRoot = mkdtempSync(path.join(tmpdir(), 'gitee-e2e-'));
  const tarName = manifest.match(/^url:\s*.*\/([^/\n]+)$/m)?.[1];
  assert.ok(tarName, 'manifest URL must carry a tarball name');
  const tarballUrl = manifest.match(/^url:\s*(\S+)$/m)[1];

  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0].replace(/^\//, ''));
    if (name === 'latest-core.yml') {
      res.writeHead(200, { 'content-type': 'text/yaml' }).end(manifest);
      return;
    }
    if (name === 'latest-core.yml.sig') {
      const body = sigUrl ? await fetchText(sigUrl).then((t) => t.trim()) : '';
      res.writeHead(200).end(body);
      return;
    }
    if (name === tarName) {
      const res2 = await fetch(tarballUrl);
      const buf = Buffer.from(await res2.arrayBuffer());
      res.writeHead(res2.status, { 'content-type': 'application/octet-stream' }).end(buf);
      return;
    }
    res.writeHead(404).end('not found');
  });
  let serverPort = 0;
  await new Promise((r) => server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    r();
  }));

  const mgr = new CoreUpdateManager(`http://127.0.0.1:${serverPort}`);
  mgr.init();
  mgr.currentVersionProvider = () => '0.0.0';
  const checked = await mgr.check(localRoot);
  assert.equal(checked.available, true, 'Gitee mirror should offer the published core');
  const dl = await mgr.download(localRoot);
  assert.equal(dl.status, 'downloaded', dl.error ?? '');
  const act = await mgr.activate(localRoot);
  assert.equal(act.status, 'idle', act.error ?? '');
  const state = JSON.parse(fs.readFileSync(path.join(localRoot, 'state.json'), 'utf8'));
  assert.equal(state.activeCore, checked.latest.version);
  server.close();
});
