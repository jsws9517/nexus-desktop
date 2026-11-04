/**
 * Launch smoke test for the packaged macOS app.
 *
 * Runs the real `nexus.app` binary with an isolated HOME (no network-dependent
 * side effects, no ~/.nexus pollution of the CI user) and verifies from the
 * app's own log file that it booted far enough to bring up the core worker.
 *
 * This is the strongest "no Mac on the desk" signal: it proves
 *   Electron starts → asar loads → better-sqlite3 actually opens → worker up.
 *
 * Success signal: the app's info log contains either
 *   - "Nexus core initialized" (worker full init complete), or
 *   - "Core ready" (main-process init gate passed).
 * Both prove the core worker came up and SQLite opened.
 *
 * Usage: node scripts/smoke-launch-mac.mjs [--arch arm64|x64] [--timeout-ms 90000]
 *
 * Exit code 0 = core-ready signal observed within the timeout; 1 otherwise.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const archIdx = argv.indexOf('--arch');
const arch = archIdx >= 0 ? argv[archIdx + 1] : 'arm64';
const timeoutIdx = argv.indexOf('--timeout-ms');
const timeoutMs = timeoutIdx >= 0 ? Number(argv[timeoutIdx + 1]) : 90_000;

const root = process.cwd();
const releaseDir = join(root, 'release');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * electron-builder writes the mac build to `release/mac-<arch>` when the target
 * arch is NOT the runner's default, and to `release/mac` when it IS. On the
 * arm64 runner used by CI (`macos-15`, arch=arm64), `--arm64` produces
 * `release/mac` *only when the runner is arm64* — but on an x64 runner it
 * would produce `release/mac-arm64`. Search both candidate directories.
 */
function findAppBundle(arch) {
  const candidates = [join(releaseDir, `mac-${arch}`, 'nexus.app'), join(releaseDir, 'mac', 'nexus.app')];
  for (const c of candidates) {
    if (existsSync(join(c, 'Contents', 'MacOS', 'nexus'))) return c;
  }
  return null;
}

function summarizeLines(files, needle) {
  let hits = 0;
  for (const f of files) {
    try {
      const text = readFileSync(f, 'utf8');
      hits += text.split(needle).length - 1;
    } catch {
      /* not written yet */
    }
  }
  return hits;
}

async function main() {
  const appBundle = findAppBundle(arch);
  if (!appBundle) {
    console.error(`[smoke-launch-mac] no .app found under release/ for arch=${arch}`);
    process.exit(1);
  }
  const bin = join(appBundle, 'Contents', 'MacOS', 'nexus');

  const home = mkdtempSync(join(tmpdir(), 'nexus-mac-smoke-'));
  console.log(`[smoke-launch-mac] isolated HOME at ${home}`);
  const logDir = join(home, '.nexus', 'logs');

  const env = {
    // The packaged app's worker spawns `node` (system-Node) to run the core.
    // A GUI-launched app on macOS gets a restricted PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin), so node/npm/homebrew CLIs are
    // unreachable — the smoke test needs them, so inherit the CI runner's
    // full PATH (homebrew prefix + node) plus the app's own env.
    ...process.env,
    HOME: home,
    NEXUS_CONFIG_DIR: join(home, '.nexus'),
    NEXUS_DISABLE_AUTO_UPDATE: '1',
    NEXUS_DISABLE_CORE_UPDATE: '1',
    // Isolated HOME means no user config, so the default anthropic provider
    // has no API key and core init refuses to start ("No usable API key").
    // The smoke test only proves boot + native module load + sessions.db
    // creation, so a placeholder key is sufficient — no network call is
    // made at this stage.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'ci-placeholder-key',
  };
  // No GUI on a headless CI session: headless mode keeps the smoke meaningful
  // (Electron still runs the full main-process lifecycle: window creation,
  // worker spawn, SQLite open) while not needing a windowserver.
  const child = spawn(bin, ['--no-sandbox'], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += String(d);
  });
  child.stderr.on('data', (d) => {
    err += String(d);
  });
  child.on('exit', (code) => {
    console.log(`[smoke-launch-mac] app exited early with code ${code}`);
    if (out.trim()) console.log(out.trim());
    if (err.trim()) console.error(err.trim());
  });

  const day = new Date().toISOString().slice(0, 10);
  const infoLog = join(logDir, `${day}.info.log`);
  const errLog = join(logDir, `${day}.error.log`);
  // "Nexus core initialized" (worker full init) or "Core ready" (main-process
  // init gate) — either proves the core worker booted and SQLite opened.
  const readyRe = /Nexus core (initialized|ready|ready for reads)|Core ready/;

  const t0 = Date.now();
  let sawCoreReady = false;
  let lastErrLogTail = '';
  while (Date.now() - t0 < timeoutMs) {
    await sleep(1000);
    if (existsSync(infoLog) && readyRe.test(readFileSync(infoLog, 'utf8'))) {
      sawCoreReady = true;
      break;
    }
    if (existsSync(errLog)) {
      const tail = readFileSync(errLog, 'utf8').slice(-800);
      if (tail !== lastErrLogTail) {
        lastErrLogTail = tail;
        console.log(`[smoke-launch-mac] error.log tail:\n${tail}`);
      }
    }
    if (child.exitCode !== null) {
      console.error(`[smoke-launch-mac] app exited code=${child.exitCode} before core ready`);
      if (err.trim()) console.error(err.trim());
      break;
    }
  }

  // Tear down the app and any leftover children.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  spawnSync('pkill', ['-f', 'nexus.app'], { stdio: 'ignore' });

  // Give the worker a moment to create sessions.db before checking.
  if (sawCoreReady) await sleep(2000);

  let dbOk = false;
  if (sawCoreReady) {
    dbOk = existsSync(join(home, '.nexus', 'sessions.db'));
  }

  let pass = sawCoreReady && dbOk;
  console.log(
    `[smoke-launch-mac] ${pass ? 'PASS' : 'FAIL'} — core ready: ${sawCoreReady}, sessions.db created: ${dbOk}, waited ${Math.round((Date.now() - t0) / 1000)}s`,
  );

  // Diagnostics on failure: dump the log tree.
  if (!pass && existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      const p = join(logDir, f);
      try {
        console.log(`--- ${f} ---\n${readFileSync(p, 'utf8').slice(-2000)}`);
      } catch {
        /* ignore */
      }
    }
  }
  if (out.trim()) console.log(`--- app stdout ---\n${out.trim()}`);
  if (err.trim()) console.error(`--- app stderr ---\n${err.trim()}`);

  rmSync(home, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

await main();
