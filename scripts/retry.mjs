/**
 * Wrap a command with exponential backoff + auto-retry for transient network
 * failures (504/502/503, ECONNRESET, ETIMEDOUT, DNS blips) that would
 * otherwise sink an entire CI job when electron-builder's toolchain downloads
 * hit a flaky gateway.
 *
 * Usage (CI, run steps with `shell: bash` so `sh -c` is available):
 *   node scripts/retry.mjs --attempts 3 --delay 15 -- sh -c "npx electron-builder --win nsis --publish never"
 *
 * Retry policy:
 *   - a zero exit code stops immediately.
 *   - a non-zero exit is retried ONLY when its output matches the transient
 *     error class (RETRYABLE below); a real build error fails fast instead of
 *     burning 3× the job time.
 *   - backoff is exponential: delay, 2*delay, 4*delay …
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const attemptsIdx = args.indexOf('--attempts');
const delayIdx = args.indexOf('--delay');
const attempts = attemptsIdx !== -1 ? Number(args[attemptsIdx + 1]) : 3;
const delaySec = delayIdx !== -1 ? Number(args[delayIdx + 1]) : 15;
const sep = args.indexOf('--');
if (sep === -1 || sep === args.length - 1) {
  console.error('retry.mjs: expected `--attempts N --delay S -- <cmd...>`');
  process.exit(2);
}
const cmd = args.slice(sep + 1);

const RETRYABLE =
  /gateway|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|504|502|503|socket hang up|network socket/i;

function runOnce() {
  return new Promise((resolve) => {
    // CI runs this with `shell: bash`, so `sh` exists on every runner image
    // that matters (the linux job is bash-native; mac ships /bin/sh).
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (err += String(c)));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function isTransient(code, out, err) {
  return code !== 0 && RETRYABLE.test(out + '\n' + err);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last;
for (let attempt = 1; attempt <= attempts; attempt++) {
  last = await runOnce();
  if (!isTransient(last.code, last.out, last.err)) {
    if (last.out) process.stdout.write(last.out);
    if (last.err) process.stderr.write(last.err);
    process.exit(last.code === 0 ? 0 : 1);
  }
  const waitMs = delaySec * 1000 * 2 ** (attempt - 1);
  process.stderr.write(
    `\n[retry] attempt ${attempt}/${attempts} hit a transient error (exit ${last.code}); retrying in ${waitMs / 1000}s…\n`,
  );
  process.stderr.write(last.err.slice(-3000) + '\n');
  if (attempt < attempts) await sleep(waitMs);
}
if (last.out) process.stdout.write(last.out);
if (last.err) process.stderr.write(last.err);
process.exit(1);
