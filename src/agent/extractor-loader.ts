/**
 * Activates installed RAG extractor packages inside the agent worker.
 *
 * The core's extractor registry is a plain in-process map. That is fine for the
 * zero-dependency built-in extractors, but it means an extension package
 * installed while the app is closed does nothing until something imports it —
 * and the only process that reads attachments for RAG is the worker, not the
 * main process where the settings UI installs packages. Registering a format in
 * the main process would silently have no effect on ingestion.
 *
 * So the worker loads them itself, at startup, before any `ragIngest` can run.
 * Each package directory under `~/.nexus/native/extractors/<name>/` exposes an
 * `index.mjs` that calls the core's `registerExtractor()` for its formats; a
 * plain dynamic import is all it takes, and the package's own `node_modules`
 * sits next to it. Nothing is shared with the main process, so the packages stay
 * portable: copy `~/.nexus` to another machine and the same formats work.
 *
 * A package that fails to load is logged and skipped — one broken extractor
 * must never stop the agent from starting.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { logger } from '../shared/logger.js';

export interface ExtractorLoadResult {
  /** Package names whose entry point ran successfully. */
  loaded: string[];
  /** Package name → why it could not be loaded. */
  failed: Record<string, string>;
}

const ENTRY_FILE = 'index.mjs';

let loadedOnce = false;

/** Root directory holding one subdirectory per installed extractor package. */
function extractorDir(): string {
  const dataDir = process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus');
  return join(dataDir, 'native', 'extractors');
}

/**
 * Package names the user disabled in settings. Read straight from config.json
 * rather than through the core's ConfigManager: the worker has not necessarily
 * loaded the agent yet at the point this runs, and a missing/!parsed file must
 * not stop every extractor from loading.
 */
function disabledPackages(): Set<string> {
  const disabled = new Set<string>();
  try {
    const configPath = join(
      process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus'),
      'config.json',
    );
    if (!existsSync(configPath)) return disabled;
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as { nativeDisabled?: unknown };
    if (Array.isArray(parsed.nativeDisabled)) {
      for (const n of parsed.nativeDisabled) if (typeof n === 'string') disabled.add(n);
    }
  } catch {
    /* unreadable config → treat nothing as disabled */
  }
  return disabled;
}

/**
 * Import every enabled extractor package. Idempotent: the worker's registry is
 * process-global, so a second call would only re-run module bodies for no gain.
 */
export async function loadExtractorPackages(): Promise<ExtractorLoadResult> {
  const result: ExtractorLoadResult = { loaded: [], failed: {} };
  if (loadedOnce) return result;
  loadedOnce = true;

  const root = extractorDir();
  if (!existsSync(root)) return result;

  const disabled = disabledPackages();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn(`extractor-loader: cannot read ${root}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (disabled.has(entry.name)) {
      logger.debug(`extractor-loader: skipping disabled package "${entry.name}"`);
      continue;
    }
    const entryPath = join(root, entry.name, ENTRY_FILE);
    if (!existsSync(entryPath)) {
      result.failed[entry.name] = `missing ${ENTRY_FILE}`;
      logger.warn(`extractor-loader: "${entry.name}" has no ${ENTRY_FILE}`);
      continue;
    }
    try {
      await import(pathToFileURL(entryPath).href);
      result.loaded.push(entry.name);
      logger.debug(`extractor-loader: loaded "${entry.name}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed[entry.name] = message;
      logger.warn(`extractor-loader: "${entry.name}" failed to load: ${message}`);
    }
  }
  return result;
}