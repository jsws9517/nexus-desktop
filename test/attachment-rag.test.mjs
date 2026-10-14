/**
 * One-time attachment RAG — retrieval quality + tool reachability.
 *
 * Two defects motivated this file, both of which made the feature look broken
 * ("tool results come back empty") while every unit in isolation passed:
 *
 *  1. Raw `bm25Search` on chunk-level rows returns ten consecutive chunks of one
 *     big document and starves every other attachment, and — because the store
 *     indexes CJK per character — matches noise like `多模` in `多模态`.
 *  2. `attachments_search` was dropped by the relevance selector even for
 *     prompts that say "附件", because MAX_KEPT truncated the kept list blindly
 *     and sliced pinned tools off the tail.
 *
 * The store is created under a temp dir per test (NEXUS_CONFIG_DIR) so nothing
 * touches the real ~/.nexus/attach-rag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const dataDir = mkdtempSync(join(tmpdir(), 'attach-rag-test-'));
process.env.NEXUS_CONFIG_DIR = dataDir;
const filesDir = join(dataDir, 'files');
mkdirSync(filesDir, { recursive: true });

const rag = await import(pathToFileURL(join(dist, 'agent', 'attachment-rag.js')));
const { selectTools, ESSENTIAL_TOOLS } = await import(
  pathToFileURL(join(dist, 'tools', 'tool-relevance.js'))
);
const { ALL_TOOL_DEFS } = await import(pathToFileURL(join(dist, 'tools', 'index.js')));

function write(name, body) {
  const p = join(filesDir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

const md = (heading, line, times) => `# ${heading}\n\n${line}\n\n`.repeat(times);

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

test('ingests allowed files and rejects extensions outside the allowlist', () => {
  const sid = 'allowlist';
  const ok = write('ok.md', md('A', '内容', 3));
  const bad = write('nope.exe', 'binary-ish');
  const res = rag.ingestAttachments(sid, [ok, bad], ['md', 'txt']);
  assert.equal(res.length, 2);
  assert.equal(res[0].ok, true);
  assert.ok(res[0].chunkCount > 0);
  assert.equal(res[1].ok, false);
  assert.equal(res[1].reason, 'not-allowed');
  assert.equal(rag.listAttachments(sid).length, 1);
  rag.disposeAttachmentStore(sid);
});

test('search returns whole passages, not 26-token fragments', () => {
  const sid = 'passages';
  const p = write('passages.md', md('Passages', 'The quick brown fox jumps over the lazy dog repeatedly.', 40));
  rag.ingestAttachments(sid, [p], ['md']);
  const hits = rag.search(sid, 'quick brown fox', 3);
  assert.ok(hits.length > 0);
  assert.ok(hits[0].snippet.includes('quick brown fox'));
  // A centred excerpt of a long chunk, not a token-sized fragment.
  assert.ok(hits[0].snippet.length > 60);
  rag.disposeAttachmentStore(sid);
});

test('hits span multiple files instead of flooding the biggest one', () => {
  const sid = 'diversify';
  const a = write('alpha.md', md('Alpha', '多模态模型可以同时处理文本和图像。', 30));
  const b = write('beta.md', md('Beta', 'Gemini CLI 支持多模态输入。', 30));
  rag.ingestAttachments(sid, [a, b], ['md']);
  const hits = rag.search(sid, '多模态', 6);
  assert.ok(hits.length >= 2);
  const files = new Set(hits.map((h) => h.file));
  assert.ok(files.size >= 2, `expected results from 2 files, got ${[...files].join(', ')}`);
  rag.disposeAttachmentStore(sid);
});

test('CJK bigram evidence outranks single-character noise', () => {
  const sid = 'bigram';
  // 'noise' repeats 模 and 多 everywhere but never the word 多模态.
  const noise = write('noise.md', md('Noise', '模型有很多种，多种模型可以多线程运行。', 30));
  const signal = write('signal.md', md('Signal', '这是一个多模态模型，支持图文输入。', 30));
  rag.ingestAttachments(sid, [noise, signal], ['md']);
  const hits = rag.search(sid, '多模态', 2);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].file, 'signal.md');
  assert.ok(hits[0].boost > 0);
  rag.disposeAttachmentStore(sid);
});

test('reports file + chunk coordinates so the model can cite them', () => {
  const sid = 'coords';
  const p = write('coords.md', md('Coords', '坐标测试内容。', 60));
  rag.ingestAttachments(sid, [p], ['md']);
  const [hit] = rag.search(sid, '坐标', 1);
  assert.equal(hit.file, 'coords.md');
  assert.ok(hit.chunk >= 1);
  assert.ok(hit.chunks >= hit.chunk);
  rag.disposeAttachmentStore(sid);
});

test('empty index falls back to a file catalogue, never to nothing', () => {
  const sid = 'fallback';
  const p = write('cat.md', md('Catalogue', '目录预览内容。', 3));
  rag.ingestAttachments(sid, [p], ['md']);
  assert.equal(rag.search(sid, 'zzzz-no-such-token').length, 0);
  const index = rag.attachmentIndex(sid);
  assert.equal(index.length, 1);
  assert.equal(index[0].name, 'cat.md');
  assert.ok(index[0].chunks > 0);
  rag.disposeAttachmentStore(sid);
});

test('remove + clear empty the session store; re-ingest is idempotent', () => {
  const sid = 'lifecycle';
  const a = write('life-a.md', md('A', '内容甲', 5));
  const b = write('life-b.md', md('B', '内容乙', 5));
  rag.ingestAttachments(sid, [a, b], ['md']);
  assert.equal(rag.listAttachments(sid).length, 2);
  rag.ingestAttachments(sid, [a], ['md']);
  assert.equal(rag.listAttachments(sid).length, 2, 're-ingest must not duplicate the file');
  rag.removeAttachment(sid, a);
  assert.equal(rag.listAttachments(sid).length, 1);
  rag.clearAttachmentStore(sid);
  assert.equal(rag.listAttachments(sid).length, 0);
  rag.disposeAttachmentStore(sid);
});

test('auto-inject budget gates Hybrid on total chunk count', () => {
  const sid = 'budget';
  const p = write('budget.md', md('Budget', '预算测试。', 5));
  rag.ingestAttachments(sid, [p], ['md']);
  assert.equal(rag.withinAutoInjectBudget(sid), true);
  assert.equal(rag.hasAttachments(sid), true);
  rag.disposeAttachmentStore(sid);
  assert.equal(rag.hasAttachments(sid), false, 'disposed store must read as empty');
});

test('attachments_search is pinned and survives the MAX_KEPT cap', () => {
  assert.ok(ESSENTIAL_TOOLS.has('attachments_search'), 'must be pinned: it is the only retrieval path');
  const kept = selectTools(ALL_TOOL_DEFS, { input: '帮我总结一下这段代码的逻辑', used: new Set() }).map(
    (d) => d.name
  );
  assert.ok(
    kept.includes('attachments_search'),
    `pinned tool truncated by the keep-cap (kept ${kept.length})`
  );
  assert.ok(ALL_TOOL_DEFS.some((d) => d.name === 'attachments_search'), 'def must be registered');
});

// ---------------------------------------------------------------------------
// Single-file navigation: top-k alone leaves the model unable to reach the one
// chunk that answers the question, which is what pushed it to grep the file
// from a shell. Outline + paging is the replacement.
// ---------------------------------------------------------------------------

function headed(name, sections) {
  // Long enough per section that each lands in its own chunk.
  return sections.map(([h, body]) => `# ${h}\n\n${body.repeat(40)}\n`).join('\n');
}

test('outline maps every chunk to its heading and is inherited', () => {
  const sid = 'outline';
  const p = write('headed.md', headed('t', [
    ['Intro', 'introductory prose. '],
    ['Middle', 'middle prose. '],
    ['End', 'closing prose. '],
  ]));
  rag.ingestAttachments(sid, [p], ['md']);
  const [file] = rag.attachmentOutline(sid);
  assert.equal(file.file, 'headed.md');
  assert.ok(file.entries.length >= 3);
  const first = file.entries[0].heading;
  assert.ok(first && first.length > 0, 'first chunk must resolve a heading');
  // Every chunk resolves to some heading (own or inherited) — never empty.
  assert.ok(file.entries.every((e) => e.heading.length > 0), 'chunks without own heading inherit the previous one');
  assert.ok(file.entries.some((e) => e.heading.includes('End')), 'last section heading must appear');
  rag.disposeAttachmentStore(sid);
});

test('chunksByNumber reads whole chunks verbatim and clamps out-of-range', () => {
  const sid = 'paging';
  const p = write('paged.md', headed('t', [
    ['Alpha', 'ALPHA-MARKER content. '],
    ['Beta', 'BETA-MARKER content. '],
    ['Gamma', 'GAMMA-MARKER content. '],
  ]));
  rag.ingestAttachments(sid, [p], ['md']);
  const [file] = rag.attachmentOutline(sid);
  const total = file.entries.length;

  const mid = rag.chunksByNumber(sid, undefined, 2, 1);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].n, 2);
  assert.equal(mid[0].chunks, total);
  assert.ok(mid[0].text.length > 0, 'a chunk read must not be empty');

  // Out of range clamps to the last chunk instead of erroring or returning [].
  const past = rag.chunksByNumber(sid, undefined, 9999, 3);
  assert.ok(past.length > 0, 'clamped read must return the tail');
  assert.equal(past[0].n, total);
  assert.equal(past[past.length - 1].n, total);

  const before = rag.chunksByNumber(sid, undefined, 0, 1);
  assert.equal(before[0].n, 1, 'below-range clamps to chunk 1');

  const range = rag.chunksByNumber(sid, undefined, 1, 5);
  assert.ok(range.length <= 5, 'count is capped');
  rag.disposeAttachmentStore(sid);
});

test('outline aggregates a section spanning many chunks', () => {
  const sid = 'outline-span';
  // One heading, many chunks: the line must say so instead of implying the
  // section is a single chunk the model could read and be done with.
  const p = write('span.md', '# Only Section\n\n' + 'filler sentence. '.repeat(400));
  rag.ingestAttachments(sid, [p], ['md']);
  const [file] = rag.attachmentOutline(sid);
  assert.ok(file.entries.length >= 4, 'needs several chunks to be meaningful');
  const line = rag.formatOutline([file], 2000);
  assert.match(line, /Only Section@1\(x\d+\)/, `expected an aggregated span, got: ${line}`);
  rag.disposeAttachmentStore(sid);
});

test('injected context leads with the outline under the strippable marker', () => {
  const sid = 'inject';
  const p = write('inject.md', headed('t', [
    ['Alpha', 'ALPHA-MARKER content. '],
    ['Beta', 'BETA-MARKER content. '],
  ]));
  rag.ingestAttachments(sid, [p], ['md']);
  const hits = rag.search(sid, 'BETA-MARKER', 1);
  assert.ok(hits.length > 0);
  const block = rag.buildContextBlock(hits, rag.attachmentOutline(sid));
  // The core strips from this marker onward before persisting the turn; a
  // differently-named header would leak into the transcript.
  assert.ok(block.startsWith('\n\n[Attachment context'), `bad header: ${block.slice(0, 60)}`);
  assert.ok(block.includes('outline'), 'outline must ride along with the passages');
  assert.ok(block.includes('Alpha') || block.includes('Beta'), 'outline must name sections');
  rag.disposeAttachmentStore(sid);
});

test('capabilities split the allowlist by extractor availability', () => {
  const caps = rag.ragCapabilities(['md', '.TXT', 'pdf', 'docx', 'md', '']);
  assert.deepEqual(caps.allowlist, ['md', 'txt', 'pdf', 'docx'], 'normalized + deduped');
  assert.ok(caps.supported.includes('md') && caps.supported.includes('txt'));
  assert.ok(caps.unsupported.includes('pdf') && caps.unsupported.includes('docx'));
  assert.equal(caps.allowlist.length, caps.supported.length + caps.unsupported.length);
});

test('tool dispatches the three retrieval modes', async () => {
  const { callAttachmentRagTool } = await import(
    pathToFileURL(join(dist, 'tools', 'attachment-rag.js'))
  );
  const sid = 'tool-modes';
  const p = write('modes.md', headed('t', [
    ['Alpha', 'ALPHA-MARKER content. '],
    ['Beta', 'BETA-MARKER content. '],
  ]));
  rag.ingestAttachments(sid, [p], ['md']);
  const ctx = {
    attachmentsSearch: (req) => ({ content: JSON.stringify(req) }),
  };

  const searchRes = callAttachmentRagTool('attachments_search', { query: 'beta' }, ctx);
  assert.match(searchRes.content, /"kind":"search"/);
  assert.match(searchRes.content, /"topK":8/);

  const outlineRes = callAttachmentRagTool('attachments_search', { mode: 'outline' }, ctx);
  assert.match(outlineRes.content, /"kind":"outline"/);

  const chunkRes = callAttachmentRagTool('attachments_search', { chunk: 2, count: 2 }, ctx);
  assert.match(chunkRes.content, /"kind":"chunk"/);
  assert.match(chunkRes.content, /"count":2/);

  // chunk wins over query — it is the "read what I just located" call.
  const bothRes = callAttachmentRagTool('attachments_search', { query: 'beta', chunk: 3 }, ctx);
  assert.match(bothRes.content, /"kind":"chunk"/);

  // search mode without a query must be a clear usage error, not a silent miss.
  const emptyRes = callAttachmentRagTool('attachments_search', {}, ctx);
  assert.equal(emptyRes.isError, true);
  assert.match(emptyRes.content, /query/);

  const noCtx = callAttachmentRagTool('attachments_search', { query: 'x' }, {});
  assert.equal(noCtx.isError, false);
  rag.disposeAttachmentStore(sid);
});