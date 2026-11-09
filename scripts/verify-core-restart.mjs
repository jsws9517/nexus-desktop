#!/usr/bin/env node
/**
 * Local, no-packaging verification of the "core restart leaves the UI frozen"
 * regression.
 *
 * What it does (all on the repo build in `dist/`, no installer, no upload):
 *   1. starts `electron .` with the Chrome DevTools protocol enabled;
 *   2. opens a non-empty session as a tab (the same `openSession` + `switchTab`
 *      path the UI uses) and asserts its transcript renders;
 *   3. kills the GLOBAL core worker process — the same crash/hot-restart path
 *      an overlay upgrade takes (`restartWorker()` → `sessionWorkers.restartAll()`);
 *   4. asserts that after the restart:
 *        - `getMessages` settles instead of hanging forever (this is the bug:
 *          IPC used to be pinned to the stopped WorkerHost);
 *        - the active tab re-renders and the composer is not stuck "running".
 *
 * Run: npm run verify:restart
 * Exit code 0 = pass, 1 = fail (with the phase that failed).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.cwd();
const PORT = Number(process.env.NEXUS_VERIFY_CDP_PORT || 9333 + Math.floor(Math.random() * 400));
const T0 = Date.now();
const log = (...a) => console.log(`[verify +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

const electronBin =
  process.platform === 'win32'
    ? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(ROOT, 'node_modules', '.bin', 'electron');

if (!existsSync(join(ROOT, 'dist', 'main', 'index.js'))) {
  console.error('[verify] dist/main/index.js missing — run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(electronBin)) {
  console.error(`[verify] electron binary not found at ${electronBin} — run npm install.`);
  process.exit(1);
}

// ---------------------------------------------------------------- CDP client
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true });
  });
  ws.addEventListener('close', (ev) => {
    closed = true;
    log(`CDP socket closed (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ''})`);
    for (const [, p] of pending) p.reject(new Error('CDP socket closed'));
    pending.clear();
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
    else resolve(msg.result);
  });
  return {
    send(method, params) {
      if (closed) return Promise.reject(new Error('CDP socket closed'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

/** Evaluate an async expression in the renderer. A hung promise returns {timeout}. */
async function evaluate(cdp, expression, timeoutMs = 8000) {
  const running = cdp
    .send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    .then((res) => {
      if (res.exceptionDetails) {
        return {
          error:
            res.exceptionDetails.exception?.description ||
            res.exceptionDetails.text ||
            'renderer exception',
        };
      }
      return { value: res.result?.value };
    });
  const winner = await Promise.race([
    running.catch((err) => ({ error: err.message })),
    sleep(timeoutMs).then(() => ({ timeout: true, ms: timeoutMs })),
  ]);
  return winner;
}

async function waitForPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === 'page' && /\/index\.html(?:[?#]|$)/.test(String(t.url)),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* devtools endpoint not up yet */
    }
    await sleep(500);
  }
  throw new Error(`no renderer page target on CDP port ${PORT} within ${timeoutMs}ms`);
}

// ------------------------------------------------------------- OS helpers
function coreWorkerPids() {
  if (process.platform !== 'win32') {
    const out = execFileSync('ps', ['-eo', 'pid=,etimes=,args='], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('agent-worker.js'))
      .map((line) => {
        const [pid, etimes] = line.split(/\s+/);
        return { pid: Number(pid), ageSec: Number(etimes) };
      })
      .sort((a, b) => b.ageSec - a.ageSec); // oldest first
  }
  const script = [
    "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
    "  Where-Object { $_.CommandLine -like '*agent-worker.js*' } |",
    '  Sort-Object CreationDate |',
    '  Select-Object ProcessId, CreationDate;',
    '$p | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToString(\'o\'))" }',
  ].join(' ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim();
  if (!out) return [];
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, created] = line.split('|');
      return { pid: Number(pid), created: String(created) };
    });
}

function killPid(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

function todayInfoLog() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
  return join(homedir(), '.nexus', 'logs', `${ymd}.info.log`);
}

