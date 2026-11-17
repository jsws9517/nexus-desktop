/**
 * Real-filesystem verification for session 47f9e6c7 problem ④ (directory drift
 * + silent permission swallow). No string assertions about intent: a real core
 * Agent with a real session relocates its project, and we check real path
 * authorization + real file writes + real sentinel freeze state.
 *
 * Run: node --test test/directory-drift-real-fs.test.mjs
 */
import './sandbox-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreDist = join(__dirname, '..', 'node_modules', 'nexus-coder', 'dist', 'src');
const deskDist = join(__dirname, '..', 'dist');

const { Agent } = await import(pathToFileURL(join(coreDist, 'agent.js')).href);
const pa = await import(pathToFileURL(join(coreDist, 'security', 'path-authorizer.js')).href);
const { SecuritySentinel } = await import(
  pathToFileURL(join(deskDist, 'agent', 'security-sentinel.js')).href
);

test('problem 4: setProjectLocation reauthorizes root and rebase prevents fs_write freeze', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nexus-drift-real-'));
  const A = join(tmp, 'A');
  const B = join(tmp, 'B');
  const C = join(tmp, 'C');
  for (const d of [A, B, C]) mkdirSync(d, { recursive: true });

  // Prompter that records + denies, so any unexpected prompt is observable.
  const prompts = [];
  pa.setPermissionPrompter(async (q) => { prompts.push(q); return 'n'; }, () => true);

  let agent;
  try {
    agent = new Agent();
    const events = [];
    agent.onEvent = (e) => events.push(e);
    await agent.init();
    const sess = agent.session.create('drift-session', 'mock', 'mock-model', { projectDir: A });
    agent.currentSessionId = sess.id;

    // Original root A is authorized explicitly; no prompt.
    pa.grantProjectRoot(A);
    assert.equal(await pa.authorizePath(join(A, 'seed.docx')), true, 'A must be authorized');
    assert.equal(prompts.length, 0, 'A must not prompt');

    // Real Agent.setProjectLocation(B): grants B + emits projectLocationChanged.
    const msg = agent.setProjectLocation(B, { projectDir: B });
    assert.ok(msg.includes(B), `success text must use effectiveDir, got: ${msg}`);
    const locEvt = events.find((e) => e.type === 'projectLocationChanged');
    assert.ok(locEvt, 'projectLocationChanged must be emitted');
    assert.equal(locEvt.projectDir, B);
    assert.equal(locEvt.previousDir, A);

    // B is now in-root: no prompt, and a real write succeeds.
    const beforeB = prompts.length;
    assert.equal(await pa.authorizePath(join(B, 'x.docx')), true, 'B must be authorized after drift');
    assert.equal(prompts.length, beforeB, 'B must not prompt');
    writeFileSync(join(B, 'x.docx'), 'real bytes');
    assert.ok(existsSync(join(B, 'x.docx')), 'real file must exist under B');

    // Reverse: unrelated dir C must NOT be auto-granted by the relocation.
    const beforeC = prompts.length;
    assert.equal(await pa.authorizePath(join(C, 'secret.docx')), false, 'C must be denied');
    assert.ok(prompts.length > beforeC, 'C must have prompted (proves no silent auto-grant)');

    // Sentinel: WITHOUT rebase, repeated writes into B freeze fs_write.
    const stale = new SecuritySentinel({ root: A, probeCountToFreeze: 2, immutablePaths: [], networkAllowlist: [] });
    for (let i = 0; i < 2; i += 1) {
      stale.evaluate({ tool: 'write_file', args: { path: join(B, `stale${i}.docx`) } });
    }
    assert.equal(stale.isFrozen('fs_write'), true, 'stale root must freeze fs_write (control case)');

    // WITH rebase (what the projectLocationChanged handler does), two writes
    // into B are in-root and must NOT freeze.
    const live = new SecuritySentinel({ root: A, probeCountToFreeze: 2, immutablePaths: [], networkAllowlist: [] });
    live.setRoot(B);
    for (let i = 0; i < 2; i += 1) {
      live.evaluate({ tool: 'write_file', args: { path: join(B, `ok${i}.docx`) } });
    }
    assert.equal(live.rootDir, B, 'sentinel root must be rebased');
    assert.equal(live.isFrozen('fs_write'), false, 'rebased root must not freeze fs_write');
  } finally {
    try { await agent?.shutdown?.(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  }
});
