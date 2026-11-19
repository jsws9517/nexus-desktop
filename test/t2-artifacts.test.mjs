/**
 * T2-4 — My Artifacts center.
 *
 * Covers the main-process artifact index (parameterized SQL filters, ordering,
 * paging, malformed-envelope tolerance), the sidebar page's pure filter state
 * machine, and the three new inline renderers (markdown / html / image).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Dedicated temp root: session-db keeps its read handle open for the process,
// so (unlike the shared sandbox-env dir) cleanup is best-effort on Windows.
const tmpRoot = mkdtempSync(join(tmpdir(), 'nexus-t2-artifacts-'));
process.env.NEXUS_CONFIG_DIR = join(tmpRoot, '.nexus');
process.env.LLMA_DATA_DIR = tmpRoot;
after(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* file lock on win */ } });

// ── seed a throwaway session DB BEFORE importing session-db ──────────────────
const nexusDir = join(process.env.LLMA_DATA_DIR, '.nexus');
mkdirSync(nexusDir, { recursive: true });
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
seed.prepare('INSERT INTO sessions (id,name,provider,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('s1', 'Alpha', 'p', 'm', T0, T0);
seed.prepare('INSERT INTO sessions (id,name,provider,model,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run('s2', 'Beta', 'p', 'm', T0, T0);

const { toArtifactContent } = await import(pathToFileURL(join(dist, 'shared', 'artifact.js')).href);
const artifact = (id, type, sessionId, body, title) => ({
  id, type, title, version: 1, status: 'done',
  meta: { sessionId, skill: 'test.skill', origin: 'main' },
  body,
});
const ins = seed.prepare(
  'INSERT INTO messages (session_id,role,content,created_at) VALUES (?,?,?,?)',
);
// Insert order deliberately NOT newest-first to verify ORDER BY created_at DESC.
ins.run('s1', 'tool', toArtifactContent(artifact('c1', 'chart', 's1', { spec: {} }, 'Chart A')), T0 + 100);
ins.run('s2', 'tool', toArtifactContent(artifact('m1', 'markdown', 's2', { content: '# Hi' }, 'Notes')), T0 + 200);
ins.run('s1', 'tool', toArtifactContent(artifact('i1', 'image', 's1', { data: 'aGVsbG8=', mime: 'image/png' }, 'Shot')), T0 + 300);
ins.run('s1', 'tool', '{"__artifactVersion":1,"artifact":{"broken":true}}', T0 + 400); // malformed → skipped
ins.run('s1', 'tool', '{"foo":"bar"}', T0 + 500); // not an envelope → no LIKE match
seed.close();

const { queryArtifacts, getArtifactMessageContent } =
  await import(pathToFileURL(join(dist, 'session-db.js')).href);

// ── main-process index ───────────────────────────────────────────────────────

test('queryArtifacts returns newest first with session names and previews', () => {
  const res = queryArtifacts();
  assert.ok(res, 'DB readable');
  assert.deepEqual(res.items.map((x) => x.type), ['image', 'markdown', 'chart']);
  assert.equal(res.items[0].sessionName, 'Alpha');
  assert.equal(res.items[0].title, 'Shot');
  assert.equal(res.items[1].sessionName, 'Beta');
  assert.ok(res.items[1].preview.includes('# Hi'));
  assert.ok(res.items.every((x) => x.id > 0), 'id is the source message id');
});

test('queryArtifacts filters by type / session / sinceMs individually and combined', () => {
  assert.deepEqual(queryArtifacts({ type: 'markdown' }).items.map((x) => x.id), [2]);
  assert.deepEqual(queryArtifacts({ sessionId: 's1' }).items.map((x) => x.type), ['image', 'chart']);
  assert.deepEqual(queryArtifacts({ sinceMs: T0 + 200 }).items.map((x) => x.type), ['image', 'markdown']);
  assert.deepEqual(
    queryArtifacts({ sessionId: 's1', type: 'chart', sinceMs: T0 + 50 }).items.map((x) => x.type),
    ['chart'],
  );
  assert.equal(queryArtifacts({ type: 'pdf' }).items.length, 0);
});

test('queryArtifacts LIMIT and parameterized sessionId (no LIKE injection)', () => {
  assert.equal(queryArtifacts({ limit: 2 }).items.length, 2);
  assert.equal(queryArtifacts({ limit: 9999 }).items.length, 3, 'cap at 500, not 9999 rows');
  // A classic injection payload is treated as a literal session id → no rows.
  assert.equal(queryArtifacts({ sessionId: "' OR 1=1 --" }).items.length, 0);
});

test('getArtifactMessageContent fetches full raw envelope by message id', () => {
  const content = getArtifactMessageContent(1);
  assert.ok(content && content.includes('"__artifactVersion":1'));
  assert.ok(content.includes('Chart A'));
  assert.equal(getArtifactMessageContent(9999), null);
});

// ── page filter state machine (pure helpers) ─────────────────────────────────

const {
  sinceMsFor, deriveSessions, filterArtifacts, exportPayloadFor,
} = await import(pathToFileURL(join(dist, 'renderer', 'sidebar', 'pages', 'artifacts.js')).href);

const NOW = new Date(2024, 0, 10, 12, 0, 0).getTime();
const items = [
  { id: 1, sessionId: 's1', sessionName: 'Alpha', type: 'chart', title: 'C', createdAt: NOW - 1000, preview: '' },
  { id: 2, sessionId: 's2', sessionName: 'Beta', type: 'markdown', title: 'M', createdAt: NOW - 9 * 86400000, preview: '' },
  { id: 3, sessionId: 's1', sessionName: 'Alpha', type: 'image', title: 'I', createdAt: NOW, preview: '' },
];

test('sinceMsFor maps the time dropdown to a lower bound', () => {
  const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
  assert.equal(sinceMsFor('today', NOW), midnight.getTime());
  assert.equal(sinceMsFor('7days', NOW), NOW - 7 * 86400000);
  assert.equal(sinceMsFor('all', NOW), undefined);
});

test('deriveSessions dedupes by sessionId and keeps names', () => {
  const list = deriveSessions(items);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.sessionName), ['Alpha', 'Beta']);
});

