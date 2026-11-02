import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installStderrNoiseFilter } from '../dist/shared/stderr-noise.js';

/**
 * The filter wraps `process.stderr.write`, binding the *current* write as its
 * forward target. To observe what it forwards without printing to the real
 * terminal, install a spy as `process.stderr.write` BEFORE calling
 * `installStderrNoiseFilter()`; the filter then forwards non-noise lines to
 * the spy, which we assert on.
 *
 * `installed` is a module-level latch, so the TTY case (which actually wraps)
 * must run only once across the whole file. The non-TTY no-op case does not
 * latch, so it can run first and be retried.
 */

test('non-TTY: install is a no-op, stderr.write stays the original', () => {
  const before = process.stderr.write;
  const savedTTY = process.stderr.isTTY;
  try {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    installStderrNoiseFilter();
    assert.equal(process.stderr.write, before, 'piped stderr must be left untouched');
  } finally {
    Object.defineProperty(process.stderr, 'isTTY', { value: savedTTY, configurable: true });
  }
});

test('TTY: noise lines swallowed, useful + unrelated lines forwarded (single install)', () => {
  const realWrite = process.stderr.write;
  const savedTTY = process.stderr.isTTY;
  const forwarded = [];
  const spy = (chunk) => {
    forwarded.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  try {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    // Spy becomes the filter's forward target; the wrapped write is installed
    // on top of it.
    process.stderr.write = spy;
    installStderrNoiseFilter();

    // These now go through the wrapped write, which forwards only non-noise.
    process.stderr.write(
      'noise: ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.\n',
    );
    process.stderr.write('noise: GLib-GObject: gobject/gsignal.c: instance has no handler with id 8452\n');
    process.stderr.write('real: app started ok\n');
    process.stderr.write('noise: ContextResult::kTransientFailure: again\n');
    // A bare GLib-GObject line that is NOT the gsignal notice must pass through.
    process.stderr.write('GLib-GObject: some other genuinely useful message\n');

    const out = forwarded.join('');
    assert.equal(
      out,
      'real: app started ok\nGLib-GObject: some other genuinely useful message\n',
    );
  } finally {
    process.stderr.write = realWrite;
    Object.defineProperty(process.stderr, 'isTTY', { value: savedTTY, configurable: true });
  }
});
