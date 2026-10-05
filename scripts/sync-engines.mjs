#!/usr/bin/env node
/**
 * Track the ACP engine registry, and check the live file against it.
 *
 * What `config/engines.json` is: a version-controlled record of the engine
 * definitions, and the reference `test/engines-config.test.mjs` diffs the live
 * file against. That drift test is what gives it teeth — it runs inside
 * `npm run test:unit`, so an unrecorded edit to `~/.nexus/engines.json` fails the
 * suite.
 *
 * What it is NOT: the runtime source of truth. Nothing in `src/` reads it, and
 * no build step installs it — the core loads `$NEXUS_CONFIG_DIR/engines.json`
 * (default `~/.nexus/engines.json`) directly. Editing the tracked copy therefore
 * changes nothing until you install it here. That is deliberate: auto-installing
 * on every build would overwrite a live registry, which is where hand-tuned
 * routing profiles (latency / cost / strengths) live.
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