test('filterArtifacts combines type / session / time and never inspects body', () => {
  assert.equal(filterArtifacts(items, { type: '', sessionId: '', time: 'all' }, NOW).length, 3);
  assert.deepEqual(
    filterArtifacts(items, { type: 'chart', sessionId: 's1', time: 'all' }, NOW).map((x) => x.id),
    [1],
  );
  // Only today's image survives (chart is 1s before midnight? both today here —
  // use 7days to exclude the 9-day-old markdown).
  assert.deepEqual(
    filterArtifacts(items, { type: '', sessionId: '', time: '7days' }, NOW).map((x) => x.id),
    [1, 3],
  );
});

test('exportPayloadFor picks text / csv / base64 encodings by type', () => {
  assert.deepEqual(
    exportPayloadFor(artifact('m', 'markdown', 's1', { content: '# Hi' }, 'Notes')),
    { defaultName: 'Notes.md', data: '# Hi', encoding: 'text' },
  );
  assert.deepEqual(
    exportPayloadFor(artifact('h', 'html', 's1', '<b>x</b>', 'Page')),
    { defaultName: 'Page.html', data: '<b>x</b>', encoding: 'text' },
  );
  const img = exportPayloadFor(artifact('i', 'image', 's1', { data: 'aGVsbG8=', mime: 'image/png' }, 'Shot'));
  assert.equal(img.encoding, 'base64');
  assert.equal(img.defaultName, 'Shot.png');
  assert.equal(exportPayloadFor(artifact('c', 'chart', 's1', { spec: {} }, 'C')), null);
});

// ── inline renderers (happy-dom) ─────────────────────────────────────────────

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
const saves = [];
win.nexusDesktop = {
  saveArtifact: (name, data, encoding) => {
    saves.push({ name, data, encoding });
    return Promise.resolve({ ok: true, path: `C:\\out\\${name}` });
  },
  revealFile: () => Promise.resolve(),
};

