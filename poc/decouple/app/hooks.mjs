// ESM resolve hook: maps "nexus-coder/..." to the overlay core dir, falling back to the base copy.
// Bare specifiers imported from overlay files are resolved from the base app (no node_modules in overlay).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let cfg = null;

export async function initialize(data) {
  cfg = data;
}

export async function resolve(specifier, context, nextResolve) {
  if (cfg && specifier.startsWith('nexus-coder/')) {
    const rel = specifier.slice('nexus-coder/'.length);
    const overlayFile = path.join(cfg.coreDir, rel);
    if (fs.existsSync(overlayFile)) {
      return { url: pathToFileURL(overlayFile).href, shortCircuit: true };
    }
    const baseFile = path.join(cfg.baseDir, 'node_modules', 'nexus-coder', rel);
    return { url: pathToFileURL(baseFile).href, shortCircuit: true };
  }

  const fromOverlay = cfg && context.parentURL
    && context.parentURL.startsWith(pathToFileURL(cfg.coreDir).href);
  const isBare = !specifier.startsWith('.') && !specifier.startsWith('/')
    && !specifier.startsWith('node:') && !specifier.startsWith('file:');
  if (fromOverlay && isBare) {
    const baseParent = pathToFileURL(path.join(cfg.baseDir, 'index.js')).href;
    return nextResolve(specifier, { ...context, parentURL: baseParent });
  }

  return nextResolve(specifier, context);
}
