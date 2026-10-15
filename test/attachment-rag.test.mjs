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
 * touches the real ~/.nexus/session-rag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

/**
 * Every session id handed out is tracked so `after` can close the SQLite
 * handles before removing the temp dir — an open handle fails the rmdir with
 * EPERM on Windows and masks whatever assertion actually failed.
 */
const openSessions = new Set();
function newSession(tag) {
  const sid = `${tag}-${openSessions.size}`;
  openSessions.add(sid);
  return sid;
}
function closeSession(sid) {
  rag.disposeAttachmentStore(sid);
  openSessions.delete(sid);
}

test.after(() => {
  // Snapshot first: closeSession deletes from the set.
  for (const sid of [...openSessions]) closeSession(sid);
  rmSync(dataDir, { recursive: true, force: true });
});

const md = (heading, line, times) => `# ${heading}\n\n${line}\n\n`.repeat(times);


test('ingests allowed files and rejects extensions outside the allowlist', async () => {
  const sid = newSession('allowlist');
  const ok = write('ok.md', md('A', '内容', 3));
  const bad = write('nope.exe', 'binary-ish');
  const res = await rag.ingestAttachments(sid, [ok, bad], ['md', 'txt']);
  assert.equal(res.length, 2);
  assert.equal(res[0].ok, true);
  assert.ok(res[0].chunkCount > 0);
  assert.equal(res[1].ok, false);
  assert.equal(res[1].reason, 'not-allowed');
  assert.equal(rag.listAttachments(sid).length, 1);
  closeSession(sid);
});

test('search returns whole passages, not 26-token fragments', async () => {
  const sid = newSession('passages');
  const p = write('passages.md', md('Passages', 'The quick brown fox jumps over the lazy dog repeatedly.', 40));
  await rag.ingestAttachments(sid, [p], ['md']);
  const hits = rag.search(sid, 'quick brown fox', 3);
  assert.ok(hits.length > 0);
  assert.ok(hits[0].snippet.includes('quick brown fox'));
  // A centred excerpt of a long chunk, not a token-sized fragment.
  assert.ok(hits[0].snippet.length > 60);
  closeSession(sid);
});

test('hits span multiple files instead of flooding the biggest one', async () => {
  const sid = newSession('diversify');
  const a = write('alpha.md', md('Alpha', '多模态模型可以同时处理文本和图像。', 30));
  const b = write('beta.md', md('Beta', 'Gemini CLI 支持多模态输入。', 30));
  await rag.ingestAttachments(sid, [a, b], ['md']);
  const hits = rag.search(sid, '多模态', 6);
  assert.ok(hits.length >= 2);
  const files = new Set(hits.map((h) => h.file));
  assert.ok(files.size >= 2, `expected results from 2 files, got ${[...files].join(', ')}`);
  closeSession(sid);
});

test('CJK bigram evidence outranks single-character noise', async () => {
  const sid = newSession('bigram');
  // 'noise' repeats 模 and 多 everywhere but never the word 多模态.
  const noise = write('noise.md', md('Noise', '模型有很多种，多种模型可以多线程运行。', 30));
  const signal = write('signal.md', md('Signal', '这是一个多模态模型，支持图文输入。', 30));
  await rag.ingestAttachments(sid, [noise, signal], ['md']);
  const hits = rag.search(sid, '多模态', 2);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].file, 'signal.md');
  assert.ok(hits[0].boost > 0);
  closeSession(sid);
});

test('reports file + chunk coordinates so the model can cite them', async () => {
  const sid = newSession('coords');
  const p = write('coords.md', md('Coords', '坐标测试内容。', 60));
  await rag.ingestAttachments(sid, [p], ['md']);
  const [hit] = rag.search(sid, '坐标', 1);
  assert.equal(hit.file, 'coords.md');
  assert.ok(hit.chunk >= 1);
  assert.ok(hit.chunks >= hit.chunk);
  closeSession(sid);
});

