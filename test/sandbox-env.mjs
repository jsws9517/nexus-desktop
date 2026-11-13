/**
 * Data-root sandbox for desktop unit tests.
 *
 * Import this module FIRST in any test that pulls in real dist/core modules
 * (AgentService, Agent, ContextManager, ...). Several of those resolve
 * dataRoot() at import time (db paths, config paths) or save the config as a
 * side effect of normalisation; without this, the tests rewrite the real
 * ~/.nexus/config.json (re-encrypting its credentials, spinning up backup
 * files) and drop session DBs under the real home.
 *
 * Precedence mirrors nexus-coder/src/config/paths.ts: NEXUS_CONFIG_DIR wins
 * over LLMA_DATA_DIR, so both are pointed at the same throwaway tree.
 */
import { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nexus-test-sandbox-'));
process.env.NEXUS_CONFIG_DIR = join(dir, '.nexus');
process.env.LLMA_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

export {};
