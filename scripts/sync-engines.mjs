#!/usr/bin/env node
/**
 * Install / verify the tracked ACP engine registry.
 *
 * `config/engines.json` in this repo is the canonical copy. The core reads the
 * live file from `$NEXUS_CONFIG_DIR` or `~/.nexus/engines.json`
 * (nexus-coder/src/config/engines.ts `enginesFilePath`), so the tracked copy is
 * useless on its own — this script is the bridge. Keeping the canonical copy in
 * git is what stops the live file from being an unrecoverable local artifact:
 * engines decide which ACP agents `acp_route` can delegate to, and a stray edit
 * there is invisible to `git status` in any project.
 *
 * The project constitution (§3) keeps user-level state in the global `~/.nexus/`,
 * so the live file stays where the core expects it and only the source of truth
 * is tracked.
 *
 *   node scripts/sync-engines.mjs           install repo -> live (backs up first)
 *   node scripts/sync-engines.mjs --check   report drift, exit 1 if out of sync
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'config', 'engines.json');

const liveDir = process.env.NEXUS_CONFIG_DIR || join(homedir(), '.nexus');
const target = join(liveDir, 'engines.json');

const checkOnly = process.argv.includes('--check');

if (!existsSync(source)) {
  console.error(`[sync-engines] missing canonical file: ${source}`);
  process.exit(1);
}

const canonical = readFileSync(source, 'utf8');

if (checkOnly) {
  if (!existsSync(target)) {
    console.error(`[sync-engines] not installed: ${target}\n  run: node scripts/sync-engines.mjs`);
    process.exit(1);
  }
  const live = readFileSync(target, 'utf8');
  if (live === canonical) {
    console.log(`[sync-engines] in sync: ${target}`);
    process.exit(0);
  }
  console.error(`[sync-engines] DRIFT between tracked copy and live file:\n  tracked: ${source}\n  live:    ${target}`);
  console.error('[sync-engines] reconcile with: node scripts/sync-engines.mjs');
  process.exit(1);
}

mkdirSync(liveDir, { recursive: true });

// Preserve whatever was there. engines.json can carry hand-tuned routing
// profiles (latency / cost / strengths) that the tracked copy does not have, so
// an overwrite must be recoverable.
if (existsSync(target)) {
  const backup = join(liveDir, 'engines.json.pre-sync');
  writeFileSync(backup, readFileSync(target, 'utf8'), 'utf8');
  console.log(`[sync-engines] backed up live file -> ${backup}`);
}

copyFileSync(source, target);
console.log(`[sync-engines] installed ${source} -> ${target}`);