/**
 * P0 Preview protocol unit tests — pure functions in src/shared/preview.ts
 * tested headlessly (no Electron). Covers MIME mapping, classification,
 * token URL encoding/decoding, and size formatting.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const { classify, mimeForPath, isPreviewable, PREVIEWABLE_KINDS, extractToken, buildPreviewUrl, formatBytes, MAX_TOKENS, TOKEN_TTL_MS, exceedsPreviewCap } =
  await import(pathToFileURL(join(dist, 'shared', 'preview.js')));

describe('mimeForPath', () => {
  test('recognises common image extensions', () => {
    assert.equal(mimeForPath('/foo/bar.png'), 'image/png');
    assert.equal(mimeForPath('/foo/bar.jpg'), 'image/jpeg');
    assert.equal(mimeForPath('/foo/bar.jpeg'), 'image/jpeg');
    assert.equal(mimeForPath('/foo/bar.gif'), 'image/gif');
    assert.equal(mimeForPath('/foo/bar.webp'), 'image/webp');
    assert.equal(mimeForPath('/foo/bar.svg'), 'image/svg+xml');
  });
  test('recognises video/audio', () => {
    assert.equal(mimeForPath('/foo/video.mp4'), 'video/mp4');
    assert.equal(mimeForPath('/foo/song.mp3'), 'audio/mpeg');
    assert.equal(mimeForPath('/foo/file.wav'), 'audio/wav');
  });
  test('recognises document types', () => {
    assert.equal(mimeForPath('/foo/doc.pdf'), 'application/pdf');
    const pptxMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    assert.equal(mimeForPath('/foo/presentation.pptx'), pptxMime);
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    assert.equal(mimeForPath('/foo/report.docx'), docxMime);
  });
  test('case-insensitive extension matching', () => {
    assert.equal(mimeForPath('/foo/photo.PNG'), 'image/png');
    assert.equal(mimeForPath('/foo/archive.PDF'), 'application/pdf');
  });
  test('unknown extension returns empty string', () => {
    assert.equal(mimeForPath('/foo/file.xyz'), '');
    assert.equal(mimeForPath('/foo/noext'), '');
  });
});

describe('classify', () => {
  const cases = [
    ['/a/b.png', 'image'],
    ['/a/b.JPEG', 'image'],
    ['/a/b.mp4', 'video'],
    ['/a/b.webm', 'video'],
    ['/a/c.mp3', 'audio'],
    ['/a/d.wav', 'audio'],
    ['/a/e.pdf', 'pdf'],
    ['/a/f.docx', 'docx'],
    ['/a/g.pptx', 'pptx'],
    ['/a/h.html', 'html'],
    ['/a/i.md', 'markdown'],
    ['/a/j.txt', 'text'],
    ['/a/k.csv', 'text'],
    // Project text types (config / data / code).
    ['/a/k.json', 'text'],
    ['/a/schema.sql', 'text'],
    ['/a/config.toml', 'text'],
    ['/a/a.yaml', 'text'],
    ['/a/b.yml', 'text'],
    ['/a/c.ini', 'text'],
    ['/a/d.log', 'text'],
    ['/a/e.sh', 'text'],
    ['/a/f.py', 'text'],
    ['/a/g.js', 'text'],
    ['/a/h.ts', 'text'],
    ['/a/i.css', 'text'],
    ['/a/l.unknown', 'unsupported'],
  ];
  for (const [path, expected] of cases) {
    test(`${path} -> ${expected}`, () => {
      assert.equal(classify(path), expected);
    });
  }
});

describe('isPreviewable', () => {
  test('accepts all previewable kinds', () => {
    for (const k of PREVIEWABLE_KINDS) {
      assert.ok(isPreviewable(k), `${k} should be previewable`);
    }
  });
  test('rejects unsupported', () => {
    assert.equal(isPreviewable('unsupported'), false);
  });
});

describe('token URL roundtrip', () => {
  test('build and extract are inverses', () => {
    const token = 'abcdef0123456789';
    const url = buildPreviewUrl(token, 'report.pdf');
    assert.equal(extractToken(url), token);
    assert.ok(url.startsWith('nexus-preview://'));
    assert.ok(url.includes('local'));
  });
  test('extractToken rejects malformed URLs', () => {
    assert.equal(extractToken('http://example.com'), null);
    assert.equal(extractToken('nexus-preview:///bad'), null);
    assert.equal(extractToken('nexus-preview://local/short'), null);
    assert.equal(extractToken('nexus-preview://local/zzzzzzzzzzzzzzzX!'), null);
    assert.equal(extractToken(''), null);
  });
  test('accepts valid 16-char hex tokens', () => {
    assert.notEqual(extractToken('nexus-preview://local/abcdef0123456789/test.pdf'), null);
    assert.notEqual(extractToken('nexus-preview://local/0000000000000000'), null);
  });
});

describe('formatBytes', () => {
  test('formats small values as bytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(500), '500 B');
  });
  test('formats KB range', () => {
    assert.match(formatBytes(1024), /KB/);
    assert.match(formatBytes(10 * 1024), /KB/);
  });
  test('formats MB range', () => {
    assert.match(formatBytes(1024 * 1024), /MB/);
  });
  test('formats GB range', () => {
    assert.match(formatBytes(1024 * 1024 * 1024), /GB/);
  });
});

test('exceedsPreviewCap', () => {
  test('allows files under 512 MiB', () => {
    assert.equal(exceedsPreviewCap(512 * 1024 * 1024 - 1), false);
  });
  test('allows files exactly at 512 MiB (strictly greater required)', () => {
    assert.equal(exceedsPreviewCap(512 * 1024 * 1024), false);
  });
  test('rejects files over 512 MiB', () => {
    assert.equal(exceedsPreviewCap(512 * 1024 * 1024 + 1), true);
    assert.equal(exceedsPreviewCap(1024 * 1024 * 1024), true);
  });
});

describe('constants', () => {
  test('MAX_TOKENS is 32', () => {
    assert.equal(MAX_TOKENS, 32);
  });
  test('TOKEN_TTL_MS is 30 minutes', () => {
    assert.equal(TOKEN_TTL_MS, 30 * 60 * 1000);
  });
});
