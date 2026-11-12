/**
 * Previewable-path extraction from tool results (dist/renderer/preview/paths.js).
 * Pure module — no DOM needed. Covers the history-restore contract: generated
 * media cards are rebuilt from persisted tool-result JSON, so every envelope
 * shape the media tools emit must yield its file paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const { jsonPathFields, findPreviewablePaths, isLocalFilePath, partitionPreviewPaths, findRawPathHits } =
  await import(pathToFileURL(join(dist, 'renderer', 'preview', 'paths.js')).href);

const PNG = 'C:/Users/pgw/.nexus/caches/tokyo_rain_1794295610760.png';

// The exact envelope generate_image persists (files[] + image_path).
const GENERATE_IMAGE_ENVELOPE = JSON.stringify(
  {
    ok: true,
    task_id: 'mt_6b4732e247',
    status: 'succeeded',
    kind: 'image',
    provider: 'agnes-image',
    model: 'agnes-image-2.5-flash',
    progress: 100,
    files: [PNG],
    image_path: PNG,
  },
  null,
  2,
);

test('jsonPathFields: the generate_image envelope yields its image path', () => {
  const out = jsonPathFields(GENERATE_IMAGE_ENVELOPE);
  assert.ok(out.includes(PNG), `expected ${PNG} in [${out}]`);
});

test('jsonPathFields: bare strings in files[] are kept even without image_path', () => {
  // Regression: the first walk dropped bare-string list entries, so an
  // envelope carrying ONLY files: [path] restored nothing on session switch.
  const content = JSON.stringify({ ok: true, files: [PNG] });
  assert.deepEqual(jsonPathFields(content), [PNG]);
});

test('jsonPathFields: files[] of {path} objects and outputs[] / artifacts[]', () => {
  const content = JSON.stringify({
    outputs: [{ path: 'D:/out/clip.mp4' }],
    artifacts: ['D:/out/report.xlsx'],
  });
  const out = jsonPathFields(content);
  assert.deepEqual(out, ['D:/out/clip.mp4', 'D:/out/report.xlsx']);
});

test('jsonPathFields: path-stem fields (image_path, video_path, output …)', () => {
  const content = JSON.stringify({ video_path: 'D:/v.mp4', output: 'D:/o.wav' });
  assert.deepEqual(jsonPathFields(content), ['D:/v.mp4', 'D:/o.wav']);
});

test('jsonPathFields: non-list strings that merely look like paths are ignored', () => {
  const content = JSON.stringify({ name: 'C:/x.png', provider: 'agnes-image' });
  assert.deepEqual(jsonPathFields(content), []);
});

test('jsonPathFields: non-JSON / malformed content yields []', () => {
  assert.deepEqual(jsonPathFields('plain text result'), []);
  assert.deepEqual(jsonPathFields('{oops'), []);
  assert.deepEqual(jsonPathFields(''), []);
});

test('findPreviewablePaths: structured args win over result text', () => {
  const out = findPreviewablePaths({ file: PNG }, 'no paths here');
  assert.deepEqual(out, [PNG]);
});

test('findPreviewablePaths: backticked absolute paths in text', () => {
  // Models emit backticked Windows paths with backslashes (as persisted in
  // sessions.db); the regex intentionally matches `C:\…`, `/…` and `~/…`.
  const win = 'C:\\Users\\pgw\\.nexus\\caches\\tokyo_rain_1794295610760.png';
  assert.deepEqual(findPreviewablePaths({}, `落盘路径：\`${win}\``), [win]);
  const posix = '/tmp/out/clip.mp4';
  assert.deepEqual(findPreviewablePaths({}, `saved \`${posix}\``), [posix]);
});

test('findPreviewablePaths: duplicates collapse across sources', () => {
  const out = findPreviewablePaths({}, GENERATE_IMAGE_ENVELOPE);
  assert.deepEqual(out, [PNG], 'files[] and image_path point at the same file');
});

test('findPreviewablePaths: non-previewable strings are filtered out', () => {
  const content = JSON.stringify({ files: ['D:/some/dir', 'https://x/y.png', PNG] });
  const out = findPreviewablePaths({}, content);
  assert.deepEqual(out, [PNG], 'directories and URLs are not previewable paths');
});

test('isLocalFilePath classifies absolute local refs', () => {
  assert.equal(isLocalFilePath('C:/x.png'), true);
  assert.equal(isLocalFilePath('C:\\x.png'), true);
  assert.equal(isLocalFilePath('\\\\server\\x.png'), true);
  assert.equal(isLocalFilePath('/tmp/x.png'), true);
  assert.equal(isLocalFilePath('images/x.png'), false);
  assert.equal(isLocalFilePath('https://a.com/x.png'), false);
  assert.equal(isLocalFilePath(42), false);
});

const IMG1 = 'C:/Users/pgw/.nexus/caches/a.png';
const IMG2 = 'C:/Users/pgw/.nexus/caches/b.png';
const IMG3 = 'C:/Users/pgw/.nexus/caches/c.png';
const IMG4 = 'C:/Users/pgw/.nexus/caches/d.png';
const IMG5 = 'C:/Users/pgw/.nexus/caches/e.png';
const IMG6 = 'C:/Users/pgw/.nexus/caches/f.png';
const VIDEO = 'D:/out/clip.mp4';
const PDF = 'D:/out/report.pdf';

test('partitionPreviewPaths: up to four images are eager, the rest defer', () => {
  assert.deepEqual(partitionPreviewPaths([IMG1, IMG2]).eager, [IMG1, IMG2]);
  assert.deepEqual(partitionPreviewPaths([IMG1, IMG2]).deferred, []);
  assert.deepEqual(partitionPreviewPaths([IMG1, IMG2, IMG3, IMG4]).eager, [IMG1, IMG2, IMG3, IMG4]);
});

test('partitionPreviewPaths: more than four images overflow into deferred', () => {
  const plan = partitionPreviewPaths([IMG1, IMG2, IMG3, IMG4, IMG5, IMG6]);
  assert.deepEqual(plan.eager, [IMG1, IMG2, IMG3, IMG4]);
  assert.deepEqual(plan.deferred, [IMG5, IMG6]);
});

test('partitionPreviewPaths: video is eager like images, other non-media kinds defer', () => {
  const plan = partitionPreviewPaths([VIDEO, PDF]);
  assert.deepEqual(plan.eager, [VIDEO]);
  assert.deepEqual(plan.deferred, [PDF]);
});

test('partitionPreviewPaths: a mix keeps media (image+video) eager, defers the rest, deduped in order', () => {
  const plan = partitionPreviewPaths([VIDEO, IMG1, PDF, IMG1, IMG2]);
  assert.deepEqual(plan.eager, [VIDEO, IMG1, IMG2]);
  // First-occurrence order preserved, duplicates dropped: VIDEO once, PDF once.
  assert.deepEqual(plan.deferred, [PDF]);
});

test('partitionPreviewPaths: empty input yields an empty plan', () => {
  assert.deepEqual(partitionPreviewPaths([]), { eager: [], deferred: [] });
});

test('partitionPreviewPaths: a generate_image + video result shows both up front', () => {
  // Both media kinds (image + video) are visual content, so a result listing
  // one of each mounts both eagerly — only truly non-media files defer.
  const content = JSON.stringify({ files: [PNG, VIDEO] });
  const paths = findPreviewablePaths({}, content);
  assert.deepEqual(paths, [PNG, VIDEO]);
  const plan = partitionPreviewPaths(paths);
  assert.deepEqual(plan.eager, [PNG, VIDEO]);
  assert.deepEqual(plan.deferred, []);
});

test('findPreviewablePaths: get_file_info — path only in args, content is metadata', () => {
  // Regression for "video inline preview doesn't survive a worker switch":
  // get_file_info returns ONLY `Size/Type/Created/...` and never echoes the
  // path, so the previewable path is recoverable from `args.path` alone. The
  // history-restore pass now threads the tool-call args into the extractor.
  const args = { path: VIDEO };
  const content = 'Size: 98304 bytes\nType: file\nCreated: 2026-01-01T00:00:00.000Z\nModified: 2026-01-02T00:00:00.000Z\nPermissions: 644';
  assert.deepEqual(findPreviewablePaths(args, content), [VIDEO]);
  // Without the args (the old `{}` behavior) the path is lost.
  assert.deepEqual(findPreviewablePaths({}, content), []);
});

// ── raw (non-backticked) absolute local paths in plain prose ──────────────
// Helper: assert the hit sequence is the expected paths AND that each
// (start, end) slice reconstructs the path exactly (no hand-computed offsets).
function expectRawPaths(text, expected) {
  const hits = findRawPathHits(text);
  assert.deepEqual(hits.map((h) => h.path), expected, 'hit paths');
  for (const h of hits) {
    assert.equal(text.slice(h.start, h.end), h.path, `slice reconstructs path for "${h.path}"`);
  }
}

test('findRawPathHits: a bare Windows drive path in prose is found', () => {
  expectRawPaths('视频已保存到 C:\\Users\\pgw\\.nexus\\caches\\clip.mp4 请查看', [
    'C:\\Users\\pgw\\.nexus\\caches\\clip.mp4',
  ]);
});

test('findRawPathHits: trailing CJK/ASCII punctuation is trimmed off the path', () => {
  // "…clip.mp4。" and "…b.png," must not swallow the punctuation; the
  // extension has to survive classify() or the path is never linked.
  expectRawPaths('见 C:\\out\\a.mp4。', ['C:\\out\\a.mp4']);
  expectRawPaths('see C:\\out\\b.png, then done', ['C:\\out\\b.png']);
});

test('findRawPathHits: UNC and POSIX paths are found', () => {
  expectRawPaths('share: \\\\nas\\media\\report.pdf here', ['\\\\nas\\media\\report.pdf']);
  expectRawPaths('wrote /tmp/out/result.png now', ['/tmp/out/result.png']);
});

test('findRawPathHits: JSON-escaped (doubled-backslash) paths still match', () => {
  // Tool-result JSON shows paths as "C:\\\\..." — doubled separators must be
  // consumed so the whole path becomes one link (fs accepts the form).
  expectRawPaths('files: ["C:\\\\Users\\\\pgw\\\\x.mp4"]', ['C:\\\\Users\\\\pgw\\\\x.mp4']);
});

test('findRawPathHits: non-previewable or non-path prose stays inert', () => {
  expectRawPaths('C:\\temp and \\server\\share', []); // no previewable ext
  expectRawPaths('the ratio 1/2 of /x/y', []); // no previewable ext
  expectRawPaths('see https://ex.com/a.png for refs', []); // URL, not local
  expectRawPaths('plain sentence with no path', []);
});

test('findRawPathHits: multiple paths in one line are all found, in order', () => {
  const hits = findRawPathHits('A: C:\\a\\1.mp4 B: C:\\b\\2.png');
  assert.deepEqual(hits.map((h) => h.path), ['C:\\a\\1.mp4', 'C:\\b\\2.png']);
  assert.ok(hits[0].start < hits[1].start, 'order preserved');
});