function logHasLineSince(path, sinceMs, needle) {
  try {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    // Rotation can move the old file aside; mtime is the reliable signal that
    // the line was written after the kill.
    if (st.mtimeMs < sinceMs) return false;
    return readFileSync(path).toString('utf8').includes(needle);
  } catch {
    return false;
  }
}

/** Offset-based variant: the file may have been rotated between polls; a fresh
 *  base file is smaller than `offset`, in which case the whole file is scanned. */
function logHasLineAfter(path, offset, needle) {
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path);
    return raw.subarray(Math.min(offset, raw.length)).toString('utf8').includes(needle);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- driver
let child = null;
let cdp = null;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
};

try {
  log(`starting electron from ${ROOT}`);
  child = spawn(electronBin, [`--remote-debugging-port=${PORT}`, '.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEXUS_DISABLE_AUTO_UPDATE: '1',
      NEXUS_DISABLE_CORE_UPDATE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderrTail = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      stderrTail.push(line.trim());
      if (stderrTail.length > 40) stderrTail.shift();
    }
  });
  let earlyExit = null;
  child.on('exit', (code) => {
    earlyExit = code;
  });

  const page = await waitForPageTarget(120_000);
  log(`renderer target: ${page.url}`);
  cdp = await connectCdp(page.webSocketDebuggerUrl);

  // Wait for the renderer API + the main process to accept session reads.
  let ready = null;
  for (let i = 0; i < 120; i++) {
    if (earlyExit !== null) {
      throw new Error(
        `electron exited early (code=${earlyExit}) — is the app already running?\n${stderrTail.join('\n')}`,
      );
    }
    const r = await evaluate(
      cdp,
      `(async () => {
        if (document.readyState !== 'complete' || !window.nexusDesktop) return { ready: false };
        try {
          const res = await window.nexusDesktop.listSessions({ limit: 5, offset: 0, excludeMock: true, excludeEmpty: true });
          return { ready: true, total: res.items?.length ?? 0 };
        } catch (err) {
          return { ready: false, err: String(err && err.message || err) };
        }
      })()`,
      6000,
    );
    if (r.value?.ready) {
      ready = r.value;
      break;
    }
    await sleep(1000);
  }
  if (!ready) throw new Error('renderer never became ready');
  log(`renderer ready (${ready.total} non-empty session(s) visible)`);

  // Pick a non-empty session and open it exactly like the UI does.
  const pick = await evaluate(
    cdp,
    `(async () => {
      const res = await window.nexusDesktop.listSessions({ limit: 20, offset: 0, excludeMock: true, excludeEmpty: true });
      const first = (res.items || [])[0];
      return first ? { id: first.id, name: first.name || '' } : null;
    })()`,
    10_000,
  );
  if (!pick.value?.id) throw new Error('no non-empty session found to open');
  const sid = pick.value.id;
  log(`test session: ${sid.slice(0, 12)} (${pick.value.name})`);

  const opened = await evaluate(
    cdp,
    `(async () => {
      const res = await window.nexusDesktop.openSession(${JSON.stringify(sid)});
      return res;
    })()`,
    30_000,
  );
  check('openSession resolves', !opened.timeout && !opened.error, JSON.stringify(opened.value ?? opened.error ?? 'timeout'));
  await sleep(1200);

  // Select the tab the same way a user click does, then wait for the transcript.
  const selected = await evaluate(
    cdp,
    `(async () => {
      const chips = [...document.querySelectorAll('#tab-bar .tab')];
      const chip = chips[chips.length - 1];
      if (!chip) return { chips: 0 };
      chip.click();
      await new Promise((r) => setTimeout(r, 2500));
      return {
        chips: chips.length,
        messages: document.querySelector('#messages')?.children.length ?? 0,
        stopHidden: document.querySelector('#btn-stop')?.classList.contains('hidden') ?? null,
        inputDisabled: document.querySelector('#input')?.disabled ?? null,
      };
    })()`,
    15_000,
  );
  const before = selected.value ?? {};
  check('tab opens and transcript renders', before.messages > 0, `messages=${before.messages}`);
  check('composer idle before restart', before.stopHidden !== false, `stopHidden=${before.stopHidden}`);

  const baseline = await evaluate(
    cdp,
    `(async () => {
      const t0 = performance.now();
      const res = await window.nexusDesktop.getMessages(${JSON.stringify(sid)}, { last: 20 });
      return { ms: Math.round(performance.now() - t0), items: res.items?.length ?? 0 };
    })()`,
    10_000,
  );
  check(
    'baseline getMessages resolves',
    !baseline.timeout && !baseline.error,
    baseline.timeout ? 'timed out' : `${baseline.value?.ms}ms, ${baseline.value?.items} rows`,
  );

  // A session that is NOT open as a tab: its reads must go through the GLOBAL
  // worker (callForSession fallback). This is the path the renderer's boot
  // sequence takes (`getStatus`, `getProviders`, …) — the one that used to be
  // pinned to the stopped WorkerHost and froze the whole boot.
  const otherSidPick = await evaluate(
    cdp,
    `(async () => {
      const open = new Set(((await window.nexusDesktop.getOpenTabs()) || []).map((t) => t.sessionId));
      const res = await window.nexusDesktop.listSessions({ limit: 50, offset: 0, excludeMock: true });
      const other = (res.items || []).find((s) => !open.has(s.id) && s.id !== ${JSON.stringify(sid)});
      return other ? other.id : '00000000-0000-4000-8000-000000000000';
    })()`,
    10_000,
  );
  const otherSid = otherSidPick.value || '00000000-0000-4000-8000-000000000000';
  log(`global-worker probe session (no tab): ${String(otherSid).slice(0, 12)}`);

  const baselineStatus = await evaluate(
    cdp,
    `(async () => {
      const t0 = performance.now();
      const s = await window.nexusDesktop.getStatus();
      return { ms: Math.round(performance.now() - t0), cwd: s.cwd };
    })()`,
    15_000,
  );
  check(
    'baseline global getStatus resolves',
    !baselineStatus.timeout && !baselineStatus.error,
    baselineStatus.timeout ? 'timed out' : `${baselineStatus.value?.ms}ms`,
  );

  // Kill the GLOBAL worker: in dev it is the oldest `node agent-worker.js`
  // child (the app spawns it before any per-tab worker or spare).
  const pids = coreWorkerPids();
  if (pids.length === 0) throw new Error('no agent-worker process found — is the core worker running?');
  const victim = pids[0];
  log(
    `killing global core worker pid=${victim.pid} (${pids.length} worker process(es) alive)`,
  );
  for (const p of pids) log(`  worker pid=${p.pid} created=${p.created}${p === victim ? '  <== kill' : ''}`);

  const infoLog = todayInfoLog();
  let logOffset = 0;
  try {
    logOffset = existsSync(infoLog) ? statSync(infoLog).size : 0;
  } catch {}
  killPid(victim.pid);
  const killedAt = Date.now();
  log(`info log: ${infoLog} (checking from offset ${logOffset})`);

  // Probe IMMEDIATELY, before waiting for the restart to finish. These are the
  // two calls that used to hang forever: both are served by the GLOBAL worker,
  // and with the old code the IPC closure held the WorkerHost captured at
  // startup — i.e. the process that was just killed.
  const postStatus = await evaluate(
    cdp,
    `(async () => {
      const t0 = performance.now();
      const s = await window.nexusDesktop.getStatus();
      return { ms: Math.round(performance.now() - t0), cwd: s.cwd };
    })()`,
    30_000,
  );
  check(
    'post-restart global getStatus settles (boot path)',
    !postStatus.timeout && !postStatus.error,
    postStatus.timeout
      ? `hung >${postStatus.ms}ms`
      : postStatus.error
        ? postStatus.error
        : `${postStatus.value?.ms}ms`,
  );
  if (postStatus.timeout) {
    const diag = await evaluate(
      cdp,
      `({ readyState: document.readyState, hasApi: !!window.nexusDesktop, tabs: document.querySelectorAll('#tab-bar .tab').length, body: document.body.textContent.slice(0, 80) })`,
      5000,
    );
    log('renderer diagnostics after timeout:', JSON.stringify(diag.value ?? diag));
  }

  const postOther = await evaluate(
    cdp,
    `(async () => {
      const t0 = performance.now();
      const res = await window.nexusDesktop.getMessages(${JSON.stringify(otherSid)}, { last: 5 });
      return { ms: Math.round(performance.now() - t0), items: res.items?.length ?? 0 };
    })()`,
    30_000,
  );
  check(
    'post-restart getMessages for a tabless session settles',
    !postOther.timeout && !postOther.error,
    postOther.timeout
      ? `hung >${postOther.ms}ms`
      : postOther.error
        ? postOther.error
        : `${postOther.value?.ms}ms, ${postOther.value?.items} rows`,
  );

  // Wait for the main process to report a clean restart (up to 60s).
  let restarted = false;
  while (Date.now() - killedAt < 60_000) {
    if (logHasLineAfter(infoLog, logOffset, 'core worker restarted cleanly')) {
      restarted = true;
      break;
    }
    await sleep(500);
  }
  check('main process reports a clean worker restart', restarted, `${Date.now() - killedAt}ms after kill`);

  // THE regression probe: after the restart, IPC must settle again. With the
  // bug, every call below hangs until the per-call timeout (the UI stays blank).
  let firstOk = null;
  let timeouts = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probe = await evaluate(
      cdp,
      `(async () => {
        const t0 = performance.now();
        const res = await window.nexusDesktop.getMessages(${JSON.stringify(sid)}, { last: 20 });
        return { ms: Math.round(performance.now() - t0), items: res.items?.length ?? 0 };
      })()`,
      8000,
    );
    if (probe.timeout) {
      timeouts++;
      log(`  post-restart getMessages hung (>8s), retrying… (${timeouts})`);
      await sleep(500);
      continue;
    }
    if (probe.error) {
      log(`  post-restart getMessages error: ${probe.error}`);
      await sleep(1000);
      continue;
    }
    firstOk = probe.value;
    break;
  }
  check(
    'post-restart getMessages settles (no permanent hang)',
    !!firstOk,
    firstOk ? `${firstOk.ms}ms, ${firstOk.items} rows, hung probes: ${timeouts}` : 'never settled',
  );

  // UI must be usable again: re-select the tab and re-render its transcript.
  await sleep(1500);
  const after = await evaluate(
    cdp,
    `(async () => {
      const chips = [...document.querySelectorAll('#tab-bar .tab')];
      const chip = chips[chips.length - 1];
      if (chip) chip.click();
      await new Promise((r) => setTimeout(r, 3000));
      return {
        chips: chips.length,
        messages: document.querySelector('#messages')?.children.length ?? 0,
        stopHidden: document.querySelector('#btn-stop')?.classList.contains('hidden') ?? null,
        sendHidden: document.querySelector('#btn-send')?.classList.contains('hidden') ?? null,
        inputDisabled: document.querySelector('#input')?.disabled ?? null,
        statusText: document.querySelector('#input-status')?.textContent ?? '',
      };
    })()`,
    15_000,
  );
  const ui = after.value ?? {};
  check('tab still present after restart', ui.chips > 0, `chips=${ui.chips}`);
  check('transcript renders after restart', ui.messages > 0, `messages=${ui.messages}`);
  check('composer not stuck running', ui.stopHidden !== false, `stopHidden=${ui.stopHidden}`);
  check('input enabled after restart', ui.inputDisabled === false, `inputDisabled=${ui.inputDisabled}`);

  if (failures.length > 0) {
    if (stderrTail.length > 0) log('app stderr (tail):\n' + stderrTail.join('\n'));
    log(`RESULT: FAIL (${failures.join(', ')})`);
    process.exitCode = 1;
  } else {
    log('RESULT: PASS — core restart keeps IPC + the transcript alive');
  }
} catch (err) {
  console.error('[verify] ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch {}
  if (child && child.pid) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {}
  }
}