test('empty index falls back to a file catalogue, never to nothing', async () => {
  const sid = newSession('fallback');
  const p = write('cat.md', md('Catalogue', '目录预览内容。', 3));
  await rag.ingestAttachments(sid, [p], ['md']);
  assert.equal(rag.search(sid, 'zzzz-no-such-token').length, 0);
  const index = rag.attachmentIndex(sid);
  assert.equal(index.length, 1);
  assert.equal(index[0].name, 'cat.md');
  assert.ok(index[0].chunks > 0);
  closeSession(sid);
});

test('remove + clear empty the session store; re-ingest is idempotent', async () => {
  const sid = newSession('lifecycle');
  const a = write('life-a.md', md('A', '内容甲', 5));
  const b = write('life-b.md', md('B', '内容乙', 5));
  await rag.ingestAttachments(sid, [a, b], ['md']);
  assert.equal(rag.listAttachments(sid).length, 2);
  await rag.ingestAttachments(sid, [a], ['md']);
  assert.equal(rag.listAttachments(sid).length, 2, 're-ingest must not duplicate the file');
  rag.removeAttachment(sid, a);
  assert.equal(rag.listAttachments(sid).length, 1);
  rag.clearAttachmentStore(sid);
  assert.equal(rag.listAttachments(sid).length, 0);
  closeSession(sid);
});

test('auto-inject budget gates Hybrid on total chunk count', async () => {
  const sid = newSession('budget');
  const p = write('budget.md', md('Budget', '预算测试。', 5));
  await rag.ingestAttachments(sid, [p], ['md']);
  assert.equal(rag.withinAutoInjectBudget(sid), true);
  assert.equal(rag.hasAttachments(sid), true);
  closeSession(sid);
  assert.equal(rag.hasAttachments(sid), false, 'disposed store must read as empty');
});

