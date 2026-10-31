import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUpdateYml,
  compareVersions,
  isNewer,
  assetCandidates,
  appVersionFeeds,
  appManifestFeeds,
  githubReleaseBase,
  giteeReleaseBase,
  formatBytes,
  formatSpeed,
  GITHUB_MIRRORS,
} from '../dist/shared/update-sources.js';

// ── parseUpdateYml ────────────────────────────────────────────────────────────

// Block style (2-space indented items) — the shape Gitee/pinned feeds use.
const YML_BLOCK = `version: 0.3.1
files:
  - url: nexus-Setup-0.3.1.exe
    sha512: lyUXUqwYlJuchQiZ/QI/9biwBYk5FQWjTMXtR6RhJ2ViEtOftTWyuVceSpN8ImLEPmHCVQqTslmGr989kHEOIQ==
    size: 103328462
path: nexus-Setup-0.3.1.exe
sha512: lyUXUqwYlJuchQiZ/QI/9biwBYk5FQWjTMXtR6RhJ2ViEtOftTWyuVceSpN8ImLEPmHCVQqTslmGr989kHEOIQ==
releaseNotes: false
`;

// Compact js-yaml style (`- url:` at column 0) — the shape GitHub's
// electron-builder writes.
const YML_COMPACT = `version: 0.3.1
files:
- url: nexus-Setup-0.3.1.exe
  sha512: ABC==
  size: 103328462
  blockmapUrl: nexus-Setup-0.3.1.exe.blockmap
path: nexus-Setup-0.3.1.exe
sha512: ABC==
releaseNotes: false
`;

// Gitee's published latest.yml pins the installer at a GitHub absolute URL.
const YML_ABSOLUTE_URL = `version: 0.3.1
files:
  - url: https://github.com/jsws9517/nexus-desktop/releases/download/v0.3.1/nexus-Setup-0.3.1.exe
    size: 103328462
path: nexus-Setup-0.3.1.exe
`;

test('parseUpdateYml handles block-style items', () => {
  const m = parseUpdateYml(YML_BLOCK);
  assert.ok(m);
  assert.equal(m.version, '0.3.1');
  assert.equal(m.path, 'nexus-Setup-0.3.1.exe');
  assert.equal(m.sha512, 'lyUXUqwYlJuchQiZ/QI/9biwBYk5FQWjTMXtR6RhJ2ViEtOftTWyuVceSpN8ImLEPmHCVQqTslmGr989kHEOIQ==');
  assert.equal(m.releaseNotes, 'false');
  assert.equal(m.files.length, 1);
  assert.equal(m.files[0].url, 'nexus-Setup-0.3.1.exe');
  assert.equal(m.files[0].size, 103328462);
  assert.equal(m.files[0].blockmapUrl, null);
});

test('parseUpdateYml handles compact js-yaml items', () => {
  const m = parseUpdateYml(YML_COMPACT);
  assert.ok(m);
  assert.equal(m.version, '0.3.1');
  assert.equal(m.files.length, 1);
  assert.equal(m.files[0].url, 'nexus-Setup-0.3.1.exe');
  assert.equal(m.files[0].size, 103328462);
  assert.equal(m.files[0].sha512, 'ABC==');
  assert.equal(m.files[0].blockmapUrl, 'nexus-Setup-0.3.1.exe.blockmap');
});

test('parseUpdateYml keeps absolute file URLs untouched', () => {
  const m = parseUpdateYml(YML_ABSOLUTE_URL);
  assert.ok(m);
  assert.equal(m.files[0].url, 'https://github.com/jsws9517/nexus-desktop/releases/download/v0.3.1/nexus-Setup-0.3.1.exe');
});

test('parseUpdateYml returns null without a version', () => {
  assert.equal(parseUpdateYml('files:\n- url: x.exe\n'), null);
});

// ── compareVersions ───────────────────────────────────────────────────────────

test('compareVersions orders plain versions', () => {
  assert.ok(compareVersions('0.3.1', '0.3.0') > 0);
  assert.ok(compareVersions('0.2.9', '0.3.0') < 0);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
});

test('compareVersions handles numeric prerelease suffixes', () => {
  // core npm versions like 1.1.26-3
  assert.ok(compareVersions('1.1.26-3', '1.1.26-2') > 0);
  assert.ok(compareVersions('1.1.26', '1.1.26-3') > 0); // release > prerelease
  assert.ok(compareVersions('1.1.26-10', '1.1.26-9') > 0); // numeric, not lexicographic
  assert.ok(isNewer('1.1.26', '1.1.26-3'));
  assert.ok(!isNewer('1.1.26-3', '1.1.26'));
});

// ── feed builders ────────────────────────────────────────────────────────────

test('githubReleaseBase pins the tag and strips a leading v', () => {
  assert.equal(
    githubReleaseBase('0.3.1'),
    'https://github.com/jsws9517/nexus-desktop/releases/download/v0.3.1',
  );
  assert.equal(githubReleaseBase('v0.3.1'), githubReleaseBase('0.3.1'));
});

test('giteeReleaseBase normalizes the tag', () => {
  assert.equal(giteeReleaseBase('0.3.1'), 'https://gitee.com/cict_1_0/nexus-desktop/releases/download/v0.3.1');
  assert.equal(giteeReleaseBase('v0.3.1'), giteeReleaseBase('0.3.1'));
});

test('appVersionFeeds: GitHub first, mirrors in speed order, ghfast.top last', () => {
  const feeds = appVersionFeeds('0.3.1');
  assert.equal(feeds[0].label, 'GitHub');
  const labels = feeds.map((f) => f.label);
  assert.deepEqual(labels, ['GitHub', ...GITHUB_MIRRORS.map((m) => m.label)]);
  assert.ok(labels.at(-1) === 'ghfast.top');
  for (const f of feeds.slice(1)) {
    assert.ok(f.url.includes('/https://github.com/jsws9517/nexus-desktop/releases/download/v0.3.1'));
  }
});

test('appManifestFeeds point at the latest/download alias', () => {
  const feeds = appManifestFeeds();
  assert.equal(feeds[0].url, 'https://github.com/jsws9517/nexus-desktop/releases/latest/download');
  assert.equal(feeds.length, 1 + GITHUB_MIRRORS.length);
});

test('assetCandidates expands github URLs through all mirrors, passes others through', () => {
  const url = 'https://github.com/jsws9517/nexus-desktop/releases/download/v0.3.1/core-1.1.26-3.tar.gz';
  const c = assetCandidates(url);
  assert.equal(c[0].label, 'GitHub');
  assert.equal(c[0].url, url);
  assert.equal(c.length, 1 + GITHUB_MIRRORS.length);
  assert.ok(c[1].url.startsWith('https://ghproxy.imciel.com/'));
  const gitee = assetCandidates('https://gitee.com/cict_1_0/nexus-desktop/releases/download/v0.3.1/x.yml');
  assert.equal(gitee.length, 1);
  assert.equal(gitee[0].url, 'https://gitee.com/cict_1_0/nexus-desktop/releases/download/v0.3.1/x.yml');
});

// ── display helpers ───────────────────────────────────────────────────────────

test('formatBytes / formatSpeed', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(320 * 1024), '320 KB');
  assert.equal(formatBytes(6.6 * 1024 * 1024), '6.6 MB');
  assert.equal(formatSpeed(312 * 1024), '312 KB/s');
  assert.equal(formatSpeed(0), '');
});
