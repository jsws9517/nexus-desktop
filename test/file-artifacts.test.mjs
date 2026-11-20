/**
 * File-reference artifacts: regular attachments and produced deliverables that
 * live on disk must be listed by "My Artifacts", not only skill envelopes.
 *
 * Seeds a throwaway session DB (same pattern as t2-artifacts) and verifies the
 * extraction helpers plus the synthesized rows / negative-id lookup in
 * session-db.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const tmpRoot = mkdtempSync(join(tmpdir(), 'nexus-file-artifacts-'));
process.env.NEXUS_CONFIG_DIR = join(tmpRoot, '.nexus');
process.env.LLMA_DATA_DIR = tmpRoot;
after(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* file lock on win */ } });

// ── seed session DB + on-disk deliverables BEFORE importing session-db ───────
const nexusDir = join(process.env.LLMA_DATA_DIR, '.nexus');
mkdirSync(nexusDir, { recursive: true });
const outDir = join(tmpRoot, 'deliverables');
mkdirSync(outDir, { recursive: true });

const docxPath = join(outDir, 'Q4 report.docx');
const pptxPath = join(outDir, 'deck.pptx');
const pdfPath = join(outDir, 'brief.pdf');
const pngPath = join(outDir, 'shot.png');
const missingPath = join(outDir, 'ghost.docx');
for (const p of [docxPath, pptxPath, pdfPath, pngPath]) writeFileSync(p, 'x');

const dbPath = join(nexusDir, 'sessions.db');
const seed = new Database(dbPath);
seed.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, name TEXT, provider TEXT NOT NULL, model TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, thinking TEXT,
    tokens INTEGER, created_at INTEGER NOT NULL
  );
`);
const T0 = 1_700_000_000_000;
const insSession = seed.prepare(
  'INSERT INTO sessions (id,name,provider,model,created_at,updated_at) VALUES (?,?,?,?,?,?)',
);
insSession.run('s1', 'Alpha', 'p', 'm', T0, T0);
insSession.run('s2', 'Beta', 'p', 'm', T0, T0);
const ins = seed.prepare('INSERT INTO messages (session_id,role,content,created_at) VALUES (?,?,?,?)');

// 1. `+` attachment flow: `@<abs path>` line in a user message.
ins.run('s1', 'user', `@${docxPath}\nplease summarize`, T0 + 100);
// 2. spawn_office / generate_image style JSON result.
ins.run('s1', 'tool', JSON.stringify({ ok: true, files: [{ path: pptxPath }], image_path: pngPath }), T0 + 200);
// 3. plain-text assistant summary with a backticked path.
ins.run('s2', 'assistant', `Done — wrote \`${pdfPath}\` for you.`, T0 + 300);
// 4. Not produced: path does not exist.
ins.run('s1', 'tool', JSON.stringify({ files: [missingPath] }), T0 + 400);
// 5. Not produced: relative path (no cwd to resolve against).
ins.run('s1', 'user', '@documents/report.docx\nhello', T0 + 500);
// 6. Not produced: ordinary source path mentioned in prose.
ins.run('s1', 'assistant', 'See `src/main.ts` for details.', T0 + 600);

// 7. Structured envelope that already references a file — must NOT be listed
//    twice (once as envelope, once as a synthesized file row).
const { toArtifactContent } = await import(pathToFileURL(join(dist, 'shared', 'artifact.js')).href);
ins.run('s1', 'tool', toArtifactContent({
  id: 'office-1', type: 'docx', title: 'Office report', version: 1, status: 'done',
  meta: { sessionId: 's1', skill: 'docx.write', origin: 'main' },
  body: { ok: true },
  refs: [{ kind: 'file', path: pdfPath }],
}), T0 + 700);