const {
  tryMountArtifact, textArtifactPayload, imageArtifactPayload,
  mountMarkdownView, mountHtmlView, mountImageView,
} = await import(pathToFileURL(join(dist, 'renderer', 'artifacts', 'artifact-view.js')).href);
const { t } = await import(pathToFileURL(join(dist, 'renderer', 'i18n.js')).href);

after(() => win.close());

const tick = () => new Promise((r) => setTimeout(r, 0));

test('payload helpers accept bare strings, objects and data URLs', () => {
  assert.deepEqual(textArtifactPayload(artifact('m', 'markdown', 's1', '# Hi', 'M'), 'markdown'),
    { text: '# Hi', ext: 'md' });
  assert.deepEqual(textArtifactPayload(artifact('h', 'html', 's1', { html: '<p>x</p>' }, 'H'), 'html'),
    { text: '<p>x</p>', ext: 'html' });
  const img = imageArtifactPayload(
    artifact('i', 'image', 's1', { data: 'data:image/jpeg;base64,aGVsbG8=' }, 'I'),
  );
  assert.equal(img.mime, 'image/jpeg');
  assert.equal(img.ext, 'jpg');
  assert.equal(img.base64, 'aGVsbG8=');
  assert.equal(imageArtifactPayload(artifact('x', 'image', 's1', 'not base64!', 'X')), null);
});

test('markdown / html / image dispatch to their dedicated views', async () => {
  const md = tryMountArtifact(toArtifactContent(
    artifact('m', 'markdown', 's1', { content: '# Heading\ntext' }, 'MD'),
  ));
  assert.ok(md.querySelector('.artifact-markdown'), 'markdown view, not <pre>');
  assert.match(md.querySelector('.artifact-markdown').innerHTML, /Heading/);
  assert.equal(md.querySelector('.artifact-json'), null);

  const html = tryMountArtifact(toArtifactContent(
    artifact('h', 'html', 's1', { html: '<h1>Page</h1>' }, 'HTML'),
  ));
  const frame = html.querySelector('iframe.artifact-html-frame');
  assert.ok(frame, 'html sandbox iframe');
  assert.equal(frame.getAttribute('sandbox'), '', 'fully sandboxed (no scripts / same-origin)');
  assert.match(frame.srcdoc, /Page/);

  const image = tryMountArtifact(toArtifactContent(
    artifact('i', 'image', 's1', { data: 'aGVsbG8=', mime: 'image/png' }, 'IMG'),
  ));
  assert.ok(image.querySelector('img.artifact-image'), 'image thumbnail');
  assert.match(image.querySelector('img.artifact-image').src, /^data:image\/png;base64,/);

  // All three export via saveArtifact with the right encoding.
  assert.equal(md.querySelectorAll('button.artifact-action').length, 1);
  md.querySelector('button.artifact-action').click();
  await tick();
  assert.deepEqual(saves.at(-1), { name: 'MD.md', data: '# Heading\ntext', encoding: 'text' });

  image.querySelector('button.artifact-action').click();
  await tick();
  assert.deepEqual(saves.at(-1), { name: 'IMG.png', data: 'aGVsbG8=', encoding: 'base64' });
});

test('mount helpers render even when called directly (pure dispatch)', () => {
  const host = win.document.createElement('div');
  mountMarkdownView(host, artifact('m', 'markdown', 's1', '**bold**', 'M'));
  assert.ok(host.querySelector('.artifact-markdown'));
  const host2 = win.document.createElement('div');
  mountHtmlView(host2, artifact('h', 'html', 's1', '<i>x</i>', 'H'));
  assert.ok(host2.querySelector('iframe'));
  const host3 = win.document.createElement('div');
  mountImageView(host3, artifact('bad', 'image', 's1', '!!!not base64!!!', 'B'));
  assert.equal(host3.querySelector('.artifact-error-text').textContent, t('artifactImageUnavailable'));
});
