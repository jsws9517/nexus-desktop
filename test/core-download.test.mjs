import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoreManifest } from '../dist/core-overlay/download.js';

test('parseCoreManifest handles multi-version YAML', () => {
  const yml = `version: 1.2.0
sha512: abc123def456
size: 1000000
url: https://example.com/core-1.2.0.tar.gz
timestamp: 2026-01-01T00:00:00.000Z

version: 1.1.0
sha512: def456abc123
size: 900000
url: https://example.com/core-1.1.0.tar.gz
timestamp: 2025-12-01T00:00:00.000Z
`;
  const entries = parseCoreManifest(yml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '1.2.0');
  assert.equal(entries[0].size, 1000000);
  assert.equal(entries[1].version, '1.1.0');
});

test('parseCoreManifest parses the protocol range + legacy line', () => {
  const yml = `version: 1.2.0
sha512: aaa
size: 1
url: https://example.com/core-1.2.0.tar.gz
timestamp: 2026-01-01T00:00:00.000Z
protocolMin: 2
protocolMax: 4

version: 1.1.0
sha512: bbb
size: 1
url: https://example.com/core-1.1.0.tar.gz
timestamp: 2025-12-01T00:00:00.000Z
protocol: 3

version: 1.0.0
sha512: ccc
size: 1
url: https://example.com/core-1.0.0.tar.gz
timestamp: 2025-11-01T00:00:00.000Z
`;
  const entries = parseCoreManifest(yml);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].protocolMin, 2, 'range min');
  assert.equal(entries[0].protocolMax, 4, 'range max');
  assert.equal(entries[1].protocolMin, 3, 'legacy protocol line folds into min');
  assert.equal(entries[1].protocolMax, 3, 'legacy protocol line folds into max');
  assert.equal(entries[2].protocolMin, null, 'unstamped entry stays null');
  assert.equal(entries[2].protocolMax, null, 'unstamped entry stays null');
});

test('parseCoreManifest ignores incomplete entries', () => {
  const yml = `version: 2.0.0
sha512: aaa
size: 500
url: https://example.com/core-2.0.0.tar.gz
timestamp: 2026-01-01T00:00:00.000Z

incomplete version: 1.0.0
sha512: bbb
`;
  const entries = parseCoreManifest(yml);
  // Incomplete entry (missing size) is skipped
  assert.equal(entries.length, 1);
  assert.equal(entries[0].version, '2.0.0');
});
