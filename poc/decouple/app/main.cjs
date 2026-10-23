// Electron main for the PoC. Runs the three checks and writes result.json into POC_ROOT.
const { app, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = process.env.POC_ROOT;
const out = {
  electron: process.versions.electron,
  node: process.versions.node,
  modules: process.versions.modules,
  tests: {},
};

function save() {
  fs.writeFileSync(path.join(ROOT, 'result.json'), JSON.stringify(out, null, 2));
}

async function testExternalAsar() {
  const asarFile = path.join(ROOT, 'overlay', 'desktop-0.2.21-poc.asar');
  const r = {};
  try {
    r.fsExists = fs.existsSync(path.join(asarFile, 'package.json'));
    r.pkgName = JSON.parse(fs.readFileSync(path.join(asarFile, 'package.json'), 'utf8')).name;
  } catch (e) {
    r.fsError = String(e);
  }
  try {
    const m = await import(pathToFileURL(path.join(asarFile, 'dist', 'main', 'index.js')).href);
    r.esmImport = m.marker;
    r.electronVersionSeen = m.electronVersion;
  } catch (e) {
    r.esmError = String(e);
  }
  return r;
}

function testUtilityProcess() {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(__dirname, 'worker.mjs'), [], {
      serviceName: 'poc-core-worker',
      stdio: 'pipe',
      env: {
        ...process.env,
        POC_ROOT: ROOT,
        POC_NATIVE_PKG: process.env.POC_NATIVE_PKG || '',
      },
    });
    let logs = '';
    child.stdout?.on('data', (d) => { logs += d; });
    child.stderr?.on('data', (d) => { logs += d; });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ timeout: true, logs });
    }, 20000);
    child.on('message', (msg) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ...msg, logs });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitedWithoutMessage: true, code, logs });
    });
  });
}

app.whenReady().then(async () => {
  try {
    out.tests.externalAsar = await testExternalAsar();
    out.tests.utilityProcess = await testUtilityProcess();
  } catch (e) {
    out.fatal = String(e);
  }
  save();
  app.quit();
});