test('attachments_search is pinned and survives the MAX_KEPT cap', async () => {
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

test('outline maps every chunk to its heading and is inherited', async () => {
  const sid = newSession('outline');
  const p = write('headed.md', headed('t', [
    ['Intro', 'introductory prose. '],
    ['Middle', 'middle prose. '],
    ['End', 'closing prose. '],
  ]));
  await rag.ingestAttachments(sid, [p], ['md']);
  const [file] = rag.attachmentOutline(sid);
  assert.equal(file.file, 'headed.md');
  assert.ok(file.entries.length >= 3);
  const first = file.entries[0].heading;
  assert.ok(first && first.length > 0, 'first chunk must resolve a heading');
  // Every chunk resolves to some heading (own or inherited) — never empty.
  assert.ok(file.entries.every((e) => e.heading.length > 0), 'chunks without own heading inherit the previous one');
  assert.ok(file.entries.some((e) => e.heading.includes('End')), 'last section heading must appear');
  closeSession(sid);
});

test('chunksByNumber reads whole chunks verbatim and clamps out-of-range', async () => {
  const sid = newSession('paging');
  const p = write('paged.md', headed('t', [
    ['Alpha', 'ALPHA-MARKER content. '],
    ['Beta', 'BETA-MARKER content. '],
    ['Gamma', 'GAMMA-MARKER content. '],
  ]));
  await rag.ingestAttachments(sid, [p], ['md']);
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
  closeSession(sid);
});

test('outline aggregates a section spanning many chunks', async () => {
  const sid = newSession('outline-span');
  // One heading, many chunks: the line must say so instead of implying the
  // section is a single chunk the model could read and be done with.
  const p = write('span.md', '# Only Section\n\n' + 'filler sentence. '.repeat(400));
  await rag.ingestAttachments(sid, [p], ['md']);
  const [file] = rag.attachmentOutline(sid);
  assert.ok(file.entries.length >= 4, 'needs several chunks to be meaningful');
  const line = rag.formatOutline([file], 2000);
  assert.match(line, /Only Section@1\(x\d+\)/, `expected an aggregated span, got: ${line}`);
  closeSession(sid);
});

// ---------------------------------------------------------------------------
// Knowledge-vault withholding + optional embedding re-rank
// ---------------------------------------------------------------------------

const { shouldHideVaultTools, inputNamesVaultTool, VAULT_TOOLS } = await import(
  pathToFileURL(join(dist, 'tools', 'attachment-rag.js'))
);

test('vault tools are withheld only when the session store answers the round', async () => {
  const base = {
    respectNarrowing: false,
    hasAttachments: true,
    hasHits: true,
    namesVaultTool: false,
    force: new Set(),
  };
  assert.equal(shouldHideVaultTools(base), true, 'attachments hold + retrieve -> withhold');
  assert.deepEqual([...VAULT_TOOLS], ['vault_search', 'vault_open', 'vault_write']);

  // No files: nothing to prefer.
  assert.equal(shouldHideVaultTools({ ...base, hasAttachments: false }), false);
  // Files but this input misses them: the round is probably about the vault.
  assert.equal(shouldHideVaultTools({ ...base, hasHits: false }), false);
  // Plan mode / role scoping is a deliberate core restriction.
  assert.equal(shouldHideVaultTools({ ...base, respectNarrowing: true }), false);
  // An explicit request from the user outranks the inferred intent.
  assert.equal(shouldHideVaultTools({ ...base, namesVaultTool: true }), false);
  // refresh_tools is the model's escape hatch — an explicit request wins.
  assert.equal(shouldHideVaultTools({ ...base, force: new Set(['vault_search']) }), false);
});

test('naming a vault tool in the prompt is detected', async () => {
  assert.equal(inputNamesVaultTool('use vault_search for React'), true);
  assert.equal(inputNamesVaultTool('打开 vault_open 看看'), true);
  assert.equal(inputNamesVaultTool('请用 vault_write 记一下'), true);
  assert.equal(inputNamesVaultTool('这个附件里讲了 React 吗'), false);
});

const { BUILTIN_TOOLS } = await import(
  pathToFileURL(join(dist, '..', 'node_modules', 'nexus-coder', 'dist', 'src', 'mcp', 'builtin-tools.js'))
);
const { applyRouting } = await import(pathToFileURL(join(dist, 'tools', 'routing.js')));

test('vault tools stay pinned so an explicit request is always answerable', async () => {
  // Regression: the desktop selector REPLACES the core's tool list, so anything
  // the core pins must be pinned here too. Without this, "use vault_search" was
  // answered with "I have no vault_search tool".
  for (const n of VAULT_TOOLS) {
    assert.ok(ESSENTIAL_TOOLS.has(n), `${n} must be pinned in ESSENTIAL_TOOLS`);
  }
  // The live pool is core builtins + desktop defs, routed (AgentService merges
  // and applies routing before selecting) — vault_* are core builtins, so the
  // desktop-only list cannot prove they survive.
  const pool = applyRouting([...ALL_TOOL_DEFS, ...BUILTIN_TOOLS]);
  const kept = selectTools(pool, { input: 'use vault_search for React', used: new Set() }).map((d) => d.name);
  for (const n of VAULT_TOOLS) {
    assert.ok(kept.includes(n), `${n} was dropped (kept ${kept.length})`);
  }
});

/** Stub provider: every passage scores by whether it contains the marker. */
function markerProvider(marker) {
  return {
    id: 'test:marker',
    async embedTexts(texts) {
      return texts.map((t) => [t.includes(marker) ? 1 : 0, 0]);
    },
    async embedQuery() {
      return [1, 0];
    },
    async embedPassages(passages) {
      return passages.map((p) => [p.includes(marker) ? 1 : 0, 0]);
    },
  };
}

test('embedding re-rank promotes a semantically closer chunk over the BM25 leader', async () => {
  const sid = newSession('rerank');
  // Both chunks contain ORION so BM25 surfaces both — a re-rank can only
  // reorder lexical seeds, never invent a recall. The filler chunk wins on term
  // frequency; only the second one is actually about the nebula, which is what
  // the embedding is asked to notice.
  const body = [
    '# Filler\n\n',
    'The ORION catalogue lists another ORION entry. '.repeat(30),
    '\n# Target\n\n',
    'The ORION record describes the nebula in detail. '.repeat(30),
  ].join('');
  const p = write('rerank.md', body);
  await rag.ingestAttachments(sid, [p], ['md']);
  const lexical = rag.search(sid, 'orion', 5);
  assert.ok(lexical.length >= 2, `precondition: need >=2 candidates, got ${lexical.length}`);

  const hits = await rag.searchRanked(sid, 'orion', 5, markerProvider('nebula'));
  assert.ok(hits.length > 0);
  assert.ok(hits[0].vector !== undefined, 'a re-ranked hit carries a cosine score');
  assert.ok(
    hits[0].snippet.includes('nebula'),
    `the passage that discusses the nebula should win; got: ${hits[0].snippet.slice(0, 80)}`
  );
  closeSession(sid);
});

test('searchRanked without a provider is exactly the lexical path', async () => {
  const sid = newSession('no-provider');
  const p = write('plain.md', md('Plain', 'plain content here.', 60));
  await rag.ingestAttachments(sid, [p], ['md']);
  const lexical = rag.search(sid, 'plain', 5);
  const off = await rag.searchRanked(sid, 'plain', 5, null);
  assert.deepEqual(off.map((h) => h.ref), lexical.map((h) => h.ref));
  assert.equal(off[0].vector, undefined, 'no re-rank means no cosine score');
  closeSession(sid);
});

test('a throwing provider degrades to BM25 with one warning', async () => {
  const sid = newSession('provider-throws');
  // Large enough for several chunks: below two candidates the re-rank is
  // skipped by design, which would make this test pass vacuously.
  const p = write('throw.md', md('Throw', 'throwaway content.', 120));
  await rag.ingestAttachments(sid, [p], ['md']);
  const lexical = rag.search(sid, 'throwaway', 5);
  assert.ok(lexical.length >= 2, `precondition: need >=2 candidates, got ${lexical.length}`);

  const warnings = [];
  let calls = 0;
  const broken = {
    id: 'test:broken',
    async embedTexts(texts) {
      calls++;
      throw new Error('backend unavailable');
    },
    async embedQuery() {
      calls++;
      throw new Error('backend unavailable');
    },
    async embedPassages(passages) {
      calls++;
      throw new Error('backend unavailable');
    },
  };
  const hits = await rag.searchRanked(sid, 'throwaway', 5, broken, (m) => warnings.push(m));
  assert.ok(hits.length > 0, 'retrieval must still answer');
  assert.deepEqual(hits.map((h) => h.ref), lexical.map((h) => h.ref), 'order falls back to BM25');
  assert.ok(hits.every((h) => h.vector === undefined), 'no cosine scores on degradation');
  assert.ok(calls > 0, 'the provider must actually have been consulted');
  assert.equal(warnings.length, 1, 'degradation is reported exactly once');
  assert.match(warnings[0], /re-rank skipped/);
  closeSession(sid);
});

test('the re-rank candidate pool is capped', async () => {
  assert.ok(
    rag.ATTACH_RERANK_CANDIDATE_CAP > 0 && rag.ATTACH_RERANK_CANDIDATE_CAP < 60,
    'cap must bound the per-turn embedding bill'
  );
});

test('injected context leads with the outline under the strippable marker', async () => {
  const sid = newSession('inject');
  const p = write('inject.md', headed('t', [
    ['Alpha', 'ALPHA-MARKER content. '],
    ['Beta', 'BETA-MARKER content. '],
  ]));
  await rag.ingestAttachments(sid, [p], ['md']);
  const hits = rag.search(sid, 'BETA-MARKER', 1);
  assert.ok(hits.length > 0);
  const block = rag.buildContextBlock(hits, rag.attachmentOutline(sid));
  // The core strips from this marker onward before persisting the turn; a
  // differently-named header would leak into the transcript.
  assert.ok(block.startsWith('\n\n[Attachment context'), `bad header: ${block.slice(0, 60)}`);
  assert.ok(block.includes('outline'), 'outline must ride along with the passages');
  assert.ok(block.includes('Alpha') || block.includes('Beta'), 'outline must name sections');
  closeSession(sid);
});

test('capabilities split the allowlist by extractor availability', async () => {
  const caps = rag.ragCapabilities(['md', '.TXT', 'pdf', 'docx', 'md', '']);
  assert.deepEqual(caps.allowlist, ['md', 'txt', 'pdf', 'docx'], 'normalized + deduped');
  assert.ok(caps.supported.includes('md') && caps.supported.includes('txt'));
  assert.ok(caps.unsupported.includes('pdf') && caps.unsupported.includes('docx'));
  assert.equal(caps.allowlist.length, caps.supported.length + caps.unsupported.length);
});

test('pre-rename stores are carried over from attach-rag/ to session-rag/', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-rag-migrate-'));
  const prevDataDir = process.env.NEXUS_CONFIG_DIR;
  const sid = 'legacy-session';
  const modUrl = pathToFileURL(join(dist, 'agent', 'attachment-rag.js')).href;
  const probe = (body) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
      env: { ...process.env, NEXUS_CONFIG_DIR: home },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    // Seed the store in a child that simply exits afterwards: releasing the
    // SQLite handle on exit is what lets the directory be renamed on Windows,
    // and `disposeAttachmentStore` can't be used because it deletes the file.
    // Then move it under the OLD directory name — the state an install that
    // predates the rename leaves behind.
    process.env.NEXUS_CONFIG_DIR = home;
    const doc = join(home, 'carried.md');
    writeFileSync(doc, '# Carried\n\n' + 'the migrated store keeps its index. '.repeat(30), 'utf8');
    probe(
      `const rag = await import(${JSON.stringify(modUrl)});
       await rag.ingestAttachments(${JSON.stringify(sid)}, [${JSON.stringify(doc)}], ['md']);`
    );

    const legacyDir = join(home, 'attach-rag');
    renameSync(join(home, 'session-rag'), legacyDir);
    assert.ok(existsSync(join(legacyDir, `${sid}.db`)), 'precondition: legacy store on disk');

    // The migration is a once-per-process step, and this test process has long
    // since passed it — so read the store back in a child that is still fresh.
    const out = probe(
      `const rag = await import(${JSON.stringify(modUrl)});
       console.log(JSON.stringify({ count: rag.listAttachments(${JSON.stringify(sid)}).length }));`
    );

    assert.equal(JSON.parse(out).count, 1, 'attachments must survive the rename');
    assert.ok(!existsSync(legacyDir), 'legacy directory must be gone after migrating');
    assert.ok(existsSync(join(home, 'session-rag', `${sid}.db`)), 'store must live under the new name');
  } finally {
    process.env.NEXUS_CONFIG_DIR = prevDataDir;
    rmSync(home, { recursive: true, force: true });
  }
});

test('tool dispatches the three retrieval modes', async () => {
  const { callAttachmentRagTool } = await import(
    pathToFileURL(join(dist, 'tools', 'attachment-rag.js'))
  );
  const sid = newSession('tool-modes');
  const p = write('modes.md', headed('t', [
    ['Alpha', 'ALPHA-MARKER content. '],
    ['Beta', 'BETA-MARKER content. '],
  ]));
  await rag.ingestAttachments(sid, [p], ['md']);
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
  closeSession(sid);
});