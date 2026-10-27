/**
 * ESM resolve hook (runs on Node's hooks thread, so no electron imports here).
 *
 *  - `nexus-coder/<rel>` resolves to `<coreDir>/<rel>` when that file exists,
 *    otherwise to the base copy shipped in app.asar.
 *  - Bare specifiers imported from overlay files are resolved from the base
 *    app, because the overlay directory has no node_modules of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface HookData {
  coreDir: string;
  baseDir: string;
}

const PKG = 'nexus-coder/';
let cfg: { coreRoot: string; coreHref: string; baseParent: string } | null = null;

type ResolveContext = { parentURL?: string; conditions?: string[]; importAttributes?: Record<string, string> };
type NextResolve = (specifier: string, context: ResolveContext) => { url: string };

export function initialize(data: unknown): void {
  const d = data as HookData;
  const coreRoot = path.resolve(d.coreDir);
  cfg = {
    coreRoot,
    coreHref: pathToFileURL(coreRoot + path.sep).href,
    baseParent: pathToFileURL(path.join(path.resolve(d.baseDir), 'index.js')).href,
  };
}

export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve) {
  if (!cfg) return nextResolve(specifier, context);

  if (specifier.startsWith(PKG)) {
    const rel = specifier.slice(PKG.length);
    const overlayFile = path.join(cfg.coreRoot, rel);
    if (fs.existsSync(overlayFile) && overlayFile.startsWith(cfg.coreRoot)) {
      return { url: pathToFileURL(overlayFile).href, shortCircuit: true };
    }
    return nextResolve(specifier, { ...context, parentURL: cfg.baseParent });
  }

  const fromOverlay = !!context.parentURL && context.parentURL.startsWith(cfg.coreHref);
  const isBare = !specifier.startsWith('.') && !specifier.startsWith('/')
    && !specifier.startsWith('node:') && !specifier.startsWith('file:');
  if (fromOverlay && isBare) {
    return nextResolve(specifier, { ...context, parentURL: cfg.baseParent });
  }

  return nextResolve(specifier, context);
}