// 8. Noise above the real rows: tool output that mentions deliverable-looking
//    paths (git status listings, chat about files). More than one SQL batch
//    (900 rows) so the walk has to continue past the newest window to reach the
//    older real artifacts above; most are relative so only a few need a stat.
for (let i = 0; i < 900; i++) {
  ins.run('s1', 'tool', `untracked nope-${i}.png and more text`, T0 + 1000 + i);
}
// Absolute but missing: reported, then dropped by the existence check.
for (let i = 0; i < 20; i++) {
  ins.run('s1', 'tool', `untracked ${join(outDir, `absent-${i}.png`)} and more text`, T0 + 1900 + i);
}
// 9. A giant inline base64 image result: never a source of paths.
ins.run('s1', 'tool', `![shot.png](data:image/png;base64,${'A'.repeat(700_000)})`, T0 + 1400);
seed.close();

const {
  queryArtifacts, getArtifactMessageContent,
} = await import(pathToFileURL(join(dist, 'session-db.js')).href);
const {
  extractAttachmentPaths, extractProducedPaths, artifactTypeForPath, isAbsoluteFilePath,
  decodeFileItemId, FILE_ITEM_STRIDE,
} = await import(pathToFileURL(join(dist, 'shared', 'file-artifacts.js')).href);
const { parseArtifactContent } = await import(pathToFileURL(join(dist, 'shared', 'artifact.js')).href);

// ── pure extraction ─────────────────────────────────────────────────────────

test('extractAttachmentPaths takes absolute @path lines only', () => {
  assert.deepEqual(extractAttachmentPaths(`@${docxPath}\nhi`), [docxPath]);
  assert.deepEqual(extractAttachmentPaths('@documents/report.docx\nhi'), []);
  assert.deepEqual(extractAttachmentPaths('mail me at a@b.com'), []);
  assert.deepEqual(extractAttachmentPaths(`@ "${docxPath}" `), [docxPath]);
});

test('extractProducedPaths covers JSON file fields, backticks and bare paths', () => {
  const json = extractProducedPaths(JSON.stringify({ files: [{ path: pptxPath }], image_path: pngPath }));
  assert.deepEqual(json, [pptxPath, pngPath]);
  // The shape every image/media tool actually returns: a path key holding an
  // array of plain strings.
  assert.deepEqual(
    extractProducedPaths(JSON.stringify({ ok: true, kind: 'image', files: [pptxPath, pngPath] })),
    [pptxPath, pngPath],
  );
  assert.deepEqual(extractProducedPaths(`Saved \`${pdfPath}\` ok`), [pdfPath]);
  assert.deepEqual(extractProducedPaths(`Saved ${pdfPath} ok`), [pdfPath]);
  assert.deepEqual(extractProducedPaths('See `src/main.ts` for details.'), []);
  assert.deepEqual(extractProducedPaths('{"foo":1}'), []);
});

test('inline base64 / giant bodies are never scanned', () => {
  // 2 MB inline image result: the alt text mentions .png but there is no path.
  const blob = `![shot.png](data:image/png;base64,${'A'.repeat(600_000)})`;
  assert.deepEqual(extractProducedPaths(blob), []);
  assert.deepEqual(extractProducedPaths(`x`.repeat(600_000) + pngPath), []);
});

test('oversized JSON results still yield normalized paths via the text pass', () => {
  // 130k of padding pushes the body past the JSON-parse cap; the raw JSON text
  // carries doubled Windows separators, which must collapse before the index
  // stores the path.
  const big = JSON.stringify({ pad: 'x'.repeat(130_000), files: [pptxPath] });
  assert.deepEqual(extractProducedPaths(big), [pptxPath]);
  const dataUrl = JSON.stringify({ data: 'data:image/png;base64,AAAA', path: pngPath });
  assert.deepEqual(extractProducedPaths(dataUrl), [pngPath]);
});

test('artifactTypeForPath / isAbsoluteFilePath', () => {
  assert.equal(artifactTypeForPath(docxPath), 'docx');
  assert.equal(artifactTypeForPath(pptxPath), 'ppt');
  assert.equal(artifactTypeForPath(pngPath), 'image');
  assert.equal(artifactTypeForPath('/tmp/notes.unknownext'), 'file');
  assert.equal(isAbsoluteFilePath('C:\\a\\b.docx'), true);
  assert.equal(isAbsoluteFilePath('/tmp/a.docx'), true);
  assert.equal(isAbsoluteFilePath('a/b.docx'), false);
});

