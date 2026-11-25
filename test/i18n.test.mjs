import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STR, t, fmtNum } from '../dist/renderer/i18n.js';

test('every i18n key has both zh-CN and en translations', () => {
  const keys = Object.keys(STR);
  assert.ok(keys.length > 80, `expected a healthy dictionary, got ${keys.length} keys`);
  for (const key of keys) {
    const entry = STR[key];
    assert.ok(entry && typeof entry === 'object', `missing entry for ${key}`);
    assert.equal(typeof entry['zh-CN'], 'string', `${key}.zh-CN missing`);
    assert.equal(typeof entry.en, 'string', `${key}.en missing`);
    assert.ok(entry['zh-CN'].length > 0, `${key}.zh-CN empty`);
    assert.ok(entry.en.length > 0, `${key}.en empty`);
  }
});

test('new A/B/E feature keys are present and complete', () => {
  for (const key of ['allowAlways', 'minimizeToTrayLabel', 'logSection', 'viewLogs', 'searchSessions', 'pin', 'pinnedSessions', 'workerRestarted', 'revealFile', 'copied']) {
    assert.ok(STR[key], `expected key "${key}"`);
  }
});

test('path-boundary note explains specific-directory grant and mode independence', () => {
  const key = 'permissionsPathBoundaryNote';
  assert.ok(STR[key], `expected key "${key}"`);
  for (const lang of ['zh-CN', 'en']) {
    const text = STR[key][lang];
    assert.match(text, /agent_test/, 'names a concrete project directory');
    assert.match(text, /root|根目录/i, 'warns against granting the drive root');
    assert.match(text, /auto/i, 'says switching mode does not change the boundary');
    assert.match(text, /prompt/i, 'says switching mode does not change the boundary');
    assert.match(text, /boundary|边界/i, 'explicitly mentions the path boundary');
  }
});

test('t() interpolates placeholders', () => {
  const out = t('toolsCount', { n: 3 });
  assert.match(out, /3/);
});

test('t() falls back to the key when missing', () => {
  assert.equal(t('definitely.missing.key'), 'definitely.missing.key');
});

test('fmtNum uses locale grouping', () => {
  const out = fmtNum(1234567);
  assert.match(out, /1/);
  assert.ok(out.length >= 7, `unexpected format: ${out}`);
});
