/**
 * H-2: background-job external notification dispatch.
 *
 * Verifies that the JobWatcher's onJobNotification hook fires on terminal
 * states (succeeded / failed / stalled) and that progress events do NOT
 * trigger it.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nexus-job-notify-'));
process.env.NEXUS_CONFIG_DIR = join(tmp, '.nexus');
process.env.LLMA_DATA_DIR = join(tmp, '.llm-agent');
process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used';
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const { JobWatcher } = await import('nexus-coder/dist/src/jobs/job-watcher.js');

/**
 * Minimal fake that mimics JobManager's EventEmitter surface
 * (on / once / emit('event', ...)).
 */
function makeFakeManager() {
  const listeners = [];
  return {
    on(event, cb) {
      if (event === 'event') listeners.push(cb);
      return this;
    },
    once() { return this; },
    emit(ev) {
      for (const cb of listeners) cb(ev);
    },
  };
}

describe('JobWatcher.onJobNotification (H-2)', () => {
  it('fires on completed/succeeded', async () => {
    const mgr = makeFakeManager();
    const calls = [];
    new JobWatcher({
      manager: mgr,
      emitOutOfBand: () => {},
      emitCompletedText: false,
      onJobNotification: (job, kind, summaryText) => {
        calls.push({ kind, summary: summaryText });
        return { jobId: job.id, kind, summary: summaryText };
      },
    });

    mgr.emit({
      type: 'completed',
      job: { id: 'j1', label: 'test', status: 'succeeded', exitCode: 0, logFile: '' },
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'succeeded');
  });

  it('fires on completed/failed', async () => {
    const mgr = makeFakeManager();
    const calls = [];
    new JobWatcher({
      manager: mgr,
      emitOutOfBand: () => {},
      emitCompletedText: false,
      onJobNotification: (job, kind, _text) => {
        calls.push({ kind });
        return { jobId: job.id, kind, summary: '' };
      },
    });

    mgr.emit({
      type: 'completed',
      job: { id: 'j5', label: 'fail', status: 'failed', exitCode: 1, logFile: '' },
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'failed');
  });

  it('fires on stalled', async () => {
    const mgr = makeFakeManager();
    const calls = [];
    new JobWatcher({
      manager: mgr,
      emitOutOfBand: () => {},
      emitCompletedText: false,
      onJobNotification: (job, kind, _text) => {
        calls.push({ kind });
        return { jobId: job.id, kind, summary: '' };
      },
    });

    mgr.emit({
      type: 'stalled',
      job: { id: 'j2', label: 'stall-test', status: 'running', logFile: '' },
      idleMs: 5000,
      tail: ['line1', 'line2'],
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'stalled');
  });

  it('does NOT fire on progress events', async () => {
    const mgr = makeFakeManager();
    const calls = [];
    new JobWatcher({
      manager: mgr,
      emitOutOfBand: () => {},
      emitCompletedText: false,
      onJobNotification: (job, kind, _text) => {
        calls.push(kind);
        return { jobId: job.id, kind, summary: '' };
      },
    });

    mgr.emit({
      type: 'progress',
      job: { id: 'j3', label: 'progress-test', status: 'running', logFile: '' },
      elapsedMs: 1000,
      logDeltaBytes: 100,
    });

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calls.length, 0, 'progress events must not trigger onJobNotification');
  });

  it('absent hook = pre-H-2 behaviour (no crash)', async () => {
    const mgr = makeFakeManager();
    new JobWatcher({
      manager: mgr,
      emitOutOfBand: () => {},
      emitCompletedText: false,
      // No onJobNotification — should just work without the hook.
    });

    mgr.emit({
      type: 'completed',
      job: { id: 'j4', label: 'no-hook', status: 'failed', exitCode: 1, logFile: '' },
    });

    await new Promise((r) => setTimeout(r, 10));
    // No assertion needed — the test passes if it didn't throw.
    assert.ok(true);
  });
});
