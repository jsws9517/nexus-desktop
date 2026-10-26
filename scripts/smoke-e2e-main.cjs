/**
 * Minimal Electron main for scenario4 of smoke-overlay-v2.mjs.
 * Forks the smoke-worker with overlay env and reports result to POC_RESULT_FILE.
 */
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.POC_ROOT;
const CORE_DIR = process.env.POC_CORE_DIR;
const APP_ROOT = process.env.POC_APP_ROOT;
const RESULT_FILE = process.env.POC_RESULT_FILE;
const WORKER_FILE = path.join(ROOT, 'scripts', 'smoke-worker.mjs');

app.whenReady().then(() => {
  const child = utilityProcess.fork(WORKER_FILE, [], {
    serviceName: 'smoke-worker',
    stdio: ['ignore', 'ignore', 'pipe'],
    execArgv: ['--max-old-space-size=512'],
    env: { ...process.env, NEXUS_OVERLAY_CORE_DIR: CORE_DIR, NEXUS_APP_ROOT: APP_ROOT },
  });
  let logs = '';
  let msgReceived = false;
  let msgData = {};

  child.stderr?.on('data', d => { logs += d.toString(); });
  child.on('message', m => {
    msgReceived = true;
    msgData = m;
    try { child.kill(); } catch {}
  });
  child.on('exit', code => {
    if (msgReceived) {
      fs.writeFileSync(RESULT_FILE, JSON.stringify(msgData, null, 2));
    } else {
      fs.writeFileSync(RESULT_FILE, JSON.stringify({ exited: code, logs }));
    }
    app.quit();
  });
  child.on('error', err => {
    fs.writeFileSync(RESULT_FILE, JSON.stringify({ error: err?.message ?? String(err), logs }));
    app.quit();
  });

  // Safety timeout: if worker hangs, write what we have and quit.
  setTimeout(() => {
    if (!msgReceived) {
      fs.writeFileSync(RESULT_FILE, JSON.stringify({ timedOut: true, exited: -1, logs }));
    }
    app.quit();
  }, 15000);
});
