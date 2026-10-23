// utilityProcess worker: registers the resolve hook, then loads core and a native module.
import { register, createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.POC_ROOT;
const NATIVE_PKG = process.env.POC_NATIVE_PKG; // electron-ABI better-sqlite3 dir (optional)
const coreDir = path.join(ROOT, 'overlay', 'core', '2.0.0-poc');
const baseDir = path.join(ROOT, 'base');

const result = { hookRegistered: false };

try {
  register('./hooks.mjs', {
    parentURL: import.meta.url,
    data: { coreDir, baseDir },
  });
  result.hookRegistered = true;
} catch (e) {
  result.hookError = String(e);
}

try {
  const v = await import('nexus-coder/dist/src/version.js');
  result.overlayVersion = v.v;
  result.overlayDepViaBase = v.dep2;
} catch (e) {
  result.overlayError = String(e);
}

try {
  const b = await import('nexus-coder/dist/src/base-only.js');
  result.fallbackToBase = b.v;
} catch (e) {
  result.fallbackError = String(e);
}

try {
  if (!NATIVE_PKG) throw new Error('POC_NATIVE_PKG not set');
  const req = createRequire(pathToFileURL(path.join(NATIVE_PKG, 'package.json')));
  const Database = req(NATIVE_PKG);
  const db = new Database(':memory:');
  result.sqlite = db.prepare('select 42 as x').get();
  db.close();
} catch (e) {
  result.sqliteError = String(e);
}

process.parentPort.postMessage(result);