test('decodeFileItemId round-trips the negative id encoding', () => {
  const id = -(42 * FILE_ITEM_STRIDE + 3);
  assert.deepEqual(decodeFileItemId(id), { messageId: 42, index: 3 });
  assert.equal(decodeFileItemId(42), null);
  assert.equal(decodeFileItemId(-3), null, 'message id 0 is invalid');
});

// ── index ───────────────────────────────────────────────────────────────────

test('queryArtifacts lists attachments and produced files with typed rows', () => {
  const res = queryArtifacts();
  assert.ok(res);
  const byTitle = new Map(res.items.map((it) => [it.title, it]));
  assert.equal(byTitle.get('Q4 report.docx')?.type, 'docx');
  assert.equal(byTitle.get('deck.pptx')?.type, 'ppt');
  assert.equal(byTitle.get('shot.png')?.type, 'image');
  assert.equal(byTitle.get('Q4 report.docx')?.sessionName, 'Alpha');
  assert.equal(byTitle.get('shot.png')?.preview, pngPath);
});

test('queryArtifacts skips missing files, relative paths and source paths', () => {
  const titles = queryArtifacts().items.map((it) => it.title);
  assert.ok(!titles.includes('ghost.docx'));
  assert.ok(!titles.includes('report.docx'), 'relative @path is not resolvable');
  assert.ok(!titles.includes('main.ts'));
});

test('an envelope file ref is not duplicated as a file row', () => {
  const res = queryArtifacts({ sessionId: 's1' });
  const pdfRows = res.items.filter((it) => it.title === 'brief.pdf');
  assert.equal(pdfRows.length, 0, 'pdf covered by the docx.write envelope refs');
  assert.equal(res.items.filter((it) => it.title === 'Office report').length, 1);
});

test('type / session / since filters apply to file rows too', () => {
  assert.deepEqual(queryArtifacts({ type: 'image' }).items.map((it) => it.title), ['shot.png']);
  assert.deepEqual(queryArtifacts({ sessionId: 's2' }).items.map((it) => it.title), ['brief.pdf']);
  const recent = queryArtifacts({ sinceMs: T0 + 150 }).items.map((it) => it.title);
  assert.ok(recent.includes('deck.pptx') && recent.includes('shot.png'));
  assert.ok(!recent.includes('Q4 report.docx'), 'attachment at T0+100 is older than the cutoff');
});

test('file rows use negative ids that resolve back to a synthesized envelope', () => {
  const item = queryArtifacts({ type: 'docx' }).items.find((it) => it.title === 'Q4 report.docx');
  assert.ok(item);
  assert.ok(item.id < 0, 'synthesized rows live in the negative id namespace');
  const content = getArtifactMessageContent(item.id);
  assert.ok(content);
  const artifact = parseArtifactContent(content);
  assert.ok(artifact);
  assert.equal(artifact.type, 'docx');
  assert.equal(artifact.title, 'Q4 report.docx');
  assert.deepEqual(artifact.refs, [{ kind: 'file', path: docxPath }]);
  assert.equal(artifact.meta.origin, 'user');
  assert.equal(artifact.body.path, docxPath);
});

test('getArtifactMessageContent still returns plain envelopes and rejects junk ids', () => {
  const envelopeId = queryArtifacts({ type: 'docx' }).items.find((it) => it.title === 'Office report').id;
  assert.ok(getArtifactMessageContent(envelopeId)?.includes('"__artifactVersion":1'));
  assert.equal(getArtifactMessageContent(0), null);
  assert.equal(getArtifactMessageContent(-99999999), null);
});

test('newest rows first across envelope and file sources', () => {
  const res = queryArtifacts({ sessionId: 's1' });
  const times = res.items.map((it) => it.createdAt);
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted);
});
