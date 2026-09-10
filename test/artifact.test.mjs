import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const {
  ARTIFACT_VERSION,
  validateArtifact,
  isArtifact,
  toArtifactContent,
  parseArtifactContent,
} = await import(pathToFileURL(join(dist, 'shared', 'artifact.js')));

const baseArtifact = {
  id: 'a-1',
  type: 'sheet',
  title: 'Sheet',
  version: 1,
  status: 'done',
  meta: { sessionId: 's-1', skill: 'sheet.read', origin: 'main' },
  body: { columns: ['a'], rows: [[1]] },
};

test('validateArtifact accepts a well-formed artifact', () => {
  assert.equal(validateArtifact(baseArtifact), null);
  assert.equal(isArtifact(baseArtifact), true);
});

test('validateArtifact rejects bad fields', () => {
  assert.ok(validateArtifact(null));
  assert.ok(validateArtifact({ ...baseArtifact, id: '' }));
  assert.ok(validateArtifact({ ...baseArtifact, type: 'exe' }));
  assert.ok(validateArtifact({ ...baseArtifact, version: 0 }));
  assert.ok(validateArtifact({ ...baseArtifact, status: 'drafty' }));
  assert.ok(validateArtifact({ ...baseArtifact, meta: { sessionId: 's-1', skill: '', origin: 'main' } }));
  assert.ok(validateArtifact({ ...baseArtifact, meta: { sessionId: 's-1', skill: 'x', origin: 'root' } }));
  assert.ok(validateArtifact({ ...baseArtifact, refs: [{ kind: 'weird' }] }));
});

test('envelope round-trips through toArtifactContent / parseArtifactContent', () => {
  const raw = toArtifactContent(baseArtifact);
  const parsed = parseArtifactContent(raw);
  assert.deepEqual(parsed, baseArtifact);
});

test('parseArtifactContent returns null for non-artifact content', () => {
  assert.equal(parseArtifactContent(''), null);
  assert.equal(parseArtifactContent('plain text'), null);
  assert.equal(parseArtifactContent('{"foo":"bar"}'), null);
  assert.equal(parseArtifactContent('[]'), null);
  assert.equal(parseArtifactContent(JSON.stringify({ __artifactVersion: ARTIFACT_VERSION + 1, artifact: baseArtifact })), null);
  assert.equal(parseArtifactContent('{broken json'), null);
});